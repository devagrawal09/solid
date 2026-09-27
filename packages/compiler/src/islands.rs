//! Stage 3 (F, compiler-scoped lazy hydration): per-module island summaries.
//!
//! Lazy hydration is correct only under the hydrate-before-write rule: before
//! a handler writes, every island that reads what it writes must be live
//! (documentation/plans/resumability.md). A runtime cannot know who reads
//! what, so without this summary the first event must hydrate every island.
//! `summarize_islands` reports, as JSON, the facts the island linker
//! (`@solidjs/compiler/islands`) joins over a module graph into a
//! handler → islands map:
//!
//! - `cells` — reactive state with a write capability:
//!   `const [r, w] = createSignal / createStore / createOptimistic /
//!   createOptimisticStore(…)` (a *pair*: `r` reads, calling `w` writes), and
//!   a binding whose initializer creates such state inside it (a *family*,
//!   e.g. `const labels = rows.map(l => createSignal(l))`: `X[i][1](…)`
//!   writes, any other reference reads — and hands out the setter, so it
//!   also escapes);
//! - `records` — every function (and every JSX `on*` handler whose value is
//!   not itself a function) with what its own body does: `reads` / `writes`
//!   (cells), `calls` (records it references: calls, `<Component />`,
//!   memo reads, handler identifiers), `contains` (records nested in it),
//!   `imports` (imported bindings it references, whether it calls them, and
//!   whether the reference is a family member read `X[i][0]()` or write
//!   `X[i][1](…)`),
//!   `escapes` / `readEscapes` (setters / accessors it references without
//!   calling: whoever receives one may write / read), and `unknownCalls` (it
//!   calls something the summary cannot see: a parameter, a member, an
//!   unanalyzed import);
//! - `escapes` — cells handed out at module top level, and *opaque* cells
//!   (state created any other way, e.g. `obj.s = createSignal(0)`), which
//!   the summary cannot name and so treats as escaped both ways;
//! - `handlers` — JSX `on*` / `on:*` attributes and the record each runs;
//! - `bindings` / `exports` — the module-scope names the linker resolves
//!   imports against.
//!
//! Soundness: the summary over-approximates. Any reference to a read binding
//! counts as a read; a setter or accessor can only be invoked through a
//! reference, and every reference is either a direct call or an escape; the
//! linker adds every write-escaped cell to the writes, and every
//! read-escaped cell to the reads, of any record with an unknown call.
//! Positions are byte offsets into the source.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    BindingPattern, Expression, ExportDefaultDeclarationKind, ImportDeclarationSpecifier,
    ImportOrExportKind, JSXAttributeName, JSXAttributeValue, JSXElementName, MemberExpression,
    Statement,
};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::GetSpan;

use crate::capabilities::JsonWriter;
use crate::compiler::{parse_program, source_type_for_filename};
use crate::error::CompileError;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals", "@solidjs/web"];
/// Hosts whose array result is `[read, write]`.
const CELL_HOSTS: &[&str] = &["createSignal", "createStore", "createOptimistic", "createOptimisticStore"];
/// Hosts whose result reads its first-argument function.
const DERIVED_HOSTS: &[&str] = &["createMemo", "createProjection"];

#[derive(Clone, Copy)]
enum Binding {
    Read(usize),
    Write(usize),
    Family(usize),
    Record(NodeId),
    Import,
}

struct Cell {
    name: String,
    kind: &'static str,
}

#[derive(Default)]
struct Record {
    name: Option<String>,
    start: u32,
    end: u32,
    handler: bool,
    reads: Vec<usize>,
    writes: Vec<usize>,
    escapes: Vec<usize>,
    read_escapes: Vec<usize>,
    calls: Vec<NodeId>,
    contains: Vec<NodeId>,
    /// (local, called, `X[i][0]()` / `X[i][1](…)` access if any).
    imports: Vec<(String, bool, Option<&'static str>)>,
    unknown_calls: bool,
}

fn push<T: PartialEq>(v: &mut Vec<T>, x: T) {
    if !v.contains(&x) {
        v.push(x);
    }
}

pub fn summarize_islands(source: &str, filename: Option<&str>) -> Result<String, CompileError> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename)?;
    let program = parse_program(&allocator, source, source_type)?;
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(&program).semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    // --- imports -------------------------------------------------------------
    let mut runtime: HashMap<SymbolId, String> = HashMap::new();
    let mut imports: Vec<(String, String, String)> = Vec::new();
    let mut bindings: HashMap<SymbolId, Binding> = HashMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else { continue };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let from = import.source.value.as_str();
        for specifier in import.specifiers.iter().flatten() {
            let (imported, local) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(s) => {
                    if s.import_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    (s.imported.name().to_string(), &s.local)
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => ("default".into(), &s.local),
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => ("*".into(), &s.local),
            };
            let Some(symbol) = local.symbol_id.get() else { continue };
            if RUNTIME_SOURCES.contains(&from) {
                runtime.insert(symbol, imported);
            } else {
                imports.push((local.name.to_string(), from.to_string(), imported));
                bindings.insert(symbol, Binding::Import);
            }
        }
    }
    let host_name = |callee: &Expression<'_>| -> Option<&str> {
        let Expression::Identifier(id) = callee else { return None };
        let symbol = id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id())?;
        runtime.get(&symbol).map(String::as_str)
    };

    // --- records: every function, plus non-function handler values ---------
    let mut records: Vec<NodeId> = Vec::new();
    let mut record_data: HashMap<NodeId, Record> = HashMap::new();
    let mut handlers: Vec<(NodeId, String, u32)> = Vec::new();
    for node in nodes.iter() {
        match node.kind() {
            AstKind::Function(f) => {
                records.push(node.id());
                record_data.insert(
                    node.id(),
                    Record {
                        name: f.id.as_ref().map(|id| id.name.to_string()),
                        start: f.span.start,
                        end: f.span.end,
                        ..Record::default()
                    },
                );
            }
            AstKind::ArrowFunctionExpression(a) => {
                records.push(node.id());
                record_data.insert(node.id(), Record { start: a.span.start, end: a.span.end, ..Record::default() });
            }
            AstKind::JSXAttribute(attr) => {
                let event = match &attr.name {
                    JSXAttributeName::Identifier(id) if id.name.starts_with("on") && id.name.len() > 2 => {
                        id.name.to_string()
                    }
                    JSXAttributeName::NamespacedName(n) if n.namespace.name == "on" => {
                        format!("on:{}", n.name.name)
                    }
                    _ => continue,
                };
                let Some(JSXAttributeValue::ExpressionContainer(container)) = &attr.value else { continue };
                let Some(expression) = container.expression.as_expression() else { continue };
                let target = match expression.without_parentheses() {
                    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => None,
                    _ => Some(()),
                };
                // The container's node id: the first child of the attribute.
                let container_id = nodes
                    .iter()
                    .find(|n| matches!(n.kind(), AstKind::JSXExpressionContainer(c) if c.span == container.span))
                    .map(|n| n.id());
                let Some(container_id) = container_id else { continue };
                if target.is_some() {
                    records.push(container_id);
                    record_data.insert(
                        container_id,
                        Record {
                            start: container.span.start,
                            end: container.span.end,
                            handler: true,
                            ..Record::default()
                        },
                    );
                    handlers.push((container_id, event, attr.span.start));
                } else {
                    let function_span = expression.without_parentheses().span();
                    let function_id = nodes
                        .iter()
                        .find(|n| {
                            matches!(n.kind(), AstKind::ArrowFunctionExpression(_) | AstKind::Function(_))
                                && n.kind().span() == function_span
                        })
                        .map(|n| n.id());
                    if let Some(id) = function_id {
                        handlers.push((id, event, attr.span.start));
                    }
                }
            }
            _ => {}
        }
    }
    let record_set: HashSet<NodeId> = records.iter().copied().collect();
    let record_of = |id: NodeId| -> Option<NodeId> {
        nodes.ancestors(id).map(|a| a.id()).find(|a| record_set.contains(a))
    };
    let function_node_at = |span: oxc_span::Span| -> Option<NodeId> {
        nodes
            .iter()
            .find(|n| {
                matches!(n.kind(), AstKind::ArrowFunctionExpression(_) | AstKind::Function(_))
                    && n.kind().span() == span
            })
            .map(|n| n.id())
    };

    // --- bindings: cells, derived values, named functions ---------------------
    let mut cells: Vec<Cell> = Vec::new();
    let mut owned_hosts: HashSet<oxc_span::Span> = HashSet::new();
    let mut families: Vec<NodeId> = Vec::new();
    for node in nodes.iter() {
        match node.kind() {
            AstKind::Function(f) if f.id.is_some() => {
                if let Some(symbol) = f.id.as_ref().and_then(|id| id.symbol_id.get()) {
                    bindings.insert(symbol, Binding::Record(node.id()));
                }
            }
            AstKind::VariableDeclarator(declarator) => {
                let Some(init) = &declarator.init else { continue };
                match (&declarator.id, init.without_parentheses()) {
                    (BindingPattern::ArrayPattern(pattern), Expression::CallExpression(call))
                        if host_name(&call.callee).is_some_and(|n| CELL_HOSTS.contains(&n)) =>
                    {
                        let ident = |i: usize| match pattern.elements.get(i) {
                            Some(Some(BindingPattern::BindingIdentifier(id))) => Some(id),
                            _ => None,
                        };
                        let cell = cells.len();
                        owned_hosts.insert(call.span);
                        cells.push(Cell {
                            name: ident(0).or(ident(1)).map(|id| id.name.to_string()).unwrap_or_default(),
                            kind: "pair",
                        });
                        if let Some(symbol) = ident(0).and_then(|id| id.symbol_id.get()) {
                            bindings.insert(symbol, Binding::Read(cell));
                        }
                        if let Some(symbol) = ident(1).and_then(|id| id.symbol_id.get()) {
                            bindings.insert(symbol, Binding::Write(cell));
                        }
                    }
                    (BindingPattern::BindingIdentifier(id), Expression::CallExpression(call))
                        if host_name(&call.callee).is_some_and(|n| DERIVED_HOSTS.contains(&n)) =>
                    {
                        let target = call
                            .arguments
                            .first()
                            .and_then(|a| a.as_expression())
                            .and_then(|e| function_node_at(e.without_parentheses().span()));
                        if let (Some(symbol), Some(target)) = (id.symbol_id.get(), target) {
                            bindings.insert(symbol, Binding::Record(target));
                        }
                    }
                    (BindingPattern::BindingIdentifier(id), Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)) => {
                        if let (Some(symbol), Some(target)) =
                            (id.symbol_id.get(), function_node_at(init.without_parentheses().span()))
                        {
                            bindings.insert(symbol, Binding::Record(target));
                            if let Some(r) = record_data.get_mut(&target) {
                                r.name.get_or_insert_with(|| id.name.to_string());
                            }
                        }
                    }
                    (BindingPattern::BindingIdentifier(id), _) if creates_cell(nodes, node.id(), &host_name) => {
                        let cell = cells.len();
                        families.push(node.id());
                        cells.push(Cell { name: id.name.to_string(), kind: "family" });
                        if let Some(symbol) = id.symbol_id.get() {
                            bindings.insert(symbol, Binding::Family(cell));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    // Any other cell-creating call (`obj.s = createSignal(0)`, a pair with a
    // rest element, …) makes state the summary cannot name: an opaque cell,
    // escaped for reads and writes.
    let mut top_read: Vec<usize> = Vec::new();
    let mut top_write: Vec<usize> = Vec::new();
    for node in nodes.iter() {
        let AstKind::CallExpression(call) = node.kind() else { continue };
        if !host_name(&call.callee).is_some_and(|n| CELL_HOSTS.contains(&n)) || owned_hosts.contains(&call.span) {
            continue;
        }
        if nodes.ancestors(node.id()).any(|a| families.contains(&a.id())) {
            continue;
        }
        let cell = cells.len();
        cells.push(Cell { name: format!("<opaque@{}>", call.span.start), kind: "opaque" });
        top_read.push(cell);
        top_write.push(cell);
    }

    // --- references ----------------------------------------------------------
    for node in nodes.iter() {
        match node.kind() {
            AstKind::IdentifierReference(ident) => {
                let Some(symbol) = ident.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id())
                else {
                    continue;
                };
                let Some(binding) = bindings.get(&symbol).copied() else { continue };
                let parent = nodes.parent_node(node.id());
                // `export { x }` names a binding; the linker resolves it.
                if matches!(parent.kind(), AstKind::ExportSpecifier(_)) {
                    continue;
                }
                let called = matches!(parent.kind(), AstKind::CallExpression(c) if c.callee.span() == ident.span);
                let access = family_access(nodes, node.id());
                let Some(record) = record_of(node.id()) else {
                    // Module top level: runs identically on server and client
                    // before hydration; only references that hand a
                    // capability out matter.
                    match binding {
                        Binding::Read(c) if !called => push(&mut top_read, c),
                        Binding::Write(c) if !called => push(&mut top_write, c),
                        Binding::Family(c) if access.is_none() => {
                            push(&mut top_read, c);
                            push(&mut top_write, c);
                        }
                        _ => {}
                    }
                    continue;
                };
                let r = record_data.get_mut(&record).unwrap();
                match binding {
                    Binding::Read(c) => {
                        push(&mut r.reads, c);
                        // An accessor handed out as a value can be called by
                        // code the summary cannot attribute.
                        if !called {
                            push(&mut r.read_escapes, c);
                        }
                    }
                    Binding::Write(c) => {
                        push(&mut r.writes, c);
                        if !called {
                            push(&mut r.escapes, c);
                        }
                    }
                    Binding::Family(c) => {
                        push(&mut r.reads, c);
                        if access != Some(FamilyAccess::Read) {
                            push(&mut r.writes, c);
                        }
                        if access.is_none() {
                            push(&mut r.escapes, c);
                            push(&mut r.read_escapes, c);
                        }
                    }
                    Binding::Record(target) => push(&mut r.calls, target),
                    Binding::Import => {
                        let access = match family_access(nodes, node.id()) {
                            Some(FamilyAccess::Read) => Some("read"),
                            Some(FamilyAccess::Write) => Some("write"),
                            None => None,
                        };
                        push(&mut r.imports, (ident.name.to_string(), called, access));
                    }
                }
            }
            AstKind::CallExpression(call) => {
                let known = match call.callee.without_parentheses() {
                    Expression::Identifier(id) => {
                        match id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) {
                            // A global (`String`, `parseInt`): cannot hold a setter.
                            None => true,
                            Some(symbol) => bindings.contains_key(&symbol) || runtime.contains_key(&symbol),
                        }
                    }
                    callee @ Expression::ComputedMemberExpression(_) => is_family_setter(callee, &bindings, scoping),
                    _ => false,
                };
                if !known && let Some(record) = record_of(node.id()) {
                    record_data.get_mut(&record).unwrap().unknown_calls = true;
                }
            }
            AstKind::JSXOpeningElement(opening) => {
                // `<Component />` is a reference; covered by IdentifierReference
                // when the tag resolves. A member tag (`<ctx.Provider>`) is
                // unknown code.
                if matches!(opening.name, JSXElementName::MemberExpression(_))
                    && let Some(record) = record_of(node.id())
                {
                    record_data.get_mut(&record).unwrap().unknown_calls = true;
                }
            }
            _ => {}
        }
    }
    for &id in &records {
        if let Some(parent) = record_of(id) {
            record_data.get_mut(&parent).unwrap().contains.push(id);
        }
    }

    // --- exports ---------------------------------------------------------------
    let mut exports: Vec<(String, String)> = Vec::new();
    let mut default_record: Option<NodeId> = None;
    for statement in &program.body {
        match statement {
            Statement::ExportDeclaration(export) => {
                for id in declaration_names(&export.declaration) {
                    exports.push((id.clone(), id));
                }
            }
            Statement::ExportNamedDeclaration(export) => {
                for specifier in &export.specifiers {
                    exports.push((specifier.exported.name().to_string(), specifier.local.name().to_string()));
                }
            }
            Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(f) => match &f.id {
                    Some(id) => exports.push(("default".into(), id.name.to_string())),
                    None => default_record = function_node_at(f.span),
                },
                ExportDefaultDeclarationKind::Identifier(id) => exports.push(("default".into(), id.name.to_string())),
                other => {
                    if let Some(e) = other.as_expression() {
                        default_record = function_node_at(e.without_parentheses().span());
                    }
                }
            },
            _ => {}
        }
    }

    // --- JSON ------------------------------------------------------------------
    let index: HashMap<NodeId, usize> = records.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut json = JsonWriter::default();
    json.begin_object();
    json.key("schema");
    json.number(1);
    json.key("imports");
    json.begin_array();
    for (local, from, imported) in &imports {
        json.begin_object();
        json.key("local");
        json.string(local);
        json.key("source");
        json.string(from);
        json.key("imported");
        json.string(imported);
        json.end_object();
    }
    json.end_array();
    json.key("exports");
    json.begin_array();
    for (name, local) in &exports {
        json.begin_object();
        json.key("name");
        json.string(name);
        json.key("local");
        json.string(local);
        json.end_object();
    }
    if let Some(id) = default_record {
        json.begin_object();
        json.key("name");
        json.string("default");
        json.key("record");
        json.number(index[&id] as u64);
        json.end_object();
    }
    json.end_array();
    json.key("cells");
    json.begin_array();
    for cell in &cells {
        json.begin_object();
        json.key("name");
        json.string(&cell.name);
        json.key("kind");
        json.string(cell.kind);
        json.end_object();
    }
    json.end_array();
    // Cells handed out at module top level (or opaque).
    json.key("escapes");
    json.begin_object();
    json.key("read");
    json.begin_array();
    for c in &top_read {
        json.number(*c as u64);
    }
    json.end_array();
    json.key("write");
    json.begin_array();
    for c in &top_write {
        json.number(*c as u64);
    }
    json.end_array();
    json.end_object();
    // Module-scope bindings, by name (what imports and exports resolve to).
    json.key("bindings");
    json.begin_object();
    let root_scope = scoping.root_scope_id();
    let mut module_bindings: Vec<(&str, Binding)> = bindings
        .iter()
        .filter(|(symbol, _)| scoping.symbol_scope_id(**symbol) == root_scope)
        .map(|(symbol, b)| (scoping.symbol_name(*symbol), *b))
        .collect();
    module_bindings.sort_by(|a, b| a.0.cmp(b.0));
    for (name, binding) in module_bindings {
        json.key(name);
        json.begin_object();
        match binding {
            Binding::Read(c) => {
                json.key("read");
                json.number(c as u64);
            }
            Binding::Write(c) => {
                json.key("write");
                json.number(c as u64);
            }
            Binding::Family(c) => {
                json.key("family");
                json.number(c as u64);
            }
            Binding::Record(r) => {
                json.key("record");
                json.number(index[&r] as u64);
            }
            Binding::Import => {
                json.key("import");
                json.boolean(true);
            }
        }
        json.end_object();
    }
    json.end_object();
    json.key("records");
    json.begin_array();
    for id in &records {
        let r = &record_data[id];
        json.begin_object();
        json.key("name");
        match &r.name {
            Some(n) => json.string(n),
            None => json.null(),
        }
        json.key("start");
        json.number(r.start as u64);
        json.key("end");
        json.number(r.end as u64);
        json.key("handler");
        json.boolean(r.handler);
        let list = |json: &mut JsonWriter, key: &str, v: &[usize]| {
            json.key(key);
            json.begin_array();
            for x in v {
                json.number(*x as u64);
            }
            json.end_array();
        };
        list(&mut json, "reads", &r.reads);
        list(&mut json, "writes", &r.writes);
        list(&mut json, "escapes", &r.escapes);
        list(&mut json, "readEscapes", &r.read_escapes);
        let calls: Vec<usize> = r.calls.iter().map(|c| index[c]).collect();
        list(&mut json, "calls", &calls);
        let contains: Vec<usize> = r.contains.iter().map(|c| index[c]).collect();
        list(&mut json, "contains", &contains);
        json.key("imports");
        json.begin_array();
        for (local, called, access) in &r.imports {
            json.begin_object();
            json.key("local");
            json.string(local);
            json.key("called");
            json.boolean(*called);
            json.key("member");
            match access {
                Some(a) => json.string(a),
                None => json.null(),
            }
            json.end_object();
        }
        json.end_array();
        json.key("unknownCalls");
        json.boolean(r.unknown_calls);
        json.end_object();
    }
    json.end_array();
    json.key("handlers");
    json.begin_array();
    for (id, event, start) in &handlers {
        json.begin_object();
        json.key("record");
        json.number(index[id] as u64);
        json.key("event");
        json.string(event);
        json.key("start");
        json.number(*start as u64);
        json.end_object();
    }
    json.end_array();
    json.end_object();
    Ok(json.out)
}

/// Whether a declarator's initializer creates cells inside it (a family).
fn creates_cell<'a, 'h>(
    nodes: &AstNodes<'a>,
    declarator: NodeId,
    host_name: &dyn Fn(&Expression<'_>) -> Option<&'h str>,
) -> bool {
    nodes.iter().any(|n| {
        matches!(n.kind(), AstKind::CallExpression(c) if host_name(&c.callee).is_some_and(|h| CELL_HOSTS.contains(&h)))
            && nodes.ancestors(n.id()).any(|a| a.id() == declarator)
    })
}

#[derive(PartialEq)]
enum FamilyAccess {
    Read,
    Write,
}

/// `X[i][0]()` reads a family member; `X[i][1](…)` writes one.
fn family_access(nodes: &AstNodes<'_>, reference: NodeId) -> Option<FamilyAccess> {
    let mut ancestors = nodes.ancestors(reference);
    let first = ancestors.next()?;
    let AstKind::ComputedMemberExpression(_) = first.kind() else { return None };
    let second = ancestors.next()?;
    let AstKind::ComputedMemberExpression(member) = second.kind() else { return None };
    let Expression::NumericLiteral(n) = &member.expression else { return None };
    let third = ancestors.next()?;
    let AstKind::CallExpression(call) = third.kind() else { return None };
    if call.callee.span() != member.span {
        return None;
    }
    match n.value as i64 {
        0 => Some(FamilyAccess::Read),
        1 => Some(FamilyAccess::Write),
        _ => None,
    }
}

fn is_family_setter(callee: &Expression<'_>, bindings: &HashMap<SymbolId, Binding>, scoping: &Scoping) -> bool {
    let Some(MemberExpression::ComputedMemberExpression(outer)) = callee.as_member_expression() else {
        return false;
    };
    let Expression::ComputedMemberExpression(inner) = &outer.object else { return false };
    let Expression::Identifier(id) = &inner.object else { return false };
    id.reference_id
        .get()
        .and_then(|r| scoping.get_reference(r).symbol_id())
        .is_some_and(|s| matches!(bindings.get(&s), Some(Binding::Family(_))))
}

fn declaration_names(declaration: &oxc_ast::ast::Declaration<'_>) -> Vec<String> {
    use oxc_ast::ast::Declaration;
    match declaration {
        Declaration::FunctionDeclaration(f) => f.id.iter().map(|id| id.name.to_string()).collect(),
        Declaration::VariableDeclaration(v) => v
            .declarations
            .iter()
            .flat_map(|d| d.id.get_binding_identifiers())
            .map(|id| id.name.to_string())
            .collect(),
        Declaration::ClassDeclaration(c) => c.id.iter().map(|id| id.name.to_string()).collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::summarize_islands;

    #[test]
    fn summarizes_cells_records_and_handlers() {
        let source = r#"
import { createMemo, createSignal } from "solid-js";
import { track } from "./analytics";
export const [count, setCount] = createSignal(0);
const labels = ["a", "b"].map(l => createSignal(l));
export function bump() { setCount(count() + 1); labels[0][1]("x"); }
export function Counter() {
  const doubled = createMemo(() => count() * 2);
  return <button onClick={bump} on:dblclick={() => track(setCount)}>{doubled()} {labels[1][0]()}</button>;
}
"#;
        let out = summarize_islands(source, Some("app.jsx")).unwrap();
        assert!(out.contains(r#""cells":[{"name":"count","kind":"pair"},{"name":"labels","kind":"family"}]"#), "{out}");
        assert!(out.contains(r#""count":{"read":0}"#), "{out}");
        assert!(out.contains(r#""setCount":{"write":0}"#), "{out}");
        assert!(out.contains(r#""labels":{"family":1}"#), "{out}");
        // bump writes both cells directly and escapes neither.
        assert!(out.contains(r#""name":"bump","start""#), "{out}");
        assert!(out.contains(r#""reads":[0,1],"writes":[0,1],"escapes":[]"#), "{out}");
        // The dblclick arrow passes setCount to an import: an escape.
        assert!(out.contains(r#""escapes":[0]"#), "{out}");
        assert!(out.contains(r#"{"local":"track","called":true,"member":null}"#), "{out}");
        assert!(out.contains(r#""event":"onClick""#), "{out}");
        assert!(out.contains(r#""event":"on:dblclick""#), "{out}");
        assert!(out.contains(r#"{"name":"count","local":"count"}"#), "{out}");
    }
}
