//! Store forms (`storeForms`, default on).
//!
//! `createStore` has two forms behind one name: the plain form
//! `createStore(value, options?)` and the derived form
//! `createStore(fn, seed, options?)`, a projection store. The runtime picks
//! the form by `typeof first === "function"`, so the one export statically
//! couples every store to the projection and reconcile machinery (≈12.7 kB
//! rendered; documentation/plans/core-runtime-slicing.md, coupling 3).
//!
//! This pass decides the form at compile time where the first argument
//! settles it, and rewrites the call to the single-form export of the same
//! module:
//!
//! ```js
//! import { createStore } from "solid-js";
//! const [state] = createStore({ todos: [] });
//! const [users] = createStore(async () => fetchUsers(), []);
//! // →
//! import { createStore, createPlainStore as _$createPlainStore,
//!   createDerivedStore as _$createDerivedStore } from "solid-js";
//! const [state] = _$createPlainStore({ todos: [] });
//! const [users] = _$createDerivedStore(async () => fetchUsers(), []);
//! ```
//!
//! An app whose every call is classified plain no longer references
//! `createStore` (nor the derived export) and sheds the derived machinery.
//!
//! Classification (syntactic, per call site; wrappers `( )`, `as`,
//! `satisfies`, `!` and type assertions are looked through):
//! - derived: a function or arrow expression, a `$(…)` block (an import of `$`
//!   from a runtime source), a function declaration, or a `const` bound to
//!   one of those;
//! - plain: an object or array literal, a primitive or template literal, or a
//!   `const` bound to one of those (a non-function value always takes the
//!   plain branch at runtime, so the rewrite never changes behavior);
//! - anything else (a parameter, an import, a call result, a spread) is left
//!   alone: `createStore` keeps deciding at runtime.
//!
//! The callee must be `createStore` imported (as a value) from `solid-js` or
//! `@solidjs/signals`, not shadowed.
use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    BindingPattern, CallExpression, Expression, ImportDeclarationSpecifier, ImportOrExportKind,
    Program, Statement, VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, Scoping, SemanticBuilder, SymbolId};
use oxc_span::Span;

use crate::shared::ast_builder::AstBuilder;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
const PLAIN_EXPORT: &str = "createPlainStore";
const PLAIN_LOCAL: &str = "_$createPlainStore";
const DERIVED_EXPORT: &str = "createDerivedStore";
const DERIVED_LOCAL: &str = "_$createDerivedStore";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Form {
    Plain,
    Derived,
}

/// Rewrite every `createStore` call whose form the first argument settles.
pub(crate) fn transform_store_forms<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    if !imports_create_store(program) {
        return;
    }
    let targets = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let scoping = semantic.scoping();
        // Symbol ids exist only after the semantic build.
        let store_symbols = runtime_imports(program, "createStore");
        let block_symbols: Vec<SymbolId> = runtime_imports(program, "$")
            .into_iter()
            .map(|(s, _)| s)
            .collect();
        let mut collector = Collector {
            scoping,
            nodes: semantic.nodes(),
            stores: &store_symbols,
            blocks: &block_symbols,
            targets: Vec::new(),
        };
        collector.visit_program(program);
        // Synthesized calls may share an empty span; never rewrite an
        // ambiguous one.
        let mut targets = collector.targets;
        let spans: Vec<Span> = targets.iter().map(|t| t.0).collect();
        targets.retain(|(span, _, _)| {
            !span.is_empty() && spans.iter().filter(|s| *s == span).count() == 1
        });
        targets
    };
    if targets.is_empty() {
        return;
    }
    // One local per (import declaration, form): an existing specifier of the
    // form's constructor from the same source is reused (the v2 client
    // lowering creates `$store`s with `createPlainStore as
    // _$createPlainStore`), else the conventional local (suffixed when
    // taken) is added to the declaration.
    let mut locals: Vec<(Span, Form, String, bool)> = Vec::new();
    for (_, form, import) in &targets {
        if locals.iter().any(|(i, f, _, _)| i == import && f == form) {
            continue;
        }
        let (local, existing) = form_local(program, *import, *form);
        locals.push((*import, *form, local, existing));
    }
    let local_of = |import: Span, form: Form| {
        locals
            .iter()
            .find(|(i, f, _, _)| *i == import && *f == form)
            .map(|(_, _, local, _)| local.clone())
            .expect("a local per target")
    };
    let mut rewriter = Rewriter {
        allocator,
        targets: targets
            .iter()
            .map(|(span, form, import)| (*span, local_of(*import, *form)))
            .collect(),
    };
    rewriter.visit_program(program);
    for (import, form, local, existing) in locals {
        if !existing {
            add_import(allocator, program, import, form, &local);
        }
    }
}

/// The local a rewritten call of `form` uses in the declaration at `import`:
/// an existing value specifier of the form's constructor from the same
/// source (`true`), or a fresh `_$createPlainStore` / `_$createDerivedStore`
/// (suffixed when the name is taken).
fn form_local(program: &Program<'_>, import_span: Span, form: Form) -> (String, bool) {
    let (export, base) = match form {
        Form::Plain => (PLAIN_EXPORT, PLAIN_LOCAL),
        Form::Derived => (DERIVED_EXPORT, DERIVED_LOCAL),
    };
    let source = program.body.iter().find_map(|statement| match statement {
        Statement::ImportDeclaration(import) if import.span == import_span => {
            Some(import.source.value.as_str())
        }
        _ => None,
    });
    let mut taken = Vec::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier
                && Some(import.source.value.as_str()) == source
                && import.import_kind != ImportOrExportKind::Type
                && specifier.import_kind != ImportOrExportKind::Type
                && specifier.imported.name() == export
            {
                return (specifier.local.name.to_string(), true);
            }
            taken.push(specifier.local().name.to_string());
        }
    }
    let mut local = base.to_string();
    let mut n = 2;
    while taken.contains(&local) {
        local = format!("{base}{n}");
        n += 1;
    }
    (local, false)
}

fn imports_create_store(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| {
        matches!(statement, Statement::ImportDeclaration(import)
        if RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.specifiers.iter().flatten().any(|specifier| matches!(
                specifier,
                ImportDeclarationSpecifier::ImportSpecifier(s) if s.imported.name() == "createStore"
            )))
    })
}

/// `(local symbol, import declaration span)` of every value import of
/// `name` from a runtime source (symbols are set by the semantic build).
fn runtime_imports(program: &Program<'_>, name: &str) -> Vec<(SymbolId, Span)> {
    let mut out = Vec::new();
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
                && specifier.imported.name() == name
                && specifier.import_kind != ImportOrExportKind::Type
                && let Some(symbol) = specifier.local.symbol_id.get()
            {
                out.push((symbol, import.span));
            }
        }
    }
    out
}

struct Collector<'s> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'s>,
    /// `createStore` import symbols with their import declaration's span.
    stores: &'s [(SymbolId, Span)],
    /// `$` import symbols.
    blocks: &'s [SymbolId],
    /// (call span, form, import declaration span).
    targets: Vec<(Span, Form, Span)>,
}

impl<'b> Visit<'b> for Collector<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        if let Some(import) = self.store_import(&call.callee)
            && let Some(first) = call.arguments.first()
            && let Some(first) = first.as_expression()
            && let Some(form) = self.classify(first, 0)
        {
            self.targets.push((call.span, form, import));
        }
        walk::walk_call_expression(self, call);
    }
}

impl Collector<'_> {
    fn symbol_of(&self, expression: &Expression<'_>) -> Option<SymbolId> {
        let Expression::Identifier(identifier) = expression else {
            return None;
        };
        identifier
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
    }

    fn store_import(&self, callee: &Expression<'_>) -> Option<Span> {
        let symbol = self.symbol_of(callee)?;
        self.stores
            .iter()
            .find(|(s, _)| *s == symbol)
            .map(|(_, span)| *span)
    }

    fn classify(&self, expression: &Expression<'_>, depth: u32) -> Option<Form> {
        if depth > 4 {
            return None;
        }
        match expression.without_parentheses() {
            Expression::TSAsExpression(e) => self.classify(&e.expression, depth + 1),
            Expression::TSSatisfiesExpression(e) => self.classify(&e.expression, depth + 1),
            Expression::TSNonNullExpression(e) => self.classify(&e.expression, depth + 1),
            Expression::TSTypeAssertion(e) => self.classify(&e.expression, depth + 1),
            Expression::FunctionExpression(_) | Expression::ArrowFunctionExpression(_) => {
                Some(Form::Derived)
            }
            Expression::CallExpression(call)
                if self
                    .symbol_of(&call.callee)
                    .is_some_and(|symbol| self.blocks.contains(&symbol)) =>
            {
                Some(Form::Derived)
            }
            Expression::ObjectExpression(_)
            | Expression::ArrayExpression(_)
            | Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::TemplateLiteral(_) => Some(Form::Plain),
            Expression::Identifier(_) => self.classify_binding(expression, depth),
            _ => None,
        }
    }

    /// A function declaration, or a `const` whose initializer classifies.
    fn classify_binding(&self, expression: &Expression<'_>, depth: u32) -> Option<Form> {
        let symbol = self.symbol_of(expression)?;
        let declaration = self.scoping.symbol_declaration(symbol);
        match self.nodes.get_node(declaration).kind() {
            AstKind::Function(_) => Some(Form::Derived),
            AstKind::VariableDeclarator(declarator) => {
                let parent = self.nodes.parent_id(declaration);
                if !matches!(
                    self.nodes.get_node(parent).kind(),
                    AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const
                ) || !matches!(declarator.id, BindingPattern::BindingIdentifier(_))
                {
                    return None;
                }
                self.classify(declarator.init.as_ref()?, depth + 1)
            }
            _ => None,
        }
    }
}

struct Rewriter<'a> {
    allocator: &'a Allocator,
    /// (call span, the constructor local it calls).
    targets: Vec<(Span, String)>,
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
        walk_mut::walk_call_expression(self, call);
        let Some((_, local)) = self.targets.iter().find(|(span, _)| *span == call.span) else {
            return;
        };
        let ast = AstBuilder::new(self.allocator);
        let callee_span = oxc_span::GetSpan::span(&call.callee);
        call.callee = ast.expression_identifier(callee_span, ast.ident(local));
    }
}

fn add_import<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    import_span: Span,
    form: Form,
    local: &str,
) {
    let ast = AstBuilder::new(allocator);
    let export = match form {
        Form::Plain => PLAIN_EXPORT,
        Form::Derived => DERIVED_EXPORT,
    };
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.span != import_span {
            continue;
        }
        let span = Span::new(0, 0);
        let specifier = ast.import_declaration_specifier_import_specifier(
            span,
            ast.module_export_name_identifier_name(span, ast.ident(export)),
            ast.binding_identifier(span, ast.ident(local)),
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

    fn compile_with(source: &str, store_forms: bool) -> String {
        compile(
            source,
            &CompileOptions {
                generate: Generate::Dom,
                store_forms,
                filename: Some("module.tsx".into()),
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn classifies_plain_and_derived_calls() {
        let source = r#"
import { createStore } from "solid-js";
const initial = { todos: [] as string[] };
const derive = (draft: any) => { draft.n = 1; };
function project(draft: any) {}
export const [a] = createStore({ n: 1 });
export const [b] = createStore([] as number[]);
export const [c] = createStore(initial);
export const [d] = createStore(async () => ({ n: 1 }), { n: 0 });
export const [e] = createStore(function (draft) {}, {});
export const [f] = createStore(derive, {});
export const [g] = createStore(project, {});
"#;
        let out = compile_with(source, true);
        assert_eq!(out.matches("_$createPlainStore(").count(), 3, "{out}");
        assert_eq!(out.matches("_$createDerivedStore(").count(), 4, "{out}");
        assert!(
            out.contains("createPlainStore as _$createPlainStore"),
            "{out}"
        );
        assert!(
            out.contains("createDerivedStore as _$createDerivedStore"),
            "{out}"
        );
        assert!(!out.contains(" createStore("), "{out}");
    }

    #[test]
    fn a_block_first_argument_is_derived() {
        let source = r#"
import { createStore, $ } from "@solidjs/signals";
export const [s] = createStore($(function* (draft) { draft.x = 1; }), {});
"#;
        let out = compile_with(source, true);
        assert!(out.contains("_$createDerivedStore("), "{out}");
        assert!(
            out.contains("createDerivedStore as _$createDerivedStore } from \"@solidjs/signals\""),
            "{out}"
        );
    }

    #[test]
    fn leaves_undecidable_foreign_shadowed_and_disabled_calls() {
        let undecidable = r#"
import { createStore } from "solid-js";
import { seed } from "./seed";
export function make(value: any, ...rest: any[]) {
  let mutable = {};
  mutable = () => {};
  return [createStore(value), createStore(seed), createStore(...rest), createStore(mutable), createStore(load())];
}
"#;
        let out = compile_with(undecidable, true);
        assert!(
            !out.contains("_$createPlainStore") && !out.contains("_$createDerivedStore"),
            "{out}"
        );
        let foreign = r#"
import { createStore } from "my-store";
export const [s] = createStore({});
"#;
        assert!(!compile_with(foreign, true).contains("_$createPlainStore"));
        let shadowed = r#"
import { createStore } from "solid-js";
export function f(createStore: any) { return createStore({}); }
"#;
        assert!(!compile_with(shadowed, true).contains("_$createPlainStore"));
        let plain = r#"
import { createStore } from "solid-js";
export const [s] = createStore({});
"#;
        assert!(!compile_with(plain, false).contains("_$createPlainStore"));
    }
}
