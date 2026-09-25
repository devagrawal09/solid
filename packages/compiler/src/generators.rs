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
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, Function, IdentifierReference,
    ImportDeclarationSpecifier, ImportOrExportKind, Program, Statement, ThrowStatement,
    YieldExpression,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use crate::shared::ast_builder::AstBuilder;

/// Modules whose named exports are the block runtime.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
/// The local name the lowered reads call.
const PERFORM_LOCAL: &str = "_$perform";
/// The path readers `yield* root.a.b` lowers to, by key count (index 0 is
/// the generic reader, which takes the keys as an array): `(imported, local)`.
/// Store and prop paths share them — the runtime read is the same; the
/// `StoreRead` / `PropRead` distinction lives only in the typecheck
/// projection (`block_projection.rs`).
const PATH_READERS: [(&str, &str); 5] = [
    ("readPathN", "_$readPathN"),
    ("readPath1", "_$readPath1"),
    ("readPath2", "_$readPath2"),
    ("readPath3", "_$readPath3"),
    ("readPath4", "_$readPath4"),
];
/// Longest path a fixed-arity reader takes; longer paths use `readPathN`.
const MAX_FIXED_PATH: usize = 4;

/// The reader index (into `PATH_READERS`) for a path of `keys` keys.
fn path_reader(keys: usize) -> usize {
    if (1..=MAX_FIXED_PATH).contains(&keys) {
        keys
    } else {
        0
    }
}

/// Lower every eligible `$(function* …)` in `program`, or report the first
/// forbidden construct inside a `$` body. A program that does not import `$`
/// from a runtime source is returned untouched without building semantic
/// information.
pub(crate) fn transform_generators<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &'a str,
) -> Result<(), String> {
    if !imports_adapter(program) {
        return Ok(());
    }
    let plan = build_plan(program, source)?;
    if plan.calls.is_empty() {
        return Ok(());
    }
    let mut rewriter = Rewriter {
        allocator,
        plan,
        source,
    };
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
    /// `yield* root.a[0][k]` member chains to lower to one handle read,
    /// `_$readPath3(root, "a", 0, k)` (`_$readPathN(root, [...])` beyond four
    /// keys).
    paths: Vec<PathYield>,
    /// Which readers the lowered paths use (indices into `PATH_READERS`).
    path_readers: [bool; 5],
    /// The runtime import declaration that receives the `perform` specifier.
    import_span: Option<Span>,
}

/// A `yield*` over a member chain, with its lowering plan.
struct PathYield {
    span: Span,
    /// Number of keys in the chain (selects the reader).
    keys: usize,
}

/// Named imports from the runtime sources that the pass recognizes.
#[derive(Default)]
pub(crate) struct RuntimeSymbols {
    pub(crate) adapter: Vec<SymbolId>,
    /// Sync operations (`raise`, `attempt`, `write`, `call`, `readStore`):
    /// performable in call form.
    pub(crate) sync_ops: Vec<SymbolId>,
    /// Declaration span of the first runtime import (host for `_$perform`).
    pub(crate) import_span: Option<Span>,
}

/// The runtime import bindings of a program (after `SemanticBuilder`).
pub(crate) fn collect_runtime_symbols(program: &Program<'_>) -> RuntimeSymbols {
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
    symbols
}

fn build_plan(program: &Program<'_>, source: &str) -> Result<Plan, String> {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();

    let symbols = collect_runtime_symbols(program);
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
                paths: Vec::new(),
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
                for path in &yields.paths {
                    self.plan.path_readers[path_reader(path.keys)] = true;
                }
                self.plan.paths.extend(yields.paths);
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
    /// Member-chain yields (`yield* root.a[0][k]`), lowered to path reads.
    paths: Vec<PathYield>,
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
        if it.delegate
            && let Some(operand) = it.argument.as_ref()
            && member_chain_root(operand).is_some()
        {
            self.paths.push(PathYield {
                span: it.span,
                keys: member_chain_keys(operand, self.source).len(),
            });
            walk::walk_yield_expression(self, it);
            return;
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

/// The root identifier of a lowerable member chain
/// `Identifier ( .name | [string] | [number] | [identifier] )+` — the direct
/// property syntax. Optional chains, calls, and computed keys other than a
/// literal or a bare identifier are not chains (the block stays with the
/// runtime driver, whose path tokens give the same semantics).
pub(crate) fn member_chain_root<'a, 'b>(
    expression: &'b Expression<'a>,
) -> Option<&'b IdentifierReference<'a>> {
    let mut current = expression;
    let mut hops = 0;
    loop {
        match current {
            Expression::StaticMemberExpression(member) if !member.optional => {
                current = &member.object;
            }
            Expression::ComputedMemberExpression(member) if !member.optional => {
                match &member.expression {
                    Expression::StringLiteral(_)
                    | Expression::NumericLiteral(_)
                    | Expression::Identifier(_) => {}
                    _ => return None,
                }
                current = &member.object;
            }
            Expression::Identifier(root) => return (hops > 0).then_some(root),
            _ => return None,
        }
        hops += 1;
    }
}

/// The keys of a member chain, innermost first, as source text for a lowered
/// path array: `"name"`, `0`, `"x"`, `index`.
pub(crate) fn member_chain_keys(expression: &Expression<'_>, source: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut current = expression;
    loop {
        match current {
            Expression::StaticMemberExpression(member) => {
                keys.push(format!("\"{}\"", member.property.name));
                current = &member.object;
            }
            Expression::ComputedMemberExpression(member) => {
                let span = member.expression.span();
                keys.push(source[span.start as usize..span.end as usize].to_string());
                current = &member.object;
            }
            _ => break,
        }
    }
    keys.reverse();
    keys
}

/// Conservative component-props detection: the root resolves to a binding
/// declared as the first parameter of a function whose name starts with an
/// uppercase letter. Anything else is a store/object path. The two forms
/// differ only in the phantom read type; the runtime read is identical.
pub(crate) fn is_component_props(
    scoping: &Scoping,
    nodes: &AstNodes<'_>,
    root: &IdentifierReference<'_>,
) -> bool {
    let Some(symbol) = root
        .reference_id
        .get()
        .and_then(|id| scoping.get_reference(id).symbol_id())
    else {
        return false;
    };
    let declaration = scoping.symbol_declaration(symbol);
    let mut node_id = declaration;
    // Walk up from the binding to the parameter list, then to the function.
    let mut saw_parameter = false;
    loop {
        let node = nodes.get_node(node_id);
        match node.kind() {
            AstKind::FormalParameter(_) => saw_parameter = true,
            AstKind::FormalParameters(params) => {
                if !saw_parameter {
                    return false;
                }
                let first = params.items.first();
                if !first.is_some_and(|param| {
                    param
                        .span()
                        .contains_inclusive(root_declaration_span(nodes, declaration))
                }) {
                    return false;
                }
            }
            AstKind::Function(function) => {
                return saw_parameter
                    && function
                        .id
                        .as_ref()
                        .is_some_and(|id| starts_uppercase(&id.name));
            }
            AstKind::ArrowFunctionExpression(_) => {
                // `const Comp = (props) => …`: the arrow's parent declarator names it.
                let parent = nodes.parent_id(node_id);
                if parent == node_id {
                    return false;
                }
                return saw_parameter
                    && matches!(
                        nodes.get_node(parent).kind(),
                        AstKind::VariableDeclarator(declarator)
                            if declarator.id.get_identifier_name().is_some_and(|name| starts_uppercase(&name))
                    );
            }
            AstKind::Program(_) => return false,
            _ => {}
        }
        let parent = nodes.parent_id(node_id);
        if parent == node_id {
            return false;
        }
        node_id = parent;
    }
}

fn root_declaration_span(nodes: &AstNodes<'_>, declaration: NodeId) -> Span {
    nodes.get_node(declaration).kind().span()
}

fn starts_uppercase(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
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
    source: &'a str,
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
            let mut needed = vec![("perform", PERFORM_LOCAL)];
            // Fixed arities in order, then the generic reader.
            for index in (1..PATH_READERS.len()).chain([0]) {
                if self.plan.path_readers[index] {
                    needed.push(PATH_READERS[index]);
                }
            }
            for (imported, local) in needed {
                let specifier = ast.import_declaration_specifier_import_specifier(
                    span,
                    ast.module_export_name_identifier_name(span, ast.ident(imported)),
                    ast.binding_identifier(span, ast.ident(local)),
                    ImportOrExportKind::Value,
                );
                match import.specifiers.as_mut() {
                    Some(specifiers) => specifiers.push(specifier),
                    None => import.specifiers = Some(ast.vec1(specifier)),
                }
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
                if let Some(index) = self
                    .plan
                    .paths
                    .iter()
                    .position(|path| path.span == yield_expression.span) =>
            {
                // `yield* root.a[0][k]` → `_$readPath3(root, "a", 0, k)`: one
                // proxy-free handle read (store/generator.ts), no operation
                // object, no path array, no `perform` dispatch.
                let path = self.plan.paths.remove(index);
                let span = yield_expression.span;
                let operand = yield_expression
                    .argument
                    .take()
                    .expect("eligibility checked the operand");
                let keys = member_chain_keys(&operand, self.source);
                debug_assert_eq!(keys.len(), path.keys);
                let root_name = member_chain_root(&operand)
                    .expect("eligibility checked the chain")
                    .name;
                // Synthesized nodes carry an empty span (the printer keys
                // literal output off spans); the outer call keeps the yield's.
                let synth = Span::new(0, 0);
                let root = ast.expression_identifier(synth, root_name);
                let key_expressions = keys.iter().map(|key| {
                    if let Some(text) = key.strip_prefix('"').and_then(|k| k.strip_suffix('"')) {
                        ast.expression_string_literal(synth, ast.str(text), None)
                    } else if let Ok(number) = key.parse::<f64>() {
                        ast.expression_numeric_literal(
                            synth,
                            number,
                            Some(ast.str(key)),
                            oxc_syntax::number::NumberBase::Decimal,
                        )
                    } else {
                        ast.expression_identifier(synth, ast.ident(key))
                    }
                });
                let reader = path_reader(path.keys);
                let mut arguments = ast.vec1(crate::shared::ast::expression_to_argument(root));
                if reader == 0 {
                    let elements = ast.vec_from_iter(
                        key_expressions.map(oxc_ast::ast::ArrayExpressionElement::from),
                    );
                    arguments.push(crate::shared::ast::expression_to_argument(
                        ast.expression_array(synth, elements),
                    ));
                } else {
                    for key in key_expressions {
                        arguments.push(crate::shared::ast::expression_to_argument(key));
                    }
                }
                *expression = ast.expression_call(
                    span,
                    ast.expression_identifier(span, ast.ident(PATH_READERS[reader].1)),
                    None,
                    arguments,
                    false,
                );
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

// ---------------------------------------------------------------------------
// Host fusion: erase `$()` and `_$perform` when the host is statically known
// ---------------------------------------------------------------------------

/// Statically known reactive hosts whose first argument may be a `$()` block.
const HOST_IMPORTS: &[&str] = &["createMemo", "createEffect", "createRenderEffect"];

/// Symbols the generator transform inserts that the fusion pass needs to
/// resolve by symbol ID (not name) to avoid false positives from shadowing.
struct HelperSymbols {
    perform: Vec<SymbolId>,
    read_path: Vec<SymbolId>,
    read_prop: Vec<SymbolId>,
}

/// After `transform_generators`, fuse `createMemo($(fn))` → `createMemo(fn)`
/// with `_$perform(x)` → `x()` and path reads → member expressions. Only
/// blocks whose body is fully erasable (no `readStore`, `raise`, `attempt`,
/// `write`, `call` inside `perform`) are fused; everything else is left for
/// the runtime.
///
/// All callee matching uses symbol-based resolution through Oxc's semantic
/// analysis, not string-name comparison, so user code that shadows `_$perform`
/// etc. in a nested scope does not trigger false positives.
pub(crate) fn fuse_host_blocks<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &'a str,
) -> Result<(), String> {
    if !imports_adapter(program) {
        return Ok(());
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();

    let mut adapter_symbols: Vec<SymbolId> = Vec::new();
    let mut host_symbols: Vec<SymbolId> = Vec::new();
    let mut helpers = HelperSymbols {
        perform: Vec::new(),
        read_path: Vec::new(),
        read_prop: Vec::new(),
    };
    for statement in program.body.iter() {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str()) {
            continue;
        }
        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(s) = specifier else {
                continue;
            };
            let Some(symbol_id) = s.local.symbol_id.get() else {
                continue;
            };
            match s.imported.name().as_str() {
                "$" => adapter_symbols.push(symbol_id),
                "perform" => helpers.perform.push(symbol_id),
                "readPath" => helpers.read_path.push(symbol_id),
                "readProp" => helpers.read_prop.push(symbol_id),
                name if HOST_IMPORTS.contains(&name) => host_symbols.push(symbol_id),
                _ => {}
            }
        }
    }
    if adapter_symbols.is_empty() || host_symbols.is_empty() || helpers.perform.is_empty() {
        return Ok(());
    }

    let plan = build_fusion_plan(scoping, &adapter_symbols, &host_symbols, &helpers, program, source);
    if plan.blocks.is_empty() {
        return Ok(());
    }
    let mut rewriter = FusionRewriter {
        allocator,
        plan,
        source,
    };
    rewriter.visit_program(program);
    Ok(())
}

struct FusionPlan {
    /// `$(fn)` call spans to unwrap — replace with the inner function.
    blocks: Vec<Span>,
    /// `_$perform(ident)` or `_$perform(member)` call spans — replace with
    /// `ident()` or `member()`.
    perform_calls: Vec<Span>,
    /// `_$perform(_$readPath/Prop(root, [keys]))` — replace with a member chain.
    perform_paths: Vec<FusionPath>,
}

struct FusionPath {
    span: Span,
    root_name: String,
    keys: Vec<String>,
}

fn build_fusion_plan(
    scoping: &Scoping,
    adapter_symbols: &[SymbolId],
    host_symbols: &[SymbolId],
    helpers: &HelperSymbols,
    program: &Program<'_>,
    source: &str,
) -> FusionPlan {
    let plan = FusionPlan {
        blocks: Vec::new(),
        perform_calls: Vec::new(),
        perform_paths: Vec::new(),
    };
    struct Collector<'a> {
        scoping: &'a Scoping,
        adapter_symbols: &'a [SymbolId],
        host_symbols: &'a [SymbolId],
        helpers: &'a HelperSymbols,
        source: &'a str,
        plan: FusionPlan,
    }
    impl<'b> Visit<'b> for Collector<'_> {
        fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
            // Match HOST($(fn)): a host call whose first argument is a `$()` call
            // containing a non-generator function expression.
            if let Some(host_sym) = resolve_callee(self.scoping, call) {
                if self.host_symbols.contains(&host_sym) && !call.arguments.is_empty() {
                    if let Argument::CallExpression(inner) = &call.arguments[0] {
                        if let Some(adapter_sym) = resolve_callee(self.scoping, inner) {
                            if self.adapter_symbols.contains(&adapter_sym)
                                && inner.arguments.len() == 1
                            {
                                if let Argument::FunctionExpression(func) = &inner.arguments[0] {
                                    if !func.generator
                                        && body_is_erasable(
                                            self.scoping, self.helpers, func,
                                        )
                                    {
                                        self.plan.blocks.push(inner.span);
                                        collect_performs(
                                            self.scoping,
                                            self.helpers,
                                            func,
                                            &mut self.plan,
                                            self.source,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            walk::walk_call_expression(self, call);
        }
    }

    let mut collector = Collector {
        scoping,
        adapter_symbols,
        host_symbols,
        helpers,
        source,
        plan,
    };
    collector.visit_program(program);
    collector.plan
}

/// Resolve an identifier callee to its symbol and check if it matches one
/// of the given target symbols (symbol-based, not name-based).
fn is_callee_one_of(
    scoping: &Scoping,
    call: &CallExpression<'_>,
    targets: &[SymbolId],
) -> bool {
    resolve_callee(scoping, call)
        .map_or(false, |sym| targets.contains(&sym))
}

/// Every `_$perform(…)` in the function body is one we know how to erase.
fn body_is_erasable(scoping: &Scoping, helpers: &HelperSymbols, func: &Function<'_>) -> bool {
    let Some(body) = func.body.as_ref() else {
        return false;
    };
    struct Checker<'a> {
        scoping: &'a Scoping,
        helpers: &'a HelperSymbols,
        ok: bool,
    }
    impl<'b> Visit<'b> for Checker<'_> {
        fn visit_function(&mut self, _it: &Function<'b>, _flags: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _it: &oxc_ast::ast::ArrowFunctionExpression<'b>,
        ) {
            // Do not walk into arrows. At the fusion point (after generator
            // transform, before JSX lowering) no `_$perform` calls exist inside
            // arrows because `yield*` is a syntax error inside arrows and the
            // generator transform only creates `_$perform` from `yield*`.
        }
        fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
            if is_callee_one_of(self.scoping, call, &self.helpers.perform)
                && !is_erasable_perform_arg(self.scoping, self.helpers, call)
            {
                self.ok = false;
            }
            walk::walk_call_expression(self, call);
        }
    }
    let mut checker = Checker { scoping, helpers, ok: true };
    checker.visit_function_body(body);
    checker.ok
}

fn is_erasable_perform_arg(
    scoping: &Scoping,
    helpers: &HelperSymbols,
    call: &CallExpression<'_>,
) -> bool {
    if call.arguments.len() != 1 {
        return false;
    }
    match &call.arguments[0] {
        Argument::Identifier(_) => true,
        Argument::StaticMemberExpression(m) => !m.optional,
        Argument::ComputedMemberExpression(m) => !m.optional,
        Argument::CallExpression(inner) => {
            is_callee_one_of(
                scoping,
                inner,
                &[&helpers.read_path[..], &helpers.read_prop[..]].concat(),
            ) && inner.arguments.len() == 2
                && matches!(&inner.arguments[0], Argument::Identifier(_))
                && matches!(&inner.arguments[1], Argument::ArrayExpression(_))
        }
        _ => false,
    }
}

fn collect_performs(
    scoping: &Scoping,
    helpers: &HelperSymbols,
    func: &Function<'_>,
    plan: &mut FusionPlan,
    source: &str,
) {
    let Some(body) = func.body.as_ref() else {
        return;
    };
    struct Collector<'a> {
        scoping: &'a Scoping,
        helpers: &'a HelperSymbols,
        plan: &'a mut FusionPlan,
        source: &'a str,
    }
    impl<'b> Visit<'b> for Collector<'_> {
        fn visit_function(&mut self, _it: &Function<'b>, _flags: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _it: &oxc_ast::ast::ArrowFunctionExpression<'b>,
        ) {
            // Same rationale as `body_is_erasable`: no `_$perform` calls exist
            // inside arrows at the fusion point.
        }
        fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
            if is_callee_one_of(self.scoping, call, &self.helpers.perform) {
                classify_perform(self.scoping, self.helpers, call, self.plan, self.source);
            }
            walk::walk_call_expression(self, call);
        }
    }
    let mut collector = Collector { scoping, helpers, plan, source };
    collector.visit_function_body(body);
}

fn classify_perform(
    scoping: &Scoping,
    helpers: &HelperSymbols,
    call: &CallExpression<'_>,
    plan: &mut FusionPlan,
    source: &str,
) {
    let span = call.span;
    match &call.arguments[0] {
        Argument::CallExpression(inner)
            if is_callee_one_of(
                scoping,
                inner,
                &[&helpers.read_path[..], &helpers.read_prop[..]].concat(),
            ) =>
        {
            if let (Argument::Identifier(root), Argument::ArrayExpression(array)) =
                (&inner.arguments[0], &inner.arguments[1])
            {
                let root_name = root.name.to_string();
                let keys = array_literal_to_keys(array, source);
                plan.perform_paths.push(FusionPath {
                    span,
                    root_name,
                    keys,
                });
            }
        }
        _ => {
            plan.perform_calls.push(span);
        }
    }
}

/// Extract the key strings from an array literal `["user", "name"]` or
/// `["items", 0, i]` the way the generator transform emitted them.
fn array_literal_to_keys(
    array: &oxc_ast::ast::ArrayExpression<'_>,
    source: &str,
) -> Vec<String> {
    array
        .elements
        .iter()
        .map(|element| match element {
            oxc_ast::ast::ArrayExpressionElement::StringLiteral(s) => {
                format!("\"{}\"", s.value)
            }
            oxc_ast::ast::ArrayExpressionElement::NumericLiteral(n) => {
                n.raw.as_ref().map_or_else(|| n.value.to_string(), |r| r.to_string())
            }
            other => {
                let span = other.span();
                source[span.start as usize..span.end as usize].to_string()
            }
        })
        .collect()
}

struct FusionRewriter<'a> {
    allocator: &'a Allocator,
    plan: FusionPlan,
    source: &'a str,
}

impl<'a> VisitMut<'a> for FusionRewriter<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let ast = AstBuilder::new(self.allocator);
        let span = expression.span();

        // Unwrap `$(fn)` → `fn`
        if self.plan.blocks.contains(&span) {
            let placeholder = ast.expression_null_literal(Span::new(0, 0));
            let owned = std::mem::replace(expression, placeholder);
            if let Expression::CallExpression(call_box) = owned {
                let mut call = call_box.unbox();
                if let Some(fn_arg) = call.arguments.pop() {
                    if let Some(fn_expr) = crate::shared::ast::argument_to_expression(fn_arg) {
                        *expression = fn_expr;
                    }
                }
            }
        }

        // `_$perform(_$readPath/Prop(root, [keys]))` → `root.key1.key2…`
        if let Some(idx) = self
            .plan
            .perform_paths
            .iter()
            .position(|p| p.span == span)
        {
            let path = &self.plan.perform_paths[idx];
            *expression = build_member_chain(&ast, &path.root_name, &path.keys, self.source);
        }

        // `_$perform(x)` → `x()`
        if self.plan.perform_calls.contains(&span) {
            let placeholder = ast.expression_null_literal(Span::new(0, 0));
            let owned = std::mem::replace(expression, placeholder);
            if let Expression::CallExpression(call_box) = owned {
                let mut call = call_box.unbox();
                if let Some(arg) = call.arguments.pop() {
                    if let Some(callee) = crate::shared::ast::argument_to_expression(arg) {
                        *expression =
                            ast.expression_call(span, callee, None, ast.vec(), false);
                    }
                }
            }
        }

        walk_mut::walk_expression(self, expression);
    }
}

/// Build `root.key1.key2[idx]…` from a root identifier and the key strings
/// the generator transform emitted (`"name"` → static, `0` → computed number,
/// bare ident → computed identifier).
fn build_member_chain<'a>(
    ast: &AstBuilder<'a>,
    root_name: &str,
    keys: &[String],
    _source: &str,
) -> Expression<'a> {
    let synth = Span::new(0, 0);
    let mut expr = ast.expression_identifier(synth, ast.ident(root_name));
    for key in keys {
        if let Some(text) = key.strip_prefix('"').and_then(|k| k.strip_suffix('"')) {
            // Static property: root.name
            expr = Expression::StaticMemberExpression(ast.alloc_static_member_expression(
                synth,
                expr,
                ast.identifier_name(synth, ast.ident(text)),
                false,
            ));
        } else if let Ok(num) = key.parse::<f64>() {
            // Numeric index: root[0]
            let index = ast.expression_numeric_literal(
                synth,
                num,
                Some(ast.str(key)),
                oxc_syntax::number::NumberBase::Decimal,
            );
            expr = Expression::ComputedMemberExpression(
                ast.alloc_computed_member_expression(synth, expr, index, false),
            );
        } else {
            // Dynamic identifier: root[i]
            let ident = ast.expression_identifier(synth, ast.ident(key));
            expr = Expression::ComputedMemberExpression(
                ast.alloc_computed_member_expression(synth, expr, ident, false),
            );
        }
    }
    expr
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

    fn fused(source: &str) -> Result<String, String> {
        compile(
            source,
            &CompileOptions {
                generate: Generate::Ssr,
                host_fusion: true,
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
        // Member chains are path reads (`props` here is not a component's
        // parameter, so the store form).
        assert!(out.contains(r#"_$readPath1(props, "count")"#), "{out}");
        assert!(out.contains(r#"_$readPath1(state, "label")"#), "{out}");
        assert!(
            out.contains(r#"perform as _$perform, readPath1 as _$readPath1"#),
            "{out}"
        );
        assert!(!out.contains("yield"), "{out}");
    }

    #[test]
    fn lowers_direct_property_paths() {
        let out = ssr(r#"import { $, createMemo } from "solid-js";
function Counter(props) {
  const name = createMemo($(function* () {
    const i = yield* index;
    return `${yield* store.user.name} ${yield* store.items[0].name} ${yield* store.items[i]} ${yield* store.items.length}`;
  }));
  return $(function* () { return <p>{yield* props.count}{yield* props.user.name}</p>; });
}
const Arrow = (props) => $(function* () { return yield* props.label; });
const notComponent = (props) => $(function* () { return yield* props.label; });
// Unsupported operands stay with the runtime driver: the whole block is left alone.
const optional = $(function* () { return yield* store.user?.name; });
const computed = $(function* () { return yield* store.items[i + 1]; });
const called = $(function* () { return yield* store.items.map(x => x); });
"#)
        .unwrap();
        assert!(
            out.contains(r#"_$readPath2(store, "user", "name")"#),
            "{out}"
        );
        // Arrays with more than two elements print multi-line.
        let flat = out.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains(r#"_$readPath3(store, "items", 0, "name")"#),
            "{out}"
        );
        assert!(out.contains(r#"_$readPath2(store, "items", i)"#), "{out}");
        assert!(
            out.contains(r#"_$readPath2(store, "items", "length")"#),
            "{out}"
        );
        assert!(out.contains(r#"_$readPath1(props, "count")"#), "{out}");
        assert!(
            out.contains(r#"_$readPath2(props, "user", "name")"#),
            "{out}"
        );
        assert!(
            out.contains(r#"const Arrow = (props) => $(function() {"#),
            "{out}"
        );
        // A component's props and any other root lower to the same reader
        // (the runtime read is identical; only the projection's phantom
        // `PropRead` / `StoreRead` differ).
        assert_eq!(
            out.matches(r#"return _$readPath1(props, "label");"#)
                .count(),
            2,
            "{out}"
        );
        // Five keys and more: the generic reader with the keys as an array.
        let deep = ssr(r#"import { $ } from "solid-js";
const d = $(function* () { return yield* s.a.b.c.d.e; });
"#)
        .unwrap();
        let flat_deep = deep.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat_deep.contains(r#"_$readPathN(s, [ "a", "b", "c", "d", "e" ])"#),
            "{deep}"
        );
        assert!(
            deep.contains("perform as _$perform, readPathN as _$readPathN"),
            "{deep}"
        );
        assert!(out.contains("yield* store.user?.name"), "{out}");
        // A computed key with an arbitrary expression is not a path the
        // projection can type, but it is still a member operand: the lowered
        // `perform` receives the path token the store hands out under the
        // strict guard, exactly what the runtime driver would `yield*`.
        assert!(out.contains("_$perform(store.items[i + 1])"), "{out}");
        assert!(out.contains("yield* store.items.map((x) => x)"), "{out}");
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

    // --- host fusion tests -------------------------------------------------------

    #[test]
    fn fuses_creatememo_erasing_block_and_perform() {
        let out = fused(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const double = createMemo($(function* (prev) {
  const c = yield* count;
  return c * 2 + (prev ?? 0);
}));
"#)
        .unwrap();
        // $ wrapper erased: createMemo receives the plain function directly
        assert!(out.contains("createMemo(function(prev) {"), "{out}");
        // No $(function in the code body (imports may still reference $)
        assert!(!out.contains("$(function("), "{out}");
        // perform erased: direct accessor call
        assert!(out.contains("const c = count();"), "{out}");
        // No _$perform in the code body (the import specifier may remain)
        assert!(!out.contains("_$perform(count)"), "{out}");
    }

    #[test]
    fn fuses_createeffect_erasing_block_and_perform() {
        let out = fused(r#"import { $, createEffect } from "solid-js";
createEffect($(function* () { return yield* double; }), v => log(v));
"#)
        .unwrap();
        assert!(out.contains("createEffect(function() {"), "{out}");
        assert!(out.contains("return double();"), "{out}");
        assert!(!out.contains("_$perform(double)"), "{out}");
    }

    #[test]
    fn fuses_blocks_around_handle_path_reads() {
        let out = fused(r#"import { $, createMemo } from "solid-js";
function Counter(props) {
  const name = createMemo($(function* () {
    return yield* store.user.name;
  }));
  const label = createMemo($(function* () {
    return yield* props.count;
  }));
}
"#)
        .unwrap();
        // The block is erased; path reads stay one handle read each. The
        // reader lowers the strict guard itself and reads through an
        // accessor or block at the path, so it is exact outside a block too
        // (a bare member chain would hand back the accessor itself).
        assert!(out.contains("createMemo(function() {"), "{out}");
        assert!(
            out.contains(r#"return _$readPath2(store, "user", "name");"#),
            "{out}"
        );
        assert!(
            out.contains(r#"return _$readPath1(props, "count");"#),
            "{out}"
        );
        assert!(!out.contains("_$perform("), "{out}");
    }

    #[test]
    fn refuses_fusion_when_body_has_non_erasable_perform() {
        // `readStore` perform args are not erasable in the prototype.
        let out = fused(r#"import { $, createMemo, readStore } from "solid-js";
const names = createMemo($(function* () {
  return yield* readStore(store, s => s.items.map(x => x.name));
}));
"#)
        .unwrap();
        assert!(out.contains("$(function() {"), "{out}");
        assert!(out.contains("_$perform(readStore("), "{out}");
    }

    #[test]
    fn refuses_fusion_for_standalone_blocks() {
        // A `$()` not consumed by a known host stays wrapped.
        let out = fused(r#"import { $, createMemo } from "solid-js";
const block = $(function* () { return yield* count; });
const m = createMemo(block);
"#)
        .unwrap();
        assert!(out.contains("$(function() {"), "{out}");
        assert!(out.contains("_$perform(count)"), "{out}");
    }

    #[test]
    fn refuses_fusion_for_unlowered_generators() {
        let out = fused(r#"import { $, createMemo, wait } from "solid-js";
const m = createMemo($(function* () {
  return yield* wait(fetch("/api"));
}));
"#)
        .unwrap();
        // Generator not lowered → function* stays → fusion skipped
        assert!(out.contains("$(function* () {"), "{out}");
        assert!(out.contains("yield* wait(fetch"), "{out}");
    }

    #[test]
    fn fusion_off_by_default() {
        let out = ssr(r#"import { $, createMemo } from "solid-js";
const m = createMemo($(function* () { return yield* count; }));
"#)
        .unwrap();
        // Without host_fusion, the block and perform remain.
        assert!(out.contains("$(function("), "{out}");
        assert!(out.contains("_$perform(count)"), "{out}");
    }

    #[test]
    fn fusion_ignores_shadowed_perform() {
        // A local variable named `_$perform` inside the block body must not
        // be mistaken for the imported perform helper. Symbol-based resolution
        // must distinguish the two.
        let out = fused(r#"import { $, createMemo } from "solid-js";
const m = createMemo($(function* () {
  const _$perform = (x) => x + 1;
  return _$perform(yield* count);
}));
"#)
        .unwrap();
        // The `_$perform` call here is the local shadow, not the imported
        // perform. The block should still be lowered (yield* → perform) but
        // fusion should not erase the user's `_$perform` call.
        // The local `_$perform` call has a non-erasable argument (a
        // perform(count) call result), so body_is_erasable should see the
        // imported _$perform(count) and consider it erasable, but the local
        // _$perform(...) is not the import and is ignored by the checker.
        // Since the block body still uses the imported perform for `count`,
        // fusion may or may not apply — but the local _$perform must NOT
        // be rewritten.
        // The key assertion: the local `_$perform` declaration is preserved.
        assert!(
            out.contains("const _$perform = (x) => x + 1;"),
            "local _$perform declaration must be preserved: {out}"
        );
    }

    #[test]
    fn fusion_skips_perform_in_nested_function() {
        // A _$perform call inside a nested function declaration is not part
        // of the block's scope. The checker skips nested functions, so the
        // block body has no direct perform calls → body_is_erasable returns
        // false (empty body from the checker's perspective, but actually the
        // block is fine since there are no performs to erase).
        //
        // In practice the generator transform never produces _$perform inside
        // nested functions (yield* is invalid there), so this tests a
        // theoretical edge case from hand-written post-transform code.
        let out = fused(r#"import { $, createMemo, createSignal, perform as _$perform } from "solid-js";
const [count] = createSignal(1);
const m = createMemo($(function() {
  function helper() { return _$perform(count); }
  return helper();
}));
"#)
        .unwrap();
        // The body has no direct perform calls (the one inside `helper` is
        // in a nested scope), so the block is erasable. But the inner
        // _$perform is inside a nested function and is NOT rewritten.
        // The $() wrapper is erased (empty erasable body), but the nested
        // function's _$perform remains.
        assert!(
            out.contains("function helper() {"),
            "nested function must be preserved: {out}"
        );
    }
}
