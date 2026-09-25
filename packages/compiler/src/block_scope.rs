//! Hydration id scopes for JSX-producing `$` blocks.
//!
//! A `$` block defers its JSX until it runs, and it runs at whichever sink
//! renders it — the client's `insert` effect or a flow control's flatten, the
//! server's template-hole resolution. Those sinks run at different times and
//! under different owners on the two sides, so hydration ids allocated by the
//! block's content drifted apart (server `<b _hk=4>`, client asking for `1`).
//! A plain component never had the problem: its JSX is created at the
//! component call, which is registration time — source order — on both sides.
//!
//! This pass restores that invariant for blocks. Every `$(fn)` whose function
//! body contains JSX is rewritten to
//!
//! ```js
//! import { blockScope as _$blockScope } from "solid-js";
//! $(_$blockScope(function () { … }));
//! ```
//!
//! `blockScope` (client: `@solidjs/signals`, server: `solid-js`'s server
//! runtime) reserves one child-id slot when the block is created and runs every
//! invocation of the body under that id with a zeroed counter. Creation is the
//! same point on both sides, so the content ids match wherever and whenever
//! each side renders the block.
//!
//! The decision is purely syntactic (does the body contain JSX?) and runs in a
//! pass shared by every generate before JSX lowering, so the dom and ssr
//! outputs wrap exactly the same blocks — the same property the hole-scope
//! predicate relies on. It runs only for hydratable builds (ids are otherwise
//! irrelevant), after generator lowering and host fusion: a fused block has no
//! `$` left and its host computation is already a real id-carrying owner.
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, ImportDeclarationSpecifier, ImportOrExportKind,
    JSXElement, JSXFragment, Program, Statement,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use crate::shared::ast::{argument_to_expression, expression_to_argument};
use crate::shared::ast_builder::AstBuilder;

/// Modules whose named `$` export is the block adapter.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
/// The local name of the scope helper.
pub(crate) const BLOCK_SCOPE_LOCAL: &str = "_$blockScope";

/// Wrap the body of every JSX-producing `$` block in `_$blockScope(…)`.
pub(crate) fn scope_jsx_blocks<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    let Some(import_span) = adapter_import_span(program) else {
        return;
    };
    let targets = {
        let semantic = SemanticBuilder::new().build(program).semantic;
        let scoping = semantic.scoping();
        let adapters = adapter_symbols(program);
        if adapters.is_empty() {
            return;
        }
        let mut collector = Collector {
            scoping,
            adapters: &adapters,
            targets: Vec::new(),
        };
        collector.visit_program(program);
        collector.targets
    };
    if targets.is_empty() {
        return;
    }
    let mut rewriter = Rewriter { allocator, targets };
    rewriter.visit_program(program);
    add_import(allocator, program, import_span);
}

/// The first value import of `$` from a runtime source (receives the helper).
fn adapter_import_span(program: &Program<'_>) -> Option<Span> {
    program.body.iter().find_map(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return None;
        };
        let imports_adapter = RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.import_kind != ImportOrExportKind::Type
            && import.specifiers.iter().flatten().any(|specifier| {
                matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if specifier.imported.name() == "$"
                            && specifier.import_kind != ImportOrExportKind::Type
                )
            });
        imports_adapter.then_some(import.span)
    })
}

fn adapter_symbols(program: &Program<'_>) -> Vec<SymbolId> {
    let mut symbols = Vec::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str())
            || import.import_kind == ImportOrExportKind::Type
        {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier
                && specifier.imported.name() == "$"
                && let Some(symbol) = specifier.local.symbol_id.get()
            {
                symbols.push(symbol);
            }
        }
    }
    symbols
}

struct Collector<'s> {
    scoping: &'s Scoping,
    adapters: &'s [SymbolId],
    /// Spans of the `$` calls whose argument gets wrapped.
    targets: Vec<Span>,
}

impl<'b> Visit<'b> for Collector<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        if self.is_adapter_call(call)
            && call.arguments.len() == 1
            && body_has_jsx(&call.arguments[0])
        {
            self.targets.push(call.span);
        }
        walk::walk_call_expression(self, call);
    }
}

impl Collector<'_> {
    fn is_adapter_call(&self, call: &CallExpression<'_>) -> bool {
        let Expression::Identifier(callee) = &call.callee else {
            return false;
        };
        callee
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
            .is_some_and(|symbol| self.adapters.contains(&symbol))
    }
}

/// Is the argument a function (expression or arrow) whose body contains JSX
/// anywhere — including nested callbacks, which run during the block?
fn body_has_jsx(argument: &Argument<'_>) -> bool {
    #[derive(Default)]
    struct Finder {
        found: bool,
    }
    impl<'b> Visit<'b> for Finder {
        fn visit_jsx_element(&mut self, _: &JSXElement<'b>) {
            self.found = true;
        }
        fn visit_jsx_fragment(&mut self, _: &JSXFragment<'b>) {
            self.found = true;
        }
    }
    let mut finder = Finder::default();
    match argument {
        Argument::FunctionExpression(function) => {
            if let Some(body) = function.body.as_ref() {
                finder.visit_function_body(body);
            }
        }
        Argument::ArrowFunctionExpression(arrow) => finder.visit_arrow_function_body(&arrow.body),
        _ => return false,
    }
    finder.found
}

struct Rewriter<'a> {
    allocator: &'a Allocator,
    targets: Vec<Span>,
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
        // Walk first: a nested block inside this one keeps its own span.
        walk_mut::walk_call_expression(self, call);
        if !self.targets.contains(&call.span) {
            return;
        }
        let ast = AstBuilder::new(self.allocator);
        let placeholder = expression_to_argument(ast.expression_null_literal(Span::new(0, 0)));
        let body = std::mem::replace(&mut call.arguments[0], placeholder);
        let span = body.span();
        let body = argument_to_expression(body).expect("a function argument is an expression");
        let wrapped = ast.expression_call(
            span,
            ast.expression_identifier(Span::new(0, 0), ast.ident(BLOCK_SCOPE_LOCAL)),
            None,
            ast.vec1(expression_to_argument(body)),
            false,
        );
        call.arguments[0] = expression_to_argument(wrapped);
    }
}

fn add_import<'a>(allocator: &'a Allocator, program: &mut Program<'a>, import_span: Span) {
    let ast = AstBuilder::new(allocator);
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.span != import_span {
            continue;
        }
        let already = import.specifiers.iter().flatten().any(|specifier| {
            matches!(
                specifier,
                ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if specifier.local.name == BLOCK_SCOPE_LOCAL
            )
        });
        if already {
            return;
        }
        let span = Span::new(0, 0);
        let specifier = ast.import_declaration_specifier_import_specifier(
            span,
            ast.module_export_name_identifier_name(span, ast.ident("blockScope")),
            ast.binding_identifier(span, ast.ident(BLOCK_SCOPE_LOCAL)),
            ImportOrExportKind::Value,
        );
        match import.specifiers.as_mut() {
            Some(specifiers) => specifiers.push(specifier),
            None => import.specifiers = Some(ast.vec1(specifier)),
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, Generate, compile};

    fn compile_with(source: &str, generate: Generate, hydratable: bool) -> String {
        compile(
            source,
            &CompileOptions {
                generate,
                hydratable,
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .unwrap_or_else(|error| panic!("{error}"))
    }

    const JSX_BLOCK: &str = r#"
import { $, createSignal } from "solid-js";
function Leaf(props) {
  const [n] = createSignal(1);
  return $(function* () {
    return <b>{props.label}{yield* n}</b>;
  });
}
"#;

    #[test]
    fn wraps_jsx_blocks_identically_on_both_generates() {
        for generate in [Generate::Dom, Generate::Ssr] {
            let out = compile_with(JSX_BLOCK, generate, true);
            assert!(out.contains("return $(_$blockScope(function"), "{out}");
            assert!(out.contains("blockScope as _$blockScope"), "{out}");
        }
    }

    #[test]
    fn leaves_non_hydratable_builds_alone() {
        for generate in [Generate::Dom, Generate::Ssr] {
            let out = compile_with(JSX_BLOCK, generate, false);
            assert!(!out.contains("_$blockScope"), "{out}");
        }
    }

    #[test]
    fn leaves_blocks_without_jsx_alone() {
        let source = r#"
import { $, createMemo, createSignal } from "solid-js";
function C() {
  const [n] = createSignal(1);
  const double = createMemo($(function* () { return (yield* n) * 2; }));
  const onClick = $(function* () { yield* n; });
  return <p onClick={onClick}>{double()}</p>;
}
"#;
        for generate in [Generate::Dom, Generate::Ssr] {
            let out = compile_with(source, generate, true);
            assert!(!out.contains("_$blockScope"), "{out}");
        }
    }

    #[test]
    fn wraps_nested_and_unlowered_blocks() {
        // The inner block waits, so the generator pass leaves it to the
        // runtime driver; the scope wraps generator bodies too.
        let source = r#"
import { $, createSignal, wait } from "solid-js";
function C() {
  const [items] = createSignal([1]);
  return $(function* () {
    const list = yield* items;
    return list.map(i => $(function* () { return <li>{i}</li>; }));
  });
}
"#;
        for generate in [Generate::Dom, Generate::Ssr] {
            let out = compile_with(source, generate, true);
            assert_eq!(out.matches("$(_$blockScope(").count(), 2, "{out}");
            assert_eq!(
                out.matches("blockScope as _$blockScope").count(),
                1,
                "{out}"
            );
        }
    }

    #[test]
    fn respects_shadowed_adapter() {
        let source = r#"
import { $ } from "solid-js";
function C() {
  const $ = f => f;
  return $(function () { return <p />; });
}
"#;
        let out = compile_with(source, Generate::Dom, true);
        assert!(!out.contains("_$blockScope("), "{out}");
    }
}
