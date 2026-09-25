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
//!
//! # Host fusion (experimental, `host_fusion`)
//!
//! A lowered block that is the direct argument of a reactive host
//! (`createMemo($(fn))`) can additionally be erased into the host's own
//! compute function — `createMemo(fn)` with `count()` for `_$perform(count)`
//! — when every operation in its body is proven from its declaration. See
//! `fuse_host_blocks` below for the proof obligations and the refusals.

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, CallExpression, Expression, Function,
    IdentifierReference, ImportDeclarationSpecifier, ImportOrExportKind, Program, Statement,
    ThrowStatement, VariableDeclarationKind, YieldExpression,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::identifier::is_identifier_name;
use oxc_syntax::scope::ScopeFlags;

use crate::block_proofs::{BLOCK_SYNC, ProofSymbols, Prover};
use crate::shared::ast::{argument_to_expression, expression_to_argument};
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
    proofs: Option<ProofConfig>,
) -> Result<(), String> {
    if !imports_adapter(program) {
        return Ok(());
    }
    let plan = build_plan(program, source, proofs)?;
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
    /// Track A block proofs: `$` call span → metadata flags, appended as
    /// `$(fn, flags)`.
    block_flags: Vec<(Span, u32)>,
    /// Reactive host calls that receive proven host options, appended as the
    /// host's options argument.
    host_options: Vec<(Span, HostOption)>,
}

/// Track A (stage 1) proof configuration: the pass proves `$` blocks
/// synchronous / non-throwing and annotates blocks and synchronous hosts. See
/// `block_proofs.rs`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ProofConfig {
    /// TypeScript source: primitive signal domains are trusted.
    pub(crate) typed: bool,
    /// Intrinsic JSX elements evaluate to plain nodes (DOM and SSR output).
    pub(crate) jsx_plain: bool,
}

/// The options a proven host call receives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HostOption {
    /// `sync: true` — the async-shape probe is skipped.
    SyncOnly,
}

const SYNC_ONLY_LOCAL: &str = "_$syncOnly";

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
    /// Reactive hosts whose first argument is a compute (proof annotation):
    /// `createMemo` / `createSignal` take `(fn, options)`, `createEffect` /
    /// `createRenderEffect` take `(fn, effect, options)`.
    pub(crate) one_arg_hosts: Vec<SymbolId>,
    pub(crate) two_arg_hosts: Vec<SymbolId>,
    pub(crate) create_signal: Vec<SymbolId>,
    pub(crate) create_memo: Vec<SymbolId>,
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
                "createMemo" => {
                    symbols.one_arg_hosts.push(symbol_id);
                    symbols.create_memo.push(symbol_id);
                }
                "createSignal" => {
                    symbols.one_arg_hosts.push(symbol_id);
                    symbols.create_signal.push(symbol_id);
                }
                "createEffect" | "createRenderEffect" => symbols.two_arg_hosts.push(symbol_id),
                _ => {}
            }
        }
    }
    symbols
}

fn build_plan(
    program: &Program<'_>,
    source: &str,
    proofs: Option<ProofConfig>,
) -> Result<Plan, String> {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();

    let symbols = collect_runtime_symbols(program);
    if symbols.adapter.is_empty() {
        return Ok(Plan::default());
    }
    let prover = proofs.map(|config| {
        Prover::new(
            scoping,
            semantic.nodes(),
            ProofSymbols {
                create_signal: symbols.create_signal.clone(),
                create_memo: symbols.create_memo.clone(),
                adapter: symbols.adapter.clone(),
            },
            config.typed,
            config.jsx_plain,
        )
    });

    struct Collector<'s> {
        scoping: &'s Scoping,
        symbols: &'s RuntimeSymbols,
        source: &'s str,
        plan: Plan,
        error: Option<String>,
        prover: Option<Prover<'s>>,
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
            // Post-order: the block argument was proven by the walk above.
            if self.prover.is_some() {
                self.annotate_host(call);
            }
        }
    }

    impl Collector<'_> {
        /// `HOST($(fn*))` with the host's exact compute arity and a proven
        /// block: pass the proven host options. A host that already has an
        /// options argument keeps its own (refused, not merged).
        fn annotate_host(&mut self, call: &CallExpression<'_>) {
            let Some(host) = resolve_callee(self.scoping, call) else {
                return;
            };
            let arity = if self.symbols.one_arg_hosts.contains(&host) {
                1
            } else if self.symbols.two_arg_hosts.contains(&host) {
                2
            } else {
                return;
            };
            if call.arguments.len() != arity {
                return;
            }
            let Some(Argument::CallExpression(block)) = call.arguments.first() else {
                return;
            };
            let Some(&(_, flags)) = self
                .plan
                .block_flags
                .iter()
                .find(|(span, _)| *span == block.span)
            else {
                return;
            };
            let option = if flags & BLOCK_SYNC != 0 {
                HostOption::SyncOnly
            } else {
                return;
            };
            self.plan.host_options.push((call.span, option));
        }

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
                if let Some(prover) = self.prover.as_mut() {
                    let proof = prover.prove(call, function);
                    if proof.flags != 0 {
                        self.plan.block_flags.push((call.span, proof.flags));
                    }
                }
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
        prover,
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
            let options = |wanted| self.plan.host_options.iter().any(|(_, o)| *o == wanted);
            if options(HostOption::SyncOnly) {
                needed.push(("syncOnly", SYNC_ONLY_LOCAL));
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
                // Track A: `$(fn, flags)` — the proven block metadata.
                if let Some(&(_, flags)) = self
                    .plan
                    .block_flags
                    .iter()
                    .find(|(span, _)| *span == call.span)
                {
                    let literal = ast.expression_numeric_literal(
                        Span::new(0, 0),
                        f64::from(flags),
                        None,
                        oxc_syntax::number::NumberBase::Decimal,
                    );
                    call.arguments
                        .push(crate::shared::ast::expression_to_argument(literal));
                }
            }
            Expression::CallExpression(call)
                if let Some(&(_, option)) = self
                    .plan
                    .host_options
                    .iter()
                    .find(|(span, _)| *span == call.span) =>
            {
                // Track A: every proven synchronous host uses the retained
                // shape-probe fast path; the measured-negative status-free
                // recompute is never compiler-selected.
                let local = match option {
                    HostOption::SyncOnly => SYNC_ONLY_LOCAL,
                };
                let options = ast.expression_identifier(Span::new(0, 0), ast.ident(local));
                call.arguments
                    .push(crate::shared::ast::expression_to_argument(options));
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
// Host fusion (experimental, `host_fusion`): erase a lowered `$()` into the
// reactive host that consumes it
// ---------------------------------------------------------------------------
//
// After `transform_generators`, a block consumed *directly* by a reactive
// host —
//
// ```js
// createMemo($(function (prev) { const c = _$perform(count); return c * 2; }));
// ```
//
// — still pays for machinery the host never uses: the block wrapper (its
// per-run host/guard/token bookkeeping and result-shape probes) and one
// `perform` dispatch per read. When the compiler can *prove* what every
// operation in the body is, the same computation is emitted the way it would
// be hand-written:
//
// ```js
// createMemo(function (prev) { const c = count(); return c * 2; });
// ```
//
// # What is proven, and what each erasure relies on
//
// `perform(x)` is a dispatch on the runtime shape of `x` (accessor, block,
// path token, operation object). The fusion never guesses that shape; it
// erases only operands whose shape follows from their declaration in the
// same module (resolved by symbol, so shadowing and aliases are respected):
//
// - `_$perform(acc)` → `acc()` when `acc` is a `const` binding of the
//   accessor a runtime factory returns: `const [acc] = createSignal(…)` /
//   `createOptimistic(…)`, or `const acc = createMemo(…)`. For an accessor,
//   `perform` is `readGuarded(acc)`, and inside a computation the strict
//   guard is already down (the core lowers it for every run), so the call is
//   the read. Anything else — an import, a parameter, a `let`, a hook result,
//   an alias of a store path, an operation held in a variable — is refused:
//   the runtime dispatch is what gives those their meaning.
// - `_$perform(_$readPath(root, ["a", 0, k]))` (and `_$readProp`) →
//   `_$readValue(root.a[0][k])`. The member chain *is* the tracked walk the
//   path op performs (the same property reads, in the same order, through
//   the real store proxy or the props getters — no path tokens exist with
//   the guard down). `readValue` keeps the one part of the op the chain
//   cannot express: reading *through* an accessor or block found at the
//   path (`yield* props.filter` with `filter: SourceAccessor<Filter>` is a
//   `Filter`), under the reactive host the erased block ran as. Erasing to
//   the bare chain would hand back the accessor itself — a silent type
//   change — so the helper stays.
// - `_$perform(_$readStore(store, selector))` → `selector(store)`. A store
//   read is one selector invocation with the guard down; that is the whole
//   operation.
//
// The `$` wrapper itself is erased only when *every* `perform` in the body
// is erased, so no operation is left to run under an ambient host: the
// erased body has no host-dependent step. Read-kind operations are admitted
// by every host; the reactive host's one refusal (`write`) never arises
// because a `write` operand is not erasable.
//
// # Refusals (the block is left exactly as lowered)
//
// - any `perform` whose operand is not one of the three shapes above, or a
//   `perform` inside a nested function or arrow (a callback runs under
//   whatever is ambient when it is called — the wrapper is what pins it);
// - a direct accessor call `acc()` in the body, or a member access on a
//   store the body also reads by path (or a proven store binding): the
//   runtime reports those violations (`[DIRECT_READ_IN_BLOCK]`,
//   `[UNREAD_PATH]`); erasing the wrapper would silently admit them, and the
//   pass never turns a visible violation into an allowed read;
// - a `function` body that uses `this` or `arguments`: `$` calls the body as
//   a plain function while a host invokes its compute as a method of the
//   node, so only an erased body could observe the difference;
// - a block that is not the first argument of a known host, a block whose
//   body is still a generator (it waits), a host or `$` that does not
//   resolve to the runtime import.
//
// What the erased wrapper no longer does — documented, not hidden: it no
// longer raises the dev-only strict guard for the body (a hidden read inside
// an opaque helper called from the body is tracked instead of reported), no
// longer probes the body's result for iterator shape (a body returning an
// iterator object is handed to the host as a value instead of being driven),
// and no longer raises `[UNREAD_PATH]` for store accesses the compiler could
// not see. Each is a compat-mode runtime diagnostic for spellings the strict
// contract forbids; behavior for conforming code is unchanged.
//
// Nested hosts (`createMemo($(… const m = createMemo($(…)) … yield* m …))`)
// fuse bottom-up: a pass fuses the innermost erasable blocks (an unfused
// inner block still contains `perform` calls, which refuse its parent), and
// the next pass re-examines the parents. Finally the generated import
// specifiers that no longer have a reference are dropped and `readValue`
// is imported when a path read was erased.

/// Reactive hosts whose first argument is the compute function: each runs the
/// block as `fn(prev)` under the reactive host (`Writes` refused).
const FUSION_HOSTS: &[&str] = &["createMemo", "createEffect", "createRenderEffect", "createSignal"];
/// The local name of the fused path read (`readValue`).
const READ_VALUE_LOCAL: &str = "_$readValue";
/// Bound on bottom-up passes over nested hosts. Real nesting is shallow; the
/// cap only bounds a pathological input.
const MAX_FUSION_PASSES: usize = 8;

/// Fuse every provably erasable `HOST($(fn))` in `program`. Runs after
/// `transform_generators` (the bodies it inspects are in call form) and
/// before JSX lowering. Never fails: a block that cannot be proven is left
/// exactly as lowered.
pub(crate) fn fuse_host_blocks<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    _source: &'a str,
) -> Result<(), String> {
    if !imports_adapter(program) {
        return Ok(());
    }
    let mut fused = false;
    let mut needs_read_value = false;
    for _ in 0..MAX_FUSION_PASSES {
        let plan = build_fusion_plan(program);
        if plan.blocks.is_empty() {
            break;
        }
        fused = true;
        needs_read_value |= !plan.path_reads.is_empty();
        let mut rewriter = FusionRewriter { allocator, plan };
        rewriter.visit_program(program);
    }
    if fused {
        finish_fusion_imports(allocator, program, needs_read_value);
    }
    Ok(())
}

/// Runtime import bindings the fusion resolves by symbol.
#[derive(Default)]
struct FusionSymbols {
    /// `$`.
    adapter: Vec<SymbolId>,
    /// `createMemo` / `createEffect` / `createRenderEffect` / `createSignal`.
    hosts: Vec<SymbolId>,
    /// `perform` (the generator pass's `_$perform`, or a user import).
    perform: Vec<SymbolId>,
    /// `readPath` and `readProp`: one tracked walk plus read-through.
    read_path: Vec<SymbolId>,
    /// `readStore`: one selector invocation.
    read_store: Vec<SymbolId>,
    /// Factories whose tuple element 0 is an accessor: `createSignal`,
    /// `createOptimistic`.
    accessor_tuples: Vec<SymbolId>,
    /// Factories whose value is an accessor: `createMemo`.
    accessor_values: Vec<SymbolId>,
    /// Factories whose tuple element 0 is a store proxy: `createStore`,
    /// `createOptimisticStore`.
    store_tuples: Vec<SymbolId>,
    /// Factories whose value is a store proxy: `createProjection`.
    store_values: Vec<SymbolId>,
}

fn collect_fusion_symbols(program: &Program<'_>) -> FusionSymbols {
    let mut symbols = FusionSymbols::default();
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
            let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                continue;
            };
            let Some(symbol) = specifier.local.symbol_id.get() else {
                continue;
            };
            let name = specifier.imported.name();
            let name = name.as_str();
            if FUSION_HOSTS.contains(&name) {
                symbols.hosts.push(symbol);
            }
            match name {
                "$" => symbols.adapter.push(symbol),
                "perform" => symbols.perform.push(symbol),
                "readPath" | "readProp" => symbols.read_path.push(symbol),
                "readStore" => symbols.read_store.push(symbol),
                _ => {}
            }
            match name {
                "createSignal" | "createOptimistic" => symbols.accessor_tuples.push(symbol),
                "createMemo" => symbols.accessor_values.push(symbol),
                "createStore" | "createOptimisticStore" => symbols.store_tuples.push(symbol),
                "createProjection" => symbols.store_values.push(symbol),
                _ => {}
            }
        }
    }
    symbols
}

/// What a binding is proven to hold, from its declaration.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Origin {
    /// A signal accessor: `const [x] = createSignal(…)`, `const x = createMemo(…)`.
    Accessor,
    /// A store proxy: `const [s] = createStore(…)`, `const s = createProjection(…)`.
    Store,
    /// Anything the pass cannot prove.
    Other,
}

struct FusionContext<'s> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'s>,
    symbols: FusionSymbols,
}

impl FusionContext<'_> {
    fn reference_symbol(&self, reference: &IdentifierReference<'_>) -> Option<SymbolId> {
        reference
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
    }

    /// The origin of a binding: a `const` declarator whose initializer is a
    /// direct call to a runtime factory, with the symbol bound either as the
    /// whole value or as element 0 of an array pattern — nothing else.
    fn binding_origin(&self, symbol: SymbolId) -> Origin {
        let mut node_id = self.scoping.symbol_declaration(symbol);
        // The binder records the declarator for every name it binds; walk up
        // from a binding identifier to be safe against either convention.
        let declarator = loop {
            match self.nodes.get_node(node_id).kind() {
                AstKind::VariableDeclarator(declarator) => break declarator,
                AstKind::BindingIdentifier(_) | AstKind::ArrayPattern(_) => {
                    let parent = self.nodes.parent_id(node_id);
                    if parent == node_id {
                        return Origin::Other;
                    }
                    node_id = parent;
                }
                _ => return Origin::Other,
            }
        };
        let parent = self.nodes.parent_id(node_id);
        if parent == node_id
            || !matches!(
                self.nodes.get_node(parent).kind(),
                AstKind::VariableDeclaration(declaration)
                    if declaration.kind == VariableDeclarationKind::Const
            )
        {
            return Origin::Other;
        }
        let tuple = match &declarator.id {
            BindingPattern::BindingIdentifier(id) if id.symbol_id.get() == Some(symbol) => false,
            BindingPattern::ArrayPattern(pattern) => match pattern.elements.first() {
                Some(Some(BindingPattern::BindingIdentifier(id)))
                    if id.symbol_id.get() == Some(symbol) =>
                {
                    true
                }
                _ => return Origin::Other,
            },
            _ => return Origin::Other,
        };
        let Some(Expression::CallExpression(init)) = &declarator.init else {
            return Origin::Other;
        };
        let Some(factory) = resolve_callee(self.scoping, init) else {
            return Origin::Other;
        };
        let symbols = &self.symbols;
        if tuple {
            if symbols.accessor_tuples.contains(&factory) {
                Origin::Accessor
            } else if symbols.store_tuples.contains(&factory) {
                Origin::Store
            } else {
                Origin::Other
            }
        } else if symbols.accessor_values.contains(&factory) {
            Origin::Accessor
        } else if symbols.store_values.contains(&factory) {
            Origin::Store
        } else {
            Origin::Other
        }
    }
}

/// One pass's rewrites, all keyed by the span of the node they replace.
#[derive(Default)]
struct FusionPlan {
    /// `$(fn)` → `fn`.
    blocks: Vec<Span>,
    /// `_$perform(acc)` → `acc()`.
    accessor_calls: Vec<Span>,
    /// `_$perform(_$readPath(root, [keys]))` → `_$readValue(root.k…)`.
    path_reads: Vec<Span>,
    /// `_$perform(_$readStore(store, selector))` → `selector(store)`.
    store_reads: Vec<Span>,
}

fn build_fusion_plan(program: &Program<'_>) -> FusionPlan {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let symbols = collect_fusion_symbols(program);
    if symbols.adapter.is_empty() || symbols.hosts.is_empty() {
        return FusionPlan::default();
    }
    let context = FusionContext {
        scoping: semantic.scoping(),
        nodes: semantic.nodes(),
        symbols,
    };

    struct Collector<'s> {
        context: &'s FusionContext<'s>,
        plan: FusionPlan,
    }

    impl<'b> Visit<'b> for Collector<'_> {
        fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
            if let Some(block) = self.host_block(call) {
                let mut check = BodyCheck::new(self.context, block);
                check.run();
                if check.ok {
                    self.plan.blocks.push(block.span);
                    self.plan.accessor_calls.extend(check.accessor_calls);
                    self.plan.path_reads.extend(check.path_reads);
                    self.plan.store_reads.extend(check.store_reads);
                }
            }
            walk::walk_call_expression(self, call);
        }
    }

    impl<'s> Collector<'s> {
        /// `HOST($(fn), …)` with `fn` in call form: the `$` call.
        fn host_block<'b>(&self, call: &'b CallExpression<'b>) -> Option<&'b CallExpression<'b>> {
            let context = self.context;
            let host = resolve_callee(context.scoping, call)?;
            if !context.symbols.hosts.contains(&host) {
                return None;
            }
            let Some(Argument::CallExpression(block)) = call.arguments.first() else {
                return None;
            };
            let adapter = resolve_callee(context.scoping, block)?;
            // `$(fn)`, or `$(fn, flags)` with the proof pass's metadata
            // literal (the host keeps the proof as its options argument).
            let flags_ok = match block.arguments.len() {
                1 => true,
                2 => matches!(block.arguments[1], Argument::NumericLiteral(_)),
                _ => false,
            };
            if !context.symbols.adapter.contains(&adapter) || !flags_ok {
                return None;
            }
            match &block.arguments[0] {
                Argument::FunctionExpression(function) => {
                    (!function.generator && !function.r#async && function.body.is_some())
                        .then_some(block)
                }
                Argument::ArrowFunctionExpression(arrow) => (!arrow.r#async).then_some(block),
                _ => None,
            }
        }
    }

    let mut collector = Collector {
        context: &context,
        plan: FusionPlan::default(),
    };
    collector.visit_program(program);
    collector.plan
}

/// Erasability of one block body (the sole argument of a `$` call).
struct BodyCheck<'s, 'b> {
    context: &'s FusionContext<'s>,
    block: &'b CallExpression<'b>,
    /// The body is an arrow: `this` and `arguments` are lexical either way.
    arrow: bool,
    /// Depth inside nested functions of any kind; `perform` must be at 0.
    depth: usize,
    /// Depth inside nested `function`s only (arrows keep `this`).
    function_depth: usize,
    ok: bool,
    accessor_calls: Vec<Span>,
    path_reads: Vec<Span>,
    store_reads: Vec<Span>,
    /// Roots of erased path reads, by symbol.
    path_roots: Vec<SymbolId>,
    /// Identifiers the body accesses a member of (depth 0), by symbol.
    member_roots: Vec<SymbolId>,
}

impl<'s, 'b> BodyCheck<'s, 'b> {
    fn new(context: &'s FusionContext<'s>, block: &'b CallExpression<'b>) -> Self {
        Self {
            context,
            block,
            arrow: matches!(block.arguments[0], Argument::ArrowFunctionExpression(_)),
            depth: 0,
            function_depth: 0,
            ok: true,
            accessor_calls: Vec::new(),
            path_reads: Vec::new(),
            store_reads: Vec::new(),
            path_roots: Vec::new(),
            member_roots: Vec::new(),
        }
    }

    fn run(&mut self) {
        match &self.block.arguments[0] {
            Argument::FunctionExpression(function) => {
                if let Some(body) = function.body.as_ref() {
                    self.visit_function_body(body);
                }
            }
            Argument::ArrowFunctionExpression(arrow) => self.visit_arrow_function_body(&arrow.body),
            _ => self.ok = false,
        }
        if !self.ok {
            return;
        }
        // A member access on a store the body reads by path (`if (store.flag)`
        // beside `yield* store.x`) or on a proven store binding: with the
        // wrapper, the access is a path token the run never reads
        // (`[UNREAD_PATH]`); erased, it would be a silent tracked read.
        for &root in &self.member_roots {
            if self.path_roots.contains(&root)
                || self.context.binding_origin(root) == Origin::Store
            {
                self.ok = false;
                return;
            }
        }
    }

    /// Classify one `perform` at depth 0. Returns false when the operand is
    /// not erasable (the caller then refuses the block).
    fn classify_perform(&mut self, call: &CallExpression<'b>) -> bool {
        if call.arguments.len() != 1 {
            return false;
        }
        let context = self.context;
        match &call.arguments[0] {
            Argument::Identifier(accessor) => {
                let proven = context
                    .reference_symbol(accessor)
                    .is_some_and(|symbol| context.binding_origin(symbol) == Origin::Accessor);
                if proven {
                    self.accessor_calls.push(call.span);
                }
                proven
            }
            Argument::CallExpression(inner) => {
                let Some(op) = resolve_callee(context.scoping, inner) else {
                    return false;
                };
                if context.symbols.read_path.contains(&op) {
                    // `_$readPath(root, ["a", 0, k])` as the generator pass emits it.
                    if inner.arguments.len() != 2 {
                        return false;
                    }
                    let (Argument::Identifier(root), Argument::ArrayExpression(keys)) =
                        (&inner.arguments[0], &inner.arguments[1])
                    else {
                        return false;
                    };
                    let literal_keys = keys.elements.iter().all(|key| {
                        matches!(
                            key,
                            ArrayExpressionElement::StringLiteral(_)
                                | ArrayExpressionElement::NumericLiteral(_)
                                | ArrayExpressionElement::Identifier(_)
                        )
                    });
                    if !literal_keys {
                        return false;
                    }
                    if let Some(symbol) = context.reference_symbol(root) {
                        self.path_roots.push(symbol);
                    }
                    self.path_reads.push(call.span);
                    true
                } else if context.symbols.read_store.contains(&op) {
                    // `_$readStore(store, selector)`: both operands must be
                    // side-effect free so `selector(store)` evaluates them in
                    // either order — an identifier or member chain, and an
                    // identifier or inline function. The selector body is
                    // checked like any nested function (no `perform`).
                    if inner.arguments.len() != 2 {
                        return false;
                    }
                    let store = match &inner.arguments[0] {
                        Argument::Identifier(_) => true,
                        Argument::StaticMemberExpression(_)
                        | Argument::ComputedMemberExpression(_) => {
                            member_chain_root(inner.arguments[0].to_expression()).is_some()
                        }
                        _ => false,
                    };
                    if !store {
                        return false;
                    }
                    match &inner.arguments[1] {
                        Argument::Identifier(_) => {}
                        Argument::ArrowFunctionExpression(arrow) => {
                            self.visit_arrow_function_expression(arrow);
                        }
                        Argument::FunctionExpression(function) => {
                            self.visit_function(function, ScopeFlags::Function);
                        }
                        _ => return false,
                    }
                    if !self.ok {
                        return false;
                    }
                    self.store_reads.push(call.span);
                    true
                } else {
                    false
                }
            }
            _ => false,
        }
    }
}

impl<'b> Visit<'b> for BodyCheck<'_, 'b> {
    fn visit_function(&mut self, it: &Function<'b>, flags: ScopeFlags) {
        self.depth += 1;
        self.function_depth += 1;
        walk::walk_function(self, it, flags);
        self.depth -= 1;
        self.function_depth -= 1;
    }

    fn visit_arrow_function_expression(&mut self, it: &oxc_ast::ast::ArrowFunctionExpression<'b>) {
        self.depth += 1;
        walk::walk_arrow_function_expression(self, it);
        self.depth -= 1;
    }

    fn visit_this_expression(&mut self, _it: &oxc_ast::ast::ThisExpression) {
        // `$` calls the body as a plain function; a host calls its compute as
        // a method of the node. Only a `function` body could tell.
        if !self.arrow && self.function_depth == 0 {
            self.ok = false;
        }
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'b>) {
        if it.name == "arguments" && !self.arrow && self.function_depth == 0 {
            self.ok = false;
        }
    }

    fn visit_member_expression(&mut self, it: &oxc_ast::ast::MemberExpression<'b>) {
        if self.depth == 0
            && let Expression::Identifier(root) = it.object()
            && let Some(symbol) = self.context.reference_symbol(root)
        {
            self.member_roots.push(symbol);
        }
        walk::walk_member_expression(self, it);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        if !self.ok {
            return;
        }
        if let Some(symbol) = resolve_callee(self.context.scoping, call) {
            if self.context.symbols.perform.contains(&symbol) {
                // The operand's sub-expressions were examined by the
                // classification; nothing else in a `perform` is walked.
                if self.depth != 0 || !self.classify_perform(call) {
                    self.ok = false;
                }
                return;
            }
            // A direct `acc()` in the body: the violation the strict scope
            // reports in dev (`[DIRECT_READ_IN_BLOCK]`).
            if self.depth == 0 && self.context.binding_origin(symbol) == Origin::Accessor {
                self.ok = false;
                return;
            }
        }
        walk::walk_call_expression(self, call);
    }
}

struct FusionRewriter<'a> {
    allocator: &'a Allocator,
    plan: FusionPlan,
}

impl<'a> VisitMut<'a> for FusionRewriter<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::CallExpression(call) = expression {
            let span = call.span;
            let plan = &self.plan;
            let planned = plan.blocks.contains(&span)
                || plan.accessor_calls.contains(&span)
                || plan.path_reads.contains(&span)
                || plan.store_reads.contains(&span);
            if planned {
                let ast = AstBuilder::new(self.allocator);
                let placeholder = ast.expression_null_literal(Span::new(0, 0));
                let Expression::CallExpression(call) = std::mem::replace(expression, placeholder)
                else {
                    unreachable!("matched above");
                };
                let call = call.unbox();
                // The operand is the first argument (a `$` call may carry a
                // trailing metadata literal, which erasure drops).
                let argument = call
                    .arguments
                    .into_iter()
                    .next()
                    .expect("planned: an operand argument");
                *expression = if plan.blocks.contains(&span) {
                    // `$(fn)` → `fn`
                    argument_to_expression(argument).expect("planned: a function")
                } else if plan.accessor_calls.contains(&span) {
                    // `_$perform(acc)` → `acc()`
                    let accessor = argument_to_expression(argument).expect("planned: an identifier");
                    ast.expression_call(span, accessor, None, ast.vec(), false)
                } else if plan.path_reads.contains(&span) {
                    // `_$perform(_$readPath(root, ["a", 0, k]))` → `_$readValue(root.a[0][k])`
                    let Argument::CallExpression(op) = argument else {
                        unreachable!("planned: a path op");
                    };
                    let mut op = op.unbox();
                    let Some(Argument::ArrayExpression(keys)) = op.arguments.pop() else {
                        unreachable!("planned: literal keys");
                    };
                    let root = argument_to_expression(op.arguments.pop().expect("planned: a root"))
                        .expect("planned: an identifier");
                    let chain = member_chain_from_keys(&ast, root, keys.unbox());
                    ast.expression_call(
                        span,
                        ast.expression_identifier(span, ast.ident(READ_VALUE_LOCAL)),
                        None,
                        ast.vec1(expression_to_argument(chain)),
                        false,
                    )
                } else {
                    // `_$perform(_$readStore(store, selector))` → `selector(store)`
                    let Argument::CallExpression(op) = argument else {
                        unreachable!("planned: a store op");
                    };
                    let mut op = op.unbox();
                    let selector = argument_to_expression(op.arguments.pop().expect("planned"))
                        .expect("planned: a selector");
                    let store = op.arguments.pop().expect("planned: a store");
                    ast.expression_call(span, selector, None, ast.vec1(store), false)
                };
            }
        }
        walk_mut::walk_expression(self, expression);
    }
}

/// `root` followed by one member access per key, as the generator pass spelled
/// them: a string that is an identifier name is a static access, any other
/// string or a number is a computed literal, an identifier is a computed
/// dynamic key. The key nodes are moved, keeping their source text.
fn member_chain_from_keys<'a>(
    ast: &AstBuilder<'a>,
    root: Expression<'a>,
    keys: oxc_ast::ast::ArrayExpression<'a>,
) -> Expression<'a> {
    let synth = Span::new(0, 0);
    let mut chain = root;
    for key in keys.elements {
        chain = match key {
            ArrayExpressionElement::StringLiteral(literal) => {
                if is_identifier_name(&literal.value) {
                    Expression::StaticMemberExpression(ast.alloc_static_member_expression(
                        synth,
                        chain,
                        ast.identifier_name(literal.span, ast.ident(&literal.value)),
                        false,
                    ))
                } else {
                    Expression::ComputedMemberExpression(ast.alloc_computed_member_expression(
                        synth,
                        chain,
                        Expression::StringLiteral(literal),
                        false,
                    ))
                }
            }
            ArrayExpressionElement::NumericLiteral(literal) => {
                Expression::ComputedMemberExpression(ast.alloc_computed_member_expression(
                    synth,
                    chain,
                    Expression::NumericLiteral(literal),
                    false,
                ))
            }
            ArrayExpressionElement::Identifier(key) => {
                Expression::ComputedMemberExpression(ast.alloc_computed_member_expression(
                    synth,
                    chain,
                    Expression::Identifier(key),
                    false,
                ))
            }
            _ => unreachable!("planned: string, number or identifier keys"),
        };
    }
    chain
}

/// Import maintenance after fusion: drop the generated specifiers
/// (`_$perform`, `_$readPath`, `_$readProp`) that no longer have a
/// reference, and import `readValue` when a path read was erased.
fn finish_fusion_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    needs_read_value: bool,
) {
    const GENERATED: &[&str] = &[PERFORM_LOCAL, READ_PATH_LOCAL, READ_PROP_LOCAL];
    let unused: Vec<String> = {
        let semantic = SemanticBuilder::new().build(program).semantic;
        let scoping = semantic.scoping();
        program
            .body
            .iter()
            .filter_map(|statement| match statement {
                Statement::ImportDeclaration(import)
                    if RUNTIME_SOURCES.contains(&import.source.value.as_str()) =>
                {
                    Some(import)
                }
                _ => None,
            })
            .flat_map(|import| import.specifiers.iter().flatten())
            .filter_map(|specifier| match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if GENERATED.contains(&specifier.local.name.as_str())
                        && specifier
                            .local
                            .symbol_id
                            .get()
                            .is_some_and(|symbol| scoping.symbol_is_unused(symbol)) =>
                {
                    Some(specifier.local.name.to_string())
                }
                _ => None,
            })
            .collect()
    };
    let ast = AstBuilder::new(allocator);
    let mut added = !needs_read_value;
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str())
            || import.import_kind == ImportOrExportKind::Type
        {
            continue;
        }
        if let Some(specifiers) = import.specifiers.as_mut() {
            specifiers.retain(|specifier| {
                !matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if unused.iter().any(|name| name == specifier.local.name.as_str())
                )
            });
        }
        if !added {
            let span = Span::new(0, 0);
            let specifier = ast.import_declaration_specifier_import_specifier(
                span,
                ast.module_export_name_identifier_name(span, ast.ident("readValue")),
                ast.binding_identifier(span, ast.ident(READ_VALUE_LOCAL)),
                ImportOrExportKind::Value,
            );
            match import.specifiers.as_mut() {
                Some(specifiers) => specifiers.push(specifier),
                None => import.specifiers = Some(ast.vec1(specifier)),
            }
            added = true;
        }
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
"#;
        let out = ssr(source).unwrap();
        assert!(out.contains("yield* wait(fetchUser(id))"), "{out}");
        assert!(out.contains("const id = yield* userId;"), "{out}");
        assert!(out.contains("yield* helper()"), "{out}");
        assert!(out.contains("yield* count?.value"), "{out}");
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

    // --- Track A stage 1: block proofs -----------------------------------------

    fn proven_as(source: &str, filename: &str, host_fusion: bool) -> String {
        compile(
            source,
            &CompileOptions {
                filename: Some(filename.into()),
                generate: Generate::Ssr,
                block_proofs: true,
                host_fusion,
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .unwrap_or_else(|error| panic!("{error}"))
    }

    fn proven(source: &str) -> String {
        proven_as(source, "input.js", false)
    }

    #[test]
    fn proves_total_reads_status_free_and_annotates_the_host() {
        let out = proven(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const isOne = createMemo($(function* () { return (yield* count) === 1; }));
"#,
        );
        assert!(
            out.contains("const isOne = createMemo($(function() {\n\treturn _$perform(count) === 1;\n}, 3), _$statusFree);"),
            "{out}"
        );
        assert!(out.contains("statusFree as _$statusFree"), "{out}");
        assert!(!out.contains("_$syncOnly"), "{out}");
    }

    #[test]
    fn separates_synchrony_from_non_throwing() {
        // `*` coerces an operand of unknown type (a Symbol throws): SYNC only.
        let js = proven(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const double = createMemo($(function* () { return (yield* count) * 2; }));
const same = createMemo($(function* () { return yield* count; }));
"#,
        );
        assert!(
            js.contains("return _$perform(count) * 2;\n}, 1), _$syncOnly)"),
            "{js}"
        );
        // A bare read never throws, but its value could be a Promise in an
        // untyped module: NOTHROW only, so the host is left alone.
        assert!(js.contains("return _$perform(count);\n}, 2))"), "{js}");
        assert!(js.contains("syncOnly as _$syncOnly"), "{js}");

        // TypeScript: `createSignal(1)` holds a number, so both are total.
        let ts = proven_as(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const [label] = createSignal<string>();
const double = createMemo($(function* () { return (yield* count) * 2; }));
const same = createMemo($(function* () { return yield* count; }));
const text = createMemo($(function* () { return `${yield* label}:${yield* count}`; }));
"#,
            "input.ts",
            false,
        );
        assert_eq!(ts.matches("}, 3), _$statusFree)").count(), 3, "{ts}");
    }

    #[test]
    fn chains_through_proven_memos_only() {
        let out = proven(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const isOne = createMemo($(function* () { return (yield* count) === 1; }));
const notOne = createMemo($(function* () { return !(yield* isOne); }));
const loose = createMemo($(function* () { return format(yield* count); }));
const fromLoose = createMemo($(function* () { return !(yield* loose); }));
"#,
        );
        assert!(
            out.contains("return !_$perform(isOne);\n}, 3), _$statusFree)"),
            "{out}"
        );
        // An unknown call proves nothing, and a read of that memo can observe
        // its error status.
        assert!(
            out.contains("return format(_$perform(count));\n}))"),
            "{out}"
        );
        assert!(
            out.contains("return !_$perform(loose);\n}, 1), _$syncOnly)"),
            "{out}"
        );
    }

    #[test]
    fn refuses_bindings_that_may_be_uninitialized() {
        let out = proven(
            r#"import { $, createMemo, createRoot, createSignal } from "solid-js";
import { imported } from "./state";
function early() {
  return createMemo($(function* () { return (yield* late) === 1; }));
}
const [late] = createSignal(1);
function hoisted() {
  return createMemo($(function* () { return (yield* declaredBefore) === 1; }));
}
const [declaredBefore] = createSignal(1);
const viaImport = createMemo($(function* () { return (yield* imported) === 1; }));
const a = createMemo($(function* () { return (yield* declaredBefore) === 1; }));
const inCallback = createRoot(() => createMemo($(function* () { return (yield* declaredBefore) === 1; })));
"#,
        );
        // Declared after the `$` call, inside a hoisted function declaration,
        // or imported: the read may run first — SYNC (`===`) only.
        assert_eq!(out.matches("}, 1), _$syncOnly)").count(), 3, "{out}");
        assert!(out.contains("const a = createMemo($(function() {"), "{out}");
        // Top level, and inside an arrow created after the declaration: the
        // binding is initialized before the block can run.
        assert_eq!(
            out.matches("_$perform(declaredBefore) === 1;\n}, 3), _$statusFree)")
                .count(),
            2,
            "{out}"
        );
    }

    #[test]
    fn refuses_unknown_calls_member_access_and_computations() {
        let out = proven(
            r#"import { $, createMemo, createSignal, createStore } from "solid-js";
const [count] = createSignal(1);
const [derived] = createSignal(() => 1);
const [store] = createStore({ x: 1 });
const call = createMemo($(function* () { const c = yield* count; return helper(c) === 1; }));
const member = createMemo($(function* () { return (yield* count).value === 1; }));
const path = createMemo($(function* () { return (yield* store.x) === 1; }));
const computed = createMemo($(function* () { return (yield* derived) === 1; }));
const loop = createMemo($(function* () { for (const x of []) {} return (yield* count) === 1; }));
"#,
        );
        // Each refuses NOTHROW; `===` keeps SYNC.
        assert_eq!(out.matches("}, 1), _$syncOnly)").count(), 5, "{out}");
        assert!(!out.contains("_$statusFree"), "{out}");
    }

    #[test]
    fn proves_result_shapes_for_synchrony() {
        let out = proven(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const arr = createMemo($(function* () { return [yield* count]; }));
const obj = createMemo($(function* () { return { n: yield* count }; }));
const thenable = createMemo($(function* () { return { then: yield* count }; }));
const spread = createMemo($(function* () { return { ...(yield* count) }; }));
const branch = createMemo($(function* () { if ((yield* count) === 1) return "a"; return null; }));
"#,
        );
        // Arrays and `then`-free object literals are never thenables.
        assert!(
            out.contains("return [_$perform(count)];\n}, 3), _$statusFree)"),
            "{out}"
        );
        assert!(
            out.contains("n: _$perform(count) };\n}, 3), _$statusFree)"),
            "{out}"
        );
        assert!(out.contains("then: _$perform(count) };\n}, 2))"), "{out}");
        assert!(!out.contains("...(_$perform(count)) };\n}, "), "{out}");
        assert!(out.contains("return null;\n}, 3), _$statusFree)"), "{out}");
    }

    #[test]
    fn jsx_blocks_prove_synchrony_only() {
        let out = compile(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
export const view = $(function* () { return <p>{(yield* count) === 1 ? "one" : "other"}</p>; });
export const comp = $(function* () { return <Other value={yield* count} />; });
"#,
            &CompileOptions {
                block_proofs: true,
                ..CompileOptions::default()
            },
        )
        .unwrap()
        .code;
        // An intrinsic element is a node (SYNC); a component returns anything.
        assert!(out.contains("}, 1);"), "{out}");
        assert_eq!(out.matches("}, 1);").count(), 1, "{out}");
    }

    #[test]
    fn annotates_effects_and_respects_existing_options() {
        let out = proven(
            r#"import { $, createMemo, createEffect, createRenderEffect, createSignal } from "solid-js";
const [count] = createSignal(1);
createEffect($(function* () { return (yield* count) === 1; }), v => log(v));
createRenderEffect($(function* () { return (yield* count) === 1; }), v => log(v));
const named = createMemo($(function* () { return (yield* count) === 1; }), { name: "named" });
const [writable] = createSignal($(function* () { return (yield* count) === 1; }));
"#,
        );
        assert_eq!(
            out.matches("(v) => log(v), _$statusFree)").count(),
            2,
            "{out}"
        );
        // A host with its own options keeps them; the block still carries
        // its metadata.
        assert!(out.contains("}, 3), { name: \"named\" })"), "{out}");
        assert!(
            out.contains("const [writable] = createSignal($(function() {"),
            "{out}"
        );
        assert!(out.contains("=== 1;\n}, 3), _$statusFree);\n"), "{out}");
    }

    #[test]
    fn proofs_survive_host_fusion_as_host_options() {
        let out = proven_as(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const isOne = createMemo($(function* () { return (yield* count) === 1; }));
"#,
            "input.js",
            true,
        );
        assert!(
            out.contains(
                "const isOne = createMemo(function() {\n\treturn count() === 1;\n}, _$statusFree);"
            ),
            "{out}"
        );
        assert!(!out.contains("$(function"), "{out}");
    }

    #[test]
    fn proofs_are_off_by_default_and_skip_unlowered_blocks() {
        let off = ssr(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const isOne = createMemo($(function* () { return (yield* count) === 1; }));
"#)
        .unwrap();
        assert!(!off.contains("statusFree"), "{off}");
        assert!(off.contains("=== 1;\n}));"), "{off}");

        let waits = proven(
            r#"import { $, createMemo, createSignal, wait } from "solid-js";
const [count] = createSignal(1);
const later = createMemo($(function* () { return yield* wait(load(yield* count)); }));
"#,
        );
        assert!(waits.contains("yield* wait("), "{waits}");
        assert!(
            !waits.contains("statusFree") && !waits.contains("syncOnly"),
            "{waits}"
        );
    }

    // --- host fusion -----------------------------------------------------------

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

    fn fused_dom(source: &str) -> Result<String, String> {
        compile(
            source,
            &CompileOptions {
                host_fusion: true,
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .map_err(|error| error.to_string())
    }

    #[test]
    fn fuses_reactive_hosts_with_proven_accessors() {
        let out = fused(r#"import { $, createMemo, createEffect, createRenderEffect, createSignal, createOptimistic } from "solid-js";
const [count] = createSignal(1);
const [draft] = createOptimistic(0);
const double = createMemo($(function* (prev) {
  const c = yield* count;
  return c * 2 + (prev ?? 0);
}));
const [total] = createSignal($(function* () { return (yield* double) + (yield* draft); }));
createEffect($(function* () { return `${yield* double} ${yield* total}`; }), v => log(v));
createRenderEffect($(function* () { return yield* count; }), v => log(v));
"#)
        .unwrap();
        assert!(out.contains("const double = createMemo(function(prev) {"), "{out}");
        assert!(out.contains("const c = count();"), "{out}");
        assert!(out.contains("const [total] = createSignal(function() {"), "{out}");
        assert!(out.contains("return double() + draft();"), "{out}");
        assert!(out.contains("createEffect(function() {"), "{out}");
        assert!(out.contains("return `${double()} ${total()}`;"), "{out}");
        assert!(out.contains("createRenderEffect(function() {"), "{out}");
        assert!(!out.contains("$(function"), "{out}");
        // Every `perform` was erased, so the generated specifier is dropped.
        assert!(!out.contains("perform"), "{out}");
        assert!(
            out.contains(
                r#"import { $, createMemo, createEffect, createRenderEffect, createSignal, createOptimistic } from "solid-js";"#
            ),
            "{out}"
        );
    }

    #[test]
    fn fuses_hand_written_call_form_and_arrow_bodies() {
        let out = fused(r#"import { $, createMemo, createSignal, perform } from "solid-js";
const [count] = createSignal(1);
const a = createMemo($(() => perform(count) + 1));
const b = createMemo($(function () { return perform(count); }));
"#)
        .unwrap();
        assert!(out.contains("const a = createMemo(() => count() + 1);"), "{out}");
        assert!(out.contains("const b = createMemo(function() {"), "{out}");
        assert!(out.contains("return count();"), "{out}");
        // The user's own specifier is theirs to keep.
        assert!(out.contains(r#"import { $, createMemo, createSignal, perform } from "solid-js";"#), "{out}");
    }

    #[test]
    fn fuses_blocks_around_handle_path_reads() {
        let out = fused(r#"import { $, createMemo, createStore } from "solid-js";
function Counter(props) {
  const [store] = createStore({ user: { name: "Ada" }, items: [], "data-x": 1 });
  const i = 0;
  const a = createMemo($(function* () { return yield* store.user.name; }));
  const b = createMemo($(function* () { return `${yield* store.items[0].name} ${yield* store.items[i]} ${yield* store.items.length}`; }));
  const c = createMemo($(function* () { return yield* props.count; }));
  const d = createMemo($(function* () { return yield* store["data-x"]; }));
  const e = createMemo($(function* () { return yield* state["label"]; }));
  return [a, b, c, d, e];
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
    fn fuses_store_selectors_to_one_call() {
        let out = fused(r#"import { $, createMemo, readStore } from "solid-js";
const names = createMemo($(function* () { return yield* readStore(store, s => s.items.map(x => x.name)); }));
const sel = s => s.count;
const count = createMemo($(function* () { return yield* readStore(store, sel); }));
const city = createMemo($(function* () { return yield* readStore(store.user, u => u.address.city); }));
"#)
        .unwrap();
        assert!(out.contains("return ((s) => s.items.map((x) => x.name))(store);"), "{out}");
        assert!(out.contains("return sel(store);"), "{out}");
        assert!(out.contains("return ((u) => u.address.city)(store.user);"), "{out}");
        assert!(!out.contains("_$perform"), "{out}");
        assert!(!out.contains("$(function"), "{out}");
        assert!(out.contains(r#"import { $, createMemo, readStore } from "solid-js";"#), "{out}");
    }

    #[test]
    fn fuses_nested_hosts_bottom_up() {
        let out = fused(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const outer = createMemo($(function* () {
  const inner = createMemo($(function* () { return (yield* count) * 2; }));
  return (yield* inner) + 1;
}));
"#)
        .unwrap();
        assert!(out.contains("const outer = createMemo(function() {"), "{out}");
        assert!(out.contains("const inner = createMemo(function() {"), "{out}");
        assert!(out.contains("return count() * 2;"), "{out}");
        assert!(out.contains("return inner() + 1;"), "{out}");
        assert!(!out.contains("perform"), "{out}");
    }

    #[test]
    fn fuses_jsx_returning_memos_ahead_of_jsx_lowering() {
        let out = fused_dom(r#"import { $, createMemo, createSignal } from "solid-js";
function View(props) {
  const [count] = createSignal(1);
  const view = createMemo($(function* () {
    return <p class={yield* props.theme}>{yield* count}</p>;
  }));
  return view;
}
"#)
        .unwrap();
        assert!(out.contains("const view = createMemo(function() {"), "{out}");
        assert!(out.contains("_$readValue(props.theme)"), "{out}");
        assert!(!out.contains("_$perform"), "{out}");
        assert!(!out.contains("$(function"), "{out}");
    }

    #[test]
    fn refuses_operands_it_cannot_prove() {
        let out = fused(r#"import { $, createMemo, createSignal, createStore, readStore } from "solid-js";
import { imported } from "./state";
const [count] = createSignal(1);
let [mutable] = createSignal(1);
const [store] = createStore({ user: { name: "Ada" } });
const hook = useCount();
const fromImport = createMemo($(function* () { return yield* imported; }));
const fromParam = (source) => createMemo($(function* () { return yield* source; }));
const fromLet = createMemo($(function* () { return yield* mutable; }));
const fromHook = createMemo($(function* () { return yield* hook; }));
const aliasedPath = createMemo($(function* () { const u = store.user; return yield* u; }));
const heldOp = createMemo($(function* () { const op = readStore(store, s => s.user.name); return yield* op; }));
const asStore = createMemo($(function* () { return yield* store; }));
const proven = createMemo($(function* () { return yield* count; }));
"#)
        .unwrap();
        for stays in [
            "_$perform(imported)",
            "_$perform(source)",
            "_$perform(mutable)",
            "_$perform(hook)",
            "_$perform(u)",
            "_$perform(op)",
            "_$perform(store)",
        ] {
            assert!(out.contains(stays), "{stays} must stay lowered: {out}");
        }
        assert_eq!(out.matches("$(function() {").count(), 7, "{out}");
        assert!(out.contains("const proven = createMemo(function() {"), "{out}");
        assert!(out.contains("return count();"), "{out}");
        // `perform` is still referenced, so its specifier stays.
        assert!(out.contains("perform as _$perform"), "{out}");
    }

    #[test]
    fn refuses_non_read_operations_and_unlowered_blocks() {
        let out = fused(r#"import { $, createMemo, createSignal, attempt, raise, write, call, wait } from "solid-js";
const [count, setCount] = createSignal(1);
const a = createMemo($(function* () { return yield* attempt(() => JSON.parse(raw), SyntaxError); }));
const b = createMemo($(function* () { if ((yield* count) < 0) yield* raise(new RangeError("negative")); return 1; }));
const c = createMemo($(function* () { yield* write(setCount, 2); return 1; }));
const d = createMemo($(function* () { return yield* call(other, 1); }));
const e = createMemo($(function* () { return yield* store.items[i + 1]; }));
const f = createMemo($(function* () { return yield* wait(fetch("/api")); }));
"#)
        .unwrap();
        assert!(out.contains("_$perform(attempt("), "{out}");
        assert!(out.contains("_$perform(raise("), "{out}");
        assert!(out.contains("_$perform(write("), "{out}");
        assert!(out.contains("_$perform(call("), "{out}");
        assert!(out.contains("_$perform(store.items[i + 1])"), "{out}");
        assert!(out.contains("$(function* () {"), "{out}");
        assert!(out.contains("yield* wait(fetch"), "{out}");
        assert!(!out.contains("createMemo(function"), "{out}");
    }

    #[test]
    fn refuses_visible_violations() {
        let out = fused(r#"import { $, createMemo, createSignal, createStore, perform } from "solid-js";
const [count] = createSignal(1);
const [store] = createStore({ flag: true, x: 1 });
const direct = createMemo($(function* () { const c = count(); return c + (yield* count); }));
const unread = createMemo($(function* () { if (store.flag) return yield* store.x; return 0; }));
const bare = createMemo($(function* () { return store.x + (yield* count); }));
const nested = createMemo($(function* () { return items.map(item => perform(count) + item); }));
const self_ = createMemo($(function* () { return this.total + (yield* count); }));
const args = createMemo($(function* () { return arguments.length + (yield* count); }));
"#)
        .unwrap();
        assert!(!out.contains("createMemo(function"), "{out}");
        assert_eq!(out.matches("$(function() {").count(), 6, "{out}");
        // The user's spellings are untouched, for the runtime to report.
        assert!(out.contains("const c = count();"), "{out}");
        assert!(out.contains("if (store.flag)"), "{out}");
        assert!(out.contains("perform(count) + item"), "{out}");
    }

    #[test]
    fn refuses_unknown_hosts_and_shadowing_and_is_off_by_default() {
        let out = fused(r#"import { $, createMemo, createSignal } from "solid-js";
import { createMemo as otherMemo } from "other-lib";
const [count] = createSignal(1);
const standalone = $(function* () { return yield* count; });
const viaVariable = createMemo(standalone);
const other = otherMemo($(function* () { return yield* count; }));
function local() {
  const createMemo = fn => fn;
  return createMemo($(function* () { return yield* count; }));
}
const second = createMemo(() => 1, $(function* () { return yield* count; }));
"#)
        .unwrap();
        assert_eq!(out.matches("$(function() {").count(), 4, "{out}");
        assert!(!out.contains("createMemo(function"), "{out}");
        assert!(out.contains("perform as _$perform"), "{out}");

        let off = ssr(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const m = createMemo($(function* () { return yield* count; }));
"#)
        .unwrap();
        assert!(off.contains("createMemo($(function() {"), "{off}");
        assert!(off.contains("_$perform(count)"), "{off}");
    }
}
