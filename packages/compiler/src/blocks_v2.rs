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
/// The local name of `$scope`, which a render-callback block becomes.
const SCOPE_LOCAL: &str = "_$scopeBlock";
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
    /// Client lowering on (DOM output with the v2 fusion): the generator
    /// pass may compile a memo / event body that waits to an `async
    /// function` (see `generators.rs`, "async v2 bodies").
    pub(crate) async_lowering: bool,
    /// The `_$$(…)` calls whose body the generator pass compiled to an
    /// `async function`: `blocks_v2_lower.rs` erases each one, or restores
    /// its generator.
    pub(crate) async_bodies: Vec<Span>,
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
    /// `$scope(function* …)`: a render-callback block (a scope).
    Scope,
    /// `$`: the block constructor (`$(function* (row) …)` as a render callback).
    Block,
    /// `For` / `Show` / `Match` / `Repeat`: flow controls whose render
    /// callback may be a block.
    Flow,
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
    yield_identifier_check(program, source)?;
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
            named_symbols: HashSet::new(),
        };
        analysis.visit_program(program);
        if !analysis.named_symbols.is_empty() {
            let mut named = NamedScopes {
                analysis: &mut analysis,
            };
            named.visit_program(program);
        }
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
        uses_scope: false,
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
    if rewriter.uses_scope {
        needed.push(("$scope", SCOPE_LOCAL));
    }
    add_imports(allocator, program, import_span, &needed);
    Ok(rewriter.bodies)
}

/// `yield` as an identifier reference in module (strict) code: a `yield*`
/// inside a plain arrow or function nested in a generator
/// (`{child => yield* comment(child)}`) is not a delegation there — the
/// parser reads `yield * comment(child)`, a multiplication by a variable
/// named `yield`, which strict code forbids. Report it at its position
/// instead of emitting it.
fn yield_identifier_check(program: &Program<'_>, source: &str) -> Result<(), String> {
    if !program.source_type.is_module() && !program.source_type.is_strict() {
        return Ok(());
    }
    if !source.contains("yield") {
        return Ok(());
    }
    struct Finder {
        found: Option<Span>,
    }
    impl<'b> Visit<'b> for Finder {
        fn visit_identifier_reference(&mut self, it: &IdentifierReference<'b>) {
            if it.name == "yield" && self.found.is_none() {
                self.found = Some(it.span);
            }
        }
    }
    let mut finder = Finder { found: None };
    finder.visit_program(program);
    match finder.found {
        Some(span) => Err(diagnostic(
            source,
            span,
            "[YIELD_IN_CALLBACK] `yield` outside a generator: a `yield*` inside a plain arrow or function callback (`{child => yield* row(child)}`) is not a delegation, it parses as `yield * row(child)` (a multiplication by an identifier named `yield`, which strict code forbids). A render callback that reads or renders a block is a block itself: `{function* (child) { … }}`, or pass the row block (`{row}`)",
        )),
        None => Ok(()),
    }
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
                        if name_of(source, specifier.imported.name().as_str())
                            .is_some_and(|name| !matches!(name, Name::Block | Name::Flow))
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
            "$scope" => Name::Scope,
            "$" => Name::Block,
            _ => return boundary(source, imported),
        };
        return Some(name);
    }
    boundary(source, imported)
}

fn boundary(source: &str, imported: &str) -> Option<Name> {
    if !BOUNDARY_SOURCES.contains(&source) {
        return None;
    }
    match imported {
        "Loading" | "Errored" => Some(Name::Boundary),
        "For" | "Show" | "Match" | "Repeat" => Some(Name::Flow),
        _ => None,
    }
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
    /// Render callbacks that are blocks (a flow control's `function* (row)`
    /// child): function spans wrapped as `_$scope(_$$(fn))`.
    scopes: HashSet<Span>,
    /// `$(function* (row) …)` render callbacks: the `$` call is dropped (its
    /// function becomes the scope).
    scope_calls: HashSet<Span>,
    /// Named row blocks (`function* row(c) { … }` passed as a render
    /// callback): the declaration becomes `const row = _$scope(_$$(…))`.
    named_scopes: HashSet<Span>,
    error: Option<String>,
}

impl Plan {
    fn is_empty(&self) -> bool {
        self.wraps.is_empty()
            && self.effects.is_empty()
            && self.lazy.is_empty()
            && self.settled.is_empty()
            && self.scopes.is_empty()
            && self.named_scopes.is_empty()
    }
}

#[derive(Clone)]
struct EffectPlan {
    /// A plain `createEffect(function* …)`: becomes `effectBlock(…)`.
    plain: bool,
    /// The hoisted reads, or `None` when the split is refused.
    split: Option<SplitPlan>,
}

/// An effect split: the reads the compute half performs, and when.
#[derive(Clone, Default)]
struct SplitPlan {
    /// The hoisted reads (`yield` span → slot).
    reads: Vec<(Span, usize)>,
    /// Per slot: `None` when the compute reads it on every run, else the
    /// disjunction of the conjunctions under which the body reads it (the
    /// compute half keeps the body's control flow: a read in an untaken
    /// branch is not subscribed).
    guards: Vec<Option<Vec<Vec<GuardTerm>>>>,
}

/// One branch condition a read sits under: the test (by span) and the
/// outcome the branch needs. `subs` maps the test's reads and read aliases
/// (`const v = yield* a`) to compute slots.
#[derive(Clone, Debug, PartialEq)]
struct GuardTerm {
    test: Span,
    polarity: Polarity,
    subs: Vec<(Span, usize)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Polarity {
    /// The test is truthy (`if` consequent, `?:` consequent, `&&` right).
    Truthy,
    /// The test is falsy (`else`, `?:` alternate, `||` right, after an early return).
    Falsy,
    /// The test is nullish (`??` right).
    Nullish,
}

struct Analysis<'s> {
    scoping: &'s Scoping,
    names: &'s HashMap<SymbolId, Name>,
    accessors: HashSet<SymbolId>,
    setters: HashSet<SymbolId>,
    source: &'s str,
    plan: Plan,
    /// Identifiers passed as a flow control's render callback: those that
    /// name a generator function declaration are named row blocks.
    named_symbols: HashSet<SymbolId>,
}

impl<'b> Visit<'b> for Analysis<'_> {
    fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
        if self.plan.error.is_none() {
            self.plan_call(call);
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_jsx_element(&mut self, element: &oxc_ast::ast::JSXElement<'b>) {
        if self.plan.error.is_none()
            && let oxc_ast::ast::JSXElementName::IdentifierReference(tag) =
                &element.opening_element.name
            && resolve(self.scoping, tag).and_then(|s| self.names.get(&s)) == Some(&Name::Flow)
        {
            for child in &element.children {
                if let oxc_ast::ast::JSXChild::ExpressionContainer(container) = child
                    && let Some(expression) = container.expression.as_expression()
                {
                    self.plan_render_callback(expression);
                }
            }
            for attribute in &element.opening_element.attributes {
                if let oxc_ast::ast::JSXAttributeItem::Attribute(attribute) = attribute
                    && attribute.name.get_identifier().name == "children"
                    && let Some(oxc_ast::ast::JSXAttributeValue::ExpressionContainer(container)) =
                        &attribute.value
                    && let Some(expression) = container.expression.as_expression()
                {
                    self.plan_render_callback(expression);
                }
            }
        }
        walk::walk_jsx_element(self, element);
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
        // `For({ each, children: function* (row) … })`: the call form's
        // render callback.
        if name == Name::Flow
            && let [Argument::ObjectExpression(object)] = call.arguments.as_slice()
        {
            for property in &object.properties {
                if let ObjectPropertyKind::ObjectProperty(property) = property
                    && !property.computed
                    && property.key.static_name().is_some_and(|key| key == "children")
                {
                    self.plan_render_callback(&property.value);
                }
            }
            return;
        }
        let Some(function) = generator_argument(call) else {
            return;
        };
        match name {
            Name::Component if call.arguments.len() == 1 => {
                self.plan.wraps.push((function.span, V2Kind::Setup));
                self.check_body(function, V2Kind::Setup);
            }
            // `$scope(function* (row) …)`: a render-callback block written
            // explicitly (the call stays; its setup is wrapped).
            Name::Scope if call.arguments.len() == 1 => {
                self.plan_scope_setup(function);
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
            props: props.into_iter().collect(),
            scope: false,
            getter_depth: 0,
        };
        checker.visit_function_body(body);
    }

    /// A render-callback block's setup: component-setup rules, with every
    /// parameter a render argument (a `<Show>` value accessor, a row's item
    /// or index) that only its view reads.
    fn plan_scope_setup(&mut self, function: &Function<'_>) {
        if self.plan.wraps.iter().any(|(span, _)| *span == function.span) {
            return;
        }
        self.plan.wraps.push((function.span, V2Kind::Setup));
        let Some(body) = function.body.as_ref() else {
            return;
        };
        let mut params = Vec::new();
        for param in &function.params.items {
            params.extend(
                param
                    .pattern
                    .get_binding_identifiers()
                    .iter()
                    .filter_map(|id| id.symbol_id.get()),
            );
        }
        let mut checker = BodyChecker {
            analysis: self,
            kind: V2Kind::Setup,
            props: params,
            scope: true,
            getter_depth: 0,
        };
        checker.visit_function_body(body);
    }

    /// A flow control's render callback: a `function* (row) { setup; return
    /// function* () { view } }`, a `$(function* (row) …)` block, or the name
    /// of a generator function declared in scope (a named row block, which
    /// may render itself). Each becomes `$scope(…)`.
    fn plan_render_callback(&mut self, expression: &Expression<'_>) {
        match expression.without_parentheses() {
            Expression::FunctionExpression(function) if function.generator && !function.r#async => {
                self.plan.scopes.insert(function.span);
                self.plan_scope_setup(function);
            }
            Expression::CallExpression(call)
                if callee_name(self.scoping, self.names, call) == Some(Name::Block)
                    && call.arguments.len() == 1 =>
            {
                if let Some(function) = generator_argument(call)
                    && !function.params.items.is_empty()
                {
                    self.plan.scope_calls.insert(call.span);
                    self.plan.scopes.insert(function.span);
                    self.plan_scope_setup(function);
                }
            }
            Expression::Identifier(identifier) => {
                // Resolved to a generator declaration after the walk.
                if let Some(symbol) = resolve(self.scoping, identifier) {
                    self.named_symbols.insert(symbol);
                }
            }
            _ => {}
        }
    }


    /// The reads an effect hoists into its compute block, or `None` when the
    /// split is refused.
    fn plan_split(&self, function: &Function<'_>) -> Option<SplitPlan> {
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
            guards: Vec::new(),
            unknown: 0,
            read_guards: Vec::new(),
            aliases: HashMap::new(),
        };
        hoister.visit_function_body(body);
        if hoister.refused {
            return None;
        }
        // Per slot: unconditional as soon as one occurrence is.
        let mut guards: Vec<Option<Vec<Vec<GuardTerm>>>> =
            vec![Some(Vec::new()); hoister.slots.len()];
        for ((_, slot), guard) in hoister.reads.iter().zip(&hoister.read_guards) {
            match guard {
                None => guards[*slot] = None,
                Some(terms) => {
                    if let Some(disjuncts) = guards[*slot].as_mut()
                        && !disjuncts.contains(terms)
                    {
                        disjuncts.push(terms.clone());
                    }
                }
            }
        }
        // A condition may only use slots the compute has already read.
        for (slot, guard) in guards.iter_mut().enumerate() {
            if guard.as_ref().is_some_and(|disjuncts| {
                disjuncts
                    .iter()
                    .flatten()
                    .flat_map(|term| &term.subs)
                    .any(|&(_, used)| used >= slot)
            }) {
                *guard = None;
            }
        }
        Some(SplitPlan {
            reads: hoister.reads,
            guards,
        })
    }

    fn classify(&self, operand: &Expression<'_>, props: &[SymbolId], scope: bool) -> OpClass {
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
                if resolve(self.scoping, id)
                    .is_some_and(|s| self.accessors.contains(&s) || (scope && props.contains(&s)))
                {
                    OpClass::StateRead
                } else {
                    OpClass::Read
                }
            }
            _ => match crate::generators::member_chain_root(operand) {
                Some(root) => {
                    let symbol = resolve(self.scoping, root);
                    if symbol.is_some_and(|s| props.contains(&s) || self.accessors.contains(&s)) {
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

/// The generator function declarations a render callback names: each is a
/// named row block (planned like an inline one).
struct NamedScopes<'x, 's> {
    analysis: &'x mut Analysis<'s>,
}

impl<'b> Visit<'b> for NamedScopes<'_, '_> {
    fn visit_function(&mut self, function: &Function<'b>, flags: ScopeFlags) {
        if function.r#type == FunctionType::FunctionDeclaration
            && function.generator
            && !function.r#async
            && let Some(symbol) = function.id.as_ref().and_then(|id| id.symbol_id.get())
            && self.analysis.named_symbols.contains(&symbol)
            && self.analysis.plan.named_scopes.insert(function.span)
        {
            self.analysis.plan_scope_setup(function);
        }
        walk::walk_function(self, function, flags);
    }
}

struct BodyChecker<'x, 's> {
    analysis: &'x mut Analysis<'s>,
    kind: V2Kind,
    /// The setup's props binding, or a render-callback block's parameters.
    props: Vec<SymbolId>,
    /// A render-callback block's setup: its parameters themselves (a
    /// `<Show>` value accessor, a row's index) are reads only its view takes.
    scope: bool,
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
            let class = self.analysis.classify(operand, &self.props, self.scope);
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
    /// The branch conditions around the current position, innermost last;
    /// `None` for a condition the compute half cannot evaluate (dropped: the
    /// read is then guarded by the rest — a superset, never a subset).
    guards: Vec<Option<GuardTerm>>,
    /// Inside control flow the guards do not model (`switch`, `try`,
    /// labels, optional chains, after an unstructured `return`): reads there
    /// are hoisted unconditionally, as in the first version of the split.
    unknown: usize,
    /// Parallel to `reads`: the conjunction each read sits under (`None`:
    /// every run).
    read_guards: Vec<Option<Vec<GuardTerm>>>,
    /// `const v = yield* a` bindings: the slot holding their value.
    aliases: HashMap<SymbolId, usize>,
}

/// Does the statement contain a `return` of the effect body (nested
/// functions excluded)?
fn may_return(statement: &Statement<'_>) -> bool {
    struct Finder {
        found: bool,
    }
    impl<'b> Visit<'b> for Finder {
        fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _: &oxc_ast::ast::ArrowFunctionExpression<'b>,
        ) {
        }
        fn visit_return_statement(&mut self, _: &ReturnStatement<'b>) {
            self.found = true;
        }
    }
    let mut finder = Finder { found: false };
    finder.visit_statement(statement);
    finder.found
}

/// Does every path through the statement end in a `return`?
fn always_returns(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::ReturnStatement(_) => true,
        Statement::BlockStatement(block) => block.body.iter().any(always_returns),
        Statement::IfStatement(it) => {
            always_returns(&it.consequent) && it.alternate.as_ref().is_some_and(always_returns)
        }
        _ => false,
    }
}

impl Hoister<'_, '_> {
    fn term(&self, test: &Expression<'_>, polarity: Polarity) -> Option<GuardTerm> {
        let mut subs = Vec::new();
        self.evaluable(test, &mut subs).then(|| GuardTerm {
            test: test.span(),
            polarity,
            subs,
        })
    }

    /// Whether the compute half can evaluate `expression` to the value the
    /// body sees: operators over literals, reads it hoisted, aliases of
    /// those reads, and bindings declared before the effect that nothing
    /// writes. `subs` receives the reads and aliases to replace by slots.
    fn evaluable(&self, expression: &Expression<'_>, subs: &mut Vec<(Span, usize)>) -> bool {
        match expression {
            Expression::NumericLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_) => true,
            Expression::TemplateLiteral(template) => template
                .expressions
                .iter()
                .all(|expression| self.evaluable(expression, subs)),
            Expression::Identifier(identifier) => {
                let scoping = self.analysis.scoping;
                match resolve(scoping, identifier) {
                    Some(symbol) => {
                        if let Some(&slot) = self.aliases.get(&symbol) {
                            subs.push((identifier.span, slot));
                            return true;
                        }
                        let declared = scoping.symbol_span(symbol);
                        declared.end <= self.function_span.start
                            && scoping
                                .get_resolved_references(symbol)
                                .all(|reference| !reference.is_write())
                    }
                    None => matches!(identifier.name.as_str(), "undefined" | "NaN" | "Infinity"),
                }
            }
            Expression::ParenthesizedExpression(it) => self.evaluable(&it.expression, subs),
            Expression::TSAsExpression(it) => self.evaluable(&it.expression, subs),
            Expression::TSSatisfiesExpression(it) => self.evaluable(&it.expression, subs),
            Expression::TSNonNullExpression(it) => self.evaluable(&it.expression, subs),
            Expression::TSTypeAssertion(it) => self.evaluable(&it.expression, subs),
            Expression::UnaryExpression(it) => {
                it.operator != oxc_syntax::operator::UnaryOperator::Delete
                    && self.evaluable(&it.argument, subs)
            }
            Expression::BinaryExpression(it) => {
                self.evaluable(&it.left, subs) && self.evaluable(&it.right, subs)
            }
            Expression::LogicalExpression(it) => {
                self.evaluable(&it.left, subs) && self.evaluable(&it.right, subs)
            }
            Expression::ConditionalExpression(it) => {
                self.evaluable(&it.test, subs)
                    && self.evaluable(&it.consequent, subs)
                    && self.evaluable(&it.alternate, subs)
            }
            // A read the split hoisted (visited before the test is used).
            Expression::YieldExpression(it) if it.delegate => {
                match self.reads.iter().find(|(span, _)| *span == it.span) {
                    Some(&(span, slot)) => {
                        subs.push((span, slot));
                        true
                    }
                    None => false,
                }
            }
            _ => false,
        }
    }

    fn guarded<F: FnOnce(&mut Self)>(&mut self, term: Option<GuardTerm>, visit: F) {
        self.guards.push(term);
        visit(self);
        self.guards.pop();
    }

    fn opaque<F: FnOnce(&mut Self)>(&mut self, visit: F) {
        self.unknown += 1;
        visit(self);
        self.unknown -= 1;
    }
}

impl<'b> Visit<'b> for Hoister<'_, '_> {
    fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &oxc_ast::ast::ArrowFunctionExpression<'b>) {}

    fn visit_if_statement(&mut self, it: &oxc_ast::ast::IfStatement<'b>) {
        self.visit_expression(&it.test);
        let truthy = self.term(&it.test, Polarity::Truthy);
        self.guarded(truthy, |this| this.visit_statement(&it.consequent));
        if let Some(alternate) = &it.alternate {
            let falsy = self.term(&it.test, Polarity::Falsy);
            self.guarded(falsy, |this| this.visit_statement(alternate));
        }
    }

    fn visit_conditional_expression(&mut self, it: &oxc_ast::ast::ConditionalExpression<'b>) {
        self.visit_expression(&it.test);
        let truthy = self.term(&it.test, Polarity::Truthy);
        self.guarded(truthy, |this| this.visit_expression(&it.consequent));
        let falsy = self.term(&it.test, Polarity::Falsy);
        self.guarded(falsy, |this| this.visit_expression(&it.alternate));
    }

    fn visit_logical_expression(&mut self, it: &oxc_ast::ast::LogicalExpression<'b>) {
        use oxc_syntax::operator::LogicalOperator;
        self.visit_expression(&it.left);
        let polarity = match it.operator {
            LogicalOperator::And => Polarity::Truthy,
            LogicalOperator::Or => Polarity::Falsy,
            LogicalOperator::Coalesce => Polarity::Nullish,
        };
        let term = self.term(&it.left, polarity);
        self.guarded(term, |this| this.visit_expression(&it.right));
    }

    fn visit_switch_statement(&mut self, it: &oxc_ast::ast::SwitchStatement<'b>) {
        self.opaque(|this| walk::walk_switch_statement(this, it));
    }
    fn visit_try_statement(&mut self, it: &oxc_ast::ast::TryStatement<'b>) {
        self.opaque(|this| walk::walk_try_statement(this, it));
    }
    fn visit_labeled_statement(&mut self, it: &oxc_ast::ast::LabeledStatement<'b>) {
        self.opaque(|this| walk::walk_labeled_statement(this, it));
    }
    fn visit_chain_expression(&mut self, it: &oxc_ast::ast::ChainExpression<'b>) {
        self.opaque(|this| walk::walk_chain_expression(this, it));
    }

    /// A statement after an early return runs only when the return did not:
    /// `if (c) return; …` guards the rest by `!c`.
    fn visit_statements(&mut self, statements: &oxc_allocator::ArenaVec<'b, Statement<'b>>) {
        let mut pushed = 0;
        let mut opaque = 0;
        for statement in statements {
            self.visit_statement(statement);
            if !may_return(statement) {
                continue;
            }
            let term = match statement {
                Statement::IfStatement(it)
                    if always_returns(&it.consequent)
                        && it.alternate.as_ref().is_none_or(|a| !may_return(a)) =>
                {
                    Some(self.term(&it.test, Polarity::Falsy))
                }
                Statement::IfStatement(it)
                    if it.alternate.as_ref().is_some_and(always_returns)
                        && !may_return(&it.consequent) =>
                {
                    Some(self.term(&it.test, Polarity::Truthy))
                }
                _ => None,
            };
            match term {
                Some(term) => {
                    self.guards.push(term);
                    pushed += 1;
                }
                None => {
                    self.unknown += 1;
                    opaque += 1;
                }
            }
        }
        for _ in 0..pushed {
            self.guards.pop();
        }
        self.unknown -= opaque;
    }

    fn visit_variable_declaration(&mut self, it: &oxc_ast::ast::VariableDeclaration<'b>) {
        walk::walk_variable_declaration(self, it);
        if it.kind != oxc_ast::ast::VariableDeclarationKind::Const {
            return;
        }
        for declarator in &it.declarations {
            if let BindingPattern::BindingIdentifier(id) = &declarator.id
                && let Some(Expression::YieldExpression(read)) = &declarator.init
                && let Some(symbol) = id.symbol_id.get()
                && let Some(&(_, slot)) = self.reads.iter().find(|(span, _)| *span == read.span)
            {
                self.aliases.insert(symbol, slot);
            }
        }
    }

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
            self.analysis.classify(operand, &[], false),
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
        let guard = (self.unknown == 0)
            .then(|| self.guards.iter().flatten().cloned().collect::<Vec<_>>())
            .filter(|terms| !terms.is_empty());
        self.read_guards.push(guard);
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
    uses_scope: bool,
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        walk_mut::walk_statement(self, statement);
        // A named row block: `function* row(c) { … }` →
        // `const row = _$scope(_$$(function* (c) { … }))`.
        if let Statement::FunctionDeclaration(function) = statement
            && self.plan.named_scopes.contains(&function.span)
        {
            let ast = AstBuilder::new(self.allocator);
            let span = function.span;
            let name = function.id.as_ref().map(|id| id.name.to_string()).unwrap_or_default();
            let taken = std::mem::replace(statement, ast.statement_empty(Span::new(0, 0)));
            let Statement::FunctionDeclaration(mut function) = taken else {
                unreachable!()
            };
            function.r#type = FunctionType::FunctionExpression;
            function.id = None;
            let expression = Expression::FunctionExpression(function);
            let block = self.wrap(span, V2Kind::Setup, expression);
            let init = self.scope(span, block);
            let declarator = ast.variable_declarator(
                span,
                oxc_ast::ast::VariableDeclarationKind::Const,
                ast.binding_pattern_binding_identifier(span, ast.ident(&name)),
                None,
                Some(init),
                false,
            );
            *statement = Statement::VariableDeclaration(ast.alloc_variable_declaration(
                span,
                oxc_ast::ast::VariableDeclarationKind::Const,
                ast.vec1(declarator),
                false,
            ));
        }
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        // Post-order: nested bodies and calls are rewritten first.
        walk_mut::walk_expression(self, expression);
        match expression {
            Expression::FunctionExpression(function) => {
                if let Some(kind) = self.wrap_kind(function.span) {
                    let span = function.span;
                    let scope = self.plan.scopes.contains(&span);
                    let taken = std::mem::replace(expression, self.placeholder());
                    let block = self.wrap(span, kind, taken);
                    *expression = if scope { self.scope(span, block) } else { block };
                }
            }
            Expression::CallExpression(call) if self.plan.scope_calls.contains(&call.span) => {
                // `$(function* (row) …)`: its function is already the scope.
                let argument = call.arguments.pop().expect("planned with one argument");
                *expression = crate::shared::ast::argument_to_expression(argument)
                    .expect("a function argument");
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

    /// `_$scope(block)`: a render-callback block.
    /// Its span is the function's widened by one: spans key the later passes'
    /// plans, and the function's own span is the `_$$` call's.
    fn scope(&mut self, span: Span, block: Expression<'a>) -> Expression<'a> {
        let ast = AstBuilder::new(self.allocator);
        self.uses_scope = true;
        ast.expression_call(
            Span::new(span.start, span.end + 1),
            ast.expression_identifier(Span::new(0, 0), ast.ident(SCOPE_LOCAL)),
            None,
            ast.vec1(expression_to_argument(block)),
            false,
        )
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
        if let Some(split) = effect.split.filter(|split| !split.reads.is_empty()) {
            // The conditions of guarded slots, cloned (with their reads and
            // read aliases replaced by the compute's slot bindings) before the
            // body's reads are replaced.
            let conditions = function
                .body
                .as_ref()
                .map(|body| self.guard_conditions(body, &split))
                .unwrap_or_default();
            let SplitPlan { reads, guards } = split;
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
            // no source node has (the call's first byte). With guarded slots
            // the compute keeps the body's control flow:
            // `const _$r0 = yield* a; const _$r1 = _$r0 > 1 ? yield* c : void 0;
            //  return [_$r0, _$r1];`
            let compute_span = Span::new(call.span.start, call.span.start + 1);
            let body = if guards.iter().all(Option::is_none) {
                let elements = ast.vec_from_iter(replacer.operands.into_iter().flatten().map(
                    |(span, operand)| {
                        ArrayExpressionElement::from(ast.expression_yield(
                            span,
                            true,
                            Some(operand),
                        ))
                    },
                ));
                ast.function_body(
                    compute_span,
                    ast.vec(),
                    ast.vec1(ast.statement_return(
                        compute_span,
                        Some(ast.expression_array(compute_span, elements)),
                    )),
                )
            } else {
                let synth = Span::new(0, 0);
                let mut statements = ast.vec();
                let mut elements = ast.vec();
                for (slot, operand) in replacer.operands.into_iter().enumerate() {
                    let Some((span, operand)) = operand else {
                        continue;
                    };
                    let read = ast.expression_yield(span, true, Some(operand));
                    let condition = guards
                        .get(slot)
                        .and_then(Option::as_ref)
                        .and_then(|disjuncts| self.disjunction(disjuncts, &conditions));
                    let init = match condition {
                        Some(condition) => {
                            ast.expression_conditional(synth, condition, read, ast.void_0(synth))
                        }
                        None => read,
                    };
                    let name = slot_binding(slot);
                    statements.push(crate::shared::ast::variable_statement(
                        self.allocator,
                        synth,
                        oxc_ast::ast::VariableDeclarationKind::Const,
                        &name,
                        init,
                    ));
                    elements.push(ArrayExpressionElement::from(
                        ast.expression_identifier(synth, ast.ident(&name)),
                    ));
                }
                statements.push(ast.statement_return(
                    compute_span,
                    Some(ast.expression_array(compute_span, elements)),
                ));
                ast.function_body(compute_span, ast.vec(), statements)
            };
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

/// The compute half's binding for slot `slot` (guarded computes only).
fn slot_binding(slot: usize) -> String {
    format!("_$r{slot}")
}

impl<'a> Rewriter<'a> {
    /// Clones of every guard condition of `split`, found in the effect body
    /// by span, with the reads and read aliases they use replaced by the
    /// compute's slot bindings.
    fn guard_conditions(
        &self,
        body: &oxc_ast::ast::FunctionBody<'a>,
        split: &SplitPlan,
    ) -> HashMap<Span, Expression<'a>> {
        use oxc_allocator::CloneIn;
        let terms: Vec<&GuardTerm> = split.guards.iter().flatten().flatten().flatten().collect();
        if terms.is_empty() {
            return HashMap::new();
        }
        let tests: HashSet<Span> = terms.iter().map(|term| term.test).collect();
        let subs: HashMap<Span, usize> = terms
            .iter()
            .flat_map(|term| term.subs.iter().copied())
            .collect();
        struct Cloner<'a, 's> {
            allocator: &'a Allocator,
            tests: &'s HashSet<Span>,
            found: HashMap<Span, Expression<'a>>,
        }
        impl<'a> Visit<'a> for Cloner<'a, '_> {
            fn visit_expression(&mut self, expression: &Expression<'a>) {
                let span = expression.span();
                if self.tests.contains(&span) && !self.found.contains_key(&span) {
                    self.found.insert(span, expression.clone_in(self.allocator));
                }
                walk::walk_expression(self, expression);
            }
        }
        struct Substitute<'a, 's> {
            allocator: &'a Allocator,
            subs: &'s HashMap<Span, usize>,
        }
        impl<'a> VisitMut<'a> for Substitute<'a, '_> {
            fn visit_expression(&mut self, expression: &mut Expression<'a>) {
                let slot = match expression {
                    Expression::Identifier(id) => self.subs.get(&id.span),
                    Expression::YieldExpression(it) => self.subs.get(&it.span),
                    _ => None,
                };
                if let Some(&slot) = slot {
                    let ast = AstBuilder::new(self.allocator);
                    *expression =
                        ast.expression_identifier(Span::new(0, 0), ast.ident(&slot_binding(slot)));
                    return;
                }
                walk_mut::walk_expression(self, expression);
            }
        }
        let mut cloner = Cloner {
            allocator: self.allocator,
            tests: &tests,
            found: HashMap::new(),
        };
        cloner.visit_function_body(body);
        let mut substitute = Substitute {
            allocator: self.allocator,
            subs: &subs,
        };
        for expression in cloner.found.values_mut() {
            substitute.visit_expression(expression);
        }
        cloner.found
    }

    /// `(a && b) || c` over the guard terms; `None` when a condition was not
    /// found (the slot is then read on every run).
    fn disjunction(
        &self,
        disjuncts: &[Vec<GuardTerm>],
        conditions: &HashMap<Span, Expression<'a>>,
    ) -> Option<Expression<'a>> {
        use oxc_allocator::CloneIn;
        use oxc_syntax::operator::{BinaryOperator, LogicalOperator, UnaryOperator};
        let ast = AstBuilder::new(self.allocator);
        let synth = Span::new(0, 0);
        let mut any: Option<Expression<'a>> = None;
        for terms in disjuncts {
            let mut all: Option<Expression<'a>> = None;
            for term in terms {
                let test = conditions.get(&term.test)?.clone_in(self.allocator);
                let test = ast.expression_parenthesized(synth, test);
                let term = match term.polarity {
                    Polarity::Truthy => test,
                    Polarity::Falsy => ast.expression_unary(synth, UnaryOperator::LogicalNot, test),
                    Polarity::Nullish => ast.expression_binary(
                        synth,
                        test,
                        BinaryOperator::Equality,
                        ast.expression_null_literal(synth),
                    ),
                };
                all = Some(match all {
                    Some(left) => ast.expression_logical(synth, left, LogicalOperator::And, term),
                    None => term,
                });
            }
            let all = all?;
            any = Some(match any {
                Some(left) => ast.expression_logical(
                    synth,
                    ast.expression_parenthesized(synth, left),
                    LogicalOperator::Or,
                    ast.expression_parenthesized(synth, all),
                ),
                None => all,
            });
        }
        any
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

// ---------------------------------------------------------------------------
// PROPS_COMPILED: skip the typed-props proxy when every prop read was lowered
// ---------------------------------------------------------------------------
//
// `$component(body)` hands the setup a typed-props proxy (`props.x` is a prop
// read; forwarding it forwards the read) and registers it so the lowered path
// readers can unwrap it. After lowering, a component whose props binding is
// ONLY ever the root of a lowered path read — `_$readPathK(props, …)`, which
// walks the raw props exactly as it walks the unwrapped proxy — never
// observes the proxy, so `$component(body, PROPS_COMPILED)` passes the raw
// props: no Proxy, no WeakMap registration per instance, and no proxy
// unwrap on every path read in the app. Any other use of the binding
// (forwarding `props.x`, spreading, a read the pass left to the runtime
// driver, a destructured parameter) keeps the proxy.

/// `$component(body, flags)`: the component's props reads are all lowered.
const PROPS_COMPILED: f64 = 1.0;
const PATH_READER_NAMES: &[&str] = &[
    "readPath1",
    "readPath2",
    "readPath3",
    "readPath4",
    "readPathN",
];

/// Flag every `$component(_$$(function (props) { … }))` whose lowered body
/// uses `props` only as the root of lowered path reads. Runs after the
/// generator pass (and host fusion), before JSX lowering.
pub(crate) fn mark_compiled_props<'a>(allocator: &'a Allocator, program: &mut Program<'a>) {
    let mut components = Vec::new();
    // `$componentCompiled` (the v2 client lowering): its setup may be the
    // plain function of an erased block.
    let mut compiled_components = Vec::new();
    let mut adapters = Vec::new();
    let mut readers = Vec::new();
    let mut any = false;
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
                let name = specifier.imported.name();
                if name == "$component" || name == "$componentCompiled" {
                    any = true;
                }
            }
        }
    }
    if !any {
        return;
    }
    let spans = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let scoping = semantic.scoping();
        let nodes = semantic.nodes();
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
                if name == "$component" {
                    components.push(symbol);
                } else if name == "$componentCompiled" {
                    components.push(symbol);
                    compiled_components.push(symbol);
                } else if name == "$" || name == "syncBlock" {
                    adapters.push(symbol);
                } else if PATH_READER_NAMES.contains(&name) {
                    readers.push(symbol);
                }
            }
        }
        struct Finder<'s> {
            scoping: &'s Scoping,
            nodes: &'s oxc_semantic::AstNodes<'s>,
            components: &'s [SymbolId],
            compiled_components: &'s [SymbolId],
            adapters: &'s [SymbolId],
            readers: &'s [SymbolId],
            spans: Vec<Span>,
        }
        impl Finder<'_> {
            fn callee(&self, call: &CallExpression<'_>) -> Option<SymbolId> {
                let Expression::Identifier(callee) = &call.callee else {
                    return None;
                };
                resolve(self.scoping, callee)
            }
            /// Every value reference of `props` is argument 0 of a path reader.
            fn only_path_roots(&self, props: SymbolId) -> bool {
                self.scoping
                    .get_resolved_references(props)
                    .all(|reference| {
                        let node = reference.node_id();
                        let span = self.nodes.get_node(node).kind().span();
                        let parent = self.nodes.parent_id(node);
                        if parent == node {
                            return false;
                        }
                        match self.nodes.get_node(parent).kind() {
                            oxc_ast::AstKind::CallExpression(call) => {
                                call.arguments.first().is_some_and(|a| a.span() == span)
                                    && self
                                        .callee(call)
                                        .is_some_and(|symbol| self.readers.contains(&symbol))
                            }
                            _ => false,
                        }
                    })
            }
        }
        impl<'b> Visit<'b> for Finder<'_> {
            fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
                let component = self.callee(call);
                let setup = match call.arguments.first() {
                    Some(Argument::CallExpression(block))
                        if self
                            .callee(block)
                            .is_some_and(|symbol| self.adapters.contains(&symbol)) =>
                    {
                        match block.arguments.first() {
                            Some(Argument::FunctionExpression(setup)) => Some(setup),
                            _ => None,
                        }
                    }
                    Some(Argument::FunctionExpression(setup))
                        if component.is_some_and(|s| self.compiled_components.contains(&s)) =>
                    {
                        Some(setup)
                    }
                    _ => None,
                };
                if call.arguments.len() == 1
                    && component.is_some_and(|symbol| self.components.contains(&symbol))
                    && let Some(setup) = setup
                    // Lowered: a setup the runtime driver still runs reads
                    // props through the proxy.
                    && !setup.generator
                {
                    let params = &setup.params;
                    let eligible = params.rest.is_none()
                        && match params.items.first() {
                            None => true,
                            Some(param) => match &param.pattern {
                                BindingPattern::BindingIdentifier(id) => id
                                    .symbol_id
                                    .get()
                                    .is_some_and(|symbol| self.only_path_roots(symbol)),
                                _ => false,
                            },
                        };
                    if eligible {
                        self.spans.push(call.span);
                    }
                }
                walk::walk_call_expression(self, call);
            }
        }
        let mut finder = Finder {
            scoping,
            nodes,
            components: &components,
            compiled_components: &compiled_components,
            adapters: &adapters,
            readers: &readers,
            spans: Vec::new(),
        };
        finder.visit_program(program);
        finder.spans
    };
    if spans.is_empty() {
        return;
    }
    struct Flagger<'a> {
        allocator: &'a Allocator,
        spans: Vec<Span>,
    }
    impl<'a> VisitMut<'a> for Flagger<'a> {
        fn visit_call_expression(&mut self, call: &mut CallExpression<'a>) {
            walk_mut::walk_call_expression(self, call);
            if self.spans.contains(&call.span) {
                let ast = AstBuilder::new(self.allocator);
                let flag = ast.expression_numeric_literal(
                    Span::new(0, 0),
                    PROPS_COMPILED,
                    None,
                    oxc_syntax::number::NumberBase::Decimal,
                );
                call.arguments.push(expression_to_argument(flag));
            }
        }
    }
    Flagger { allocator, spans }.visit_program(program);
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

    /// The pre-pass and the lowering alone: v2 fusion and the client
    /// lowering (on by default; tested in `blocks_v2_lower.rs`) are off.
    fn compile_as(source: &str, generate: Generate) -> Result<String, String> {
        compile(
            source,
            &CompileOptions {
                generate,
                v2_fusion: false,
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
    fn the_compute_half_keeps_the_bodys_control_flow() {
        let out = ssr(
            r#"import { $component, $signal, $effect, $cleanup } from "solid-js";
const limit = 1;
export const C = $component(function* () {
  const [a] = yield* $signal(1);
  const [flag] = yield* $signal(false);
  const [c] = yield* $signal(0);
  const [d] = yield* $signal(0);
  yield* $effect(function* () {
    const v = yield* a;
    const f = yield* flag;
    if (v > limit) log(yield* c);
    else log(f && (yield* d));
    yield* $cleanup(() => log(v));
  });
  return function* () { return 1; };
});
"#,
        )
        .unwrap();
        let flat = out.split_whitespace().collect::<Vec<_>>().join(" ");
        // Unconditional reads first, then each guarded read under the
        // condition the body reads it under (aliases become slots).
        assert!(flat.contains("const _$r0 = _$perform(a);"), "{out}");
        assert!(flat.contains("const _$r1 = _$perform(flag);"), "{out}");
        assert!(
            flat.contains("const _$r2 = _$r0 > limit ? _$perform(c) : void 0;"),
            "{out}"
        );
        assert!(
            flat.contains("const _$r3 = !(_$r0 > limit) && _$r1 ? _$perform(d) : void 0;"),
            "{out}"
        );
        assert!(flat.contains("return [ _$r0, _$r1, _$r2, _$r3 ];"), "{out}");
        // The body is unchanged apart from the slots.
        assert!(flat.contains("if (v > limit) log(_$v[2]);"), "{out}");
        assert!(flat.contains("else log(f && _$v[3]);"), "{out}");

        // Early returns guard what follows; an unevaluable condition (a
        // call) is dropped, never inverted; a mutable binding is not trusted.
        let early = ssr(r#"import { $component, $signal, $effect } from "solid-js";
let mutable = 0;
export const bump = () => mutable++;
export const C = $component(function* () {
  const [a] = yield* $signal(1);
  const [b] = yield* $signal(1);
  const [c] = yield* $signal(1);
  yield* $effect(function* () {
    const v = yield* a;
    if (!v) return;
    if (check(v)) log(yield* b);
    if (mutable) log(yield* c);
  });
  return function* () { return 1; };
});
"#)
        .unwrap();
        let flat = early.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains("const _$r1 = !!_$r0 ? _$perform(b) : void 0;"),
            "{early}"
        );
        assert!(
            flat.contains("const _$r2 = !!_$r0 ? _$perform(c) : void 0;"),
            "{early}"
        );

        // Reads under control flow the split does not model stay unconditional.
        let opaque = ssr(r#"import { $component, $signal, $effect } from "solid-js";
export const C = $component(function* () {
  const [a] = yield* $signal(1);
  const [b] = yield* $signal(1);
  yield* $effect(function* () {
    switch (yield* a) { case 1: log(yield* b); }
  });
  return function* () { return 1; };
});
"#)
        .unwrap();
        let flat = opaque.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains("return [_$perform(a), _$perform(b)];"),
            "{opaque}"
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

    fn dom(source: &str) -> Result<String, String> {
        compile_as(source, Generate::Dom)
    }

    #[test]
    fn views_reading_only_in_deferred_holes_are_static() {
        let view = |body: &str| {
            let out = dom(&format!(
                r#"import {{ $component, $signal }} from "solid-js";
export const C = $component(function* () {{
  const [n] = yield* $signal(0);
  const go = () => {{}};
  return function* () {{ {body} }};
}});
"#
            ))
            .unwrap();
            out.contains("}, 5);")
        };
        // Holes, dynamic attributes and component props are deferred.
        assert!(view("return <p class={(yield* n) ? \"a\" : \"b\"}>{yield* n}</p>;"));
        assert!(view("return <div><b>{yield* n}</b><Other v={yield* n} onClick={yield* n} /></div>;"));
        // A read the view evaluates itself is not.
        assert!(!view("const v = yield* n; return <p>{v}</p>;"));
        assert!(!view("return (yield* n) ? <p /> : <b />;"));
        // Handlers, refs and spreads on an intrinsic element run eagerly.
        assert!(!view("return <p onClick={(yield* n) ? go : go} />;"));
        assert!(!view("return <p {...{ a: yield* n }} />;"));
    }

    #[test]
    fn lowered_v2_bodies_carry_the_sync_proof_by_default() {
        let out = dom(r#"import { $component, $signal, $memo } from "solid-js";
export const Counter = $component(function* () {
  const [count] = yield* $signal(0);
  const doubled = yield* $memo(function* () { return (yield* count) * 2; });
  return function* () { return <p>{yield* doubled}</p>; };
});
"#)
        .unwrap();
        // The memo is proven BLOCK_SYNC (`$(fn, 1)`); the view (JSX whose
        // only read is a hole) BLOCK_SYNC | BLOCK_STATIC (`$(fn, 5)`).
        assert!(
            out.contains(
                "return _$perform(count) * 2;
	}, 1)"
            ),
            "{out}"
        );
        assert!(
            out.contains(
                "return _el$;
	}, 5);"
            ),
            "{out}"
        );
        // Only the flag: no host options without `blockProofs`.
        assert!(
            !out.contains("syncOnly") && !out.contains("statusFree"),
            "{out}"
        );

        // A plain (non-v2) `$` block keeps the unannotated form by default.
        let plain = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const doubled = createMemo($(function* () { return (yield* count) * 2; }));
"#)
        .unwrap();
        assert!(
            plain.contains(
                "* 2;
}));"
            ),
            "{plain}"
        );
    }

    #[test]
    fn props_compiled_when_every_prop_read_is_lowered() {
        let out = dom(r#"import { $component } from "solid-js";
export const Row = $component(function* (props) {
  return function* () { return <li>{yield* props.item.label}{yield* props.id}</li>; };
});
export const Empty = $component(function* () {
  return function* () { return <hr />; };
});
"#)
        .unwrap();
        // (The setup is proven BLOCK_SYNC too: it returns its view block.)
        assert_eq!(out.matches("}, 1), 1);").count(), 2, "{out}");

        // Forwarding `props.id` forwards the read: the proxy stays.
        let forwarded = dom(r#"import { $component } from "solid-js";
const Child = $component(function* (props) {
  return function* () { return <i>{yield* props.id}</i>; };
});
export const Parent = $component(function* (props) {
  return function* () { return <div>{Child({ id: props.id })}</div>; };
});
"#)
        .unwrap();
        assert_eq!(forwarded.matches("}, 1), 1);").count(), 1, "{forwarded}");
        assert!(
            forwarded.contains("const Child = $component(_$$(function(props)"),
            "{forwarded}"
        );

        // A setup left to the runtime driver reads props through the proxy.
        let driven = dom(r#"import { $component, $memo, attempt } from "solid-js";
export const Async = $component(function* (props) {
  const m = yield* $memo(function* () { const id = yield* props.id; return yield* attempt(() => load(id)); });
  return function* () { return <i>{yield* m}</i>; };
});
"#)
        .unwrap();
        assert!(!driven.contains("}, 1), 1);"), "{driven}");
    }
}
