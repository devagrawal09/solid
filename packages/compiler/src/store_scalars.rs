//! Store scalar replacement (experimental, `storeScalars`; S2 in
//! documentation/plans/heuristic-oracles.md).
//!
//! A store whose shape is a flat literal of primitives, that never escapes,
//! and whose setter only assigns whole fields is observably a set of
//! independent signals. The pass replaces it by one signal per field:
//!
//! ```js
//! const [s, setS] = createStore({ count: 0, label: "a" });
//! s.count;                                   // → _$s_count()
//! setS(d => { d.count++; d.label = "b" + x; });
//! // → (() => { _$set_s_count(_$p => ++_$p);
//! //            { const _$v = "b" + x; _$set_s_label(() => _$v); } })()
//! ```
//!
//! Measured on the oracle: mount −76%, update −67%, select −29% (a store is
//! a target, a proxy and a node per field; a signal is a node).
//!
//! Proof (all syntactic, per store; any failure keeps the store):
//! - `const [s, setS] = createStore({ … })` (or `[s]`), `createStore`
//!   imported from `solid-js` / `@solidjs/signals`, one argument: an object
//!   literal of `key: <primitive literal>` properties (no spread, computed
//!   or duplicate keys, methods, accessors);
//! - every reference to `s` is a read `s.key` of a known key: not written,
//!   deleted, called, destructured, optional, or delegated (`yield*`);
//! - every reference to `setS` is a call `setS(d => …)` / `setS(function (d)
//!   { … })` whose body is only field writes `d.key = e`, `d.key op= e`,
//!   `d.key++` / `--` (never logical assignments), where `e` is provably
//!   primitive (a literal, template, unary / binary / update / `typeof`
//!   expression, a `String` / `Number` / `Boolean` / `BigInt` call, a read of
//!   a scalar-replaced field, or a conditional / logical / sequence of those)
//!   and reads the draft only as `d.key` of the field it writes; the draft is
//!   used for nothing else, and no setter call sits inside another's callback.
//!
//! So every field only ever holds a primitive: a store read of it returns
//! the value itself (no nested proxy) and compares with `===`, as a signal
//! does. Both stage writes until flush (reads before flush return the
//! committed value). A draft read sees the draft's own writes; the rewrite
//! keeps that with a functional updater (`_$p`, the latest value), and a
//! right-hand side that reads its own field moves into the updater so it is
//! evaluated at the same point. Equivalence is pinned by
//! scripts/heuristics/fusion/stores.mjs (compiled off vs on, identical
//! values and effect runs).
//!
//! The pass runs first, on the authored program, and builds each replacement
//! from source text (spans still address the source).
use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, AssignmentOperator, AssignmentTarget, BindingPattern, Expression,
    ImportDeclarationSpecifier, ImportOrExportKind, ObjectPropertyKind, Program, PropertyKey,
    PropertyKind, SimpleAssignmentTarget, Statement, UnaryOperator, UpdateOperator,
    VariableDeclarationKind,
};
use oxc_ast_visit::{VisitMut, walk_mut};
use oxc_parser::Parser;
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, SourceType, Span};

use crate::shared::ast_builder::AstBuilder;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
const PRIMITIVE_CALLS: &[&str] = &["String", "Number", "Boolean", "BigInt"];

struct Field {
    init_span: Span,
    /// The initial value's source text, with replaced-store reads rewritten.
    init: String,
    getter: String,
    setter: String,
}

struct Store {
    declarator: Span,
    fields: Vec<Field>,
}

/// Rewrite every provable store. Returns how many were replaced.
pub(crate) fn transform_store_scalars<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &str,
    source_type: SourceType,
) -> usize {
    let Some(import_span) = store_import_span(program) else {
        return 0;
    };
    let edits = {
        let semantic = SemanticBuilder::new().with_build_nodes(true).build(program).semantic;
        plan(program, semantic.scoping(), semantic.nodes(), source)
    };
    let Some(edits) = edits else { return 0 };
    // Every fragment must parse before anything is rewritten (all or nothing).
    let scratch = Allocator::default();
    let texts = edits
        .reads
        .values()
        .chain(edits.calls.values())
        .cloned()
        .chain(edits.stores.iter().flat_map(|s| s.fields.iter().map(declarator_text)));
    for text in texts {
        if Parser::new(&scratch, scratch.alloc_str(&text), source_type).parse_expression().is_err() {
            return 0;
        }
    }
    let count = edits.stores.len();
    let mut rewriter = Rewriter { allocator, source_type, edits };
    rewriter.visit_program(program);
    add_import(allocator, program, import_span);
    count
}

fn store_import_span(program: &Program<'_>) -> Option<Span> {
    program.body.iter().find_map(|statement| {
        let Statement::ImportDeclaration(import) = statement else { return None };
        let found = RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.import_kind != ImportOrExportKind::Type
            && import.specifiers.iter().flatten().any(|s| {
                matches!(s, ImportDeclarationSpecifier::ImportSpecifier(s)
                    if s.imported.name() == "createStore" && s.import_kind != ImportOrExportKind::Type)
            });
        found.then_some(import.span)
    })
}

// --- planning ---------------------------------------------------------------

struct Edits {
    stores: Vec<Store>,
    /// Declarator span → store index.
    declarators: HashMap<Span, usize>,
    /// `s.key` read span → replacement text.
    reads: HashMap<Span, String>,
    /// `setS(…)` call span → replacement text.
    calls: HashMap<Span, String>,
}

struct WriteOp {
    field: usize,
    /// `=` → None; `+=` → Some("+"); `++` → Some("++").
    op: Option<&'static str>,
    rhs: Option<Span>,
}

fn plan(program: &Program<'_>, scoping: &Scoping, nodes: &AstNodes<'_>, source: &str) -> Option<Edits> {
    // createStore symbols.
    let mut create_store: HashSet<SymbolId> = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else { continue };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str()) || import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        for s in import.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(s) = s
                && s.imported.name() == "createStore"
                && let Some(symbol) = s.local.symbol_id.get()
            {
                create_store.insert(symbol);
            }
        }
    }
    let resolves_to = |e: &Expression<'_>, set: &HashSet<SymbolId>| -> bool {
        let Expression::Identifier(id) = e else { return false };
        id.reference_id
            .get()
            .and_then(|r| scoping.get_reference(r).symbol_id())
            .is_some_and(|s| set.contains(&s))
    };

    // Candidates.
    struct Candidate {
        declarator: Span,
        getter: SymbolId,
        setter: Option<SymbolId>,
        name: String,
        fields: Vec<(String, Span)>,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    for node in nodes.iter() {
        let AstKind::VariableDeclarator(d) = node.kind() else { continue };
        let Some(Expression::CallExpression(call)) = &d.init else { continue };
        if !resolves_to(&call.callee, &create_store) || call.arguments.len() != 1 {
            continue;
        }
        if !matches!(nodes.parent_node(node.id()).kind(), AstKind::VariableDeclaration(v) if v.kind == VariableDeclarationKind::Const)
        {
            continue;
        }
        let BindingPattern::ArrayPattern(pattern) = &d.id else { continue };
        if pattern.rest.is_some() || pattern.elements.is_empty() || pattern.elements.len() > 2 {
            continue;
        }
        let ident = |i: usize| match pattern.elements.get(i) {
            Some(Some(BindingPattern::BindingIdentifier(id))) => Some(id),
            _ => None,
        };
        let Some(getter) = ident(0) else { continue };
        let setter = ident(1);
        if pattern.elements.len() == 2 && setter.is_none() {
            continue;
        }
        let Argument::ObjectExpression(object) = &call.arguments[0] else { continue };
        let mut fields: Vec<(String, Span)> = Vec::new();
        let mut ok = true;
        for property in &object.properties {
            let ObjectPropertyKind::ObjectProperty(p) = property else {
                ok = false;
                break;
            };
            let key = match &p.key {
                PropertyKey::StaticIdentifier(id) if !p.computed => id.name.to_string(),
                PropertyKey::StringLiteral(s) if !p.computed => s.value.to_string(),
                _ => {
                    ok = false;
                    break;
                }
            };
            if p.kind != PropertyKind::Init
                || p.method
                || p.shorthand
                || !(is_literal(&p.value) || primitive(&p.value, scoping, &|_| false, &|_| false, &|_| false))
                || fields.iter().any(|f| f.0 == key)
            {
                ok = false;
                break;
            }
            fields.push((key, p.value.span()));
        }
        if !ok || fields.is_empty() {
            continue;
        }
        let (Some(g), s) = (getter.symbol_id.get(), setter.and_then(|s| s.symbol_id.get())) else { continue };
        if setter.is_some() && s.is_none() {
            continue;
        }
        candidates.push(Candidate { declarator: d.span, getter: g, setter: s, name: getter.name.to_string(), fields });
    }
    if candidates.is_empty() {
        return None;
    }

    // Verify each candidate's references; collect its sites. A setter's
    // right-hand side may read another candidate's field (a primitive); the
    // reader then depends on that store being replaced too.
    struct Accepted {
        store: Store,
        getter: SymbolId,
        reads: Vec<(Span, usize)>,
        calls: Vec<(Span, Vec<WriteOp>, SymbolId, Span)>,
        deps: HashSet<SymbolId>,
    }
    let store_keys: HashMap<SymbolId, Vec<String>> =
        candidates.iter().map(|c| (c.getter, c.fields.iter().map(|f| f.0.clone()).collect())).collect();
    let deps = std::cell::RefCell::new(HashSet::new());
    let store_read = |e: &Expression<'_>| -> bool {
        let Expression::StaticMemberExpression(m) = e.without_parentheses() else { return false };
        let Expression::Identifier(id) = &m.object else { return false };
        let Some(symbol) = id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) else {
            return false;
        };
        let known = store_keys.get(&symbol).is_some_and(|keys| keys.iter().any(|k| k == m.property.name.as_str()));
        if known {
            deps.borrow_mut().insert(symbol);
        }
        known
    };
    let mut accepted: Vec<Accepted> = Vec::new();
    let mut used_names: HashSet<String> = HashSet::new();
    'candidate: for c in candidates {
        deps.borrow_mut().clear();
        let key_index = |k: &str| c.fields.iter().position(|f| f.0 == k);
        let mut reads = Vec::new();
        for reference in scoping.get_resolved_references(c.getter) {
            let Some(field) = static_read(nodes, reference.node_id(), &key_index) else { continue 'candidate };
            reads.push(field);
        }
        let mut calls = Vec::new();
        if let Some(setter) = c.setter {
            for reference in scoping.get_resolved_references(setter) {
                let Some(call) = setter_call(nodes, scoping, reference.node_id(), &key_index, setter, c.getter, &store_read) else {
                    continue 'candidate;
                };
                calls.push(call);
            }
        }
        let base = sanitize(&c.name);
        let fields = c
            .fields
            .iter()
            .enumerate()
            .map(|(i, (key, init))| {
                let part = if is_identifier(key) { key.clone() } else { i.to_string() };
                let mut getter = format!("_${base}_{part}");
                while !used_names.insert(getter.clone()) {
                    getter.push('_');
                }
                let setter = format!("_$set_{}", &getter[2..]);
                let _ = key;
                Field { init_span: *init, init: String::new(), getter, setter }
            })
            .collect();
        accepted.push(Accepted {
            store: Store { declarator: c.declarator, fields },
            getter: c.getter,
            reads,
            calls,
            deps: deps.borrow().clone(),
        });
    }
    loop {
        let replaced: HashSet<SymbolId> = accepted.iter().map(|a| a.getter).collect();
        let before = accepted.len();
        accepted.retain(|a| a.deps.iter().all(|d| replaced.contains(d)));
        if accepted.len() == before {
            break;
        }
    }
    if accepted.is_empty() {
        return None;
    }

    // Replacement text. Reads of any accepted store inside a setter's
    // right-hand side are rewritten within the generated text.
    let read_text: HashMap<Span, String> = accepted
        .iter()
        .flat_map(|a| a.reads.iter().map(move |(span, f)| (*span, format!("{}()", a.store.fields[*f].getter))))
        .collect();
    let mut edits = Edits {
        stores: Vec::new(),
        declarators: HashMap::new(),
        reads: read_text.clone(),
        calls: HashMap::new(),
    };
    for (index, mut a) in accepted.into_iter().enumerate() {
        for field in &mut a.store.fields {
            let span = field.init_span;
            let inner = read_text
                .iter()
                .filter(|(s, _)| span.start <= s.start && s.end <= span.end)
                .map(|(s, t)| (*s, t.clone()))
                .collect();
            field.init = splice(source, span, inner);
        }
        for (call_span, ops, draft, _) in &a.calls {
            let mut body = String::new();
            for op in ops {
                let field = &a.store.fields[op.field];
                // `d.key` of the written field inside the right-hand side.
                let own_reads = draft_reads(nodes, scoping, &[*draft, a.getter], op);
                let rhs = op.rhs.map(|span| {
                    let mut inner: Vec<(Span, String)> = own_reads.iter().map(|s| (*s, "_$p".to_string())).collect();
                    for (s, t) in &read_text {
                        if span.start <= s.start && s.end <= span.end && !own_reads.contains(s) {
                            inner.push((*s, t.clone()));
                        }
                    }
                    splice(source, span, inner)
                });
                let set = &field.setter;
                match (op.op, rhs) {
                    (Some("++"), None) => body.push_str(&format!("{set}(_$p => ++_$p);")),
                    (Some("--"), None) => body.push_str(&format!("{set}(_$p => --_$p);")),
                    (None, Some(rhs)) if own_reads.is_empty() => {
                        body.push_str(&format!("{{ const _$v = ({rhs}); {set}(() => _$v); }}"))
                    }
                    (None, Some(rhs)) => body.push_str(&format!("{set}(_$p => ({rhs}));")),
                    (Some(o), Some(rhs)) if own_reads.is_empty() => {
                        body.push_str(&format!("{{ const _$v = ({rhs}); {set}(_$p => _$p {o} _$v); }}"))
                    }
                    (Some(o), Some(rhs)) => body.push_str(&format!("{set}(_$p => _$p {o} ({rhs}));")),
                    _ => return None,
                }
            }
            edits.calls.insert(*call_span, format!("(() => {{ {body} }})()"));
        }
        edits.declarators.insert(a.store.declarator, index);
        edits.stores.push(a.store);
    }
    Some(edits)
}

/// A primitive literal.
fn is_literal(e: &Expression<'_>) -> bool {
    match e.without_parentheses() {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_) => true,
        Expression::TemplateLiteral(t) => t.expressions.is_empty(),
        Expression::UnaryExpression(u) => {
            matches!(u.operator, UnaryOperator::UnaryNegation | UnaryOperator::UnaryPlus)
                && matches!(u.argument, Expression::NumericLiteral(_) | Expression::BigIntLiteral(_))
        }
        _ => false,
    }
}

/// `s.key` in a read-only position → the field index.
fn static_read(nodes: &AstNodes<'_>, reference: NodeId, key_index: &dyn Fn(&str) -> Option<usize>) -> Option<(Span, usize)> {
    let member_node = nodes.parent_node(reference);
    let AstKind::StaticMemberExpression(member) = member_node.kind() else { return None };
    if member.optional || member.object.span() != nodes.get_node(reference).kind().span() {
        return None;
    }
    let field = key_index(member.property.name.as_str())?;
    if !read_only_position(nodes, member_node.id(), member.span) {
        return None;
    }
    Some((member.span, field))
}

fn read_only_position(nodes: &AstNodes<'_>, member: NodeId, span: Span) -> bool {
    let parent = nodes.parent_node(member);
    match parent.kind() {
        AstKind::AssignmentExpression(a) => a.left.span() != span,
        AstKind::UpdateExpression(_) | AstKind::ChainExpression(_) | AstKind::TaggedTemplateExpression(_) => false,
        AstKind::UnaryExpression(u) => u.operator != UnaryOperator::Delete,
        AstKind::CallExpression(c) => c.callee.span() != span,
        AstKind::NewExpression(n) => n.callee.span() != span,
        AstKind::YieldExpression(y) => !y.delegate,
        AstKind::ForInStatement(f) => f.left.span() != span,
        AstKind::ForOfStatement(f) => f.left.span() != span,
        kind => !kind.debug_name().contains("AssignmentTarget"),
    }
}

/// `setS(d => …)` with only field writes → (call span, writes, draft, callback span).
fn setter_call(
    nodes: &AstNodes<'_>,
    scoping: &Scoping,
    reference: NodeId,
    key_index: &dyn Fn(&str) -> Option<usize>,
    setter: SymbolId,
    getter: SymbolId,
    store_read: &dyn Fn(&Expression<'_>) -> bool,
) -> Option<(Span, Vec<WriteOp>, SymbolId, Span)> {
    let call_node = nodes.parent_node(reference);
    let AstKind::CallExpression(call) = call_node.kind() else { return None };
    if call.callee.span() != nodes.get_node(reference).kind().span() || call.arguments.len() != 1 || call.optional {
        return None;
    }
    // Not inside another setter callback (re-entrant writes).
    for ancestor in nodes.ancestors(call_node.id()) {
        if let AstKind::CallExpression(outer) = ancestor.kind()
            && let Expression::Identifier(id) = &outer.callee
            && id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) == Some(setter)
        {
            return None;
        }
    }
    let (params, expressions, callback): (_, Vec<&Expression<'_>>, Span) = match &call.arguments[0] {
        Argument::ArrowFunctionExpression(a) if !a.r#async => {
            let exprs = if let Some(e) = a.body.as_expression() {
                vec![e]
            } else {
                match &a.body {
                    oxc_ast::ast::ArrowFunctionBody::FunctionBody(b) => statements_as_expressions(&b.statements)?,
                    _ => return None,
                }
            };
            (&a.params, exprs, a.span)
        }
        Argument::FunctionExpression(f) if !f.r#async && !f.generator && f.id.is_none() => {
            (&f.params, statements_as_expressions(&f.body.as_ref()?.statements)?, f.span)
        }
        _ => return None,
    };
    if params.items.len() != 1 || params.rest.is_some() || params.items[0].initializer.is_some() {
        return None;
    }
    let BindingPattern::BindingIdentifier(draft) = &params.items[0].pattern else { return None };
    let draft_symbol = draft.symbol_id.get()?;
    let member_of = |e: &Expression<'_>, symbol: SymbolId| -> Option<usize> {
        let Expression::StaticMemberExpression(m) = e.without_parentheses() else { return None };
        let Expression::Identifier(id) = &m.object else { return None };
        (id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) == Some(symbol))
            .then(|| key_index(m.property.name.as_str()))
            .flatten()
    };
    let draft_member = |e: &Expression<'_>| member_of(e, draft_symbol);
    // Inside its own setter the store's proxy IS the draft: `s.key` reads the
    // draft (latest) value, exactly like `d.key`.
    let latest_member = |e: &Expression<'_>| draft_member(e).or_else(|| member_of(e, getter));
    let target_field = |t: &SimpleAssignmentTarget<'_>| -> Option<usize> {
        let SimpleAssignmentTarget::StaticMemberExpression(m) = t else { return None };
        if m.optional {
            return None;
        }
        let Expression::Identifier(id) = &m.object else { return None };
        (id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) == Some(draft_symbol))
            .then(|| key_index(m.property.name.as_str()))
            .flatten()
    };
    let mut ops = Vec::new();
    let mut allowed_draft_refs = 0usize;
    for e in expressions {
        match e.without_parentheses() {
            Expression::AssignmentExpression(a) => {
                let AssignmentTarget::StaticMemberExpression(_) = &a.left else { return None };
                let field = target_field(a.left.as_simple_assignment_target()?)?;
                let op = match a.operator {
                    AssignmentOperator::Assign => None,
                    AssignmentOperator::LogicalAnd | AssignmentOperator::LogicalOr | AssignmentOperator::LogicalNullish => {
                        return None;
                    }
                    other => Some(other.as_str().trim_end_matches('=')),
                };
                if !primitive(
                    &a.right,
                    scoping,
                    &|e| latest_member(e) == Some(field),
                    &|e| latest_member(e).is_some(),
                    store_read,
                ) {
                    return None;
                }
                allowed_draft_refs += 1 + count_draft_reads(&a.right, &|e| draft_member(e) == Some(field));
                ops.push(WriteOp { field, op, rhs: Some(a.right.span()) });
            }
            Expression::UpdateExpression(u) => {
                let field = target_field(&u.argument)?;
                allowed_draft_refs += 1;
                let op = if u.operator == UpdateOperator::Increment { "++" } else { "--" };
                ops.push(WriteOp { field, op: Some(op), rhs: None });
            }
            _ => return None,
        }
    }
    // The draft is used for nothing else (every reference counted above, all
    // directly in the callback: no closure keeps it).
    let refs: Vec<_> = scoping.get_resolved_references(draft_symbol).collect();
    if refs.len() != allowed_draft_refs {
        return None;
    }
    for r in refs {
        let inner = nodes
            .ancestors(r.node_id())
            .find(|a| matches!(a.kind(), AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)))
            .map(|a| a.kind().span());
        if inner != Some(callback) {
            return None;
        }
    }
    Some((call.span, ops, draft_symbol, callback))
}

fn statements_as_expressions<'b, 'a>(statements: &'b [Statement<'a>]) -> Option<Vec<&'b Expression<'a>>> {
    statements
        .iter()
        .map(|s| match s {
            Statement::ExpressionStatement(e) => Some(&e.expression),
            _ => None,
        })
        .collect()
}

/// Whether `e` provably evaluates to a primitive. `own` recognizes `d.key`
/// of the written field (allowed); `any_draft` any other draft use (refused).
fn primitive(
    e: &Expression<'_>,
    scoping: &Scoping,
    own: &dyn Fn(&Expression<'_>) -> bool,
    any_draft: &dyn Fn(&Expression<'_>) -> bool,
    store_read: &dyn Fn(&Expression<'_>) -> bool,
) -> bool {
    let e = e.without_parentheses();
    if own(e) {
        return true;
    }
    if any_draft(e) || mentions_draft_elsewhere(e, own, any_draft) {
        return false;
    }
    if store_read(e) {
        return true;
    }
    match e {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::TemplateLiteral(_)
        | Expression::BinaryExpression(_)
        | Expression::UpdateExpression(_) => true,
        Expression::UnaryExpression(u) => u.operator != UnaryOperator::Delete,
        Expression::ConditionalExpression(c) => {
            primitive(&c.consequent, scoping, own, any_draft, store_read)
                && primitive(&c.alternate, scoping, own, any_draft, store_read)
        }
        Expression::LogicalExpression(l) => {
            primitive(&l.left, scoping, own, any_draft, store_read)
                && primitive(&l.right, scoping, own, any_draft, store_read)
        }
        Expression::SequenceExpression(s) => s.expressions.last().is_some_and(|x| primitive(x, scoping, own, any_draft, store_read)),
        Expression::CallExpression(c) => match &c.callee {
            // An unshadowed global conversion.
            Expression::Identifier(id) => {
                PRIMITIVE_CALLS.contains(&id.name.as_str())
                    && id.reference_id.get().is_some_and(|r| scoping.get_reference(r).symbol_id().is_none())
            }
            _ => false,
        },
        // Other members are unknown.
        _ => false,
    }
}

/// A draft reference nested anywhere in `e` other than `own` reads.
fn mentions_draft_elsewhere(
    e: &Expression<'_>,
    own: &dyn Fn(&Expression<'_>) -> bool,
    any_draft: &dyn Fn(&Expression<'_>) -> bool,
) -> bool {
    use oxc_ast_visit::Visit;
    struct Finder<'f> {
        own: &'f dyn Fn(&Expression<'_>) -> bool,
        any: &'f dyn Fn(&Expression<'_>) -> bool,
        found: bool,
    }
    impl<'b> Visit<'b> for Finder<'_> {
        fn visit_expression(&mut self, e: &Expression<'b>) {
            if (self.own)(e) {
                return;
            }
            if (self.any)(e) {
                self.found = true;
                return;
            }
            oxc_ast_visit::walk::walk_expression(self, e);
        }
    }
    let mut f = Finder { own, any: any_draft, found: false };
    oxc_ast_visit::walk::walk_expression(&mut f, e);
    f.found
}

fn count_draft_reads(e: &Expression<'_>, own: &dyn Fn(&Expression<'_>) -> bool) -> usize {
    use oxc_ast_visit::Visit;
    struct Counter<'f> {
        own: &'f dyn Fn(&Expression<'_>) -> bool,
        n: usize,
    }
    impl<'b> Visit<'b> for Counter<'_> {
        fn visit_expression(&mut self, e: &Expression<'b>) {
            if (self.own)(e) {
                self.n += 1;
                return;
            }
            oxc_ast_visit::walk::walk_expression(self, e);
        }
    }
    let mut c = Counter { own, n: 0 };
    c.visit_expression(e);
    c.n
}

/// Spans of `d.key` / `s.key` (the written field, read from the draft) inside
/// a write's right-hand side.
fn draft_reads(nodes: &AstNodes<'_>, scoping: &Scoping, symbols: &[SymbolId], op: &WriteOp) -> Vec<Span> {
    let Some(rhs) = op.rhs else { return Vec::new() };
    symbols
        .iter()
        .flat_map(|s| scoping.get_resolved_references(*s))
        .filter_map(|r| {
            let AstKind::StaticMemberExpression(m) = nodes.parent_node(r.node_id()).kind() else { return None };
            (rhs.start <= m.span.start && m.span.end <= rhs.end).then_some(m.span)
        })
        .collect()
}

/// Source text of `span` with inner spans replaced (outermost wins).
fn splice(source: &str, span: Span, mut inner: Vec<(Span, String)>) -> String {
    inner.sort_by_key(|(s, _)| (s.start, std::cmp::Reverse(s.end)));
    let mut out = String::new();
    let mut at = span.start as usize;
    for (s, text) in inner {
        if (s.start as usize) < at {
            continue;
        }
        out.push_str(&source[at..s.start as usize]);
        out.push_str(&text);
        at = s.end as usize;
    }
    out.push_str(&source[at..span.end as usize]);
    out
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect()
}

// --- rewrite ----------------------------------------------------------------

struct Rewriter<'a> {
    allocator: &'a Allocator,
    source_type: SourceType,
    edits: Edits,
}

/// Every span in a parsed fragment → the site it replaces.
struct Respan(Span);
impl<'a> VisitMut<'a> for Respan {
    fn visit_span(&mut self, it: &mut Span) {
        *it = self.0;
    }
}

impl<'a> Rewriter<'a> {
    fn parse(&mut self, text: &str, site: Span) -> Option<Expression<'a>> {
        let text = self.allocator.alloc_str(text);
        match Parser::new(self.allocator, text, self.source_type).parse_expression() {
            Ok(mut e) => {
                Respan(Span::new(site.start, site.start)).visit_expression(&mut e);
                Some(e)
            }
            // Pre-validated in transform_store_scalars.
            Err(_) => None,
        }
    }
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let span = expression.span();
        let text = match expression {
            Expression::StaticMemberExpression(_) => self.edits.reads.get(&span).cloned(),
            Expression::CallExpression(_) => self.edits.calls.get(&span).cloned(),
            _ => None,
        };
        if let Some(text) = text
            && let Some(replacement) = self.parse(&text, span)
        {
            *expression = replacement;
            return;
        }
        walk_mut::walk_expression(self, expression);
    }

    fn visit_variable_declaration(&mut self, declaration: &mut oxc_ast::ast::VariableDeclaration<'a>) {
        walk_mut::walk_variable_declaration(self, declaration);
        if !declaration.declarations.iter().any(|d| self.edits.declarators.contains_key(&d.span)) {
            return;
        }
        let ast = AstBuilder::new(self.allocator);
        let declaration_kind = declaration.kind;
        let mut out = ast.vec();
        for d in declaration.declarations.drain(..) {
            let Some(&index) = self.edits.declarators.get(&d.span) else {
                out.push(d);
                continue;
            };
            let texts: Vec<String> = self.edits.stores[index].fields.iter().map(declarator_text).collect();
            for text in texts {
                // `[get, set] = _$createSignal(init)`, parsed as an
                // assignment and turned into a declarator.
                let Some(Expression::AssignmentExpression(assign)) = self.parse(&text, d.span) else { continue };
                let assign = assign.unbox();
                let AssignmentTarget::ArrayAssignmentTarget(target) = assign.left else { continue };
                let names: Vec<_> = target
                    .elements
                    .iter()
                    .flatten()
                    .filter_map(|t| match t {
                        oxc_ast::ast::AssignmentTargetMaybeDefault::AssignmentTargetIdentifier(id) => Some(id.name),
                        _ => None,
                    })
                    .collect();
                let elements = ast.vec_from_iter(names.into_iter().map(|name| {
                    Some(ast.binding_pattern_binding_identifier(d.span, name))
                }));
                let pattern = ast.binding_pattern_array_pattern(d.span, elements, None);
                out.push(ast.variable_declarator(d.span, declaration_kind, pattern, None, Some(assign.right), false));
            }
        }
        declaration.declarations = out;
    }
}

fn declarator_text(field: &Field) -> String {
    format!("[{}, {}] = _$createSignal({})", field.getter, field.setter, field.init)
}

fn add_import<'a>(allocator: &'a Allocator, program: &mut Program<'a>, import_span: Span) {
    let ast = AstBuilder::new(allocator);
    for statement in program.body.iter_mut() {
        let Statement::ImportDeclaration(import) = statement else { continue };
        if import.span != import_span {
            continue;
        }
        let span = Span::new(0, 0);
        let specifier = ast.import_declaration_specifier_import_specifier(
            span,
            ast.module_export_name_identifier_name(span, ast.ident("createSignal")),
            ast.binding_identifier(span, ast.ident("_$createSignal")),
            ImportOrExportKind::Value,
        );
        if let Some(specifiers) = import.specifiers.as_mut() {
            specifiers.push(specifier);
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, Generate, compile};

    fn run(source: &str, generate: Generate, on: bool) -> String {
        compile(source, &CompileOptions { generate, store_scalars: on, ..CompileOptions::default() })
            .map(|o| o.code)
            .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn replaces_a_flat_store_with_signals() {
        let source = r#"
import { createStore, createMemo } from "solid-js";
const [s, setS] = createStore({ count: 0, label: "a", "my-key": true });
const [t, setT] = createStore({ n: 1 });
export const doubled = createMemo(() => s.count * 2 + t.n);
export function bump(x) {
  setS(d => { d.count++; d.label = "b" + x; d.count += t.n; });
  setS(d => d.label = d.label + "!");
  setT(function (d) { d.n = Number(x) + 1; });
}
"#;
        let out = run(source, Generate::Dom, true);
        assert!(!out.contains("createStore("), "{out}");
        assert!(out.contains("createSignal as _$createSignal"), "{out}");
        assert!(out.contains("[_$s_count, _$set_s_count] = _$createSignal(0)"), "{out}");
        assert!(out.contains("[_$s_2, _$set_s_2] = _$createSignal(true)"), "{out}");
        assert!(out.contains("_$s_count() * 2 + _$t_n()"), "{out}");
        assert!(out.contains("_$set_s_count((_$p) => ++_$p)"), "{out}");
        assert!(out.contains("const _$v = \"b\" + x"), "{out}");
        assert!(out.contains("_$set_s_count((_$p) => _$p + _$v)"), "{out}");
        assert!(out.contains("_$set_s_label((_$p) => _$p + \"!\")"), "{out}");
        // `s.count` inside s's own setter is the draft's latest value.
        let own = run(
            "import { createStore } from \"solid-js\";\nconst [s, set] = createStore({ n: \"a\" + 1 });\nset(d => { d.n = s.n + 1; });\ns.n;",
            Generate::Dom,
            true,
        );
        assert!(own.contains("_$createSignal(\"a\" + 1)"), "{own}");
        assert!(own.contains("_$set_s_n((_$p) => _$p + 1)"), "{own}");
    }

    #[test]
    fn keeps_stores_it_cannot_prove() {
        let cases = [
            // escapes
            "const [s] = createStore({ a: 0 }); console.log(s);",
            "const [s] = createStore({ a: 0 }); export { s };",
            "const [s] = createStore({ a: 0 }); const { a } = s;",
            // unknown key, dynamic key, nested shape, non-literal init
            "const [s] = createStore({ a: 0 }); s.b;",
            "const [s] = createStore({ a: 0 }); s[k];",
            "const [s] = createStore({ a: { b: 1 } }); s.a;",
            "const [s] = createStore({ a: x }); s.a;",
            "let [s] = createStore({ a: 0 }); s.a;",
            // writes that are not whole primitive fields
            "const [s, set] = createStore({ a: 0 }); set(d => { d.a = x; });",
            "const [s, set] = createStore({ a: 0 }); set(d => { d.a ||= 1; });",
            "const [s, set] = createStore({ a: 0 }); set(d => { d.b = 1; });",
            "const [s, set] = createStore({ a: 0 }); set(d => { g(d); });",
            "const [s, set] = createStore({ a: 0, b: 0 }); set(d => { d.a = d.b; });",
            "const [s, set] = createStore({ a: 0 }); set(d => { if (x) d.a = 1; });",
            "const [s, set] = createStore({ a: 0 }); set(d => ({ a: 1 }));",
            "const [s, set] = createStore({ a: 0 }); on(set);",
            "const [s, set] = createStore({ a: 0 }); set(d => { d.a = 1; setTimeout(() => d.a); });",
            // inside its setter the store reads the draft: another field is refused
            "const [s, set] = createStore({ a: 0, b: 0 }); set(d => { d.a = s.b + 1; });",
        ];
        for case in cases {
            let source = format!("import {{ createStore }} from \"solid-js\";\n{case}");
            let out = run(&source, Generate::Dom, true);
            assert!(out.contains("createStore("), "{case}\n{out}");
            assert!(!out.contains("_$createSignal"), "{case}\n{out}");
        }
    }

    #[test]
    fn jsx_reads_on_every_generate_and_off_by_default() {
        let source = r#"
import { createStore } from "solid-js";
export function Counter() {
  const [s, setS] = createStore({ count: 0 });
  return <button onClick={() => setS(d => { d.count++; })}>{s.count}</button>;
}
"#;
        for generate in [Generate::Dom, Generate::Ssr] {
            let out = run(source, generate, true);
            assert!(out.contains("_$s_count"), "{out}");
            assert!(!out.contains("createStore("), "{out}");
            assert!(!out.contains("s.count"), "{out}");
        }
        assert!(run(source, Generate::Dom, false).contains("createStore("));
    }
}
