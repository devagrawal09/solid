//! Memo fusion (experimental, `memoFusion`).
//!
//! A memo read by exactly one computation costs a node, a link, a height slot
//! and a hydration id to cache a value only one reader asks for. Inlining it
//! into that reader measured mount −31% to −38% and chain updates −70%
//! (documentation/plans/heuristic-oracles.md, H1). This pass proves the fact
//! syntactically and inlines:
//!
//! ```js
//! const total = createMemo(() => a() + b());
//! const label = createMemo(() => `${total()} items`);   // memo → memo
//! createRenderEffect(() => label(), v => el.textContent = v);
//! // →
//! createRenderEffect(() => `${a() + b()} items`, v => el.textContent = v,
//!   { equals: _$isEqual });                              // keeps the cut-off
//! ```
//!
//! Readers (exactly one reference, a zero-argument call `m()`):
//! - **another memo**: the read is directly in the reader memo's function
//!   (not in a nested callback). The reader keeps its own equality; the
//!   inner cut-off only saved the reader a pure recompute.
//! - **an effect**: `createEffect` / `createRenderEffect` whose compute is
//!   exactly `() => m()`. The effect gets `{ equals: _$isEqual }` — the
//!   memo's default comparator — so its callback still runs only on a change
//!   (runtime: effect `equals`, CONFIG_EFFECT_EQUALS). A compute that wraps
//!   the read (`() => f(m())`) is refused: `f(m())` may stay equal while
//!   `m()` changed, and the callback ran on that before.
//! - **JSX** in the memo's own component (not inside a callback): an
//!   attribute or child expression. Bindings apply idempotently, so the
//!   binding may re-run on an unchanged value. Performance policy (measured,
//!   round 2 "shared sources"): refused when the memo reads anything from
//!   outside its component — an outer accessor or the props parameter —
//!   because a per-row memo over a shared source (a selection) is cheaper
//!   than a per-row binding recompute; and refused in an attribute of an
//!   element with more than one dynamic attribute (the grouped effect loses
//!   the cut-off for every part).
//!
//! The memo (`const m = createMemo(fn)`, one argument — no options) must:
//! - be a non-`async`, non-generator function with no parameters;
//! - create nothing and read no context: no call of any runtime import in its
//!   body (factories, `onCleanup`, `useContext`, `untrack`, …), no `this`,
//!   `arguments`, `new`, `await`, `yield`, tagged templates;
//! - call only known accessors (zero-argument calls of `createSignal` /
//!   `createMemo` bindings) and a small set of synchronous built-ins — so it
//!   can never return a promise that a reader would treat as a value.
//!
//! Runs on every generate (a memo consumes a hydration id on both sides; the
//! server and client outputs must fuse the same memos), to a fixpoint so
//! chains collapse.
use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, BindingPattern, CallExpression, Expression,
    ImportDeclarationSpecifier, ImportOrExportKind, JSXAttributeItem, JSXAttributeValue,
    JSXExpression, Program, Statement, VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use crate::shared::ast::expression_to_argument;
use crate::shared::ast_builder::AstBuilder;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
const IS_EQUAL_LOCAL: &str = "_$isEqual";
/// Synchronous built-in methods a fused body may call on a value.
const SYNC_METHODS: &[&str] = &[
    "toFixed", "toString", "toUpperCase", "toLowerCase", "trim", "trimStart", "trimEnd",
    "slice", "substring", "includes", "indexOf", "lastIndexOf", "join", "startsWith",
    "endsWith", "padStart", "padEnd", "charAt", "concat", "split", "replace", "replaceAll",
    "at", "some", "every", "find", "findIndex", "map", "filter", "reduce", "flat", "toLocaleString",
];
/// Synchronous global functions / namespaces a fused body may call.
const SYNC_GLOBALS: &[&str] = &["String", "Number", "Boolean", "Math", "JSON", "Array", "Object"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Reader {
    Memo,
    Effect,
    Jsx,
}

#[derive(Debug)]
struct Fusion {
    memo: SymbolId,
    /// The memo's `VariableDeclarator` span (removed).
    declarator: Span,
    /// The `m()` call span (replaced).
    read: Span,
    reader: Reader,
    /// Effect readers: the compute function's span (replaced) and the effect
    /// call's span (receives the `equals` option).
    effect_call: Option<Span>,
}

/// Fuse single-reader memos, to a fixpoint. Returns the number fused.
pub(crate) fn transform_memo_fusion<'a>(allocator: &'a Allocator, program: &mut Program<'a>) -> usize {
    let Some(import_span) = runtime_import_span(program) else {
        return 0;
    };
    let mut total = 0;
    let mut needs_is_equal = false;
    // Each round fuses one layer (chains collapse over rounds).
    for _ in 0..16 {
        let plan = {
            let semantic = SemanticBuilder::new().with_build_nodes(true).build(program).semantic;
            plan_round(program, semantic.scoping(), semantic.nodes())
        };
        if plan.is_empty() {
            break;
        }
        total += plan.len();
        needs_is_equal |= plan.iter().any(|f| f.reader == Reader::Effect);
        apply(allocator, program, plan);
    }
    if needs_is_equal {
        add_import(allocator, program, import_span);
    }
    total
}

// --- planning ---------------------------------------------------------------

fn runtime_import_span(program: &Program<'_>) -> Option<Span> {
    program.body.iter().find_map(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return None;
        };
        let has_memo = RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.import_kind != ImportOrExportKind::Type
            && import.specifiers.iter().flatten().any(|s| {
                matches!(s, ImportDeclarationSpecifier::ImportSpecifier(s)
                    if s.imported.name() == "createMemo" && s.import_kind != ImportOrExportKind::Type)
            });
        has_memo.then_some(import.span)
    })
}

/// Local symbol → imported name, for value imports from runtime sources.
fn runtime_imports(program: &Program<'_>) -> HashMap<SymbolId, String> {
    let mut map = HashMap::new();
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
            if let ImportDeclarationSpecifier::ImportSpecifier(s) = specifier
                && s.import_kind != ImportOrExportKind::Type
                && let Some(symbol) = s.local.symbol_id.get()
            {
                map.insert(symbol, s.imported.name().to_string());
            }
        }
    }
    map
}

fn plan_round(program: &Program<'_>, scoping: &Scoping, nodes: &AstNodes<'_>) -> Vec<Fusion> {
    let imports = runtime_imports(program);
    let name_of = |call: &CallExpression<'_>| -> Option<String> {
        let Expression::Identifier(callee) = &call.callee else {
            return None;
        };
        let symbol = callee.reference_id.get().and_then(|id| scoping.get_reference(id).symbol_id())?;
        imports.get(&symbol).cloned()
    };

    // Accessors: `const [x] = createSignal(…)`, `const m = createMemo(…)`.
    let mut accessors: HashSet<SymbolId> = HashSet::new();
    // Memo candidates by symbol: (declarator span, declarator node id, function node span).
    let mut memos: Vec<(SymbolId, Span, NodeId, Span)> = Vec::new();
    for node in nodes.iter() {
        let AstKind::VariableDeclarator(declarator) = node.kind() else {
            continue;
        };
        let Some(Expression::CallExpression(call)) = &declarator.init else {
            continue;
        };
        let Some(name) = name_of(call) else { continue };
        match (name.as_str(), &declarator.id) {
            ("createSignal" | "createOptimistic", BindingPattern::ArrayPattern(pattern)) => {
                if let Some(Some(first)) = pattern.elements.first()
                    && let BindingPattern::BindingIdentifier(id) = first
                    && let Some(symbol) = id.symbol_id.get()
                {
                    accessors.insert(symbol);
                }
            }
            ("createMemo", BindingPattern::BindingIdentifier(id)) => {
                let Some(symbol) = id.symbol_id.get() else { continue };
                accessors.insert(symbol);
                let is_const = matches!(
                    nodes.parent_node(node.id()).kind(),
                    AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const
                );
                if !is_const || call.arguments.len() != 1 {
                    continue;
                }
                let fn_span = match &call.arguments[0] {
                    Argument::ArrowFunctionExpression(a) if !a.r#async && a.params.items.is_empty() && a.params.rest.is_none() => a.span,
                    Argument::FunctionExpression(f)
                        if !f.r#async && !f.generator && f.params.items.is_empty() && f.params.rest.is_none() =>
                    {
                        f.span
                    }
                    _ => continue,
                };
                memos.push((symbol, declarator.span, node.id(), fn_span));
            }
            _ => {}
        }
    }
    let memo_symbols: HashSet<SymbolId> = memos.iter().map(|m| m.0).collect();

    let mut plan: Vec<Fusion> = Vec::new();
    for &(symbol, declarator_span, declarator_node, fn_span) in &memos {
        // The memo's function node.
        let Some(fn_node) = find_function_node(nodes, declarator_node, fn_span) else { continue };
        let body_facts = match body_facts(nodes, fn_node, scoping, &imports, &accessors) {
            Some(f) => f,
            None => continue,
        };
        // A narrowing memo (its result is a comparison or a negation) exists
        // for its cut-off: most source writes leave it unchanged, and a fused
        // reader would re-run on every one of them (measured +8% to +16% per
        // write; scripts/heuristics/fusion/bench.mjs).
        if narrows(nodes.get_node(fn_node).kind()) {
            continue;
        }
        // Exactly one reference: a zero-argument call.
        let refs: Vec<_> = scoping.get_resolved_references(symbol).collect();
        if refs.len() != 1 {
            continue;
        }
        let ref_node = refs[0].node_id();
        let call_node = nodes.parent_node(ref_node);
        let AstKind::CallExpression(read) = call_node.kind() else { continue };
        if read.callee.span() != nodes.get_node(ref_node).kind().span() || !read.arguments.is_empty() {
            continue;
        }
        // Declared before it is read (no hoisted closure reads).
        if read.span.start < declarator_span.end {
            continue;
        }
        // Classify the reader: walk up to the first function boundary.
        let mut jsx_container: Option<NodeId> = None;
        let mut boundary: Option<NodeId> = None;
        let mut previous = call_node.id();
        for ancestor in nodes.ancestors(call_node.id()) {
            match ancestor.kind() {
                AstKind::JSXExpressionContainer(_) if jsx_container.is_none() => jsx_container = Some(ancestor.id()),
                AstKind::ArrowFunctionExpression(_) | AstKind::Function(_) => {
                    boundary = Some(ancestor.id());
                    break;
                }
                AstKind::Program(_) => break,
                _ => {}
            }
            previous = ancestor.id();
        }
        let _ = previous;
        let Some(boundary) = boundary else { continue };
        let (reader, effect_call) = if let Some(container) = jsx_container {
            // JSX: the memo's own component, no callback in between.
            let memo_scope = enclosing_function(nodes, declarator_node);
            if memo_scope != Some(boundary) {
                continue;
            }
            // Performance policy: only component-local sources.
            if !body_facts.accessor_reads.iter().all(|s| {
                let decl = scoping.symbol_declaration(*s);
                enclosing_function(nodes, decl) == Some(boundary)
            }) {
                continue;
            }
            if references_params(nodes, boundary, &body_facts.identifiers, scoping) {
                continue;
            }
            // Grouped attribute effects lose the cut-off for every part.
            if in_grouped_attribute(nodes, container) {
                continue;
            }
            (Reader::Jsx, None)
        } else {
            // Shared sources: the memo's cut-off shields its reader from
            // writes it absorbs; keep it unless every source lives in the
            // memo's own scope.
            let memo_scope = enclosing_function(nodes, declarator_node);
            if !body_facts
                .accessor_reads
                .iter()
                .all(|s| enclosing_function(nodes, scoping.symbol_declaration(*s)) == memo_scope)
            {
                continue;
            }
            // The boundary must be the first argument of a known host call.
            let host = nodes.parent_node(boundary);
            let AstKind::CallExpression(host_call) = host.kind() else { continue };
            let boundary_span = nodes.get_node(boundary).kind().span();
            if host_call.arguments.first().map(|a| a.span()) != Some(boundary_span) {
                continue;
            }
            match name_of(host_call).as_deref() {
                Some("createMemo") => (Reader::Memo, None),
                Some("createEffect" | "createRenderEffect") => {
                    // Compute must be exactly `() => m()`.
                    let exact = matches!(
                        nodes.get_node(boundary).kind(),
                        AstKind::ArrowFunctionExpression(a)
                            if a.body.as_expression().is_some_and(|e| e.span() == read.span)
                    );
                    // An existing options argument must be an object literal
                    // without `equals`.
                    let options_ok = match host_call.arguments.get(2) {
                        None => true,
                        Some(Argument::ObjectExpression(o)) => !o.properties.iter().any(|p| {
                            matches!(p, oxc_ast::ast::ObjectPropertyKind::ObjectProperty(p)
                                if p.key.static_name().is_some_and(|n| n == "equals"))
                        }),
                        _ => false,
                    };
                    if !exact || !options_ok || host_call.arguments.len() < 2 {
                        continue;
                    }
                    (Reader::Effect, Some(host_call.span))
                }
                _ => continue,
            }
        };
        plan.push(Fusion {
            memo: symbol,
            declarator: declarator_span,
            read: read.span,
            reader,
            effect_call,
        });
    }

    // One layer per round, innermost first: skip a fusion whose memo's own
    // function contains another planned read (that inner memo fuses into it
    // this round; this one follows next round, so a chain collapses toward
    // its reader and an effect reader still sees an exact `() => m()`).
    let fn_span_of = |memo: SymbolId| memos.iter().find(|m| m.0 == memo).map(|m| m.3).unwrap();
    let reads: Vec<(SymbolId, Span)> = plan.iter().map(|f| (f.memo, f.read)).collect();
    let _ = memo_symbols;
    plan.retain(|f| {
        let own = fn_span_of(f.memo);
        !reads
            .iter()
            .any(|(s, read)| *s != f.memo && own.start <= read.start && read.end <= own.end)
    });
    plan
}

fn find_function_node(nodes: &AstNodes<'_>, declarator: NodeId, fn_span: Span) -> Option<NodeId> {
    // The function is a descendant of the declarator's call.
    nodes
        .iter()
        .find(|n| {
            matches!(n.kind(), AstKind::ArrowFunctionExpression(_) | AstKind::Function(_))
                && n.kind().span() == fn_span
                && nodes.ancestors(n.id()).any(|a| a.id() == declarator)
        })
        .map(|n| n.id())
}

/// Whether a memo function's result is a comparison or a negation.
fn narrows(kind: AstKind<'_>) -> bool {
    use oxc_ast::ast::{FunctionBody, UnaryOperator};
    let result = |body: &FunctionBody<'_>| -> Option<bool> {
        let Some(Statement::ReturnStatement(ret)) = body.statements.last() else {
            return None;
        };
        let e = ret.argument.as_ref()?;
        Some(match e.without_parentheses() {
            Expression::BinaryExpression(b) => b.operator.is_equality() || b.operator.is_compare(),
            Expression::UnaryExpression(u) => u.operator == UnaryOperator::LogicalNot,
            _ => false,
        })
    };
    let expr_narrows = |e: &Expression<'_>| match e.without_parentheses() {
        Expression::BinaryExpression(b) => b.operator.is_equality() || b.operator.is_compare(),
        Expression::UnaryExpression(u) => u.operator == UnaryOperator::LogicalNot,
        _ => false,
    };
    match kind {
        AstKind::ArrowFunctionExpression(a) => match &a.body {
            oxc_ast::ast::ArrowFunctionBody::FunctionBody(body) => result(body).unwrap_or(false),
            _ => a.body.as_expression().is_some_and(expr_narrows),
        },
        AstKind::Function(f) => f.body.as_ref().and_then(|b| result(b)).unwrap_or(false),
        _ => false,
    }
}

fn enclosing_function(nodes: &AstNodes<'_>, node: NodeId) -> Option<NodeId> {
    nodes
        .ancestors(node)
        .find(|a| matches!(a.kind(), AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)))
        .map(|a| a.id())
}

struct BodyFacts {
    accessor_reads: Vec<SymbolId>,
    identifiers: Vec<SymbolId>,
}

/// Checks the memo body's purity; returns what it reads.
fn body_facts(
    nodes: &AstNodes<'_>,
    fn_node: NodeId,
    scoping: &Scoping,
    imports: &HashMap<SymbolId, String>,
    accessors: &HashSet<SymbolId>,
) -> Option<BodyFacts> {
    let mut facts = BodyFacts { accessor_reads: Vec::new(), identifiers: Vec::new() };
    let fn_span = nodes.get_node(fn_node).kind().span();
    for node in nodes.iter() {
        let span = node.kind().span();
        if !(fn_span.start < span.start && span.end <= fn_span.end) {
            continue;
        }
        // Only nodes that really descend from the memo function.
        match node.kind() {
            AstKind::AwaitExpression(_)
            | AstKind::YieldExpression(_)
            | AstKind::ThisExpression(_)
            | AstKind::NewExpression(_)
            | AstKind::TaggedTemplateExpression(_)
            | AstKind::Super(_)
            | AstKind::JSXElement(_)
            | AstKind::JSXFragment(_) => return None,
            AstKind::IdentifierReference(id) => {
                if id.name == "arguments" {
                    return None;
                }
                if let Some(symbol) = id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) {
                    facts.identifiers.push(symbol);
                }
            }
            AstKind::CallExpression(call) => match &call.callee {
                Expression::Identifier(callee) => {
                    let symbol = callee.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id());
                    match symbol {
                        Some(s) if accessors.contains(&s) && call.arguments.is_empty() => {
                            facts.accessor_reads.push(s)
                        }
                        Some(s) if imports.contains_key(&s) => return None,
                        // Unresolved global: allowed only for known sync globals.
                        None if SYNC_GLOBALS.contains(&callee.name.as_str()) => {}
                        _ => return None,
                    }
                }
                Expression::StaticMemberExpression(member) => {
                    let method = member.property.name.as_str();
                    let global_ns = matches!(&member.object, Expression::Identifier(o)
                        if SYNC_GLOBALS.contains(&o.name.as_str())
                            && o.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()).is_none());
                    if !(SYNC_METHODS.contains(&method) || global_ns) {
                        return None;
                    }
                }
                _ => return None,
            },
            _ => {}
        }
    }
    Some(facts)
}

fn references_params(nodes: &AstNodes<'_>, function: NodeId, identifiers: &[SymbolId], scoping: &Scoping) -> bool {
    let params: Vec<SymbolId> = match nodes.get_node(function).kind() {
        AstKind::ArrowFunctionExpression(a) => a.params.items.iter().filter_map(|p| p.pattern.get_binding_identifier().and_then(|b| b.symbol_id.get())).collect(),
        AstKind::Function(f) => f.params.items.iter().filter_map(|p| p.pattern.get_binding_identifier().and_then(|b| b.symbol_id.get())).collect(),
        _ => Vec::new(),
    };
    let _ = scoping;
    identifiers.iter().any(|s| params.contains(s))
}

/// Is this JSX expression container an attribute value on an element with
/// more than one dynamic (non-handler) attribute?
fn in_grouped_attribute(nodes: &AstNodes<'_>, container: NodeId) -> bool {
    let parent = nodes.parent_node(container);
    let AstKind::JSXAttribute(_) = parent.kind() else {
        return false;
    };
    let opening = nodes.parent_node(parent.id());
    let AstKind::JSXOpeningElement(opening) = opening.kind() else {
        return false;
    };
    let dynamic = opening
        .attributes
        .iter()
        .filter(|item| match item {
            JSXAttributeItem::Attribute(a) => {
                let name = a.name.get_identifier().name.as_str();
                let handler = name.starts_with("on") || name == "ref";
                !handler
                    && matches!(&a.value, Some(JSXAttributeValue::ExpressionContainer(c))
                        if !matches!(c.expression, JSXExpression::StringLiteral(_) | JSXExpression::NumericLiteral(_) | JSXExpression::EmptyExpression(_)))
            }
            JSXAttributeItem::SpreadAttribute(_) => true,
        })
        .count();
    dynamic > 1
}

// --- rewriting --------------------------------------------------------------

fn apply<'a>(allocator: &'a Allocator, program: &mut Program<'a>, plan: Vec<Fusion>) {
    // Clone each memo's function first (immutable walk).
    let mut functions: HashMap<Span, Expression<'a>> = HashMap::new();
    {
        struct Grab<'x, 'a> {
            allocator: &'a Allocator,
            wanted: &'x HashSet<Span>,
            out: &'x mut HashMap<Span, Expression<'a>>,
        }
        impl<'x, 'a> Visit<'a> for Grab<'x, 'a> {
            fn visit_variable_declarator(&mut self, d: &oxc_ast::ast::VariableDeclarator<'a>) {
                if self.wanted.contains(&d.span)
                    && let Some(Expression::CallExpression(call)) = &d.init
                    && let Some(arg) = call.arguments.first()
                {
                    let f: Expression<'a> = match arg {
                        Argument::ArrowFunctionExpression(a) => Expression::ArrowFunctionExpression(a.clone_in(self.allocator)),
                        Argument::FunctionExpression(f) => Expression::FunctionExpression(f.clone_in(self.allocator)),
                        _ => return,
                    };
                    self.out.insert(d.span, f);
                }
                walk::walk_variable_declarator(self, d);
            }
        }
        let wanted: HashSet<Span> = plan.iter().map(|f| f.declarator).collect();
        let mut grab = Grab { allocator, wanted: &wanted, out: &mut functions };
        grab.visit_program(program);
    }
    let mut rewriter = Rewriter {
        allocator,
        by_read: plan.iter().map(|f| (f.read, f.declarator)).collect(),
        effects: plan.iter().filter_map(|f| f.effect_call.map(|c| (c, f.declarator))).collect(),
        remove: plan.iter().map(|f| f.declarator).collect(),
        functions,
    };
    rewriter.visit_program(program);
}

struct Rewriter<'a> {
    allocator: &'a Allocator,
    /// read call span → memo declarator span
    by_read: HashMap<Span, Span>,
    /// effect call span → memo declarator span
    effects: HashMap<Span, Span>,
    remove: HashSet<Span>,
    functions: HashMap<Span, Expression<'a>>,
}

impl<'a> Rewriter<'a> {
    /// The expression that replaces `m()`: the body of an expression arrow,
    /// else an immediately invoked copy of the function.
    fn inlined(&self, declarator: Span) -> Option<Expression<'a>> {
        let ast = AstBuilder::new(self.allocator);
        let function = self.functions.get(&declarator)?.clone_in(self.allocator);
        if let Expression::ArrowFunctionExpression(arrow) = &function
            && let Some(body) = arrow.body.as_expression()
        {
            let inner = body.clone_in(self.allocator);
            return Some(ast.expression_parenthesized(Span::new(0, 0), inner));
        }
        let span = function.span();
        Some(ast.expression_call(
            span,
            ast.expression_parenthesized(Span::new(0, 0), function),
            None,
            ast.vec(),
            false,
        ))
    }
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::CallExpression(call) = expression {
            // Effect reader: replace the compute with the memo's function and
            // add `{ equals: _$isEqual }`.
            if let Some(&declarator) = self.effects.get(&call.span) {
                let ast = AstBuilder::new(self.allocator);
                if let Some(function) = self.functions.get(&declarator) {
                    call.arguments[0] = expression_to_argument(function.clone_in(self.allocator));
                    let equals = ast.object_property_kind_object_property(
                        Span::new(0, 0),
                        oxc_ast::ast::PropertyKind::Init,
                        ast.property_key_static_identifier(Span::new(0, 0), ast.ident("equals")),
                        ast.expression_identifier(Span::new(0, 0), ast.ident(IS_EQUAL_LOCAL)),
                        false,
                        false,
                        false,
                    );
                    match call.arguments.get_mut(2) {
                        Some(Argument::ObjectExpression(o)) => o.properties.push(equals),
                        _ => {
                            let object = ast.expression_object(Span::new(0, 0), ast.vec1(equals));
                            call.arguments.push(expression_to_argument(object));
                        }
                    }
                }
                walk_mut::walk_expression(self, expression);
                return;
            }
            if let Some(&declarator) = self.by_read.get(&call.span)
                && let Some(replacement) = self.inlined(declarator)
            {
                *expression = replacement;
                return;
            }
        }
        walk_mut::walk_expression(self, expression);
    }

    fn visit_statements(&mut self, statements: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        let remove = &self.remove;
        statements.retain(|statement| match statement {
            Statement::VariableDeclaration(d) => {
                !(d.declarations.len() == 1 && remove.contains(&d.declarations[0].span))
            }
            _ => true,
        });
        for statement in statements.iter_mut() {
            if let Statement::VariableDeclaration(d) = statement
                && d.declarations.len() > 1
            {
                d.declarations.retain(|x| !remove.contains(&x.span));
            }
        }
        walk_mut::walk_statements(self, statements);
    }

    fn visit_function(&mut self, f: &mut oxc_ast::ast::Function<'a>, flags: ScopeFlags) {
        walk_mut::walk_function(self, f, flags);
    }
}

fn add_import<'a>(allocator: &'a Allocator, program: &mut Program<'a>, import_span: Span) {
    let ast = AstBuilder::new(allocator);
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(import) = statement else { continue };
        if import.span != import_span {
            continue;
        }
        let already = import.specifiers.iter().flatten().any(|s| {
            matches!(s, ImportDeclarationSpecifier::ImportSpecifier(s) if s.local.name == IS_EQUAL_LOCAL)
        });
        if already {
            return;
        }
        let span = Span::new(0, 0);
        let specifier = ast.import_declaration_specifier_import_specifier(
            span,
            ast.module_export_name_identifier_name(span, ast.ident("isEqual")),
            ast.binding_identifier(span, ast.ident(IS_EQUAL_LOCAL)),
            ImportOrExportKind::Value,
        );
        match import.specifiers.as_mut() {
            Some(s) => s.push(specifier),
            None => import.specifiers = Some(ast.vec1(specifier)),
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, Generate, compile};

    fn fuse(source: &str, generate: Generate) -> String {
        compile(source, &CompileOptions { generate, memo_fusion: true, ..CompileOptions::default() })
            .map(|o| o.code)
            .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn fuses_a_memo_chain_into_an_effect_with_equals() {
        let source = r#"
import { createMemo, createRenderEffect, createSignal } from "solid-js";
const [a] = createSignal(1);
const [b] = createSignal(2);
const total = createMemo(() => a() + b());
const label = createMemo(() => `${total()} items`);
createRenderEffect(() => label(), v => console.log(v));
"#;
        let out = fuse(source, Generate::Dom);
        assert!(!out.contains("createMemo(("), "{out}");
        assert!(out.contains("equals: _$isEqual"), "{out}");
        assert!(out.contains("isEqual as _$isEqual"), "{out}");
        assert!(out.contains("a() + b()"), "{out}");
    }

    #[test]
    fn keeps_memos_with_two_readers_escapes_options_or_effects_that_wrap_the_read() {
        let source = r#"
import { createMemo, createRenderEffect, createSignal } from "solid-js";
const [a] = createSignal(1);
const twice = createMemo(() => a() * 2);
createRenderEffect(() => twice(), v => console.log(v));
createRenderEffect(() => twice(), v => console.log(v));
const escaped = createMemo(() => a() + 1);
export { escaped };
const opts = createMemo(() => a() + 2, { equals: false });
createRenderEffect(() => opts(), v => console.log(v));
const wrapped = createMemo(() => a() + 3);
createRenderEffect(() => wrapped() > 1, v => console.log(v));
"#;
        let out = fuse(source, Generate::Dom);
        assert_eq!(out.matches("createMemo(").count(), 4, "{out}");
    }

    #[test]
    fn keeps_narrowing_memos_and_shared_sources() {
        let source = r#"
import { createMemo, createRenderEffect, createSignal } from "solid-js";
const [selected] = createSignal(-1);
export function row(i) {
  const [x] = createSignal(0);
  const big = createMemo(() => x() > 1000);
  createRenderEffect(() => big(), v => console.log(v));
  const off = createMemo(() => { return !x(); });
  createRenderEffect(() => off(), v => console.log(v));
  const shifted = createMemo(() => selected() + i);
  createRenderEffect(() => shifted(), v => console.log(v));
  const local = createMemo(() => x() + i);
  createRenderEffect(() => local(), v => console.log(v));
}
"#;
        let out = fuse(source, Generate::Dom);
        assert_eq!(out.matches("createMemo(").count(), 3, "{out}");
        assert!(out.contains("big = createMemo"), "{out}");
        assert!(out.contains("off = createMemo"), "{out}");
        assert!(out.contains("shifted = createMemo"), "{out}");
        assert!(!out.contains("local = createMemo"), "{out}");
    }

    #[test]
    fn refuses_bodies_that_could_create_await_or_call_unknowns() {
        let source = r#"
import { createMemo, createRenderEffect, createSignal, untrack } from "solid-js";
const [a] = createSignal(1);
const m1 = createMemo(() => fetchUser(a()));
createRenderEffect(() => m1(), v => console.log(v));
const m2 = createMemo(() => untrack(a));
createRenderEffect(() => m2(), v => console.log(v));
const m3 = createMemo(async () => a());
createRenderEffect(() => m3(), v => console.log(v));
const m4 = createMemo(prev => a() + prev);
createRenderEffect(() => m4(), v => console.log(v));
"#;
        let out = fuse(source, Generate::Dom);
        assert_eq!(out.matches("createMemo(").count(), 4, "{out}");
    }

    #[test]
    fn fuses_local_jsx_reads_on_every_generate_but_not_shared_sources() {
        let source = r#"
import { createMemo, createSignal } from "solid-js";
const [selected] = createSignal(-1);
function Row(props) {
  const [label] = createSignal("x");
  const upper = createMemo(() => label().toUpperCase());
  const isSel = createMemo(() => selected() === 1);
  return <tr class={isSel() ? "danger" : ""}><td>{upper()}</td></tr>;
}
"#;
        for generate in [Generate::Dom, Generate::Ssr] {
            let out = fuse(source, generate);
            // `upper` is local → fused; `isSel` reads an outer source → kept.
            assert!(!out.contains("const upper"), "{out}");
            assert!(out.contains("isSel"), "{out}");
        }
    }

    #[test]
    fn leaves_everything_alone_when_off() {
        let source = r#"
import { createMemo, createRenderEffect, createSignal } from "solid-js";
const [a] = createSignal(1);
const m = createMemo(() => a() + 1);
createRenderEffect(() => m(), v => console.log(v));
"#;
        let out = compile(source, &CompileOptions::default()).unwrap().code;
        assert!(out.contains("createMemo("), "{out}");
    }
}
