//! Generator blocks v2: client lowering (DOM output, on by default with the
//! v2 fusion; `hostFusion: false` turns it off).
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
//! Only SYNC-flagged blocks are erased, and only in DOM output: a flagged
//! `$` call passed to `$component` / `$event` is never wrapped in a
//! hydration id scope (`block_scope.rs`; flagged views are, on both sides,
//! as `$` or `syncBlock`), so erasing it on the client alone keeps hydration
//! ids aligned with the server, and every primitive is still created in the
//! same order.
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
    BodyCheck, FusionContext, FusionPlan, FusionRewriter, READ_VALUE_LOCAL, collect_fusion_symbols,
};
use crate::shared::ast::{argument_to_expression, expression_to_argument};
use crate::shared::ast_builder::AstBuilder;

#[cfg(test)]
mod tests;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];

/// Run the v2 client lowering over a DOM program (after fusion).
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
        // `store_forms.rs` (a later pass) adds `createPlainStore as
        // _$createPlainStore` without checking for an existing specifier.
        let base = match imported {
            "createPlainStore" => "_$plainStore".to_string(),
            _ => format!("_${imported}"),
        };
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

/// A lowered (call-form) function the compiler built from a v2 body.
fn lowered(function: &Function<'_>) -> bool {
    !function.generator && !function.r#async && function.body.is_some()
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
}

fn lower_operations<'a>(allocator: &'a Allocator, program: &mut Program<'a>, v2: &V2Bodies) {
    let mut imports = Imports::new(program);
    let plan = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let names = Names::new(program);
        let mut collector = OpsCollector {
            scoping: semantic.scoping(),
            nodes: semantic.nodes(),
            names: &names,
            v2,
            imports: &mut imports,
            plan: OpsPlan::default(),
            stack: Vec::new(),
        };
        collector.visit_program(program);
        collector.plan
    };
    if plan.direct.is_empty() && plan.unwrap.is_empty() && plan.throws.is_empty() {
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
            ("$flush", V2Kind::Event) if statement && op.arguments.is_empty() => ("flush", false),
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

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::CallExpression(call) = expression {
            let span = call.span;
            if let Some(value) = self.plan.unwrap.remove(&span) {
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
    if plan.fusion.blocks.is_empty() {
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
    } = plan;
    EraseRewriter {
        allocator,
        halves,
        events,
        setups,
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
        if !lowered(function) || !sync_flagged(block) || !self.is_v2(block) {
            return;
        }
        // What the call becomes when its block is erasable, and whether the
        // check skips nested blocks (a setup's views, events and memos).
        let (target, skip_blocks) = match name {
            "effectBlock"
                if call.arguments.len() == 2
                    && function.params.items.len() == 1
                    && function.params.rest.is_none()
                    && half_cleanups(function).is_some() =>
            {
                ("createEffect", false)
            }
            "$event" if call.arguments.len() == 1 => ("$eventCompiled", false),
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
        {
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
