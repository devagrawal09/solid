//! Synchronous actions (experimental, `syncActions`).
//!
//! `action(function* (…) { … })` opens a transaction per call so that writes
//! spanning an async gap (`yield`) stay atomic. A body with no `yield` has no
//! gap: the generator runs to completion on its first step, and the
//! transaction only adds cost (measured −15% to −22% per call without it;
//! documentation/plans/heuristic-oracles.md, A1). This pass proves that fact
//! syntactically and rewrites
//!
//! ```js
//! import { action } from "solid-js";
//! const save = action(function* (x) { setA(x); setB(x); });
//! // →
//! import { action, syncAction as _$syncAction } from "solid-js";
//! const save = _$syncAction(function (x) { setA(x); setB(x); });
//! ```
//!
//! `syncAction` (packages/signals/src/core/action.ts) keeps everything an
//! action does for a one-slice body except the transaction: the owned-scope
//! guard, the provenance stamp, the flush-in-action guard, the attribution
//! brackets, and a returned promise. Equivalence — plain and optimistic
//! writes, writes to nodes an in-flight action holds, nested action calls —
//! is pinned by packages/signals/tests/sync-action.test.ts.
//!
//! Proof (all syntactic, per call site):
//! - the callee is `action` imported from `solid-js` / `@solidjs/signals`
//!   (a value import, not shadowed);
//! - exactly one argument, a non-`async` generator function expression;
//! - no `yield` / `yield*` in its own body (nested functions and classes are
//!   their own scopes and are not searched);
//! - if the function expression is named, the name is not referenced inside
//!   (calling it would change from "make a generator" to "run the body").
//!
//! DOM output only: on the server `action(fn)` is the identity (calling it
//! returns an unstarted generator), so the rewrite would run bodies during SSR.
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Class, Expression, Function, ImportDeclarationSpecifier,
    ImportOrExportKind, Program, Statement, YieldExpression,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{Scoping, SemanticBuilder, SymbolId};
use oxc_span::Span;
use oxc_syntax::scope::ScopeFlags;

use crate::shared::ast_builder::AstBuilder;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
/// The local name of the helper.
pub(crate) const SYNC_ACTION_LOCAL: &str = "_$syncAction";

/// Rewrite every proven-synchronous `action(function* …)` call.
pub(crate) fn transform_sync_actions<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    let Some(import_span) = action_import_span(program) else {
        return;
    };
    let targets = {
        // Symbol ids exist only after the semantic build.
        let semantic = SemanticBuilder::new().build(program).semantic;
        let actions = action_symbols(program);
        let mut collector = Collector {
            scoping: semantic.scoping(),
            actions: &actions,
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

/// The first value import of `action` from a runtime source (receives the
/// helper import).
fn action_import_span(program: &Program<'_>) -> Option<Span> {
    program.body.iter().find_map(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return None;
        };
        let imports_action = RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.import_kind != ImportOrExportKind::Type
            && import.specifiers.iter().flatten().any(|specifier| {
                matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if specifier.imported.name() == "action"
                            && specifier.import_kind != ImportOrExportKind::Type
                )
            });
        imports_action.then_some(import.span)
    })
}

/// Every local symbol bound to an `action` value import from a runtime
/// source (after the semantic build).
fn action_symbols(program: &Program<'_>) -> Vec<SymbolId> {
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
                && specifier.imported.name() == "action"
                && specifier.import_kind != ImportOrExportKind::Type
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
    actions: &'s [SymbolId],
    /// Spans of the `action(…)` calls to rewrite.
    targets: Vec<Span>,
}

impl<'b> Visit<'b> for Collector<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        if self.is_action_call(call)
            && call.arguments.len() == 1
            && let Argument::FunctionExpression(function) = &call.arguments[0]
            && self.provably_synchronous(function)
        {
            self.targets.push(call.span);
        }
        walk::walk_call_expression(self, call);
    }
}

impl Collector<'_> {
    fn is_action_call(&self, call: &CallExpression<'_>) -> bool {
        let Expression::Identifier(callee) = &call.callee else {
            return false;
        };
        callee
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
            .is_some_and(|symbol| self.actions.contains(&symbol))
    }

    fn provably_synchronous(&self, function: &Function<'_>) -> bool {
        if !function.generator || function.r#async {
            return false;
        }
        // A named generator that refers to itself would change meaning.
        if let Some(id) = &function.id
            && let Some(symbol) = id.symbol_id.get()
            && self.scoping.get_resolved_reference_ids(symbol).iter().next().is_some()
        {
            return false;
        }
        let Some(body) = function.body.as_ref() else {
            return false;
        };
        let mut finder = YieldFinder { found: false };
        finder.visit_function_body(body);
        !finder.found
    }
}

/// Finds a `yield` belonging to the searched function (not to a nested one).
struct YieldFinder {
    found: bool,
}

impl<'b> Visit<'b> for YieldFinder {
    fn visit_yield_expression(&mut self, _: &YieldExpression<'b>) {
        self.found = true;
    }
    // Nested functions and classes are their own generator scopes.
    fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
    fn visit_class(&mut self, _: &Class<'b>) {}
}

struct Rewriter<'a> {
    allocator: &'a Allocator,
    targets: Vec<Span>,
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
        walk_mut::walk_call_expression(self, call);
        if !self.targets.contains(&call.span) {
            return;
        }
        let ast = AstBuilder::new(self.allocator);
        let callee_span = oxc_span::GetSpan::span(&call.callee);
        call.callee = ast.expression_identifier(callee_span, ast.ident(SYNC_ACTION_LOCAL));
        if let Argument::FunctionExpression(function) = &mut call.arguments[0] {
            function.generator = false;
        }
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
        let span = Span::new(0, 0);
        let specifier = ast.import_declaration_specifier_import_specifier(
            span,
            ast.module_export_name_identifier_name(span, ast.ident("syncAction")),
            ast.binding_identifier(span, ast.ident(SYNC_ACTION_LOCAL)),
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

    fn compile_with(source: &str, generate: Generate, sync_actions: bool) -> String {
        compile(
            source,
            &CompileOptions {
                generate,
                sync_actions,
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn rewrites_a_yield_free_action() {
        let source = r#"
import { action, createSignal } from "solid-js";
const [a, setA] = createSignal(0);
export const save = action(function* (x) { setA(x); return x; });
"#;
        let out = compile_with(source, Generate::Dom, true);
        assert!(out.contains("_$syncAction(function(x)") || out.contains("_$syncAction(function (x)"), "{out}");
        assert!(out.contains("syncAction as _$syncAction"), "{out}");
        assert!(!out.contains("function*"), "{out}");
    }

    #[test]
    fn leaves_actions_that_yield_alone() {
        let source = r#"
import { action } from "solid-js";
export const save = action(function* (x) { yield fetch(x); });
export const each = action(function* () { yield* other(); });
"#;
        let out = compile_with(source, Generate::Dom, true);
        assert!(!out.contains("_$syncAction"), "{out}");
    }

    #[test]
    fn nested_yields_do_not_count() {
        let source = r#"
import { action } from "solid-js";
export const save = action(function* () {
  const g = function* () { yield 1; };
  return [...g()];
});
"#;
        let out = compile_with(source, Generate::Dom, true);
        assert!(out.contains("_$syncAction("), "{out}");
    }

    #[test]
    fn leaves_async_generators_arrows_and_references_alone() {
        let source = r#"
import { action } from "solid-js";
export const a = action(async function* () { await 1; });
const body = function* () {};
export const b = action(body);
export const c = action(function* self() { return self; });
"#;
        let out = compile_with(source, Generate::Dom, true);
        assert!(!out.contains("_$syncAction"), "{out}");
    }

    #[test]
    fn respects_shadowing_foreign_actions_and_ssr_and_the_flag() {
        let shadowed = r#"
import { action } from "solid-js";
function f(action) { return action(function* () {}); }
"#;
        assert!(!compile_with(shadowed, Generate::Dom, true).contains("_$syncAction"));
        let foreign = r#"
import { action } from "my-lib";
export const a = action(function* () {});
"#;
        assert!(!compile_with(foreign, Generate::Dom, true).contains("_$syncAction"));
        let plain = r#"
import { action } from "solid-js";
export const a = action(function* () {});
"#;
        assert!(!compile_with(plain, Generate::Ssr, true).contains("_$syncAction"));
        assert!(!compile_with(plain, Generate::Dom, false).contains("_$syncAction"));
    }
}
