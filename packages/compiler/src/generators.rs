//! `$()` block lowering.
//!
//! `solid-js` (and `@solidjs/signals`) export `$`, which builds a typed
//! reactive block from a generator body: inside it every reactive read is
//! `yield* signal`, a typed throw is `yield* raise(error)`, a typed fallible
//! call is `yield* attempt(fn, ...Errors)`, and an async suspension is
//! `yield* wait(promise, ...Errors)`. The runtime drives the generator; this
//! pass removes that driver from compiled output by lowering the body to
//! call form, which `$` runs under the same strict scope:
//!
//! ```js
//! createMemo($(function* (prev) { const c = yield* count; return c * 2; }));
//! // becomes
//! import { perform as _$perform } from "solid-js";
//! createMemo($(function (prev) { const c = _$perform(count); return c * 2; }));
//! ```
//!
//! `perform` executes one operation exactly as the driver would (a read with
//! the strict guard lowered, a raise, an attempt), so the two modes agree.
//! Because `$` stays in the output, a source-level direct read (`count()`)
//! inside the body is emitted verbatim and still fails at runtime in dev
//! (`[DIRECT_READ_IN_BLOCK]`) — the pass never turns a violation into a
//! silently allowed read.
//!
//! The pass runs before JSX lowering, so a `yield*` inside a JSX expression
//! container (`<div>{yield* count}</div>`) becomes an ordinary dynamic
//! expression (`{_$perform(count)}`) for the JSX transform — the
//! fine-grained read that JSX gives a call. Without this pass such JSX
//! cannot be compiled (the JSX transform hoists expressions into arrow
//! functions, where `yield` is a syntax error), so JSX yields are a
//! compiler-only spelling.
//!
//! # Diagnostics (compile errors)
//!
//! Inside an eligible `$` generator body (nested functions excluded):
//! - a `throw` statement (`[THROW_IN_BLOCK]` — use `yield* raise(error)`);
//! - a bare `yield` (`[PLAIN_YIELD_IN_BLOCK]` — operations use `yield*`);
//! - `$(async function* …)` (`[ASYNC_GENERATOR_IN_BLOCK]` — use
//!   `yield* wait(promise)`; `await` is not allowed);
//! - a `yield*` inside a JSX expression container in a block the pass cannot
//!   lower (`[JSX_YIELD_IN_UNLOWERED_BLOCK]`): the JSX transform would hoist
//!   it into an arrow function, where `yield` is a syntax error.
//!
//! # Lowered subset
//!
//! A `$` call is lowered only when the rewrite is semantics-preserving by
//! construction; otherwise it is left untouched for the runtime driver,
//! never partially rewritten:
//!
//! - the callee resolves (by symbol — local shadowing wins, aliases allowed)
//!   to a named `$` import from `solid-js` or `@solidjs/signals`;
//! - the sole argument is a non-async generator `function` expression;
//! - every `yield*` operand is an identifier or a (non-optional) member
//!   expression — an accessor, a block, or an operation held in a variable —
//!   or a direct call to the `raise` / `attempt` / `write` / `call` /
//!   `readStore` imports (sync operations `perform` executes under the
//!   current host — a lowered `readStore` is one selector invocation with no
//!   generator involved). A `yield*` over
//!   `wait(...)` or over any other call (a block factory, delegation to an
//!   unknown generator) leaves the whole call to the runtime driver, which
//!   is the only thing that can suspend.
//!
//! An async operation reaching `perform` through a variable the pass could
//! not see through fails loudly at runtime (`[ASYNC_OP_OUTSIDE_DRIVER]`)
//! rather than miscompiling. The lowered function stays a `function`
//! expression (`this`/`arguments` keep their meaning); a `: Generator<…>`
//! return annotation is dropped since it no longer describes the function.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, Function, ImportDeclarationSpecifier, ImportOrExportKind,
    Program, Statement, ThrowStatement, YieldExpression,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{Scoping, SemanticBuilder, SymbolId};
use oxc_span::Span;
use oxc_syntax::scope::ScopeFlags;

use crate::shared::ast_builder::AstBuilder;

/// Modules whose named exports are the block runtime.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
/// The local name the lowered reads call.
const PERFORM_LOCAL: &str = "_$perform";

/// Lower every eligible `$(function* …)` in `program`, or report the first
/// forbidden construct inside a `$` body. A program that does not import `$`
/// from a runtime source is returned untouched without building semantic
/// information.
pub(crate) fn transform_generators<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &str,
) -> Result<(), String> {
    if !imports_adapter(program) {
        return Ok(());
    }
    let plan = build_plan(program, source)?;
    if plan.calls.is_empty() {
        return Ok(());
    }
    let mut rewriter = Rewriter { allocator, plan };
    rewriter.visit_program(program);
    Ok(())
}

/// Cheap syntactic gate: is `$` imported by name from a runtime source?
fn imports_adapter(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return false;
        };
        RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.specifiers.iter().flatten().any(|specifier| {
                matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if specifier.imported.name() == "$"
                )
            })
    })
}

#[derive(Default)]
struct Plan {
    /// `$(function* …)` calls whose body is lowered to call form.
    calls: Vec<Span>,
    /// `yield* x` expressions (inside those calls) to lower to `_$perform(x)`.
    yields: Vec<Span>,
    /// The runtime import declaration that receives the `perform` specifier.
    import_span: Option<Span>,
}

/// Named imports from the runtime sources that the pass recognizes.
#[derive(Default)]
struct RuntimeSymbols {
    adapter: Vec<SymbolId>,
    /// Sync operations (`raise`, `attempt`, `write`, `call`, `readStore`):
    /// performable in call form.
    sync_ops: Vec<SymbolId>,
    /// Declaration span of the first runtime import (host for `_$perform`).
    import_span: Option<Span>,
}

fn build_plan(program: &Program<'_>, source: &str) -> Result<Plan, String> {
    let semantic = SemanticBuilder::new().build(program).semantic;
    let scoping = semantic.scoping();

    let mut symbols = RuntimeSymbols::default();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str())
            || import.import_kind == ImportOrExportKind::Type
        {
            continue;
        }
        symbols.import_span.get_or_insert(import.span);
        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                continue;
            };
            let Some(symbol_id) = specifier.local.symbol_id.get() else {
                continue;
            };
            match specifier.imported.name().as_str() {
                "$" => symbols.adapter.push(symbol_id),
                "raise" | "attempt" | "write" | "call" | "readStore" => {
                    symbols.sync_ops.push(symbol_id)
                }
                _ => {}
            }
        }
    }
    if symbols.adapter.is_empty() {
        return Ok(Plan::default());
    }

    struct Collector<'s> {
        scoping: &'s Scoping,
        symbols: &'s RuntimeSymbols,
        source: &'s str,
        plan: Plan,
        error: Option<String>,
    }

    impl<'b> Visit<'b> for Collector<'_> {
        fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
            if self.error.is_none() && self.is_adapter_call(call) {
                match self.plan_block(call) {
                    Ok(()) => {}
                    Err(error) => self.error = Some(error),
                }
            }
            walk::walk_call_expression(self, call);
        }
    }

    impl Collector<'_> {
        fn is_adapter_call(&self, call: &CallExpression<'_>) -> bool {
            resolve_callee(self.scoping, call)
                .is_some_and(|symbol| self.symbols.adapter.contains(&symbol))
        }

        /// Diagnose the body, then decide whether it is lowerable.
        fn plan_block(&mut self, call: &CallExpression<'_>) -> Result<(), String> {
            if call.arguments.len() != 1 {
                return Ok(());
            }
            let Argument::FunctionExpression(function) = &call.arguments[0] else {
                return Ok(());
            };
            if function.r#async && function.generator {
                return Err(diagnostic(
                    self.source,
                    function.span,
                    "[ASYNC_GENERATOR_IN_BLOCK] `$` does not accept async generators: `await` is not allowed in a block; suspend with `yield* wait(promise)`",
                ));
            }
            if !function.generator {
                return Ok(());
            }
            let Some(body) = function.body.as_ref() else {
                return Ok(());
            };
            let mut yields = YieldCollector {
                scoping: self.scoping,
                symbols: self.symbols,
                source: self.source,
                spans: Vec::new(),
                lowerable: true,
                jsx_yield: None,
                jsx_depth: 0,
                error: None,
            };
            yields.visit_function_body(body);
            if let Some(error) = yields.error {
                return Err(error);
            }
            if let (false, Some(span)) = (yields.lowerable, yields.jsx_yield) {
                return Err(diagnostic(
                    self.source,
                    span,
                    "[JSX_YIELD_IN_UNLOWERED_BLOCK] a `yield*` inside JSX only compiles when the compiler lowers the block, but this block also waits (or yields an operand the compiler cannot lower). A block that returns JSX may only read signals; move the wait into a reactive computation the JSX reads",
                ));
            }
            if yields.lowerable {
                self.plan.calls.push(call.span);
                self.plan.yields.extend(yields.spans);
            }
            Ok(())
        }
    }

    let mut collector = Collector {
        scoping,
        symbols: &symbols,
        source,
        plan: Plan::default(),
        error: None,
    };
    collector.visit_program(program);
    if let Some(error) = collector.error {
        return Err(error);
    }
    let mut plan = collector.plan;
    plan.import_span = symbols.import_span;
    Ok(plan)
}

fn resolve_callee(scoping: &Scoping, call: &CallExpression<'_>) -> Option<SymbolId> {
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    callee
        .reference_id
        .get()
        .and_then(|id| scoping.get_reference(id).symbol_id())
}

/// Walks one generator body (nested functions own their yields and throws;
/// arrows cannot yield for the enclosing generator but may throw for
/// themselves, so both are skipped), collecting lowerable yields, flagging
/// the ones only the runtime driver can execute, and diagnosing forbidden
/// constructs.
struct YieldCollector<'s> {
    scoping: &'s Scoping,
    symbols: &'s RuntimeSymbols,
    source: &'s str,
    spans: Vec<Span>,
    lowerable: bool,
    /// The first `yield*` found inside a JSX expression container: such a
    /// yield only compiles if the block is lowered (the JSX transform hoists
    /// the expression into an arrow function, where `yield` is a syntax
    /// error), so it is a diagnostic when the block cannot be.
    jsx_yield: Option<Span>,
    jsx_depth: usize,
    error: Option<String>,
}

impl<'b> Visit<'b> for YieldCollector<'_> {
    fn visit_function(&mut self, _it: &Function<'b>, _flags: ScopeFlags) {}

    fn visit_arrow_function_expression(&mut self, _it: &oxc_ast::ast::ArrowFunctionExpression<'b>) {
    }

    fn visit_throw_statement(&mut self, it: &ThrowStatement<'b>) {
        if self.error.is_none() {
            self.error = Some(diagnostic(
                self.source,
                it.span,
                "[THROW_IN_BLOCK] `throw` is not allowed in a `$` block; use `yield* raise(error)` so the block's error type records it",
            ));
        }
    }

    fn visit_jsx_expression_container(&mut self, it: &oxc_ast::ast::JSXExpressionContainer<'b>) {
        self.jsx_depth += 1;
        walk::walk_jsx_expression_container(self, it);
        self.jsx_depth -= 1;
    }

    fn visit_yield_expression(&mut self, it: &YieldExpression<'b>) {
        if self.jsx_depth > 0 && self.jsx_yield.is_none() {
            self.jsx_yield = Some(it.span);
        }
        if !it.delegate {
            if self.error.is_none() {
                self.error = Some(diagnostic(
                    self.source,
                    it.span,
                    "[PLAIN_YIELD_IN_BLOCK] a bare `yield` is not allowed in a `$` block; operations are yielded with `yield*` (`yield* signal`, `yield* wait(...)`, `yield* raise(...)`)",
                ));
            }
            return;
        }
        match it.argument.as_ref() {
            Some(operand) if is_operand_lowerable(operand, self.scoping, self.symbols) => {
                self.spans.push(it.span);
            }
            _ => self.lowerable = false,
        }
        walk::walk_yield_expression(self, it);
    }
}

/// Operands `perform` can execute in call form: identifiers and
/// non-optional member expressions (an accessor, block or sync op held in a
/// binding), and direct `raise(...)` / `attempt(...)` / `write(...)` /
/// `call(...)` / `readStore(...)` calls. Everything else — `wait(...)` and
/// any unknown call — stays with the runtime driver.
fn is_operand_lowerable(
    expression: &Expression<'_>,
    scoping: &Scoping,
    symbols: &RuntimeSymbols,
) -> bool {
    match expression {
        Expression::Identifier(_) => true,
        Expression::StaticMemberExpression(member) => !member.optional,
        Expression::ComputedMemberExpression(member) => !member.optional,
        Expression::CallExpression(call) => {
            resolve_callee(scoping, call).is_some_and(|symbol| symbols.sync_ops.contains(&symbol))
        }
        _ => false,
    }
}

fn diagnostic(source: &str, span: Span, message: &str) -> String {
    let (line, column) = line_column(source, span.start);
    format!("{message} ({line}:{column})")
}

/// 1-based line and column of a byte offset.
fn line_column(source: &str, offset: u32) -> (usize, usize) {
    let offset = (offset as usize).min(source.len());
    let before = &source[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |tail| tail.chars().count())
        + 1;
    (line, column)
}

struct Rewriter<'a> {
    allocator: &'a Allocator,
    plan: Plan,
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_program(&mut self, program: &mut Program<'a>) {
        walk_mut::walk_program(self, program);
        // `import { …, perform as _$perform } from "<runtime source>"`.
        let Some(import_span) = self.plan.import_span else {
            return;
        };
        let ast = AstBuilder::new(self.allocator);
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
                ast.module_export_name_identifier_name(span, ast.ident("perform")),
                ast.binding_identifier(span, ast.ident(PERFORM_LOCAL)),
                ImportOrExportKind::Value,
            );
            match import.specifiers.as_mut() {
                Some(specifiers) => specifiers.push(specifier),
                None => import.specifiers = Some(ast.vec1(specifier)),
            }
            return;
        }
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let ast = AstBuilder::new(self.allocator);
        match expression {
            Expression::CallExpression(call) if self.plan.calls.contains(&call.span) => {
                if let Argument::FunctionExpression(function) = &mut call.arguments[0] {
                    function.generator = false;
                    // `: Generator<…>` no longer describes the function.
                    function.return_type = None;
                }
            }
            Expression::YieldExpression(yield_expression)
                if self.plan.yields.contains(&yield_expression.span) =>
            {
                let span = yield_expression.span;
                let operand = yield_expression
                    .argument
                    .take()
                    .expect("eligibility checked the operand");
                let callee = ast.expression_identifier(span, ast.ident(PERFORM_LOCAL));
                *expression = ast.expression_call(
                    span,
                    callee,
                    None,
                    ast.vec1(crate::shared::ast::expression_to_argument(operand)),
                    false,
                );
            }
            _ => {}
        }
        // Walk the (possibly new) node: a lowered body holds the yields, and
        // a lowered operand may itself contain one.
        walk_mut::walk_expression(self, expression);
    }
}

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, Generate, compile};

    fn ssr(source: &str) -> Result<String, String> {
        compile(
            source,
            &CompileOptions {
                generate: Generate::Ssr,
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .map_err(|error| error.to_string())
    }

    #[test]
    fn lowers_reads_to_perform_and_keeps_the_block() {
        let out = ssr(r#"import { $, createMemo, createEffect } from "solid-js";
const double = createMemo($(function* (prev) {
  const c = yield* count;
  return c * 2 + (prev ?? 0);
}));
createEffect($(function* () { return yield* double; }), v => log(v));
"#)
        .unwrap();
        assert!(out.contains("const c = _$perform(count);"), "{out}");
        assert!(out.contains("return _$perform(double);"), "{out}");
        assert!(out.contains("createMemo($(function(prev) {"), "{out}");
        assert!(!out.contains("yield"), "{out}");
        assert!(
            out.contains(
                r#"import { $, createMemo, createEffect, perform as _$perform } from "solid-js";"#
            ),
            "{out}"
        );
    }

    #[test]
    fn lowers_member_operands_sync_ops_and_jsx_children() {
        let out = ssr(r#"import { $, raise, attempt } from "@solidjs/signals";
export const view = $(function* () {
  const n = yield* attempt(() => JSON.parse(props.raw), SyntaxError);
  if (n < 0) yield* raise(new RangeError("negative"));
  return <p>{yield* props.count}{yield* state["label"]}</p>;
});
"#)
        .unwrap();
        assert!(
            out.contains("_$perform(attempt(() => JSON.parse(props.raw), SyntaxError))"),
            "{out}"
        );
        assert!(
            out.contains(r#"_$perform(raise(new RangeError("negative")))"#),
            "{out}"
        );
        assert!(out.contains("_$perform(props.count)"), "{out}");
        assert!(out.contains(r#"_$perform(state["label"])"#), "{out}");
        assert!(!out.contains("yield"), "{out}");
    }

    #[test]
    fn lowers_event_block_writes_and_delegation() {
        let out = ssr(r#"import { $, write, call } from "solid-js";
export const onClick = $(function* (event) {
  const c = yield* count;
  yield* write(setCount, c + 1);
  return yield* call(props.onClick, event);
});
"#)
        .unwrap();
        assert!(out.contains("_$perform(write(setCount, c + 1))"), "{out}");
        assert!(
            out.contains("_$perform(call(props.onClick, event))"),
            "{out}"
        );
        assert!(out.contains("$(function(event) {"), "{out}");
        assert!(!out.contains("yield"), "{out}");
    }

    #[test]
    fn lowers_store_reads_to_one_selector_invocation() {
        let out = ssr(r#"import { $, readStore } from "solid-js";
export const view = $(function* () {
  const name = yield* readStore(store, state => state.user.name);
  return <ul>{yield* readStore(store, state => state.items.map(item => <li>{item.name}</li>))}</ul>;
});
const aliased = $(function* () { const sel = state => state.count; return yield* readStore(store, sel); });
"#)
        .unwrap();
        assert!(
            out.contains("_$perform(readStore(store, (state) => state.user.name))"),
            "{out}"
        );
        assert!(
            out.contains("_$perform(readStore(store, (state) => state.items.map("),
            "{out}"
        );
        assert!(out.contains("_$perform(readStore(store, sel))"), "{out}");
        assert!(!out.contains("yield"), "{out}");
    }

    #[test]
    fn leaves_waits_and_unknown_calls_to_the_runtime() {
        let source = r#"import { $, wait } from "solid-js";
const a = $(function* () { const id = yield* userId; return yield* wait(fetchUser(id)); });
const b = $(function* () { return yield* helper(); });
const c = $(function* () { return yield* count?.value; });
const d = $(() => count());
"#;
        let out = ssr(source).unwrap();
        assert!(out.contains("yield* wait(fetchUser(id))"), "{out}");
        assert!(out.contains("const id = yield* userId;"), "{out}");
        assert!(out.contains("yield* helper()"), "{out}");
        assert!(out.contains("yield* count?.value"), "{out}");
        assert!(out.contains("$(() => count())"), "{out}");
        assert!(!out.contains("_$perform"), "{out}");
        assert!(
            out.contains(r#"import { $, wait } from "solid-js";"#),
            "{out}"
        );
    }

    #[test]
    fn diagnoses_forbidden_constructs() {
        let throw_error = ssr(r#"import { $ } from "solid-js";
const a = $(function* () {
  if (yield* flag) throw new Error("no");
  return 1;
});
"#)
        .unwrap_err();
        assert!(throw_error.contains("[THROW_IN_BLOCK]"), "{throw_error}");
        assert!(throw_error.contains("(3:20)"), "{throw_error}");

        let yield_error = ssr(r#"import { $ } from "solid-js";
const a = $(function* () { const c = yield count; return c; });
"#)
        .unwrap_err();
        assert!(
            yield_error.contains("[PLAIN_YIELD_IN_BLOCK]"),
            "{yield_error}"
        );

        let async_error = ssr(r#"import { $ } from "solid-js";
const a = $(async function* () { return await fetchIt(); });
"#)
        .unwrap_err();
        assert!(
            async_error.contains("[ASYNC_GENERATOR_IN_BLOCK]"),
            "{async_error}"
        );

        let jsx_error = ssr(r#"import { $, wait } from "solid-js";
const view = $(function* () {
  return <p>{(yield* wait(fetchUser(1))).name}</p>;
});
"#)
        .unwrap_err();
        assert!(
            jsx_error.contains("[JSX_YIELD_IN_UNLOWERED_BLOCK]"),
            "{jsx_error}"
        );
        assert!(jsx_error.contains("(3:15)"), "{jsx_error}");
        // A lowered block may yield inside JSX; an unlowered block may yield
        // outside it.
        let fine = ssr(r#"import { $, wait } from "solid-js";
const a = $(function* () { return <p>{yield* count}</p>; });
const b = $(function* () { const u = yield* wait(fetchUser(1)); return <p>{u.name}</p>; });
"#)
        .unwrap();
        assert!(fine.contains("_$perform(count)"), "{fine}");
        assert!(fine.contains("yield* wait(fetchUser(1))"), "{fine}");

        // Nested functions own their throws.
        let nested = ssr(r#"import { $ } from "solid-js";
const a = $(function* () {
  const check = () => { throw new Error("mine"); };
  return yield* count;
});
"#)
        .unwrap();
        assert!(nested.contains("_$perform(count)"), "{nested}");
    }

    #[test]
    fn respects_shadowing_other_sources_and_the_option() {
        let shadowed = ssr(r#"import { $ } from "solid-js";
function local() {
  const $ = fn => fn;
  return $(function* () { return yield* count; });
}
"#)
        .unwrap();
        assert!(shadowed.contains("yield* count"), "{shadowed}");

        let other = ssr(r#"import { $ } from "jquery";
const a = $(function* () { throw new Error("not ours"); });
"#)
        .unwrap();
        assert!(other.contains("throw new Error"), "{other}");

        let off = compile(
            r#"import { $ } from "solid-js";
const a = $(function* () { return yield* count; });
"#,
            &CompileOptions {
                generate: Generate::Ssr,
                generators: false,
                ..CompileOptions::default()
            },
        )
        .unwrap()
        .code;
        assert!(off.contains("yield* count"), "{off}");
    }
}
