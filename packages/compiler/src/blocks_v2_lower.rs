//! Generator blocks v2: the lowering of compiled v2 bodies (DOM and SSR
//! output, on by default with the v2 fusion; `hostFusion: false` turns it
//! off). Named "client lowering" historically: it ran on DOM output only
//! until section 11 of `documentation/plans/blocks-v2-performance.md`.
//!
//! After the generator pass has lowered the v2 bodies to call form and the
//! v2 fusion has erased the blocks consumed by reactive hosts, what is left
//! of a compiled `$component` still runs through the block machinery at
//! runtime: every setup creation is an operation object handed to `perform`
//! (host check, dispatch, a guard bracket), a split effect's half is a block
//! run by `runEffectHalf`, and the module imports `$`, which retains the
//! generator driver. This pass removes each of those where the semantics are
//! identical by construction, and leaves anything unproven exactly as lowered.
//!
//! 1. **Setup operations become direct calls.** The compile-time host rules
//!    (`blocks_v2.rs`) already checked what `perform`'s host check verifies,
//!    so in a lowered v2 body (at its own depth — not in a nested callback,
//!    which may run under another host):
//!
//!    | lowered | becomes |
//!    | --- | --- |
//!    | `_$perform($signal(v, o))` | `_$createSignal(v, o)`, or `_$withReceipts(_$createSignal(v, o))` when the setter escapes |
//!    | `_$perform($store(v))` | `_$createPlainStore(v)` / `_$withReceipts(…)` |
//!    | `_$perform(set(x))` of a non-escaping setter | `set(x)` (a setter returns the value its receipt carries) |
//!    | `_$perform($memo(_$$(…), o))` | `_$createMemo(_$$(…), o)` |
//!    | `_$perform($effect(_$$(…), c))` | `_$effectBlock(_$$(…), c)` |
//!    | `_$perform($settled(_$$(…)))` | `_$settledBlock(_$$(…))` |
//!    | `_$perform($cleanup(fn))` | `_$blockCleanup(fn)` |
//!    | `_$perform($flush());` (statement) | `_$flush();` |
//!
//!    The primitives are imported from the module the v2 constructor came
//!    from — `solid-js`'s hydration-aware ones in a `solid-js` app, the ones
//!    `solid-js` registers for blocks. A setter *escapes* when any use of it
//!    is not a call whose result is discarded or `perform`ed (a use the
//!    compiler cannot see may `yield*` the receipt): it keeps its receipts.
//!    The primitives do no reactive read outside their own computations, so
//!    whether the setup's strict guard is up when they are called is not
//!    observable.
//! 2. **Fused effect halves.** `effectBlock(_$$(half, SYNC), compute)` whose
//!    half passes the fusion's body check (no operation left, no visible
//!    violation, no `this` / `arguments`), registers `$cleanup` only as
//!    top-level statements and has no `return`, becomes
//!    `createEffect(compute, half')`: each `_$blockCleanup(fn);` statement
//!    binds `fn`, and the half returns the one cleanup (or a function running
//!    them in order) — exactly what `runEffectHalf` collects and returns.
//! 3. **Erased events and setups.** `$event(_$$(fn, SYNC))` whose body passes
//!    the body check (reads of proven accessors become direct calls) is
//!    `$eventCompiled(fn)`: dispatched as the block was (no owner context,
//!    failures to the nearest boundary) with no block run. A setup
//!    `$component(_$$(fn, SYNC))` with no operation left (nested blocks — its
//!    view, events, memos — are their own bodies) and whose every `return` is
//!    a block is `$componentCompiled(fn)`: the setup runs untracked as a plain
//!    function.
//! 4. **Compiled-only constructors.** A constructor whose argument the
//!    compiler built targets its `…Compiled` entry (`$componentCompiled`,
//!    `$eventCompiled`, `effectBlockCompiled`, `settledBlockCompiled`), which
//!    does not wrap generator bodies. When every `_$$` in the module is a
//!    lowered body proven `BLOCK_SYNC`, `_$$` is imported as `syncBlock`
//!    (the block wrapper without the driver): a module compiled this way does
//!    not retain the generator driver (`drive`, `step`, `settle`, `resume`).
//!
//! 5. **Contexts and helper generators.** In a setup, `_$perform(Ctx)` of a
//!    binding proven to be a context (`const Ctx = createContext(…)` from a
//!    runtime module) is `_$readContext(Ctx)`: `perform` steps the context's
//!    iterator and performs its one context operation, which the host rules
//!    already admitted. A module-local `function*` helper whose every
//!    `yield*` reads a proven context and whose every reference is
//!    `_$perform(helper(…))` directly in a setup becomes a plain function
//!    (`yield* Ctx` → `_$readContext(Ctx)`), called directly.
//! 6. **Async bodies.** A memo / event body the generator pass compiled to an
//!    `async function` (`generators.rs`, "async v2 bodies") is erased like a
//!    synchronous one — `$event(_$$(fn))` → `$eventCompiled(_$asyncBody(fn))`,
//!    `createMemo(_$$(fn))` → `createMemo(_$asyncBody(fn))` — when the same
//!    body check passes; otherwise its generator is restored exactly
//!    (`restore_async_generators`) and the driver runs it as before.
//! 7. **Settled bodies.** `settledBlock(_$$(fn, SYNC))` whose body passes the
//!    effect-half conditions is `onSettled(fn')` with the cleanups returned.
//! 8. **What is left of `perform`.** `_$perform(acc)` of a proven accessor is
//!    `_$readAccessor(acc)`, `_$perform(readStore(s, sel))` is
//!    `_$readSelected(s, sel)` — `perform`'s own result for those operands —
//!    and, after the JSX transform, plain calls where the transform put them
//!    inside a computation (`fuse_computation_reads`).
//!
//! The pass runs identically on DOM and SSR output (same input: the v2 and
//! generator passes, the fusion and the async lowering run on both), so the
//! same blocks are erased on both sides. Hydration ids stay aligned twice
//! over: only SYNC-flagged blocks are erased, and a flagged `$` call passed
//! to `$component` / `$event` is never wrapped in a hydration id scope
//! (`block_scope.rs`; flagged views are, on both sides, as `$` or
//! `syncBlock`), and every primitive is still created in the same order. An
//! erased effect half or settled body, and every async body, has no JSX: a
//! block with JSX is scoped on both sides and never erased. The server's
//! primitives are the ones the operations created with (`solid-js`'
//! server entry registers them as the block primitives): `createEffect(
//! compute, half)` and `effectBlock` both reach the server effect with the
//! compute only, `onSettled` and `settledBlock` both allocate the one id.
//! What stays DOM-only is `fuse_computation_reads` (the server's holes are
//! thunks the renderer may evaluate with the guard up: `readAccessor`).
use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, BindingPattern, CallExpression, Expression, Function, FunctionBody,
    IdentifierReference, ImportDeclarationSpecifier, ImportOrExportKind, Program, ReturnStatement,
    Statement, VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use crate::block_proofs::BLOCK_SYNC;
use crate::blocks_v2::{V2Bodies, V2Kind};
use crate::generators::{
    BodyCheck, FusionContext, FusionPlan, FusionRewriter, Origin, READ_VALUE_LOCAL,
    collect_fusion_symbols,
};
use crate::shared::ast::{argument_to_expression, expression_to_argument};
use crate::shared::ast_builder::AstBuilder;

#[cfg(test)]
mod tests;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];

/// Run the v2 lowering over a DOM or SSR program (after fusion).
pub(crate) fn lower_v2_client<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    v2: &V2Bodies,
) {
    if runtime_imports(program).is_empty() {
        return;
    }
    lower_operations(allocator, program, v2);
    erase_blocks(allocator, program, v2);
    if !v2.async_bodies.is_empty() {
        restore_async_generators(allocator, program, v2);
    }
    lower_remaining_reads(allocator, program);
    compiled_constructors(allocator, program, v2);
    drop_unused_generated(allocator, program);
}

// --- imports -----------------------------------------------------------------------

/// A value import specifier from a runtime source.
struct RuntimeImport {
    source: String,
    imported: String,
    local: String,
    symbol: Option<SymbolId>,
}

fn runtime_imports(program: &Program<'_>) -> Vec<RuntimeImport> {
    let mut imports = Vec::new();
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
                && specifier.import_kind != ImportOrExportKind::Type
            {
                imports.push(RuntimeImport {
                    source: import.source.value.to_string(),
                    imported: specifier.imported.name().to_string(),
                    local: specifier.local.name.to_string(),
                    symbol: specifier.local.symbol_id.get(),
                });
            }
        }
    }
    imports
}

/// The generated import specifiers a pass needs, by `(source, imported)`.
struct Imports {
    existing: Vec<RuntimeImport>,
    taken: HashSet<String>,
    requested: Vec<(String, String, String)>,
}

impl Imports {
    fn new(program: &Program<'_>) -> Self {
        let existing = runtime_imports(program);
        let mut taken: HashSet<String> = existing.iter().map(|i| i.local.clone()).collect();
        for statement in &program.body {
            if let Statement::ImportDeclaration(import) = statement {
                for specifier in import.specifiers.iter().flatten() {
                    taken.insert(specifier.local().name.to_string());
                }
            }
        }
        Self {
            existing,
            taken,
            requested: Vec::new(),
        }
    }

    /// The local of a generated `imported as _$…` specifier from `source`.
    fn local(&mut self, source: &str, imported: &str) -> String {
        if let Some(found) = self
            .existing
            .iter()
            .find(|i| i.source == source && i.imported == imported && i.local.starts_with("_$"))
        {
            return found.local.clone();
        }
        if let Some((_, _, local)) = self
            .requested
            .iter()
            .find(|(s, i, _)| s == source && i == imported)
        {
            return local.clone();
        }
        // (`store_forms.rs`, a later pass, reuses this specifier for the
        // plain `createStore` calls it rewrites.)
        let base = format!("_${imported}");
        let mut local = base.clone();
        let mut n = 2;
        while self.taken.contains(&local) {
            local = format!("{base}{n}");
            n += 1;
        }
        self.taken.insert(local.clone());
        self.requested
            .push((source.to_string(), imported.to_string(), local.clone()));
        local
    }

    fn apply<'a>(self, allocator: &'a Allocator, program: &mut Program<'a>) {
        let ast = AstBuilder::new(allocator);
        for (source, imported, local) in self.requested {
            for statement in program.body.iter_mut() {
                let Statement::ImportDeclaration(import) = statement else {
                    continue;
                };
                if import.source.value.as_str() != source
                    || import.import_kind == ImportOrExportKind::Type
                {
                    continue;
                }
                let span = Span::new(0, 0);
                let specifier = ast.import_declaration_specifier_import_specifier(
                    span,
                    ast.module_export_name_identifier_name(span, ast.ident(&imported)),
                    ast.binding_identifier(span, ast.ident(&local)),
                    ImportOrExportKind::Value,
                );
                match import.specifiers.as_mut() {
                    Some(specifiers) => specifiers.push(specifier),
                    None => import.specifiers = Some(ast.vec1(specifier)),
                }
                break;
            }
        }
    }
}

/// Runtime import symbols by imported name, with their source.
struct Names {
    by_symbol: HashMap<SymbolId, (String, String)>,
}

impl Names {
    fn new(program: &Program<'_>) -> Self {
        let by_symbol = runtime_imports(program)
            .into_iter()
            .filter_map(|i| i.symbol.map(|s| (s, (i.imported, i.source))))
            .collect();
        Self { by_symbol }
    }

    /// The imported name and source a callee resolves to.
    fn of(&self, scoping: &Scoping, call: &CallExpression<'_>) -> Option<(&str, &str)> {
        let symbol = callee_symbol(scoping, call)?;
        self.by_symbol
            .get(&symbol)
            .map(|(imported, source)| (imported.as_str(), source.as_str()))
    }

    fn is(&self, scoping: &Scoping, call: &CallExpression<'_>, name: &str) -> bool {
        self.of(scoping, call)
            .is_some_and(|(imported, _)| imported == name)
    }
}

fn callee_symbol(scoping: &Scoping, call: &CallExpression<'_>) -> Option<SymbolId> {
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    reference_symbol(scoping, callee)
}

fn reference_symbol(scoping: &Scoping, reference: &IdentifierReference<'_>) -> Option<SymbolId> {
    reference
        .reference_id
        .get()
        .and_then(|id| scoping.get_reference(id).symbol_id())
}

/// `_$$(fn[, flags])` with `fn` a function: the block call's function.
fn block_function<'b, 'a>(
    names: &Names,
    scoping: &Scoping,
    argument: Option<&'b Argument<'a>>,
) -> Option<(&'b CallExpression<'a>, &'b Function<'a>)> {
    let Some(Argument::CallExpression(block)) = argument else {
        return None;
    };
    if !names.is(scoping, block, "$") {
        return None;
    }
    match block.arguments.first() {
        Some(Argument::FunctionExpression(function)) => Some((block, function)),
        _ => None,
    }
}

/// The block's metadata literal carries `BLOCK_SYNC`.
fn sync_flagged(block: &CallExpression<'_>) -> bool {
    matches!(
        block.arguments.get(1),
        Some(Argument::NumericLiteral(flags)) if (flags.value as u32) & BLOCK_SYNC != 0
    ) && block.arguments.len() == 2
}

/// A lowered (call-form) function the compiler built from a v2 body (an
/// `async function` for a memo / event body that waits: see
/// `generators.rs`, "async v2 bodies").
fn lowered(function: &Function<'_>) -> bool {
    !function.generator && function.body.is_some()
}

// --- 1. setup operations ---------------------------------------------------------------

/// One `_$perform(OP(args))` → `LOCAL(args)` (optionally `WRAP(LOCAL(args))`).
struct Direct {
    local: String,
    wrap: Option<String>,
}

#[derive(Default)]
struct OpsPlan {
    direct: HashMap<Span, Direct>,
    /// `_$perform(set(x))` → `set(x)` (`false`), or `set(x).value` (`true`:
    /// the setter returns receipts and the value is used).
    unwrap: HashMap<Span, bool>,
    /// `_$perform(raise(e));` → `throw e;`.
    throws: HashSet<Span>,
    /// `_$perform(Ctx)` of a proven context in a setup → `_$readContext(Ctx)`.
    contexts: HashMap<Span, String>,
    /// `_$perform(helper(args))` of a lowered helper → `helper(args)`.
    helper_calls: HashSet<Span>,
    /// Lowered helpers: their `function*` declarations (by function span)
    /// become plain functions, their `yield* Ctx` → `_$readContext(Ctx)`.
    helper_functions: HashSet<Span>,
    helper_yields: HashMap<Span, String>,
}

fn lower_operations<'a>(allocator: &'a Allocator, program: &mut Program<'a>, v2: &V2Bodies) {
    let mut imports = Imports::new(program);
    let plan = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let names = Names::new(program);
        let contexts = context_symbols(program, semantic.scoping(), &names);
        let helpers = lowerable_helpers(
            program,
            semantic.scoping(),
            semantic.nodes(),
            &names,
            v2,
            &contexts,
        );
        let mut collector = OpsCollector {
            scoping: semantic.scoping(),
            nodes: semantic.nodes(),
            names: &names,
            v2,
            imports: &mut imports,
            plan: OpsPlan::default(),
            stack: Vec::new(),
            contexts: &contexts,
            helpers: helpers.iter().map(|(symbol, _)| *symbol).collect(),
        };
        collector.visit_program(program);
        let mut plan = collector.plan;
        if !helpers.is_empty() {
            let source = contexts_source(program, &names, &contexts);
            let local = imports.local(&source, "readContext");
            for (_, function) in &helpers {
                plan.helper_functions.insert(function.0);
                for span in &function.1 {
                    plan.helper_yields.insert(*span, local.clone());
                }
            }
        }
        plan
    };
    if plan.direct.is_empty()
        && plan.unwrap.is_empty()
        && plan.throws.is_empty()
        && plan.contexts.is_empty()
        && plan.helper_calls.is_empty()
        && plan.helper_functions.is_empty()
    {
        return;
    }
    OpsRewriter { allocator, plan }.visit_program(program);
    imports.apply(allocator, program);
}

struct OpsCollector<'s, 'x> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'s>,
    names: &'s Names,
    v2: &'s V2Bodies,
    imports: &'x mut Imports,
    plan: OpsPlan,
    /// The lowered v2 bodies around the current position, innermost last:
    /// their kind and the depth of nested functions inside them.
    stack: Vec<(V2Kind, usize)>,
    /// Proven contexts (`const Ctx = createContext(…)`).
    contexts: &'s HashSet<SymbolId>,
    /// Lowered helper generators.
    helpers: HashSet<SymbolId>,
}

impl<'s> OpsCollector<'s, '_> {
    /// The kind of the lowered v2 body the current position is directly in.
    fn body_kind(&self) -> Option<V2Kind> {
        match self.stack.last() {
            Some(&(kind, 0)) => Some(kind),
            _ => None,
        }
    }

    fn plan_perform(&mut self, call: &CallExpression<'_>, statement: bool) {
        let Some(kind) = self.body_kind() else {
            return;
        };
        if call.arguments.len() != 1 || !self.names.is(self.scoping, call, "perform") {
            return;
        }
        if kind == V2Kind::Setup {
            // `yield* Ctx` of a proven context: the context read itself.
            if let Some(Argument::Identifier(context)) = call.arguments.first()
                && reference_symbol(self.scoping, context)
                    .is_some_and(|symbol| self.contexts.contains(&symbol))
            {
                let source = self
                    .names
                    .of(self.scoping, call)
                    .map(|(_, source)| source.to_string())
                    .unwrap_or_else(|| "solid-js".to_string());
                let local = self.imports.local(&source, "readContext");
                self.plan.contexts.insert(call.span, local);
                return;
            }
            // `yield* helper()` of a lowered helper: the plain call.
            if let Some(Argument::CallExpression(helper)) = call.arguments.first()
                && callee_symbol(self.scoping, helper)
                    .is_some_and(|symbol| self.helpers.contains(&symbol))
            {
                self.plan.helper_calls.insert(call.span);
                return;
            }
        }
        let Some(Argument::CallExpression(op)) = call.arguments.first() else {
            return;
        };
        if op
            .arguments
            .iter()
            .any(|a| matches!(a, Argument::SpreadElement(_)))
        {
            return;
        }
        let Some((name, source)) = self.names.of(self.scoping, op) else {
            // `_$perform(set(x))` of a setter the plan proved plain is
            // unwrapped by the setter analysis.
            return;
        };
        let source = source.to_string();
        let prebuilt = block_function(self.names, self.scoping, op.arguments.first()).is_some();
        let (imported, wrap) = match (name, kind) {
            ("$signal" | "$store", V2Kind::Setup) => {
                // `$store(value)` creates the plain store form.
                let factory = if name == "$signal" {
                    "createSignal"
                } else {
                    "createPlainStore"
                };
                let escapes = self.setter_escapes(call);
                (factory, escapes)
            }
            ("$memo", V2Kind::Setup) if prebuilt => ("createMemo", false),
            ("$effect", V2Kind::Setup) if prebuilt => ("effectBlock", false),
            ("$settled", V2Kind::Setup) if prebuilt => ("settledBlock", false),
            ("$cleanup", V2Kind::Setup | V2Kind::Effect) => ("blockCleanup", false),
            // (In an async body too: a body whose block is not erased is
            // restored to its generator, `_$flush()` back to `yield*
            // $flush()`, see `restore_async_generators`.)
            ("$flush", V2Kind::Event) if statement && op.arguments.is_empty() => {
                ("flush", false)
            }
            // `perform` throws a raised error (the host rules admit `raise`
            // in these kinds): as a statement it is a `throw`.
            ("raise", V2Kind::Memo | V2Kind::Effect | V2Kind::Event)
                if statement && op.arguments.len() == 1 =>
            {
                self.plan.throws.insert(call.span);
                return;
            }
            _ => return,
        };
        let local = self.imports.local(&source, imported);
        let wrap = wrap.then(|| self.imports.local(&source, "withReceipts"));
        self.plan.direct.insert(call.span, Direct { local, wrap });
    }

    /// `const [get, set] = _$perform($signal(…))`: does `set` escape? Every
    /// `_$perform(set(x))` is planned either way: `set(x)` when the setter
    /// stays plain (it returns the value the receipt would carry) or its
    /// result is discarded, else `set(x).value` (`perform` reads a receipt's
    /// value before any host check).
    fn setter_escapes(&mut self, perform: &CallExpression<'_>) -> bool {
        // The perform must be the whole initializer of a `const` array
        // pattern `[get, set]` (no defaults, no rest).
        let Some(declarator) = self.declarator_of(perform) else {
            return true;
        };
        let BindingPattern::ArrayPattern(pattern) = &declarator.id else {
            return true;
        };
        if pattern.rest.is_some() || pattern.elements.len() > 2 {
            return true;
        }
        let setter = match pattern.elements.get(1) {
            None | Some(None) => return false,
            Some(Some(BindingPattern::BindingIdentifier(id))) => id.symbol_id.get(),
            Some(Some(_)) => return true,
        };
        if !matches!(
            pattern.elements.first(),
            None | Some(None) | Some(Some(BindingPattern::BindingIdentifier(_)))
        ) {
            return true;
        }
        let Some(setter) = setter else {
            return true;
        };
        let mut escapes = false;
        // `_$perform(set(x))` calls: (perform span, result discarded).
        let mut performed = Vec::new();
        for reference in self.scoping.get_resolved_references(setter) {
            let node = reference.node_id();
            let span = self.nodes.get_node(node).kind().span();
            let parent = self.nodes.parent_id(node);
            let AstKind::CallExpression(call) = self.nodes.get_node(parent).kind() else {
                escapes = true;
                continue;
            };
            if call.callee.span() != span {
                escapes = true;
                continue;
            }
            let outer = self.nodes.parent_id(parent);
            match self.nodes.get_node(outer).kind() {
                // The result is discarded — unless the statement is a concise
                // arrow's body (`() => set(x)` returns the receipt).
                AstKind::ExpressionStatement(_) if !self.concise_arrow_body(outer) => {}
                AstKind::CallExpression(perform)
                    if perform.arguments.len() == 1
                        && perform.arguments[0].span() == call.span
                        && self.names.is(self.scoping, perform, "perform") =>
                {
                    let statement = self.nodes.parent_id(outer);
                    let discarded = matches!(
                        self.nodes.get_node(statement).kind(),
                        AstKind::ExpressionStatement(_)
                    ) && !self.concise_arrow_body(statement);
                    performed.push((perform.span, discarded));
                }
                _ => escapes = true,
            }
        }
        for (span, discarded) in performed {
            self.plan.unwrap.insert(span, escapes && !discarded);
        }
        escapes
    }

    /// Is this expression statement the body of a concise arrow?
    fn concise_arrow_body(&self, statement: oxc_semantic::NodeId) -> bool {
        let body = self.nodes.parent_id(statement);
        if !matches!(self.nodes.get_node(body).kind(), AstKind::FunctionBody(_)) {
            return false;
        }
        let function = self.nodes.parent_id(body);
        matches!(self.nodes.get_node(function).kind(),
            AstKind::ArrowFunctionExpression(arrow) if arrow.get_expression().is_some())
    }

    fn declarator_of(
        &self,
        perform: &CallExpression<'_>,
    ) -> Option<&'s oxc_ast::ast::VariableDeclarator<'s>> {
        // Find the declarator whose init is this perform by walking up from
        // the perform's node (found by span among the nodes' call kinds).
        let node = self.nodes.iter().find(|node| {
            matches!(node.kind(), AstKind::CallExpression(call) if call.span == perform.span)
        })?;
        let parent = self.nodes.parent_id(node.id());
        let AstKind::VariableDeclarator(declarator) = self.nodes.get_node(parent).kind() else {
            return None;
        };
        let declaration = self.nodes.parent_id(parent);
        match self.nodes.get_node(declaration).kind() {
            AstKind::VariableDeclaration(declaration)
                if declaration.kind == VariableDeclarationKind::Const =>
            {
                Some(declarator)
            }
            _ => None,
        }
    }
}

impl<'b> Visit<'b> for OpsCollector<'_, '_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        self.plan_perform(call, false);
        // A lowered v2 body: `_$$(function (…) {…}[, flags])`.
        let body = self
            .v2
            .kind_of(call.span)
            .filter(|_| self.names.is(self.scoping, call, "$"))
            .filter(|_| {
                matches!(call.arguments.first(),
                    Some(Argument::FunctionExpression(function)) if lowered(function))
            });
        if let Some(kind) = body {
            self.visit_expression(&call.callee);
            if let Some(Argument::FunctionExpression(function)) = call.arguments.first() {
                self.stack.push((kind, 0));
                if let Some(body) = function.body.as_ref() {
                    self.visit_function_body(body);
                }
                self.stack.pop();
            }
            return;
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_expression_statement(&mut self, it: &oxc_ast::ast::ExpressionStatement<'b>) {
        if let Expression::CallExpression(call) = &it.expression {
            self.plan_perform(call, true);
            // Planned as a statement: skip the expression-level visit of
            // this call, walk its parts.
            self.visit_expression(&call.callee);
            for argument in &call.arguments {
                self.visit_argument(argument);
            }
            return;
        }
        walk::walk_expression_statement(self, it);
    }

    fn visit_function(&mut self, it: &Function<'b>, flags: ScopeFlags) {
        if let Some(top) = self.stack.last_mut() {
            top.1 += 1;
        }
        walk::walk_function(self, it, flags);
        if let Some(top) = self.stack.last_mut() {
            top.1 -= 1;
        }
    }

    fn visit_arrow_function_expression(&mut self, it: &oxc_ast::ast::ArrowFunctionExpression<'b>) {
        if let Some(top) = self.stack.last_mut() {
            top.1 += 1;
        }
        walk::walk_arrow_function_expression(self, it);
        if let Some(top) = self.stack.last_mut() {
            top.1 -= 1;
        }
    }
}

struct OpsRewriter<'a> {
    allocator: &'a Allocator,
    plan: OpsPlan,
}

impl<'a> VisitMut<'a> for OpsRewriter<'a> {
    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        // `_$perform(raise(e));` → `throw e;`.
        let thrown = match statement {
            Statement::ExpressionStatement(it) => {
                let span = it.span;
                match &mut it.expression {
                    Expression::CallExpression(perform)
                        if self.plan.throws.remove(&perform.span) =>
                    {
                        let Some(Argument::CallExpression(mut raise)) = perform.arguments.pop()
                        else {
                            unreachable!("planned: a raise call");
                        };
                        let error = raise.arguments.pop().expect("planned: one argument");
                        Some((
                            span,
                            argument_to_expression(error).expect("planned: no spread"),
                        ))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        if let Some((span, error)) = thrown {
            *statement = Statement::new_throw_statement(
                span,
                error,
                &oxc_ast::builder::AstBuilder::new(self.allocator),
            );
        }
        walk_mut::walk_statement(self, statement);
    }

    fn visit_function(&mut self, it: &mut Function<'a>, flags: ScopeFlags) {
        if self.plan.helper_functions.remove(&it.span) {
            // A lowered helper: its `yield* Ctx` reads are direct calls.
            it.generator = false;
            it.return_type = None;
        }
        walk_mut::walk_function(self, it, flags);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::YieldExpression(it) = expression
            && let Some(local) = self.plan.helper_yields.remove(&it.span)
        {
            let ast = AstBuilder::new(self.allocator);
            let span = it.span;
            let context = it.argument.take().expect("planned: `yield* Ctx`");
            *expression = ast.expression_call(
                span,
                ast.expression_identifier(Span::new(0, 0), ast.ident(&local)),
                None,
                ast.vec1(expression_to_argument(context)),
                false,
            );
            return;
        }
        if let Expression::CallExpression(call) = expression {
            let span = call.span;
            if let Some(local) = self.plan.contexts.remove(&span) {
                // `_$perform(Ctx)` → `_$readContext(Ctx)`.
                let ast = AstBuilder::new(self.allocator);
                call.callee = ast.expression_identifier(call.callee.span(), ast.ident(&local));
            } else if self.plan.helper_calls.remove(&span) {
                // `_$perform(helper(args))` → `helper(args)`.
                let argument = call.arguments.pop().expect("planned: one argument");
                *expression = argument_to_expression(argument).expect("planned: a call");
            } else if let Some(value) = self.plan.unwrap.remove(&span) {
                // `_$perform(set(x))` → `set(x)` / `set(x).value`.
                let argument = call.arguments.pop().expect("planned: one argument");
                let write = argument_to_expression(argument).expect("planned: a call");
                *expression = if value {
                    let ast = AstBuilder::new(self.allocator);
                    Expression::StaticMemberExpression(ast.alloc_static_member_expression(
                        span,
                        write,
                        ast.identifier_name(Span::new(0, 0), ast.ident("value")),
                        false,
                    ))
                } else {
                    write
                };
            } else if let Some(direct) = self.plan.direct.remove(&span) {
                // `_$perform(OP(args))` → `LOCAL(args)` / `WRAP(LOCAL(args))`.
                let ast = AstBuilder::new(self.allocator);
                let Some(Argument::CallExpression(op)) = call.arguments.pop() else {
                    unreachable!("planned: an operation call");
                };
                let op = op.unbox();
                let direct_call = ast.expression_call(
                    span,
                    ast.expression_identifier(Span::new(0, 0), ast.ident(&direct.local)),
                    None,
                    op.arguments,
                    false,
                );
                *expression = match direct.wrap {
                    Some(wrap) => ast.expression_call(
                        Span::new(0, 0),
                        ast.expression_identifier(Span::new(0, 0), ast.ident(&wrap)),
                        None,
                        ast.vec1(expression_to_argument(direct_call)),
                        false,
                    ),
                    None => direct_call,
                };
            }
        }
        walk_mut::walk_expression(self, expression);
    }
}

// --- 2. erasures -----------------------------------------------------------------------

#[derive(Default)]
struct ErasePlan {
    fusion: FusionPlan,
    /// `effectBlock(_$$(half), compute)` → `createEffect(compute, half')`:
    /// call span → the `createEffect` local.
    halves: HashMap<Span, String>,
    /// `$event(_$$(fn))` → `$eventCompiled(fn)`: call span → local.
    events: HashMap<Span, String>,
    /// `$component(_$$(fn), …)` → `$componentCompiled(fn, …)`: call span → local.
    setups: HashMap<Span, String>,
    /// `settledBlock(_$$(fn))` → `onSettled(fn')`: call span → the
    /// `onSettled` local (the half's cleanups returned, as for effect halves).
    settled: HashMap<Span, String>,
    /// An erased async body: `_$$(async fn)` → `_$asyncBody(fn)`: block span
    /// → the `asyncBody` local.
    async_blocks: HashMap<Span, String>,
}

fn erase_blocks<'a>(allocator: &'a Allocator, program: &mut Program<'a>, v2: &V2Bodies) {
    let mut imports = Imports::new(program);
    let plan = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let names = Names::new(program);
        let context = FusionContext {
            scoping: semantic.scoping(),
            nodes: semantic.nodes(),
            symbols: collect_fusion_symbols(program),
        };
        let mut collector = EraseCollector {
            context: &context,
            names: &names,
            v2,
            imports: &mut imports,
            plan: ErasePlan::default(),
        };
        collector.visit_program(program);
        collector.plan
    };
    if plan.fusion.blocks.is_empty() && plan.async_blocks.is_empty() {
        return;
    }
    if !plan.fusion.path_reads.is_empty() {
        // `readValue` comes from the module the blocks' `$` came from.
        if let Some(source) = runtime_imports(program)
            .iter()
            .find(|i| i.imported == "$")
            .map(|i| i.source.clone())
        {
            let local = imports.local(&source, "readValue");
            debug_assert_eq!(local, READ_VALUE_LOCAL);
        }
    }
    let ErasePlan {
        fusion,
        halves,
        events,
        setups,
        settled,
        async_blocks,
    } = plan;
    EraseRewriter {
        allocator,
        halves,
        events,
        setups,
        settled,
        async_blocks,
    }
    .visit_program(program);
    FusionRewriter {
        allocator,
        plan: fusion,
    }
    .visit_program(program);
    imports.apply(allocator, program);
}

struct EraseCollector<'s, 'x> {
    context: &'s FusionContext<'s>,
    names: &'s Names,
    v2: &'s V2Bodies,
    imports: &'x mut Imports,
    plan: ErasePlan,
}

impl EraseCollector<'_, '_> {
    fn is_v2(&self, block: &CallExpression<'_>) -> bool {
        self.v2.kind_of(block.span).is_some()
    }

    /// Run the fusion's body check; plan the erasure when it passes.
    fn check<'b>(&mut self, block: &'b CallExpression<'b>, skip_blocks: bool) -> bool {
        let mut check = BodyCheck::new(self.context, block);
        check.skip_blocks = skip_blocks;
        check.run();
        if check.ok {
            self.plan.fusion.blocks.push(block.span);
            self.plan.fusion.accessor_calls.extend(check.accessor_calls);
            self.plan.fusion.path_reads.extend(check.path_reads);
            self.plan.fusion.store_reads.extend(check.store_reads);
        }
        check.ok
    }

    /// The body check of an async body: its operations are erased as a
    /// synchronous body's are, but its block becomes `asyncBody(fn)`.
    fn check_async<'b>(&mut self, block: &'b CallExpression<'b>) -> bool {
        let mut check = BodyCheck::new(self.context, block);
        check.run();
        if check.ok {
            self.plan.fusion.accessor_calls.extend(check.accessor_calls);
            self.plan.fusion.path_reads.extend(check.path_reads);
            self.plan.fusion.store_reads.extend(check.store_reads);
        }
        check.ok
    }

    fn plan_call<'b>(&mut self, call: &'b CallExpression<'b>) {
        let scoping = self.context.scoping;
        let Some((name, source)) = self.names.of(scoping, call) else {
            return;
        };
        let source = source.to_string();
        let Some((block, function)) = block_function(self.names, scoping, call.arguments.first())
        else {
            return;
        };
        if function.r#async {
            // An async body the generator pass compiled (memo / event): the
            // host calls it through `asyncBody` when every other operation
            // is erased; otherwise `restore_async_generators` gives it back
            // to the driver.
            if !self.v2.async_bodies.contains(&block.span) {
                return;
            }
            let event = match (name, self.v2.kind_of(block.span)) {
                ("$event", Some(V2Kind::Event)) if call.arguments.len() == 1 => true,
                ("createMemo", Some(V2Kind::Memo)) if (1..=2).contains(&call.arguments.len()) => {
                    false
                }
                _ => return,
            };
            if !self.check_async(block) {
                return;
            }
            let local = self.imports.local(&source, "asyncBody");
            self.plan.async_blocks.insert(block.span, local);
            if event {
                let local = self.imports.local(&source, "$eventCompiled");
                self.plan.events.insert(call.span, local);
            }
            return;
        }
        if !lowered(function) || !sync_flagged(block) || !self.is_v2(block) {
            return;
        }
        // What the call becomes when its block is erasable, and whether the
        // check skips nested blocks (a setup's views, events and memos).
        let (target, skip_blocks) = match name {
            // (A body with JSX is scoped for hydration ids on both sides,
            // `block_scope.rs`: its block reserves an id slot the server
            // reserves too, so it is never erased on the client alone.)
            "effectBlock"
                if call.arguments.len() == 2
                    && function.params.items.len() == 1
                    && function.params.rest.is_none()
                    && half_cleanups(function).is_some()
                    && !crate::block_scope::body_has_jsx(&block.arguments[0]) =>
            {
                ("createEffect", false)
            }
            "$event" if call.arguments.len() == 1 => ("$eventCompiled", false),
            // `onSettled` calls its callback with no argument, as
            // `settledCallback` runs the block with `undefined`.
            "settledBlock"
                if call.arguments.len() == 1
                    && function.params.items.is_empty()
                    && function.params.rest.is_none()
                    && half_cleanups(function).is_some()
                    && !crate::block_scope::body_has_jsx(&block.arguments[0]) =>
            {
                ("onSettled", false)
            }
            "$component"
                if (1..=2).contains(&call.arguments.len())
                    && returns_blocks(self.names, scoping, function) =>
            {
                ("$componentCompiled", true)
            }
            _ => return,
        };
        if !self.check(block, skip_blocks) {
            return;
        }
        let local = self.imports.local(&source, target);
        let plan = match name {
            "effectBlock" => &mut self.plan.halves,
            "$event" => &mut self.plan.events,
            "settledBlock" => &mut self.plan.settled,
            _ => &mut self.plan.setups,
        };
        plan.insert(call.span, local);
    }
}

impl<'b> Visit<'b> for EraseCollector<'_, '_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        self.plan_call(call);
        walk::walk_call_expression(self, call);
    }
}

/// The half's `_$blockCleanup(fn);` statements must be top-level statements
/// and the half must not `return`: the number of cleanups, or `None`.
fn half_cleanups(function: &Function<'_>) -> Option<usize> {
    let body = function.body.as_ref()?;
    struct Finder {
        /// Calls of `_$blockCleanup` anywhere (by name: generated local).
        calls: usize,
        returns: bool,
    }
    impl<'b> Visit<'b> for Finder {
        fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _: &oxc_ast::ast::ArrowFunctionExpression<'b>,
        ) {
        }
        fn visit_return_statement(&mut self, _: &ReturnStatement<'b>) {
            self.returns = true;
        }
        fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
            if is_block_cleanup(call) {
                self.calls += 1;
            }
            walk::walk_call_expression(self, call);
        }
    }
    let mut finder = Finder {
        calls: 0,
        returns: false,
    };
    finder.visit_function_body(body);
    let top_level = body
        .statements
        .iter()
        .filter(|statement| {
            matches!(statement, Statement::ExpressionStatement(it)
                if matches!(&it.expression, Expression::CallExpression(call) if is_block_cleanup(call)))
        })
        .count();
    (!finder.returns && finder.calls == top_level).then_some(top_level)
}

fn is_block_cleanup(call: &CallExpression<'_>) -> bool {
    matches!(&call.callee, Expression::Identifier(callee) if callee.name.starts_with("_$blockCleanup"))
        && call.arguments.len() == 1
        && !matches!(call.arguments[0], Argument::SpreadElement(_))
}

/// Every `return` of the setup (at its own depth) returns a `_$$(…)` block.
fn returns_blocks(names: &Names, scoping: &Scoping, function: &Function<'_>) -> bool {
    let Some(body) = function.body.as_ref() else {
        return false;
    };
    struct Finder<'s> {
        names: &'s Names,
        scoping: &'s Scoping,
        ok: bool,
        any: bool,
    }
    impl<'b> Visit<'b> for Finder<'_> {
        fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _: &oxc_ast::ast::ArrowFunctionExpression<'b>,
        ) {
        }
        fn visit_return_statement(&mut self, it: &ReturnStatement<'b>) {
            self.any = true;
            let block = matches!(&it.argument,
                Some(Expression::CallExpression(call)) if self.names.is(self.scoping, call, "$"));
            self.ok &= block;
        }
    }
    let mut finder = Finder {
        names,
        scoping,
        ok: true,
        any: false,
    };
    finder.visit_function_body(body);
    finder.ok && finder.any
}

struct EraseRewriter<'a> {
    allocator: &'a Allocator,
    halves: HashMap<Span, String>,
    events: HashMap<Span, String>,
    setups: HashMap<Span, String>,
    settled: HashMap<Span, String>,
    async_blocks: HashMap<Span, String>,
}

impl<'a> VisitMut<'a> for EraseRewriter<'a> {
    fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
        walk_mut::walk_call_expression(self, call);
        let ast = AstBuilder::new(self.allocator);
        let span = call.span;
        if let Some(local) = self
            .events
            .remove(&span)
            .or_else(|| self.setups.remove(&span))
            .or_else(|| self.async_blocks.remove(&span))
        {
            call.callee = ast.expression_identifier(call.callee.span(), ast.ident(&local));
        } else if let Some(local) = self.settled.remove(&span) {
            // `settledBlock(_$$(fn))` → `onSettled(fn')`; the `_$$` wrapper
            // is erased by the fusion rewrite.
            if let Some(Argument::CallExpression(block)) = call.arguments.first_mut()
                && let Some(Argument::FunctionExpression(function)) = block.arguments.first_mut()
                && let Some(body) = function.body.as_mut()
            {
                return_cleanups(self.allocator, body);
            }
            call.callee = ast.expression_identifier(call.callee.span(), ast.ident(&local));
        } else if let Some(local) = self.halves.remove(&span) {
            // `effectBlock(_$$(half), compute)` → `createEffect(compute, half')`;
            // the `_$$` wrapper is erased by the fusion rewrite.
            let compute = call.arguments.pop().expect("planned: a compute");
            let mut half = call.arguments.pop().expect("planned: a half");
            if let Argument::CallExpression(block) = &mut half
                && let Some(Argument::FunctionExpression(function)) = block.arguments.first_mut()
                && let Some(body) = function.body.as_mut()
            {
                return_cleanups(self.allocator, body);
            }
            call.arguments = ast.vec_from_array([compute, half]);
            call.callee = ast.expression_identifier(call.callee.span(), ast.ident(&local));
        }
    }
}

/// `_$blockCleanup(f);` statements → `const _$cleanupN = f;`, and the body
/// returns them: `return _$cleanup0;` or a function running them in order.
fn return_cleanups<'a>(allocator: &'a Allocator, body: &mut FunctionBody<'a>) {
    let ast = AstBuilder::new(allocator);
    let synth = Span::new(0, 0);
    let mut names = Vec::new();
    for statement in body.statements.iter_mut() {
        let Statement::ExpressionStatement(it) = statement else {
            continue;
        };
        let Expression::CallExpression(call) = &mut it.expression else {
            continue;
        };
        if !is_block_cleanup(call) {
            continue;
        }
        let argument = call.arguments.pop().expect("checked: one argument");
        let value = argument_to_expression(argument).expect("checked: no spread");
        let name = format!("_$cleanup{}", names.len());
        *statement = crate::shared::ast::variable_statement(
            allocator,
            synth,
            VariableDeclarationKind::Const,
            &name,
            value,
        );
        names.push(name);
    }
    let returned = match names.as_slice() {
        [] => return,
        [one] => ast.expression_identifier(synth, ast.ident(one)),
        many => {
            let calls = ast.vec_from_iter(many.iter().map(|name| {
                ast.statement_expression(
                    synth,
                    ast.expression_call(
                        synth,
                        ast.expression_identifier(synth, ast.ident(name)),
                        None,
                        ast.vec(),
                        false,
                    ),
                )
            }));
            let params = ast.formal_parameters(
                synth,
                oxc_ast::ast::FormalParameterKind::ArrowFormalParameters,
                ast.vec(),
                None,
            );
            let body = ast.function_body(synth, ast.vec(), calls);
            ast.expression_arrow_function(synth, false, false, None, params, None, body)
        }
    };
    body.statements
        .push(ast.statement_return(synth, Some(returned)));
}

// --- 3. compiled constructors ----------------------------------------------------------

fn compiled_constructors<'a>(allocator: &'a Allocator, program: &mut Program<'a>, v2: &V2Bodies) {
    let mut imports = Imports::new(program);
    let (renames, sync_adapter) = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let scoping = semantic.scoping();
        let names = Names::new(program);
        let mut collector = RenameCollector {
            scoping,
            names: &names,
            imports: &mut imports,
            renames: HashMap::new(),
        };
        collector.visit_program(program);
        let renames = collector.renames;
        // `_$$` → `syncBlock`: every use of the generated adapter is a call
        // of a lowered function proven BLOCK_SYNC.
        let sync_adapter = runtime_imports(program)
            .into_iter()
            .filter(|i| i.imported == "$" && i.local == crate::blocks_v2::BLOCK_LOCAL)
            .find_map(|adapter| {
                let symbol = adapter.symbol?;
                let all_sync = scoping.get_resolved_references(symbol).all(|reference| {
                    let node = reference.node_id();
                    let span = semantic.nodes().get_node(node).kind().span();
                    let parent = semantic.nodes().parent_id(node);
                    match semantic.nodes().get_node(parent).kind() {
                        AstKind::CallExpression(call) => {
                            call.callee.span() == span
                                && sync_flagged(call)
                                && v2.kind_of(call.span).is_some()
                                && match call.arguments.first() {
                                    Some(Argument::FunctionExpression(function)) => {
                                        lowered(function)
                                    }
                                    // A hydration id scope around a lowered body.
                                    Some(Argument::CallExpression(scope)) => matches!(
                                        scope.arguments.first(),
                                        Some(Argument::FunctionExpression(function)) if lowered(function)
                                    ),
                                    _ => false,
                                }
                        }
                        _ => false,
                    }
                });
                all_sync.then_some(adapter.source)
            });
        (renames, sync_adapter)
    };
    if !renames.is_empty() {
        RenameRewriter { allocator, renames }.visit_program(program);
    }
    imports.apply(allocator, program);
    if sync_adapter.is_some() {
        let ast = AstBuilder::new(allocator);
        for statement in program.body.iter_mut() {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            for specifier in import.specifiers.iter_mut().flatten() {
                if let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier
                    && specifier.local.name == crate::blocks_v2::BLOCK_LOCAL
                    && specifier.imported.name() == "$"
                {
                    specifier.imported = ast.module_export_name_identifier_name(
                        Span::new(0, 0),
                        ast.ident("syncBlock"),
                    );
                }
            }
        }
    }
}

struct RenameCollector<'s, 'x> {
    scoping: &'s Scoping,
    names: &'s Names,
    imports: &'x mut Imports,
    renames: HashMap<Span, String>,
}

impl<'b> Visit<'b> for RenameCollector<'_, '_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        if let Some((name, source)) = self.names.of(self.scoping, call) {
            let source = source.to_string();
            let prebuilt_block =
                block_function(self.names, self.scoping, call.arguments.first()).is_some();
            let target = match name {
                // (An erased setup was renamed by the erasure itself; a plain
                // function the author passed is not the compiler's to run.)
                "$component" => block_function(self.names, self.scoping, call.arguments.first())
                    .filter(|(_, setup)| returns_blocks(self.names, self.scoping, setup))
                    .map(|_| "$componentCompiled"),
                "$event" if prebuilt_block => Some("$eventCompiled"),
                "effectBlock" if prebuilt_block => Some("effectBlockCompiled"),
                "settledBlock" if prebuilt_block => Some("settledBlockCompiled"),
                _ => None,
            };
            if let Some(target) = target {
                let local = self.imports.local(&source, target);
                self.renames.insert(call.span, local);
            }
        }
        walk::walk_call_expression(self, call);
    }
}

struct RenameRewriter<'a> {
    allocator: &'a Allocator,
    renames: HashMap<Span, String>,
}

impl<'a> VisitMut<'a> for RenameRewriter<'a> {
    fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
        walk_mut::walk_call_expression(self, call);
        if let Some(local) = self.renames.remove(&call.span) {
            let ast = AstBuilder::new(self.allocator);
            call.callee = ast.expression_identifier(call.callee.span(), ast.ident(&local));
        }
    }
}

// --- 4. imports ----------------------------------------------------------------------

/// Drop generated specifiers (`_$…` locals) that nothing references any more.
fn drop_unused_generated<'a>(_allocator: &'a Allocator, program: &mut Program<'a>) {
    let unused: HashSet<String> = {
        let semantic = SemanticBuilder::new().build(program).semantic;
        let scoping = semantic.scoping();
        runtime_imports(program)
            .into_iter()
            .filter(|i| i.local.starts_with("_$"))
            .filter(|i| i.symbol.is_some_and(|s| scoping.symbol_is_unused(s)))
            .map(|i| i.local)
            .collect()
    };
    if unused.is_empty() {
        return;
    }
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str()) {
            continue;
        }
        if let Some(specifiers) = import.specifiers.as_mut() {
            specifiers.retain(|specifier| {
                !matches!(specifier, ImportDeclarationSpecifier::ImportSpecifier(specifier)
                    if unused.contains(specifier.local.name.as_str()))
            });
        }
    }
}

// --- 5. contexts and helper generators ------------------------------------------------

/// Bindings proven to hold a context: `const Ctx = createContext(…)` with
/// `createContext` imported from a runtime source (both providers carry the
/// context iterator `yield* Ctx` steps).
fn context_symbols(program: &Program<'_>, scoping: &Scoping, names: &Names) -> HashSet<SymbolId> {
    struct Finder<'s> {
        scoping: &'s Scoping,
        names: &'s Names,
        found: HashSet<SymbolId>,
    }
    impl<'b> Visit<'b> for Finder<'_> {
        fn visit_variable_declaration(&mut self, it: &oxc_ast::ast::VariableDeclaration<'b>) {
            if it.kind == VariableDeclarationKind::Const {
                for declarator in &it.declarations {
                    if let BindingPattern::BindingIdentifier(id) = &declarator.id
                        && let Some(Expression::CallExpression(call)) = declarator.init.as_ref()
                        && self.names.is(self.scoping, call, "createContext")
                        && let Some(symbol) = id.symbol_id.get()
                    {
                        self.found.insert(symbol);
                    }
                }
            }
            walk::walk_variable_declaration(self, it);
        }
    }
    let mut finder = Finder {
        scoping,
        names,
        found: HashSet::new(),
    };
    finder.visit_program(program);
    finder.found
}

/// The runtime module `readContext` is imported from: the blocks' own.
fn contexts_source(program: &Program<'_>, _names: &Names, _contexts: &HashSet<SymbolId>) -> String {
    runtime_imports(program)
        .into_iter()
        .find(|i| i.imported == "$")
        .map(|i| i.source)
        .unwrap_or_else(|| "solid-js".to_string())
}

/// Helper generators a setup delegates to (`yield* useTodos()`) that lower
/// to plain functions: a module-level, non-exported `function*` declaration
/// whose every `yield*` reads a proven context, and whose every reference
/// is `_$perform(helper(…))` directly in a lowered setup body. `perform` of
/// the helper's generator steps it under the setup's host, performing each
/// context read (`readGuarded(getContext(Ctx))`); the lowered helper makes
/// the same reads, in the same order, as direct `readContext` calls, and
/// returns what the generator returned. Returns each helper's symbol with
/// its function span and the spans of its `yield*`s.
#[allow(clippy::type_complexity)]
fn lowerable_helpers(
    program: &Program<'_>,
    scoping: &Scoping,
    nodes: &AstNodes<'_>,
    names: &Names,
    v2: &V2Bodies,
    contexts: &HashSet<SymbolId>,
) -> Vec<(SymbolId, (Span, Vec<Span>))> {
    let mut out = Vec::new();
    if contexts.is_empty() {
        return out;
    }
    for statement in &program.body {
        let Statement::FunctionDeclaration(function) = statement else {
            continue;
        };
        if !function.generator || function.r#async {
            continue;
        }
        let (Some(id), Some(body)) = (function.id.as_ref(), function.body.as_ref()) else {
            continue;
        };
        let Some(symbol) = id.symbol_id.get() else {
            continue;
        };
        // The body: every `yield` a `yield*` of a proven context.
        struct Yields<'s> {
            scoping: &'s Scoping,
            contexts: &'s HashSet<SymbolId>,
            spans: Vec<Span>,
            ok: bool,
        }
        impl<'b> Visit<'b> for Yields<'_> {
            fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
            fn visit_arrow_function_expression(
                &mut self,
                _: &oxc_ast::ast::ArrowFunctionExpression<'b>,
            ) {
            }
            fn visit_class(&mut self, _: &oxc_ast::ast::Class<'b>) {}
            fn visit_yield_expression(&mut self, it: &oxc_ast::ast::YieldExpression<'b>) {
                let context = it.delegate
                    && matches!(&it.argument, Some(Expression::Identifier(reference))
                        if reference_symbol(self.scoping, reference)
                            .is_some_and(|symbol| self.contexts.contains(&symbol)));
                if context {
                    self.spans.push(it.span);
                } else {
                    self.ok = false;
                }
            }
        }
        let mut yields = Yields {
            scoping,
            contexts,
            spans: Vec::new(),
            ok: true,
        };
        yields.visit_function_body(body);
        if !yields.ok {
            continue;
        }
        // Every reference: `_$perform(helper(…))` directly in a lowered setup.
        let mut any = false;
        let callers_ok = scoping.get_resolved_references(symbol).all(|reference| {
            any = true;
            let node = reference.node_id();
            let span = nodes.get_node(node).kind().span();
            let parent = nodes.parent_id(node);
            let AstKind::CallExpression(call) = nodes.get_node(parent).kind() else {
                return false;
            };
            if call.callee.span() != span
                || call
                    .arguments
                    .iter()
                    .any(|a| matches!(a, Argument::SpreadElement(_)))
            {
                return false;
            }
            let outer = nodes.parent_id(parent);
            let AstKind::CallExpression(perform) = nodes.get_node(outer).kind() else {
                return false;
            };
            if perform.arguments.len() != 1
                || perform.arguments[0].span() != call.span
                || !names.is(scoping, perform, "perform")
            {
                return false;
            }
            // The first function around the perform is a lowered setup body.
            let mut current = outer;
            loop {
                let next = nodes.parent_id(current);
                if next == current {
                    return false;
                }
                current = next;
                match nodes.get_node(current).kind() {
                    AstKind::Function(function) => {
                        let block = nodes.parent_id(current);
                        return matches!(nodes.get_node(block).kind(),
                            AstKind::CallExpression(block)
                                if names.is(scoping, block, "$")
                                    && v2.kind_of(block.span) == Some(V2Kind::Setup)
                                    && lowered(function));
                    }
                    AstKind::ArrowFunctionExpression(_) | AstKind::Class(_) => return false,
                    _ => {}
                }
            }
        });
        if any && callers_ok {
            out.push((symbol, (function.span, yields.spans)));
        }
    }
    out
}

// --- 6. async bodies the erasure did not take ------------------------------------------

/// An async v2 body (`generators.rs`, "async v2 bodies") whose block was not
/// erased goes back to the generator the driver runs, exactly as authored:
/// `(_$a.t(ARGS) ? _$a.r(await _$a.p) : _$a.v)` → `yield* attempt(ARGS)`,
/// `_$perform(x)` → `yield* x`, `_$readPathK(root, k…)` → `yield*
/// root[k]…`, `return _$a.ret(v)` → `return v`, the wrapper `try` and the
/// added parameters dropped. (What the client lowering already did to the
/// body — setter writes as calls, `raise` as `throw` — means the same under
/// the driver.)
fn restore_async_generators<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    v2: &V2Bodies,
) {
    let imports = runtime_imports(program);
    let Some(attempt) = imports
        .iter()
        .find(|i| i.imported == "attempt")
        .map(|i| i.local.clone())
    else {
        return;
    };
    // `_$flush()` (the lowered `yield* $flush()`) and the author's `$flush`.
    let flush = imports
        .iter()
        .find(|i| i.imported == "flush" && i.local.starts_with("_$"))
        .zip(imports.iter().find(|i| i.imported == "$flush"))
        .map(|(lowered, op)| (lowered.local.clone(), op.local.clone()));
    struct Finder<'a, 'x> {
        allocator: &'a Allocator,
        v2: &'x V2Bodies,
        attempt: &'x str,
        flush: Option<&'x (String, String)>,
    }
    impl<'a> VisitMut<'a> for Finder<'a, '_> {
        fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
            if self.v2.async_bodies.contains(&call.span)
                && matches!(&call.callee, Expression::Identifier(callee)
                    if callee.name == crate::blocks_v2::BLOCK_LOCAL)
                && let Some(Argument::FunctionExpression(function)) = call.arguments.first_mut()
                && function.r#async
            {
                restore_generator(self.allocator, function, self.attempt, self.flush);
            }
            walk_mut::walk_call_expression(self, call);
        }
    }
    Finder {
        allocator,
        v2,
        attempt: &attempt,
        flush: flush.as_ref(),
    }
    .visit_program(program);
}

fn restore_generator<'a>(
    allocator: &'a Allocator,
    function: &mut Function<'a>,
    attempt: &str,
    flush: Option<&(String, String)>,
) {
    use crate::generators::{ASYNC_INPUT_PARAM, ASYNC_RUN_PARAM};
    let param_name = |param: &oxc_ast::ast::FormalParameter<'_>| match &param.pattern {
        BindingPattern::BindingIdentifier(id) => Some(id.name.to_string()),
        _ => None,
    };
    if function.params.items.last().and_then(param_name).as_deref() == Some(ASYNC_RUN_PARAM) {
        function.params.items.pop();
        if function.params.items.len() == 1
            && function
                .params
                .items
                .first()
                .and_then(param_name)
                .as_deref()
                == Some(ASYNC_INPUT_PARAM)
        {
            function.params.items.pop();
        }
    }
    function.r#async = false;
    function.generator = true;
    let Some(body) = function.body.as_mut() else {
        return;
    };
    // The wrapper: `try { BODY } catch (_$e) { _$a.x(_$e); } finally { _$a.f(); }`.
    if body.statements.len() == 1
        && let Some(Statement::TryStatement(wrapper)) = body.statements.first_mut()
    {
        let ast = AstBuilder::new(allocator);
        let statements = std::mem::replace(&mut wrapper.block.body, ast.vec());
        body.statements = statements;
    }
    let mut restorer = Restorer {
        allocator,
        attempt,
        flush,
    };
    for statement in body.statements.iter_mut() {
        restorer.visit_statement(statement);
    }
}

struct Restorer<'a, 'x> {
    allocator: &'a Allocator,
    attempt: &'x str,
    /// The lowered `flush` local and the author's `$flush` local.
    flush: Option<&'x (String, String)>,
}

impl Restorer<'_, '_> {
    fn is_run_member(expression: &Expression<'_>, name: &str) -> bool {
        matches!(expression, Expression::StaticMemberExpression(member)
            if member.property.name == name
                && matches!(&member.object, Expression::Identifier(object)
                    if object.name == crate::generators::ASYNC_RUN_PARAM))
    }
}

impl<'a> VisitMut<'a> for Restorer<'a, '_> {
    // Nested functions are their own bodies (their `_$perform`s, if any,
    // belong to blocks of their own).
    fn visit_function(&mut self, _: &mut Function<'a>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(
        &mut self,
        _: &mut oxc_ast::ast::ArrowFunctionExpression<'a>,
    ) {
    }
    fn visit_class(&mut self, _: &mut oxc_ast::ast::Class<'a>) {}

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let ast = AstBuilder::new(self.allocator);
        let builder = oxc_ast::builder::AstBuilder::new(self.allocator);
        let synth = Span::new(0, 0);
        let replacement = match expression {
            // `(_$a.t(ARGS) ? _$a.r(await _$a.p) : _$a.v)` → `yield* attempt(ARGS)`.
            Expression::ParenthesizedExpression(parenthesized)
                if matches!(&parenthesized.expression, Expression::ConditionalExpression(c)
                    if matches!(&c.test, Expression::CallExpression(t)
                        if Self::is_run_member(&t.callee, "t"))) =>
            {
                let span = parenthesized.span;
                let Expression::ConditionalExpression(conditional) = &mut parenthesized.expression
                else {
                    unreachable!("matched above");
                };
                let Expression::CallExpression(test) = &mut conditional.test else {
                    unreachable!("matched above");
                };
                let arguments = std::mem::replace(&mut test.arguments, ast.vec());
                let call = ast.expression_call(
                    synth,
                    ast.expression_identifier(synth, ast.ident(self.attempt)),
                    None,
                    arguments,
                    false,
                );
                Some(Expression::new_yield_expression(
                    span,
                    true,
                    Some(call),
                    &builder,
                ))
            }
            // `_$flush()` → `yield* $flush()` (the lowering's statement
            // `$flush`, at the body's own depth like every restored form).
            Expression::CallExpression(call)
                if call.arguments.is_empty()
                    && self.flush.is_some_and(|(lowered, _)| matches!(&call.callee,
                        Expression::Identifier(callee) if callee.name == lowered.as_str())) =>
            {
                let (_, op) = self.flush.expect("matched above");
                let span = call.span;
                let operation = ast.expression_call(
                    synth,
                    ast.expression_identifier(synth, ast.ident(op)),
                    None,
                    ast.vec(),
                    false,
                );
                Some(Expression::new_yield_expression(
                    span,
                    true,
                    Some(operation),
                    &builder,
                ))
            }
            // `_$a.ret(v)` → `v`.
            Expression::CallExpression(call)
                if Self::is_run_member(&call.callee, "ret") && call.arguments.len() == 1 =>
            {
                let argument = call.arguments.pop().expect("checked: one argument");
                argument_to_expression(argument)
            }
            // `_$perform(x)` → `yield* x`.
            Expression::CallExpression(call)
                if matches!(&call.callee, Expression::Identifier(callee)
                    if callee.name == "_$perform")
                    && call.arguments.len() == 1 =>
            {
                let span = call.span;
                let argument = call.arguments.pop().expect("checked: one argument");
                argument_to_expression(argument).map(|operand| {
                    Expression::new_yield_expression(span, true, Some(operand), &builder)
                })
            }
            // `_$readPathK(root, k…)` / `_$readPathN(root, [k…])` → `yield* root[k]…`.
            Expression::CallExpression(call)
                if matches!(&call.callee, Expression::Identifier(callee)
                    if callee.name.starts_with("_$readPath"))
                    && !call.arguments.is_empty() =>
            {
                let span = call.span;
                let mut arguments = std::mem::replace(&mut call.arguments, ast.vec()).into_iter();
                let root = arguments.next().and_then(argument_to_expression);
                let mut keys: Vec<Expression<'a>> = Vec::new();
                for argument in arguments {
                    match argument {
                        Argument::ArrayExpression(array) => {
                            for element in array.unbox().elements {
                                if element.is_expression() {
                                    keys.push(element.into_expression());
                                }
                            }
                        }
                        other => keys.extend(argument_to_expression(other)),
                    }
                }
                root.map(|root| {
                    let chain = keys
                        .into_iter()
                        .fold(root, |object, key| member(self.allocator, object, key));
                    Expression::new_yield_expression(span, true, Some(chain), &builder)
                })
            }
            _ => None,
        };
        if let Some(replacement) = replacement {
            *expression = replacement;
        }
        walk_mut::walk_expression(self, expression);
    }
}

/// `object[key]`, as `object.key` when the key is an identifier-name string.
fn member<'a>(
    allocator: &'a Allocator,
    object: Expression<'a>,
    key: Expression<'a>,
) -> Expression<'a> {
    let ast = AstBuilder::new(allocator);
    let synth = Span::new(0, 0);
    if let Expression::StringLiteral(literal) = &key
        && oxc_syntax::identifier::is_identifier_name(literal.value.as_str())
    {
        let name = literal.value.to_string();
        return Expression::StaticMemberExpression(ast.alloc_static_member_expression(
            synth,
            object,
            ast.identifier_name(synth, ast.ident(&name)),
            false,
        ));
    }
    Expression::ComputedMemberExpression(
        ast.alloc_computed_member_expression(synth, object, key, false),
    )
}

// --- 7. what is left of `perform` -------------------------------------------------------

/// `_$perform(acc)` of a proven accessor → `_$readAccessor(acc)`, and
/// `_$perform(readStore(s, sel))` → `_$readSelected(s, sel)`, wherever the
/// fusion left them (a prop getter, an attribute the JSX transform may
/// evaluate in the view body): each is what `perform` does with that operand,
/// without the dispatch (`readAccessor`: the read with the strict guard
/// lowered; `readSelected`: the store read op performed). After the JSX
/// transform, the ones inside a computation become plain calls
/// (`fuse_computation_reads`).
fn lower_remaining_reads<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    let mut imports = Imports::new(program);
    let plan: HashMap<Span, String> = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let names = Names::new(program);
        let context = FusionContext {
            scoping: semantic.scoping(),
            nodes: semantic.nodes(),
            symbols: collect_fusion_symbols(program),
        };
        struct Collector<'s, 'x> {
            context: &'s FusionContext<'s>,
            names: &'s Names,
            imports: &'x mut Imports,
            plan: HashMap<Span, String>,
        }
        impl<'b> Visit<'b> for Collector<'_, '_> {
            fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
                let scoping = self.context.scoping;
                if call.arguments.len() == 1
                    && matches!(&call.callee, Expression::Identifier(callee)
                        if callee.name == "_$perform")
                    && let Some((_, source)) = self
                        .names
                        .of(scoping, call)
                        .filter(|(name, _)| *name == "perform")
                {
                    let source = source.to_string();
                    match &call.arguments[0] {
                        Argument::Identifier(accessor)
                            if self
                                .context
                                .reference_symbol(accessor)
                                .is_some_and(|symbol| {
                                    self.context.binding_origin(symbol) == Origin::Accessor
                                }) =>
                        {
                            let local = self.imports.local(&source, "readAccessor");
                            self.plan.insert(call.span, local);
                        }
                        Argument::CallExpression(read)
                            if self.names.is(scoping, read, "readStore")
                                && read.arguments.len() == 2
                                && !read
                                    .arguments
                                    .iter()
                                    .any(|a| matches!(a, Argument::SpreadElement(_))) =>
                        {
                            let local = self.imports.local(&source, "readSelected");
                            self.plan.insert(call.span, local);
                        }
                        _ => {}
                    }
                }
                walk::walk_call_expression(self, call);
            }
        }
        let mut collector = Collector {
            context: &context,
            names: &names,
            imports: &mut imports,
            plan: HashMap::new(),
        };
        collector.visit_program(program);
        collector.plan
    };
    if plan.is_empty() {
        return;
    }
    struct Rewriter<'a> {
        allocator: &'a Allocator,
        plan: HashMap<Span, String>,
    }
    impl<'a> VisitMut<'a> for Rewriter<'a> {
        fn visit_expression(&mut self, expression: &mut Expression<'a>) {
            if let Expression::CallExpression(call) = expression
                && let Some(local) = self.plan.remove(&call.span)
            {
                let ast = AstBuilder::new(self.allocator);
                let span = call.span;
                let argument = call.arguments.pop().expect("planned: one argument");
                let callee = ast.expression_identifier(Span::new(0, 0), ast.ident(&local));
                *expression = match argument {
                    // `_$perform(readStore(s, sel))` → `_$readSelected(s, sel)`.
                    Argument::CallExpression(read) if local.starts_with("_$readSelected") => {
                        let read = read.unbox();
                        ast.expression_call(span, callee, None, read.arguments, false)
                    }
                    argument => ast.expression_call(span, callee, None, ast.vec1(argument), false),
                };
            }
            walk_mut::walk_expression(self, expression);
        }
    }
    Rewriter { allocator, plan }.visit_program(program);
    imports.apply(allocator, program);
}

/// After the DOM JSX transform: inside a computation the transform created
/// (`effect(compute, …)`, `insert(el, compute, …)`, `memo(compute)` from the
/// renderer module), the strict guard is down — the core lowers it for every
/// computation run — so `_$readAccessor(acc)` is `acc()` and
/// `_$readSelected(s, sel)` is `sel(s)` (the fused store read; `s` an
/// identifier or member chain and `sel` an identifier or inline function, so
/// either evaluation order reads the same). Only at the compute's own depth.
pub(crate) fn fuse_computation_reads<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    module_name: &str,
) {
    // The renderer's computation helpers, by local name.
    let mut computations: HashMap<String, usize> = HashMap::new();
    let mut readers = false;
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        for specifier in import.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                continue;
            };
            let imported = specifier.imported.name();
            if import.source.value.as_str() == module_name {
                let argument = match imported.as_str() {
                    "effect" | "memo" => 0,
                    "insert" => 1,
                    _ => continue,
                };
                computations.insert(specifier.local.name.to_string(), argument);
            } else if RUNTIME_SOURCES.contains(&import.source.value.as_str())
                && matches!(imported.as_str(), "readAccessor" | "readSelected")
            {
                readers = true;
            }
        }
    }
    if computations.is_empty() || !readers {
        return;
    }
    struct Fuser<'a> {
        allocator: &'a Allocator,
        computations: HashMap<String, usize>,
        /// Inside a compute function, at its own depth.
        depth: Option<usize>,
    }
    impl<'a> Fuser<'a> {
        fn fuse(&self, expression: &mut Expression<'a>) {
            let Expression::CallExpression(call) = expression else {
                return;
            };
            let Expression::Identifier(callee) = &call.callee else {
                return;
            };
            let ast = AstBuilder::new(self.allocator);
            if callee.name.starts_with("_$readAccessor")
                && call.arguments.len() == 1
                && matches!(call.arguments[0], Argument::Identifier(_))
            {
                let span = call.span;
                let accessor = argument_to_expression(call.arguments.pop().expect("one"))
                    .expect("an identifier");
                *expression = ast.expression_call(span, accessor, None, ast.vec(), false);
            } else if callee.name.starts_with("_$readSelected")
                && call.arguments.len() == 2
                && (matches!(call.arguments[0], Argument::Identifier(_))
                    || crate::generators::member_chain_root(call.arguments[0].to_expression())
                        .is_some())
                && matches!(
                    call.arguments[1],
                    Argument::Identifier(_)
                        | Argument::ArrowFunctionExpression(_)
                        | Argument::FunctionExpression(_)
                )
            {
                let span = call.span;
                let selector =
                    argument_to_expression(call.arguments.pop().expect("two")).expect("a selector");
                let store = call.arguments.pop().expect("two");
                *expression = ast.expression_call(
                    span,
                    ast.expression_parenthesized(Span::new(0, 0), selector),
                    None,
                    ast.vec1(store),
                    false,
                );
            }
        }
    }
    impl<'a> VisitMut<'a> for Fuser<'a> {
        fn visit_function(&mut self, it: &mut Function<'a>, flags: ScopeFlags) {
            let saved = self.depth.map(|d| d + 1);
            let prev = std::mem::replace(&mut self.depth, saved);
            walk_mut::walk_function(self, it, flags);
            self.depth = prev;
        }
        fn visit_arrow_function_expression(
            &mut self,
            it: &mut oxc_ast::ast::ArrowFunctionExpression<'a>,
        ) {
            let saved = self.depth.map(|d| d + 1);
            let prev = std::mem::replace(&mut self.depth, saved);
            walk_mut::walk_arrow_function_expression(self, it);
            self.depth = prev;
        }
        fn visit_expression(&mut self, expression: &mut Expression<'a>) {
            if self.depth == Some(1) {
                self.fuse(expression);
            }
            walk_mut::walk_expression(self, expression);
        }
        fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
            let compute = match &call.callee {
                Expression::Identifier(callee) => {
                    self.computations.get(callee.name.as_str()).copied()
                }
                _ => None,
            };
            let Some(index) = compute else {
                walk_mut::walk_call_expression(self, call);
                return;
            };
            self.visit_expression(&mut call.callee);
            for (i, argument) in call.arguments.iter_mut().enumerate() {
                let is_compute = i == index
                    && matches!(
                        argument,
                        Argument::ArrowFunctionExpression(_) | Argument::FunctionExpression(_)
                    );
                if is_compute {
                    // The compute function itself is depth 1.
                    let prev = self.depth.replace(0);
                    self.visit_argument(argument);
                    self.depth = prev;
                } else {
                    // Anything else (an apply function, a nested call) is
                    // not a compute's own depth.
                    let prev = self.depth.take();
                    self.visit_argument(argument);
                    self.depth = prev;
                }
            }
        }
    }
    Fuser {
        allocator,
        computations,
        depth: None,
    }
    .visit_program(program);
}
