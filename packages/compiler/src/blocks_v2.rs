//! Generator blocks v2 (documentation/plans/generator-blocks-v2.md): a
//! pre-pass that rewrites the v2 block forms into the `$(function* …)` shape
//! the generator pass (`generators.rs`) lowers, so v2 bodies get the same
//! call-form lowering, `yield*`-in-JSX support and block proofs.
//!
//! ```js
//! const Card = $component(function* (props) {
//!   const [n, setN] = yield* $signal(0);
//!   yield* $effect(function* () { log(yield* n, yield* props.id); });
//!   return function* () { return <p>{yield* n}{Loading({ children: Child({ id: yield* props.id }) })}</p>; };
//! });
//! // →
//! const Card = $component(_$$(function* (props) {
//!   const [n, setN] = yield* $signal(0);
//!   yield* $effect(_$$(function* (_$v) { log(_$v[0], _$v[1]); }),
//!                  _$$(function* () { return [yield* n, yield* props.id]; }));
//!   return _$$(function* () { return <p>{yield* n}{Loading({ get children() { return Child({ get id() { return yield* props.id; } }); } })}</p>; });
//! }));
//! ```
//!
//! What the pass does:
//!
//! - **Bodies.** The generator argument of `$component` / `$memo` / `$event`,
//!   of a single-argument `createMemo`, and the generator a component setup
//!   returns (its view) are wrapped in `$` (imported as `_$$`); the runtime
//!   constructors accept a prebuilt block.
//! - **Effect split.** `$effect(function* …)` and `createEffect(function* …)`
//!   hoist every read into a compute block; the body receives the values as
//!   `_$v[i]`. Version one hoists reads in branches unconditionally (a
//!   superset subscription with correct values) and refuses the split — the
//!   effect stays one tracked pass — when a read sits in a loop, reads a
//!   binding declared inside the effect, or the body declares parameters.
//!   A plain `createEffect(function* …)` becomes `effectBlock(…)`.
//! - **Lazy props.** A component call with an object literal — `Loading(…)`
//!   / `Errored(…)` anywhere, any capitalized callee inside a view — gets
//!   getters for its non-literal props, so children are created where the
//!   callee evaluates them (inside a boundary) and props stay reactive.
//!   Inside a getter a `yield*` would not belong to the view, so a view read
//!   there is a compile error: read into a `const` first.
//! - **Host rules.** Each operation is checked against the block kind
//!   (`[OP_NOT_ALLOWED]`), mirroring the runtime admission matrix and the
//!   types: setup creates / cleans up / reads context; a view only reads; a
//!   memo reads, raises and attempts; an effect reads, writes, cleans up,
//!   raises and attempts; an event reads, writes, flushes, raises and
//!   attempts.
use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, CallExpression, DoWhileStatement, Expression,
    ForInStatement, ForOfStatement, ForStatement, FormalParameterKind, Function, FunctionType,
    IdentifierReference, ImportDeclarationSpecifier, ImportOrExportKind, ObjectPropertyKind,
    Program, PropertyKey, PropertyKind, ReturnStatement, Statement, VariableDeclarator,
    WhileStatement, YieldExpression,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use crate::shared::ast::{expression_to_argument, object_getter_property};
use crate::shared::ast_builder::AstBuilder;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
const BOUNDARY_SOURCES: &[&str] = &["solid-js", "@solidjs/web"];
/// The local name the wrapped bodies call.
pub(crate) const BLOCK_LOCAL: &str = "_$$";
const EFFECT_BLOCK_LOCAL: &str = "_$effectBlock";
const SETTLED_BLOCK_LOCAL: &str = "_$settledBlock";
const VALUES_PARAM: &str = "_$v";

/// The kind of a v2 block body, which decides the operations it admits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum V2Kind {
    Setup,
    View,
    Memo,
    Effect,
    Event,
}

impl V2Kind {
    fn name(self) -> &'static str {
        match self {
            V2Kind::Setup => "component setup",
            V2Kind::View => "view",
            V2Kind::Memo => "memo",
            V2Kind::Effect => "effect",
            V2Kind::Event => "event",
        }
    }

    fn rules(self) -> &'static str {
        match self {
            V2Kind::Setup => {
                "setup creates state ($signal, $store, $memo, $effect), registers $cleanup and reads context (yield* Ctx); reads belong in the view"
            }
            V2Kind::View => "a view only reads (yield* source, yield* Child(props))",
            V2Kind::Memo => "a memo reads, raises and attempts; it never writes or cleans up",
            V2Kind::Effect => {
                "an effect reads, writes, registers $cleanup, raises and attempts (sync); it never creates or flushes"
            }
            V2Kind::Event => {
                "an event reads, writes, flushes, raises and attempts; it never creates or cleans up"
            }
        }
    }

    /// The body is lowered to call form only when every operation it yields
    /// is synchronous: an `attempt` in a memo or event may be async, so it
    /// stays with the runtime driver.
    pub(crate) fn attempt_may_suspend(self) -> bool {
        matches!(self, V2Kind::Memo | V2Kind::Event)
    }
}

/// What the generator pass needs to know about the rewritten bodies: the span
/// of each synthesized `_$$(…)` call and its kind.
#[derive(Default)]
pub(crate) struct V2Bodies {
    pub(crate) kinds: Vec<(Span, V2Kind)>,
}

impl V2Bodies {
    pub(crate) fn kind_of(&self, span: Span) -> Option<V2Kind> {
        self.kinds.iter().find(|(s, _)| *s == span).map(|(_, k)| *k)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Name {
    Component,
    Memo,
    Effect,
    Event,
    Signal,
    Store,
    Cleanup,
    Flush,
    Raise,
    Attempt,
    CreateMemo,
    CreateEffect,
    /// `$settled(function* …)`: a run-once effect created in setup.
    Settled,
    /// `onSettled(function* …)`: the plain host's run-once effect.
    OnSettled,
    Boundary,
}

/// An operation, classified from the syntax of a `yield*` operand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpClass {
    Create,
    Cleanup,
    Flush,
    Raise,
    Attempt,
    Write,
    /// A read of a source (`yield* x`, `yield* a.b`).
    Read,
    /// A read the setup may not perform: a `$signal` / `$memo` accessor or a
    /// props path.
    StateRead,
    /// Any other call (a child view, a setter receipt of unknown origin, a
    /// helper): admitted everywhere.
    Other,
}

impl OpClass {
    fn name(self) -> &'static str {
        match self {
            OpClass::Create => "create",
            OpClass::Cleanup => "cleanup",
            OpClass::Flush => "flush",
            OpClass::Raise => "raise",
            OpClass::Attempt => "attempt",
            OpClass::Write => "write",
            OpClass::Read | OpClass::StateRead => "read",
            OpClass::Other => "call",
        }
    }

    fn allowed_in(self, kind: V2Kind) -> bool {
        use OpClass::*;
        match kind {
            V2Kind::Setup => matches!(self, Create | Cleanup | Read | Other),
            V2Kind::View => matches!(self, Read | StateRead | Other),
            V2Kind::Memo => matches!(self, Read | StateRead | Raise | Attempt | Other),
            V2Kind::Effect => {
                matches!(
                    self,
                    Read | StateRead | Write | Cleanup | Raise | Attempt | Other
                )
            }
            V2Kind::Event => {
                matches!(
                    self,
                    Read | StateRead | Write | Flush | Raise | Attempt | Other
                )
            }
        }
    }
}

/// Rewrite the v2 forms in `program`; returns the synthesized bodies for the
/// generator pass, or the first compile error.
pub(crate) fn transform_blocks_v2<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &'a str,
) -> Result<V2Bodies, String> {
    if !imports_v2(program) {
        return Ok(V2Bodies::default());
    }
    let (plan, import_span) = {
        let semantic = SemanticBuilder::new().build(program).semantic;
        let scoping = semantic.scoping();
        let names = collect_names(program);
        let mut bindings = BindingCollector {
            scoping,
            names: &names,
            accessors: HashSet::new(),
            setters: HashSet::new(),
        };
        bindings.visit_program(program);
        let mut analysis = Analysis {
            scoping,
            names: &names,
            accessors: bindings.accessors,
            setters: bindings.setters,
            source,
            plan: Plan::default(),
        };
        analysis.visit_program(program);
        if let Some(error) = analysis.plan.error.take() {
            return Err(error);
        }
        (analysis.plan, runtime_import_span(program))
    };
    if plan.is_empty() {
        return Ok(V2Bodies::default());
    }
    let Some(import_span) = import_span else {
        return Ok(V2Bodies::default());
    };
    let mut rewriter = Rewriter {
        allocator,
        plan,
        bodies: V2Bodies::default(),
        uses_block: false,
        uses_effect_block: false,
        uses_settled_block: false,
    };
    rewriter.visit_program(program);
    let mut needed = Vec::new();
    if rewriter.uses_block {
        needed.push(("$", BLOCK_LOCAL));
    }
    if rewriter.uses_effect_block {
        needed.push(("effectBlock", EFFECT_BLOCK_LOCAL));
    }
    if rewriter.uses_settled_block {
        needed.push(("settledBlock", SETTLED_BLOCK_LOCAL));
    }
    add_imports(allocator, program, import_span, &needed);
    Ok(rewriter.bodies)
}

/// Cheap syntactic gate: does the module import a v2 constructor, a
/// generator-accepting host or a boundary?
fn imports_v2(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return false;
        };
        let source = import.source.value.as_str();
        (RUNTIME_SOURCES.contains(&source) || BOUNDARY_SOURCES.contains(&source))
            && import.specifiers.iter().flatten().any(|specifier| {
                matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if name_of(source, specifier.imported.name().as_str()).is_some()
                )
            })
    })
}

fn name_of(source: &str, imported: &str) -> Option<Name> {
    if RUNTIME_SOURCES.contains(&source) {
        let name = match imported {
            "$component" => Name::Component,
            "$memo" => Name::Memo,
            "$effect" => Name::Effect,
            "$event" => Name::Event,
            "$signal" => Name::Signal,
            "$store" => Name::Store,
            "$cleanup" => Name::Cleanup,
            "$flush" => Name::Flush,
            "raise" => Name::Raise,
            "attempt" => Name::Attempt,
            "createMemo" => Name::CreateMemo,
            "createEffect" => Name::CreateEffect,
            "$settled" => Name::Settled,
            "onSettled" => Name::OnSettled,
            _ => return boundary(source, imported),
        };
        return Some(name);
    }
    boundary(source, imported)
}

fn boundary(source: &str, imported: &str) -> Option<Name> {
    (BOUNDARY_SOURCES.contains(&source) && matches!(imported, "Loading" | "Errored"))
        .then_some(Name::Boundary)
}

fn collect_names(program: &Program<'_>) -> HashMap<SymbolId, Name> {
    let mut names = HashMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let source = import.source.value.as_str();
        for specifier in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier
                && specifier.import_kind != ImportOrExportKind::Type
                && let Some(name) = name_of(source, specifier.imported.name().as_str())
                && let Some(symbol) = specifier.local.symbol_id.get()
            {
                names.insert(symbol, name);
            }
        }
    }
    names
}

/// The first value import from a runtime source (receives `_$$`).
fn runtime_import_span(program: &Program<'_>) -> Option<Span> {
    program.body.iter().find_map(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return None;
        };
        (RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.import_kind != ImportOrExportKind::Type)
            .then_some(import.span)
    })
}

fn resolve(scoping: &Scoping, reference: &IdentifierReference<'_>) -> Option<SymbolId> {
    reference
        .reference_id
        .get()
        .and_then(|id| scoping.get_reference(id).symbol_id())
}

fn callee_name(
    scoping: &Scoping,
    names: &HashMap<SymbolId, Name>,
    call: &CallExpression<'_>,
) -> Option<Name> {
    let Expression::Identifier(callee) = &call.callee else {
        return None;
    };
    resolve(scoping, callee).and_then(|symbol| names.get(&symbol).copied())
}

fn generator_argument<'b, 'a>(call: &'b CallExpression<'a>) -> Option<&'b Function<'a>> {
    match call.arguments.first() {
        Some(Argument::FunctionExpression(function)) if function.generator && !function.r#async => {
            Some(function)
        }
        _ => None,
    }
}

fn diagnostic(source: &str, span: Span, message: &str) -> String {
    let offset = (span.start as usize).min(source.len());
    let before = &source[..offset];
    let line = before.matches('\n').count() + 1;
    let column = before
        .rsplit('\n')
        .next()
        .map_or(0, |tail| tail.chars().count())
        + 1;
    format!("{message} ({line}:{column})")
}

// --- bindings -------------------------------------------------------------------

/// Accessors and setters bound from `yield* $signal(…)` / `$store(…)` /
/// `$memo(…)`: reading an accessor is a read, calling a setter a write.
struct BindingCollector<'s> {
    scoping: &'s Scoping,
    names: &'s HashMap<SymbolId, Name>,
    accessors: HashSet<SymbolId>,
    setters: HashSet<SymbolId>,
}

impl<'b> Visit<'b> for BindingCollector<'_> {
    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'b>) {
        if let Some(Expression::YieldExpression(yield_expression)) = &declarator.init
            && yield_expression.delegate
            && let Some(Expression::CallExpression(call)) = &yield_expression.argument
            && let Some(name) = callee_name(self.scoping, self.names, call)
        {
            match (&declarator.id, name) {
                (BindingPattern::ArrayPattern(pattern), Name::Signal | Name::Store) => {
                    let mut elements = pattern.elements.iter();
                    if let Some(Some(BindingPattern::BindingIdentifier(id))) = elements.next()
                        && let Some(symbol) = id.symbol_id.get()
                    {
                        self.accessors.insert(symbol);
                    }
                    if let Some(Some(BindingPattern::BindingIdentifier(id))) = elements.next()
                        && let Some(symbol) = id.symbol_id.get()
                    {
                        self.setters.insert(symbol);
                    }
                }
                (BindingPattern::BindingIdentifier(id), Name::Memo) => {
                    if let Some(symbol) = id.symbol_id.get() {
                        self.accessors.insert(symbol);
                    }
                }
                _ => {}
            }
        }
        walk::walk_variable_declarator(self, declarator);
    }
}

// --- analysis -------------------------------------------------------------------

#[derive(Default)]
struct Plan {
    /// Generator function spans wrapped in `_$$(…)`, by kind.
    wraps: Vec<(Span, V2Kind)>,
    /// Effect calls (`$effect(…)` / `createEffect(…)`), by call span.
    effects: Vec<(Span, EffectPlan)>,
    /// Component calls whose object literal props become getters.
    lazy: HashSet<Span>,
    /// `onSettled(function* …)` calls, whose callee becomes `settledBlock`.
    settled: HashSet<Span>,
    error: Option<String>,
}

impl Plan {
    fn is_empty(&self) -> bool {
        self.wraps.is_empty()
            && self.effects.is_empty()
            && self.lazy.is_empty()
            && self.settled.is_empty()
    }
}

#[derive(Clone)]
struct EffectPlan {
    /// A plain `createEffect(function* …)`: becomes `effectBlock(…)`.
    plain: bool,
    /// The hoisted reads (`yield` span → slot), or `None` when the split is
    /// refused.
    split: Option<Vec<(Span, usize)>>,
}

struct Analysis<'s> {
    scoping: &'s Scoping,
    names: &'s HashMap<SymbolId, Name>,
    accessors: HashSet<SymbolId>,
    setters: HashSet<SymbolId>,
    source: &'s str,
    plan: Plan,
}

impl<'b> Visit<'b> for Analysis<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        if self.plan.error.is_none() {
            self.plan_call(call);
        }
        walk::walk_call_expression(self, call);
    }
}

impl Analysis<'_> {
    fn fail(&mut self, span: Span, message: &str) {
        if self.plan.error.is_none() {
            self.plan.error = Some(diagnostic(self.source, span, message));
        }
    }

    fn plan_call(&mut self, call: &CallExpression<'_>) {
        let name = callee_name(self.scoping, self.names, call);
        if name == Some(Name::Boundary) && lazy_eligible(call) {
            self.plan.lazy.insert(call.span);
        }
        let Some(name) = name else { return };
        let Some(function) = generator_argument(call) else {
            return;
        };
        match name {
            Name::Component if call.arguments.len() == 1 => {
                self.plan.wraps.push((function.span, V2Kind::Setup));
                self.check_body(function, V2Kind::Setup);
            }
            Name::Memo | Name::CreateMemo if call.arguments.len() == 1 => {
                self.plan.wraps.push((function.span, V2Kind::Memo));
                self.check_body(function, V2Kind::Memo);
            }
            Name::Event if call.arguments.len() == 1 => {
                self.plan.wraps.push((function.span, V2Kind::Event));
                self.check_body(function, V2Kind::Event);
            }
            // A run-once effect: effect rules, no split (it never re-runs, so
            // there is no compute half to subscribe).
            Name::Settled | Name::OnSettled if call.arguments.len() == 1 => {
                self.plan.wraps.push((function.span, V2Kind::Effect));
                self.check_body(function, V2Kind::Effect);
                if name == Name::OnSettled {
                    self.plan.settled.insert(call.span);
                }
            }
            Name::Effect | Name::CreateEffect if call.arguments.len() == 1 => {
                self.check_body(function, V2Kind::Effect);
                let split = self.plan_split(function);
                self.plan.effects.push((
                    call.span,
                    EffectPlan {
                        plain: name == Name::CreateEffect,
                        split,
                    },
                ));
            }
            _ => {}
        }
    }

    /// Check a body's operations against its kind; a setup's returned view
    /// is planned and checked as a view.
    fn check_body(&mut self, function: &Function<'_>, kind: V2Kind) {
        let Some(body) = function.body.as_ref() else {
            return;
        };
        let props = (kind == V2Kind::Setup)
            .then(|| {
                function
                    .params
                    .items
                    .first()
                    .and_then(|param| param.pattern.get_binding_identifier())
                    .and_then(|id| id.symbol_id.get())
            })
            .flatten();
        let mut checker = BodyChecker {
            analysis: self,
            kind,
            props,
            getter_depth: 0,
        };
        checker.visit_function_body(body);
    }

    /// The reads an effect hoists into its compute block, or `None` when the
    /// split is refused.
    fn plan_split(&self, function: &Function<'_>) -> Option<Vec<(Span, usize)>> {
        if !function.params.items.is_empty() || function.params.rest.is_some() {
            return None;
        }
        let body = function.body.as_ref()?;
        let mut hoister = Hoister {
            analysis: self,
            function_span: function.span,
            loop_depth: 0,
            reads: Vec::new(),
            slots: Vec::new(),
            refused: false,
        };
        hoister.visit_function_body(body);
        (!hoister.refused).then_some(hoister.reads)
    }

    fn classify(&self, operand: &Expression<'_>, props: Option<SymbolId>) -> OpClass {
        match operand {
            Expression::CallExpression(call) => {
                if let Some(name) = callee_name(self.scoping, self.names, call) {
                    return match name {
                        Name::Signal | Name::Store | Name::Memo | Name::Effect | Name::Settled => {
                            OpClass::Create
                        }
                        Name::Cleanup => OpClass::Cleanup,
                        Name::Flush => OpClass::Flush,
                        Name::Raise => OpClass::Raise,
                        Name::Attempt => OpClass::Attempt,
                        _ => OpClass::Other,
                    };
                }
                if let Expression::Identifier(callee) = &call.callee
                    && resolve(self.scoping, callee).is_some_and(|s| self.setters.contains(&s))
                {
                    return OpClass::Write;
                }
                OpClass::Other
            }
            Expression::Identifier(id) => {
                if resolve(self.scoping, id).is_some_and(|s| self.accessors.contains(&s)) {
                    OpClass::StateRead
                } else {
                    OpClass::Read
                }
            }
            _ => match crate::generators::member_chain_root(operand) {
                Some(root) => {
                    let symbol = resolve(self.scoping, root);
                    if symbol.is_some_and(|s| Some(s) == props || self.accessors.contains(&s)) {
                        OpClass::StateRead
                    } else {
                        OpClass::Read
                    }
                }
                None => OpClass::Other,
            },
        }
    }
}

/// A call whose props can become getters: one object literal argument of
/// plain `key: value` properties.
fn lazy_eligible(call: &CallExpression<'_>) -> bool {
    let [Argument::ObjectExpression(object)] = call.arguments.as_slice() else {
        return false;
    };
    object.properties.iter().all(|property| match property {
        ObjectPropertyKind::ObjectProperty(property) => {
            property.kind == PropertyKind::Init
                && !property.method
                && !property.computed
                && matches!(
                    property.key,
                    PropertyKey::StaticIdentifier(_) | PropertyKey::StringLiteral(_)
                )
        }
        ObjectPropertyKind::SpreadProperty(_) => false,
    })
}

fn starts_uppercase(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

struct BodyChecker<'x, 's> {
    analysis: &'x mut Analysis<'s>,
    kind: V2Kind,
    props: Option<SymbolId>,
    /// Inside the getter-to-be of a lazy prop (a `yield*` there would move
    /// into a getter).
    getter_depth: usize,
}

impl<'b> Visit<'b> for BodyChecker<'_, '_> {
    // Nested functions are their own bodies (a nested v2 constructor is
    // planned by the outer walk).
    fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &oxc_ast::ast::ArrowFunctionExpression<'b>) {}

    fn visit_return_statement(&mut self, statement: &ReturnStatement<'b>) {
        if self.kind == V2Kind::Setup
            && let Some(Expression::FunctionExpression(view)) = &statement.argument
            && view.generator
            && !view.r#async
        {
            self.analysis.plan.wraps.push((view.span, V2Kind::View));
            self.analysis.check_body(view, V2Kind::View);
            return;
        }
        walk::walk_return_statement(self, statement);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        let lazy = self.kind == V2Kind::View
            && lazy_eligible(call)
            && matches!(&call.callee, Expression::Identifier(callee)
                if starts_uppercase(&callee.name)
                    && callee_name(self.analysis.scoping, self.analysis.names, call)
                        .is_none_or(|name| name == Name::Boundary));
        let boundary = callee_name(self.analysis.scoping, self.analysis.names, call)
            == Some(Name::Boundary)
            && lazy_eligible(call);
        if lazy {
            self.analysis.plan.lazy.insert(call.span);
        }
        if lazy || boundary {
            walk::walk_expression(self, &call.callee);
            self.getter_depth += 1;
            for argument in &call.arguments {
                self.visit_argument(argument);
            }
            self.getter_depth -= 1;
            return;
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_yield_expression(&mut self, it: &YieldExpression<'b>) {
        if self.getter_depth > 0 {
            self.analysis.fail(
                it.span,
                "[YIELD_IN_LAZY_PROP] a `yield*` inside a component call's props would move into a lazy prop getter; read it into a `const` in the view first",
            );
            return;
        }
        if it.delegate
            && let Some(operand) = &it.argument
        {
            let class = self.analysis.classify(operand, self.props);
            if !class.allowed_in(self.kind) {
                let message = format!(
                    "[OP_NOT_ALLOWED] `{}` is not allowed in a {} block: {}",
                    class.name(),
                    self.kind.name(),
                    self.kind.rules()
                );
                self.analysis.fail(it.span, &message);
            }
        }
        walk::walk_yield_expression(self, it);
    }
}

struct Hoister<'x, 's> {
    analysis: &'x Analysis<'s>,
    function_span: Span,
    loop_depth: usize,
    reads: Vec<(Span, usize)>,
    /// Operand source text of each slot (duplicate reads share a slot).
    slots: Vec<String>,
    refused: bool,
}

impl<'b> Visit<'b> for Hoister<'_, '_> {
    fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &oxc_ast::ast::ArrowFunctionExpression<'b>) {}

    fn visit_for_statement(&mut self, it: &ForStatement<'b>) {
        self.loop_depth += 1;
        walk::walk_for_statement(self, it);
        self.loop_depth -= 1;
    }
    fn visit_for_in_statement(&mut self, it: &ForInStatement<'b>) {
        self.loop_depth += 1;
        walk::walk_for_in_statement(self, it);
        self.loop_depth -= 1;
    }
    fn visit_for_of_statement(&mut self, it: &ForOfStatement<'b>) {
        self.loop_depth += 1;
        walk::walk_for_of_statement(self, it);
        self.loop_depth -= 1;
    }
    fn visit_while_statement(&mut self, it: &WhileStatement<'b>) {
        self.loop_depth += 1;
        walk::walk_while_statement(self, it);
        self.loop_depth -= 1;
    }
    fn visit_do_while_statement(&mut self, it: &DoWhileStatement<'b>) {
        self.loop_depth += 1;
        walk::walk_do_while_statement(self, it);
        self.loop_depth -= 1;
    }

    fn visit_yield_expression(&mut self, it: &YieldExpression<'b>) {
        let Some(operand) = it.argument.as_ref().filter(|_| it.delegate) else {
            walk::walk_yield_expression(self, it);
            return;
        };
        if !matches!(
            self.analysis.classify(operand, None),
            OpClass::Read | OpClass::StateRead
        ) {
            walk::walk_yield_expression(self, it);
            return;
        }
        if self.loop_depth > 0 || !self.free(operand) {
            self.refused = true;
            return;
        }
        let span = operand.span();
        let text = &self.analysis.source[span.start as usize..span.end as usize];
        let slot = match self.slots.iter().position(|s| s == text) {
            Some(slot) => slot,
            None => {
                self.slots.push(text.to_string());
                self.slots.len() - 1
            }
        };
        self.reads.push((it.span, slot));
    }
}

impl Hoister<'_, '_> {
    /// Every binding the operand references is declared outside the effect.
    fn free(&self, operand: &Expression<'_>) -> bool {
        struct Refs<'s> {
            scoping: &'s Scoping,
            inside: Span,
            free: bool,
        }
        impl<'b> Visit<'b> for Refs<'_> {
            fn visit_identifier_reference(&mut self, it: &IdentifierReference<'b>) {
                if let Some(symbol) = resolve(self.scoping, it) {
                    let declared = self.scoping.symbol_span(symbol);
                    if self.inside.contains_inclusive(declared) {
                        self.free = false;
                    }
                }
            }
        }
        let mut refs = Refs {
            scoping: self.analysis.scoping,
            inside: self.function_span,
            free: true,
        };
        refs.visit_expression(operand);
        refs.free
    }
}

// --- rewrite ---------------------------------------------------------------------

struct Rewriter<'a> {
    allocator: &'a Allocator,
    plan: Plan,
    bodies: V2Bodies,
    uses_block: bool,
    uses_effect_block: bool,
    uses_settled_block: bool,
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        // Post-order: nested bodies and calls are rewritten first.
        walk_mut::walk_expression(self, expression);
        match expression {
            Expression::FunctionExpression(function) => {
                if let Some(kind) = self.wrap_kind(function.span) {
                    let span = function.span;
                    let taken = std::mem::replace(expression, self.placeholder());
                    *expression = self.wrap(span, kind, taken);
                }
            }
            Expression::CallExpression(call) => {
                if self.plan.lazy.contains(&call.span) {
                    self.make_props_lazy(call);
                }
                if self.plan.settled.contains(&call.span) {
                    let ast = AstBuilder::new(self.allocator);
                    let callee_span = call.callee.span();
                    call.callee =
                        ast.expression_identifier(callee_span, ast.ident(SETTLED_BLOCK_LOCAL));
                    self.uses_settled_block = true;
                }
                if let Some(index) = self.plan.effects.iter().position(|(s, _)| *s == call.span) {
                    let (_, effect) = self.plan.effects.remove(index);
                    self.rewrite_effect(call, effect);
                }
            }
            _ => {}
        }
    }
}

impl<'a> Rewriter<'a> {
    fn placeholder(&self) -> Expression<'a> {
        AstBuilder::new(self.allocator).void_0(Span::new(0, 0))
    }

    fn wrap_kind(&self, span: Span) -> Option<V2Kind> {
        self.plan
            .wraps
            .iter()
            .find(|(s, _)| *s == span)
            .map(|(_, k)| *k)
    }

    /// `_$$(fn)`: the call carries the function's span, which the generator
    /// pass keys its plan on.
    fn wrap(&mut self, span: Span, kind: V2Kind, function: Expression<'a>) -> Expression<'a> {
        let ast = AstBuilder::new(self.allocator);
        self.uses_block = true;
        self.bodies.kinds.push((span, kind));
        ast.expression_call(
            span,
            ast.expression_identifier(Span::new(0, 0), ast.ident(BLOCK_LOCAL)),
            None,
            ast.vec1(expression_to_argument(function)),
            false,
        )
    }

    fn make_props_lazy(&mut self, call: &mut CallExpression<'a>) {
        let Some(Argument::ObjectExpression(object)) = call.arguments.first_mut() else {
            return;
        };
        let ast = AstBuilder::new(self.allocator);
        let properties = std::mem::replace(&mut object.properties, ast.vec());
        let mut rewritten = ast.vec_with_capacity(properties.len());
        for property in properties {
            let ObjectPropertyKind::ObjectProperty(property) = property else {
                rewritten.push(property);
                continue;
            };
            let keep = matches!(
                property.value,
                Expression::StringLiteral(_)
                    | Expression::NumericLiteral(_)
                    | Expression::BooleanLiteral(_)
                    | Expression::NullLiteral(_)
                    | Expression::FunctionExpression(_)
                    | Expression::ArrowFunctionExpression(_)
            );
            let name = match &property.key {
                PropertyKey::StaticIdentifier(id) => id.name.to_string(),
                PropertyKey::StringLiteral(literal) => literal.value.to_string(),
                _ => {
                    rewritten.push(ObjectPropertyKind::ObjectProperty(property));
                    continue;
                }
            };
            if keep {
                rewritten.push(ObjectPropertyKind::ObjectProperty(property));
                continue;
            }
            let property = property.unbox();
            rewritten.push(object_getter_property(
                self.allocator,
                property.span,
                &name,
                property.value,
            ));
        }
        object.properties = rewritten;
    }

    fn rewrite_effect(&mut self, call: &mut CallExpression<'a>, effect: EffectPlan) {
        let ast = AstBuilder::new(self.allocator);
        let Some(argument) = call.arguments.pop() else {
            return;
        };
        let Some(Expression::FunctionExpression(mut function)) =
            crate::shared::ast::argument_to_expression(argument)
        else {
            return;
        };
        let body_span = function.span;
        let mut arguments = ast.vec();
        let mut compute = None;
        if let Some(reads) = effect.split.filter(|reads| !reads.is_empty()) {
            // Replace the reads with `_$v[i]`, keeping each slot's first operand.
            let slots = reads
                .iter()
                .map(|(_, slot)| *slot)
                .max()
                .map_or(0, |m| m + 1);
            let mut replacer = ReadReplacer {
                allocator: self.allocator,
                reads,
                operands: (0..slots).map(|_| None).collect(),
            };
            if let Some(body) = function.body.as_mut() {
                replacer.visit_function_body(body);
            }
            let param = ast.formal_parameter(
                Span::new(0, 0),
                ast.vec(),
                ast.binding_pattern_binding_identifier(Span::new(0, 0), ast.ident(VALUES_PARAM)),
                None,
                None,
                false,
                None,
                false,
                false,
            );
            function.params.items.push(param);
            // `_$$(function* () { return [yield* a, yield* b]; })`, on a span
            // no source node has (the call's first byte).
            let compute_span = Span::new(call.span.start, call.span.start + 1);
            let elements = ast.vec_from_iter(replacer.operands.into_iter().flatten().map(
                |(span, operand)| {
                    ArrayExpressionElement::from(ast.expression_yield(span, true, Some(operand)))
                },
            ));
            let body = ast.function_body(
                compute_span,
                ast.vec(),
                ast.vec1(ast.statement_return(
                    compute_span,
                    Some(ast.expression_array(compute_span, elements)),
                )),
            );
            let function_expression = ast.expression_function(
                compute_span,
                FunctionType::FunctionExpression,
                None,
                true,
                false,
                false,
                None,
                None,
                ast.formal_parameters(
                    compute_span,
                    FormalParameterKind::FormalParameter,
                    ast.vec(),
                    None,
                ),
                None,
                Some(body),
            );
            compute = Some(self.wrap(compute_span, V2Kind::Memo, function_expression));
        }
        let body = self.wrap(
            body_span,
            V2Kind::Effect,
            Expression::FunctionExpression(function),
        );
        arguments.push(expression_to_argument(body));
        if let Some(compute) = compute {
            arguments.push(expression_to_argument(compute));
        }
        call.arguments = arguments;
        if effect.plain {
            self.uses_effect_block = true;
            let callee_span = call.callee.span();
            call.callee = ast.expression_identifier(callee_span, ast.ident(EFFECT_BLOCK_LOCAL));
        }
    }
}

struct ReadReplacer<'a> {
    allocator: &'a Allocator,
    reads: Vec<(Span, usize)>,
    /// Each slot's operand and the span of the `yield*` it came from.
    operands: Vec<Option<(Span, Expression<'a>)>>,
}

impl<'a> VisitMut<'a> for ReadReplacer<'a> {
    fn visit_function(&mut self, _: &mut Function<'a>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(
        &mut self,
        _: &mut oxc_ast::ast::ArrowFunctionExpression<'a>,
    ) {
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::YieldExpression(yield_expression) = expression
            && let Some(&(span, slot)) =
                self.reads.iter().find(|(s, _)| *s == yield_expression.span)
        {
            let ast = AstBuilder::new(self.allocator);
            let operand = yield_expression
                .argument
                .take()
                .expect("a hoisted read has an operand");
            if self.operands[slot].is_none() {
                self.operands[slot] = Some((span, operand));
            }
            let synth = Span::new(0, 0);
            *expression =
                Expression::ComputedMemberExpression(ast.alloc_computed_member_expression(
                    span,
                    ast.expression_identifier(synth, ast.ident(VALUES_PARAM)),
                    ast.expression_numeric_literal(
                        synth,
                        slot as f64,
                        None,
                        oxc_syntax::number::NumberBase::Decimal,
                    ),
                    false,
                ));
            return;
        }
        walk_mut::walk_expression(self, expression);
    }
}

fn add_imports<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    import_span: Span,
    needed: &[(&str, &str)],
) {
    let ast = AstBuilder::new(allocator);
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        if import.span != import_span {
            continue;
        }
        let span = Span::new(0, 0);
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

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, Generate, compile};

    fn compile_as(source: &str, generate: Generate) -> Result<String, String> {
        compile(
            source,
            &CompileOptions {
                generate,
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .map_err(|error| error.to_string())
    }

    fn ssr(source: &str) -> Result<String, String> {
        compile_as(source, Generate::Ssr)
    }

    #[test]
    fn lowers_setup_view_memo_and_event_bodies() {
        let out = ssr(
            r#"import { $component, $signal, $memo, $event } from "solid-js";
export const Counter = $component(function* (props) {
  const [count, setCount] = yield* $signal(0);
  const doubled = yield* $memo(function* () { return (yield* count) * 2; });
  const inc = $event(function* () { yield* setCount(c => c + 1); });
  return function* () {
    return <button onClick={inc}>{yield* props.label}{yield* doubled}</button>;
  };
});
"#,
        )
        .unwrap();
        assert!(!out.contains("yield"), "{out}");
        assert!(out.contains("$component(_$$(function(props)"), "{out}");
        assert!(out.contains("_$perform($signal(0))"), "{out}");
        assert!(out.contains("$memo(_$$(function()"), "{out}");
        assert!(out.contains("_$perform(setCount((c) => c + 1))"), "{out}");
        assert!(out.contains("return _$$(function()"), "{out}");
        assert!(out.contains(r#"$ as _$$"#), "{out}");
    }

    #[test]
    fn splits_effects_into_compute_and_effect_halves() {
        let out = ssr(
            r#"import { $component, $signal, $effect, $cleanup } from "solid-js";
export const Search = $component(function* (props) {
  const [url, setUrl] = yield* $signal("");
  yield* $effect(function* () {
    const q = yield* props.query;
    yield* setUrl(`/search?q=${q}`);
    if (yield* url) log(yield* props.query);
    yield* $cleanup(() => cancel());
  });
  return function* () { return yield* url; };
});
"#,
        )
        .unwrap();
        assert!(!out.contains("yield"), "{out}");
        // The body reads the hoisted values; duplicate reads share a slot.
        assert!(out.contains("$effect(_$$(function(_$v)"), "{out}");
        assert!(out.contains("const q = _$v[0];"), "{out}");
        assert!(out.contains("if (_$v[1]) log(_$v[0]);"), "{out}");
        // The compute reads them.
        assert!(
            out.contains(r#"return [_$readPath1(props, "query"), _$perform(url)];"#),
            "{out}"
        );
    }

    #[test]
    fn refuses_the_split_for_reads_of_effect_locals_and_loops() {
        let out = ssr(r#"import { $component, $signal, $effect } from "solid-js";
export const C = $component(function* () {
  const [list] = yield* $signal([]);
  yield* $effect(function* () {
    const current = yield* list;
    for (const item of current) log(yield* item);
  });
  return function* () { return 1; };
});
"#)
        .unwrap();
        assert!(out.contains("$effect(_$$(function()"), "{out}");
        assert!(!out.contains("_$v"), "{out}");
    }

    #[test]
    fn plain_hosts_accept_generator_bodies() {
        let out = ssr(r#"import { createMemo, createEffect } from "solid-js";
const m = createMemo(function* () { return (yield* a) + 1; });
createEffect(function* () { log(yield* m); });
"#)
        .unwrap();
        assert!(!out.contains("yield"), "{out}");
        assert!(out.contains("createMemo(_$$(function()"), "{out}");
        assert!(out.contains("_$effectBlock(_$$(function(_$v)"), "{out}");
        assert!(out.contains("effectBlock as _$effectBlock"), "{out}");
    }

    #[test]
    fn boundaries_and_view_component_calls_get_lazy_props() {
        let out = compile_as(
            r#"import { $component, Loading, Errored } from "solid-js";
export const App = $component(function* () {
  return function* () {
    const user = yield* User({ id: "1" });
    return <main>{Errored({ fallback: err => <p>{err().message}</p>, children: Loading({ fallback: <p>…</p>, children: Profile({ id: current }) }) })}{user}</main>;
  };
});
"#,
            Generate::Dom,
        )
        .unwrap();
        assert!(!out.contains("yield"), "{out}");
        assert!(out.contains("get children()"), "{out}");
        assert!(out.contains("get id()"), "{out}");
        // Literals and functions stay plain.
        assert!(
            out.contains(r#"User({ id: "1" })"#) || out.contains(r#"User({id: "1"})"#),
            "{out}"
        );
        assert!(
            out.contains("fallback: err =>") || out.contains("fallback: (err) =>"),
            "{out}"
        );
    }

    #[test]
    fn host_rules_are_compile_errors() {
        let read_in_setup = ssr(r#"import { $component, $signal } from "solid-js";
export const C = $component(function* (props) {
  const id = yield* props.id;
  return function* () { return id; };
});
"#)
        .unwrap_err();
        assert!(
            read_in_setup
                .contains("[OP_NOT_ALLOWED] `read` is not allowed in a component setup block"),
            "{read_in_setup}"
        );

        let create_in_view = ssr(r#"import { $component, $signal } from "solid-js";
export const C = $component(function* () {
  return function* () { const [n] = yield* $signal(0); return 1; };
});
"#)
        .unwrap_err();
        assert!(
            create_in_view.contains("`create` is not allowed in a view block"),
            "{create_in_view}"
        );

        let write_in_memo = ssr(r#"import { $component, $signal, $memo } from "solid-js";
export const C = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const m = yield* $memo(function* () { yield* setN(1); return 1; });
  return function* () { return 1; };
});
"#)
        .unwrap_err();
        assert!(
            write_in_memo.contains("`write` is not allowed in a memo block"),
            "{write_in_memo}"
        );

        let flush_in_effect = ssr(r#"import { $component, $effect, $flush } from "solid-js";
export const C = $component(function* () {
  yield* $effect(function* () { yield* $flush(); });
  return function* () { return 1; };
});
"#)
        .unwrap_err();
        assert!(
            flush_in_effect.contains("`flush` is not allowed in a effect block")
                || flush_in_effect.contains("`flush` is not allowed in an effect block"),
            "{flush_in_effect}"
        );

        let cleanup_in_event = ssr(r#"import { $event, $cleanup } from "solid-js";
export const h = $event(function* () { yield* $cleanup(() => {}); });
"#)
        .unwrap_err();
        assert!(
            cleanup_in_event.contains("`cleanup` is not allowed in a event block")
                || cleanup_in_event.contains("`cleanup` is not allowed in an event block"),
            "{cleanup_in_event}"
        );

        let yield_in_prop = ssr(r#"import { $component } from "solid-js";
export const C = $component(function* (props) {
  return function* () { return <div>{Child({ id: yield* props.id })}</div>; };
});
"#)
        .unwrap_err();
        assert!(
            yield_in_prop.contains("[YIELD_IN_LAZY_PROP]"),
            "{yield_in_prop}"
        );
    }

    #[test]
    fn async_attempts_stay_with_the_driver() {
        let out = ssr(r#"import { $memo, $event, attempt } from "solid-js";
const m = $memo(function* () { return yield* attempt(() => fetch("/x")); });
const h = $event(function* () { yield* attempt(() => save()); });
"#)
        .unwrap();
        // Wrapped, but left as generators for the runtime driver.
        assert!(out.contains("$memo(_$$(function*"), "{out}");
        assert!(out.contains("$event(_$$(function*"), "{out}");
    }

    #[test]
    fn settled_bodies_run_once_as_effects() {
        let out = ssr(
            r#"import { $component, $settled, $event, $cleanup, onSettled } from "solid-js";
export const App = $component(function* () {
  yield* $settled(function* () {
    const sync = $event(function* () { log(1); });
    window.addEventListener("hashchange", sync);
    yield* $cleanup(() => window.removeEventListener("hashchange", sync));
  });
  return function* () { return 1; };
});
onSettled(function* () { yield* $cleanup(() => log(2)); });
"#,
        )
        .unwrap();
        assert!(!out.contains("yield"), "{out}");
        assert!(out.contains("$settled(_$$(function()"), "{out}");
        assert!(!out.contains("_$v"), "{out}");
        assert!(out.contains("_$settledBlock(_$$(function()"), "{out}");
        assert!(out.contains("settledBlock as _$settledBlock"), "{out}");

        let flush_in_settled = ssr(r#"import { $component, $settled, $flush } from "solid-js";
export const C = $component(function* () {
  yield* $settled(function* () { yield* $flush(); });
  return function* () { return 1; };
});
"#)
        .unwrap_err();
        assert!(
            flush_in_settled.contains("[OP_NOT_ALLOWED] `flush`"),
            "{flush_in_settled}"
        );
    }
}
