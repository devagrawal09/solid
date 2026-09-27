//! Stage 5 (C, pruned resumability): compile an island module into a
//! resumable server module and a component-free client.
//!
//! documentation/plans/resumability.md measured C (a hand-written resumable
//! client) as the only strategy that beats every hydration strategy on load
//! plus first interaction, provided the serialized state is pruned to the
//! live closure. This pass derives that closure and both halves of the page
//! from one source module:
//!
//! - **Live cells**: module cells (`const [a, setA] = createSignal(v)`, and
//!   families `const X = <expr>.map(v => createSignal(v))`) written by an
//!   exported handler — an exported function that is not a component —
//!   directly or through module functions it calls.
//! - **Live sites**: DOM bindings in the islands' components (and the
//!   components they render) whose expression reads a live cell. A
//!   component-local `createMemo` read is inlined (memo fusion); a
//!   component-local value is a *capture* (an identifier or `props.key`),
//!   evaluated on the server when the element renders and serialized per
//!   instance. Sites that read no live cell stay server-rendered text: no
//!   client code, no serialized value.
//! - **Server module** (JSX; compile it with `generate: "ssr"`): the source
//!   plus a `data-q` attribute on each element owning live sites
//!   (`_$q([[site, [captures]], …])` records the instances and returns their
//!   ids) and an exported `__qState()` returning the live closure: the values
//!   of the cells the client needs and the instance table.
//! - **Client module** (plain JS, no component code, no web runtime): the
//!   cells rebuilt from those values, the handlers verbatim, one expression
//!   per live site, and a waker. The first write to a cell creates the render
//!   effects of every instance of every site reading it *before* the write
//!   (hydrate-before-write at binding granularity); each effect compares with
//!   the DOM, so its first run is a no-op and nothing needs flushing.
//!
//! Refused (the island stays a hydration island): a live value flowing into
//! a component prop or children, a live site that is not an attribute or the
//! sole child of an intrinsic element, JSX event handlers, a handler or live
//! site reading a module binding the client cannot rebuild (non-cell data,
//! imports), escaping setters, and component-local accessors used as values.
//! Captures must be primitives; the server recorder checks at render time.
use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, BindingPattern, Declaration, Expression, ImportDeclarationSpecifier,
    ImportOrExportKind, JSXAttributeName, JSXChild, JSXElementName, Statement,
};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use crate::capabilities::JsonWriter;
use crate::compiler::{parse_program, source_type_for_filename};
use crate::error::CompileError;
use crate::store_scalars::splice;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];

#[derive(Clone, Copy, PartialEq)]
enum CellKind {
    Pair,
    Family,
}

struct Cell {
    kind: CellKind,
    name: String,
    getter: SymbolId,
    setter: Option<(SymbolId, String)>,
}

enum SiteKind {
    Text,
    Class,
    Attr(String),
}

struct Site {
    kind: SiteKind,
    reads: Vec<usize>,
    /// Client expression over `$0…`.
    expression: String,
    /// Server capture expressions, in parameter order.
    captures: Vec<String>,
    /// The owning element's tag-name end (where `data-q` is inserted).
    owner: u32,
}

pub fn compile_resumable(source: &str, filename: Option<&str>, islands: &[String]) -> Result<String, CompileError> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename)?;
    let program = parse_program(&allocator, source, source_type)?;
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(&program).semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let mut reasons: Vec<String> = Vec::new();
    let root = scoping.root_scope_id();
    let symbol_of = |e: &Expression<'_>| -> Option<SymbolId> {
        let Expression::Identifier(id) = e else { return None };
        id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id())
    };

    // --- module scope ---------------------------------------------------------
    let mut runtime: HashMap<SymbolId, String> = HashMap::new();
    let mut imported: HashSet<SymbolId> = HashSet::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else { continue };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        for s in import.specifiers.iter().flatten() {
            let (name, local) = match s {
                ImportDeclarationSpecifier::ImportSpecifier(s) => (s.imported.name().to_string(), &s.local),
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => ("default".into(), &s.local),
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => ("*".into(), &s.local),
            };
            let Some(symbol) = local.symbol_id.get() else { continue };
            if RUNTIME_SOURCES.contains(&import.source.value.as_str()) {
                runtime.insert(symbol, name);
            } else {
                imported.insert(symbol);
            }
        }
    }
    let host = |e: &Expression<'_>| symbol_of(e).and_then(|s| runtime.get(&s).cloned());

    let mut cells: Vec<Cell> = Vec::new();
    let mut functions: HashMap<SymbolId, (NodeId, Span)> = HashMap::new();
    let mut exported: HashSet<SymbolId> = HashSet::new();
    let mut statement_span: HashMap<SymbolId, Span> = HashMap::new();
    for statement in &program.body {
        let (declaration, span, is_export) = match statement {
            Statement::ExportDeclaration(e) => (&e.declaration, e.span, true),
            _ => match statement.as_declaration() {
                Some(d) => (d, statement.span(), false),
                None => continue,
            },
        };
        match declaration {
            Declaration::FunctionDeclaration(f) => {
                let Some(symbol) = f.id.as_ref().and_then(|id| id.symbol_id.get()) else { continue };
                let node = nodes
                    .iter()
                    .find(|n| matches!(n.kind(), AstKind::Function(g) if g.span == f.span))
                    .map(|n| n.id());
                if let Some(node) = node {
                    functions.insert(symbol, (node, f.span));
                }
                statement_span.insert(symbol, span);
                if is_export {
                    exported.insert(symbol);
                }
            }
            Declaration::VariableDeclaration(v) => {
                for d in &v.declarations {
                    let Some(init) = &d.init else { continue };
                    match (&d.id, init.without_parentheses()) {
                        (BindingPattern::ArrayPattern(p), Expression::CallExpression(call))
                            if host(&call.callee).as_deref() == Some("createSignal") && p.rest.is_none() =>
                        {
                            let ident = |i: usize| match p.elements.get(i) {
                                Some(Some(BindingPattern::BindingIdentifier(id))) => Some(id),
                                _ => None,
                            };
                            let Some(g) = ident(0) else { continue };
                            let Some(getter) = g.symbol_id.get() else { continue };
                            let setter = ident(1).and_then(|s| s.symbol_id.get().map(|x| (x, s.name.to_string())));
                            cells.push(Cell { kind: CellKind::Pair, name: g.name.to_string(), getter, setter });
                        }
                        (BindingPattern::BindingIdentifier(id), e) if is_family_init(e, &host) => {
                            let Some(symbol) = id.symbol_id.get() else { continue };
                            cells.push(Cell { kind: CellKind::Family, name: id.name.to_string(), getter: symbol, setter: None });
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    let cell_of = |s: SymbolId| cells.iter().position(|c| c.getter == s);
    let setter_of = |s: SymbolId| cells.iter().position(|c| c.setter.as_ref().is_some_and(|x| x.0 == s));
    let function_of_node = |id: NodeId| -> Option<NodeId> {
        nodes
            .ancestors(id)
            .find(|a| functions.values().any(|(n, _)| *n == a.id()))
            .map(|a| a.id())
    };
    let root_function_symbol = |node: NodeId| functions.iter().find(|(_, (n, _))| *n == node).map(|(s, _)| *s);

    // --- components --------------------------------------------------------------
    let mut components: Vec<SymbolId> = Vec::new();
    for name in islands {
        match functions.keys().find(|s| scoping.symbol_name(**s) == name) {
            Some(s) => components.push(*s),
            None => reasons.push(format!("island {name}: no module-level function of that name")),
        }
    }
    let mut i = 0;
    while i < components.len() {
        let (node, _) = functions[&components[i]];
        for n in nodes.iter() {
            let AstKind::JSXOpeningElement(o) = n.kind() else { continue };
            let JSXElementName::IdentifierReference(tag) = &o.name else { continue };
            if function_of_node(n.id()) != Some(node) {
                continue;
            }
            if let Some(s) = tag.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id())
                && functions.contains_key(&s)
                && !components.contains(&s)
            {
                components.push(s);
            }
        }
        i += 1;
    }
    let component_nodes: HashSet<NodeId> = components.iter().map(|s| functions[s].0).collect();

    // --- handlers and the live closure -----------------------------------------------
    let handlers: Vec<SymbolId> = exported
        .iter()
        .copied()
        .filter(|s| functions.contains_key(s) && !components.contains(s))
        .collect();
    let mut client_functions: Vec<SymbolId> = handlers.clone();
    let mut live: HashSet<usize> = HashSet::new();
    let mut needed: HashSet<usize> = HashSet::new();
    let mut k = 0;
    while k < client_functions.len() {
        let symbol = client_functions[k];
        let (fn_node, _) = functions[&symbol];
        for n in nodes.iter() {
            let AstKind::IdentifierReference(ident) = n.kind() else { continue };
            if function_of_node(n.id()) != Some(fn_node) {
                continue;
            }
            let Some(s) = ident.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) else { continue };
            if scoping.symbol_scope_id(s) != root {
                continue;
            }
            let parent = nodes.parent_node(n.id());
            let called = matches!(parent.kind(), AstKind::CallExpression(c) if c.callee.span() == ident.span);
            if let Some(c) = setter_of(s) {
                if !called {
                    reasons.push(format!("{}: setter {} escapes", scoping.symbol_name(symbol), ident.name));
                }
                live.insert(c);
                needed.insert(c);
            } else if let Some(c) = cell_of(s) {
                needed.insert(c);
                if cells[c].kind == CellKind::Family {
                    match family_member(nodes, n.id()) {
                        Some(0) => {}
                        Some(1) => {
                            live.insert(c);
                        }
                        _ => reasons.push(format!("{}: family {} used as a value", scoping.symbol_name(symbol), ident.name)),
                    }
                }
            } else if functions.contains_key(&s) {
                if components.contains(&s) {
                    reasons.push(format!("{}: handler references component {}", scoping.symbol_name(symbol), ident.name));
                } else if !client_functions.contains(&s) {
                    client_functions.push(s);
                }
            } else if !runtime.contains_key(&s) {
                reasons.push(format!(
                    "{}: handler reads module binding {} the client cannot rebuild",
                    scoping.symbol_name(symbol),
                    ident.name
                ));
            }
        }
        k += 1;
    }

    // Components: no event handlers (not resumable yet), no setter use.
    for n in nodes.iter() {
        let in_component = || function_of_node(n.id()).is_some_and(|f| component_nodes.contains(&f));
        match n.kind() {
            AstKind::JSXAttribute(a) if in_component() => {
                let is_event = match &a.name {
                    JSXAttributeName::Identifier(id) => id.name.starts_with("on") && id.name.len() > 2,
                    JSXAttributeName::NamespacedName(ns) => ns.namespace.name == "on",
                };
                if is_event {
                    reasons.push("JSX event handlers are not resumable yet".into());
                }
            }
            AstKind::IdentifierReference(ident) if in_component() => {
                if let Some(s) = ident.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id())
                    && setter_of(s).is_some()
                {
                    reasons.push(format!("component uses setter {}", ident.name));
                }
            }
            _ => {}
        }
    }

    // --- sites ------------------------------------------------------------------------------
    // Component-local memos: symbol → (function node, function span).
    let mut memos: HashMap<SymbolId, NodeId> = HashMap::new();
    for n in nodes.iter() {
        let AstKind::VariableDeclarator(d) = n.kind() else { continue };
        let (BindingPattern::BindingIdentifier(id), Some(Expression::CallExpression(call))) = (&d.id, &d.init) else {
            continue;
        };
        if host(&call.callee).as_deref() != Some("createMemo") || call.arguments.len() != 1 {
            continue;
        }
        let Some(Argument::ArrowFunctionExpression(a)) = call.arguments.first() else { continue };
        if !a.params.items.is_empty() || a.r#async {
            continue;
        }
        let fn_node = nodes
            .iter()
            .find(|x| matches!(x.kind(), AstKind::ArrowFunctionExpression(b) if b.span == a.span))
            .map(|x| x.id());
        if let (Some(s), Some(f)) = (id.symbol_id.get(), fn_node) {
            memos.insert(s, f);
        }
    }

    let mut sites: Vec<Site> = Vec::new();
    for n in nodes.iter() {
        let AstKind::JSXExpressionContainer(container) = n.kind() else { continue };
        let Some(expression) = container.expression.as_expression() else { continue };
        let Some(component) = function_of_node(n.id()).filter(|f| component_nodes.contains(f)) else { continue };
        let _ = component;
        let parent = nodes.parent_node(n.id());
        // Where the value lands.
        let (kind, owner, intrinsic) = match parent.kind() {
            AstKind::JSXAttribute(a) => {
                let name = match &a.name {
                    JSXAttributeName::Identifier(id) => id.name.to_string(),
                    JSXAttributeName::NamespacedName(ns) => format!("{}:{}", ns.namespace.name, ns.name.name),
                };
                if name.starts_with("on") {
                    continue;
                }
                let opening = nodes.parent_node(parent.id());
                let AstKind::JSXOpeningElement(o) = opening.kind() else { continue };
                let kind = if name == "class" { SiteKind::Class } else { SiteKind::Attr(name) };
                (Some(kind), o.name.span().end, is_intrinsic(&o.name))
            }
            AstKind::JSXElement(el) => {
                let sole = el
                    .children
                    .iter()
                    .filter(|c| !matches!(c, JSXChild::Text(t) if t.value.trim().is_empty()))
                    .count()
                    == 1;
                let intrinsic = is_intrinsic(&el.opening_element.name);
                (sole.then_some(SiteKind::Text), el.opening_element.name.span().end, intrinsic)
            }
            _ => (None, 0, false),
        };
        let mut reads: Vec<usize> = Vec::new();
        let mut captures: Vec<(Span, String)> = Vec::new();
        let mut ok = true;
        let expression_text = site_text(
            source,
            nodes,
            scoping,
            expression.span(),
            &memos,
            &cell_of,
            &functions,
            &imported,
            &runtime,
            &mut reads,
            &mut captures,
            &mut ok,
            0,
        );
        let is_live = reads.iter().any(|c| live.contains(c));
        if !is_live {
            continue;
        }
        let where_ = &source[container.span.start as usize..container.span.end as usize];
        if !intrinsic {
            reasons.push(format!("live value passed to a component: {where_}"));
            continue;
        }
        let Some(kind) = kind else {
            reasons.push(format!("live site is not an attribute or a sole child: {where_}"));
            continue;
        };
        if !ok {
            reasons.push(format!("live site reads what the client cannot rebuild: {where_}"));
            continue;
        }
        for c in &reads {
            needed.insert(*c);
        }
        sites.push(Site {
            kind,
            reads,
            expression: expression_text,
            captures: captures.into_iter().map(|(_, t)| t).collect(),
            owner,
        });
    }
    let _ = root_function_symbol;

    // --- outputs ----------------------------------------------------------------------------
    let mut needed: Vec<usize> = needed.into_iter().collect();
    needed.sort();
    let mut live_list: Vec<usize> = live.iter().copied().collect();
    live_list.sort();

    // Server: data-q per owning element, recorder, state.
    let mut by_owner: Vec<(u32, Vec<usize>)> = Vec::new();
    for (i, s) in sites.iter().enumerate() {
        match by_owner.iter_mut().find(|(o, _)| *o == s.owner) {
            Some((_, v)) => v.push(i),
            None => by_owner.push((s.owner, vec![i])),
        }
    }
    let inserts: Vec<(Span, String)> = by_owner
        .iter()
        .map(|(owner, list)| {
            let entries: Vec<String> =
                list.iter().map(|i| format!("[{i}, [{}]]", sites[*i].captures.join(", "))).collect();
            (Span::new(*owner, *owner), format!(" data-q={{_$q([{}])}}", entries.join(", ")))
        })
        .collect();
    let mut server = splice(source, Span::new(0, source.len() as u32), inserts);
    server.push_str(
        "\n// Resumable (compileResumable): instance recorder and the live closure.\n\
         const __qI = [];\n\
         function _$q(list) {\n  let out = \"\";\n  for (const [s, c] of list) {\n    for (const v of c)\n      if ((v !== null && typeof v === \"object\") || typeof v === \"function\")\n        throw new Error(\"resumable: a captured value is not a primitive\");\n    out += (out ? \" \" : \"\") + __qI.length;\n    __qI.push([s, c]);\n  }\n  return out;\n}\n",
    );
    let state: Vec<String> = needed
        .iter()
        .map(|c| {
            let cell = &cells[*c];
            match cell.kind {
                CellKind::Pair => format!("{}: {}()", json_key(&cell.name), cell.name),
                CellKind::Family => format!("{}: {}.map(m => m[0]())", json_key(&cell.name), cell.name),
            }
        })
        .collect();
    server.push_str(&format!(
        "export function __qState() {{\n  return {{ c: {{ {} }}, i: __qI.splice(0) }};\n}}\n",
        state.join(", ")
    ));

    // Client.
    let mut client = String::new();
    client.push_str("// Resumable client (compileResumable): no component code.\n");
    client.push_str("import { createRenderEffect as _$effect, createRoot as _$root, createSignal as _$signal } from \"solid-js\";\n");
    client.push_str("const _$Q = globalThis.__q;\nconst _$I = _$Q.i;\nconst _$B = new Uint8Array(_$I.length);\nconst _$W = new Uint8Array(");
    client.push_str(&cells.len().to_string());
    client.push_str(");\nlet _$E = null;\n");
    for c in &needed {
        let cell = &cells[*c];
        match cell.kind {
            CellKind::Pair => {
                let raw = format!("_$set_{}", cell.name);
                client.push_str(&format!("const [{}, {raw}] = _$signal(_$Q.c[{}]);\n", cell.name, json_key(&cell.name)));
                if let Some((_, setter)) = &cell.setter {
                    client.push_str(&format!("const {setter} = (...a) => (_$wake({c}), {raw}(...a));\n"));
                }
            }
            CellKind::Family => client.push_str(&format!(
                "const {} = _$Q.c[{}].map(v => {{ const s = _$signal(v); return [s[0], (...a) => (_$wake({c}), s[1](...a))]; }});\n",
                cell.name,
                json_key(&cell.name)
            )),
        }
    }
    for s in &client_functions {
        let span = statement_span[s];
        client.push_str(&source[span.start as usize..span.end as usize]);
        client.push('\n');
    }
    client.push_str("const _$S = [\n");
    for s in &sites {
        let params: Vec<String> = (0..s.captures.len()).map(|i| format!("${i}")).collect();
        let (k, name) = match &s.kind {
            SiteKind::Text => (0, String::new()),
            SiteKind::Class => (1, String::new()),
            SiteKind::Attr(n) => (2, n.clone()),
        };
        let reads: Vec<String> = s.reads.iter().map(|c| c.to_string()).collect();
        client.push_str(&format!(
            "  {{ k: {k}, n: {}, r: [{}], f: ({}) => ({}) }},\n",
            json_string(&name),
            reads.join(", "),
            params.join(", "),
            s.expression
        ));
    }
    client.push_str("];\n");
    client.push_str(CLIENT_RUNTIME);

    // --- JSON -------------------------------------------------------------------------------
    let mut json = JsonWriter::default();
    json.begin_object();
    json.key("resumable");
    json.boolean(reasons.is_empty());
    json.key("reasons");
    json.begin_array();
    for r in &reasons {
        json.string(r);
    }
    json.end_array();
    json.key("liveCells");
    json.begin_array();
    for c in &live_list {
        json.string(&cells[*c].name);
    }
    json.end_array();
    json.key("serializedCells");
    json.begin_array();
    for c in &needed {
        json.string(&cells[*c].name);
    }
    json.end_array();
    json.key("sites");
    json.number(sites.len() as u64);
    json.key("server");
    json.string(&server);
    json.key("client");
    json.string(&client);
    json.end_object();
    Ok(json.out)
}

const CLIENT_RUNTIME: &str = r#"// Waker: before the first write to a cell, bind every instance of every
// site reading it (hydrate-before-write, per binding). Effects compare with
// the DOM, so their first run is a no-op.
function _$apply(el, s, v) {
  if (s.k === 0) {
    const t = v == null || v === false ? "" : String(v);
    if (el.textContent !== t) el.textContent = t;
  } else if (s.k === 1) {
    const t = v == null || v === false ? "" : String(v);
    if (el.className !== t) el.className = t;
  } else {
    const t = v == null || v === false ? null : String(v);
    if (el.getAttribute(s.n) !== t) t === null ? el.removeAttribute(s.n) : el.setAttribute(s.n, t);
  }
}
function _$wake(c) {
  if (_$W[c]) return;
  _$W[c] = 1;
  if (!_$E) {
    _$E = [];
    for (const el of document.querySelectorAll("[data-q]"))
      for (const i of el.getAttribute("data-q").split(" ")) _$E[+i] = el;
  }
  _$root(() => {
    for (let i = 0; i < _$I.length; i++) {
      if (_$B[i]) continue;
      const [si, caps] = _$I[i];
      const s = _$S[si];
      if (!s.r.includes(c)) continue;
      _$B[i] = 1;
      const el = _$E[i];
      _$effect(() => s.f(...caps), v => _$apply(el, s, v));
    }
  });
}
"#;

/// `<expr>.map(v => createSignal(v))`.
fn is_family_init(e: &Expression<'_>, host: &dyn Fn(&Expression<'_>) -> Option<String>) -> bool {
    let Expression::CallExpression(call) = e else { return false };
    let Some(member) = call.callee.as_member_expression() else { return false };
    if member.static_property_name() != Some("map") || call.arguments.len() != 1 {
        return false;
    }
    let Some(Argument::ArrowFunctionExpression(a)) = call.arguments.first() else { return false };
    let [param] = a.params.items.as_slice() else { return false };
    let BindingPattern::BindingIdentifier(p) = &param.pattern else { return false };
    let Some(Expression::CallExpression(inner)) = a.body.as_expression() else { return false };
    host(&inner.callee).as_deref() == Some("createSignal")
        && inner.arguments.len() == 1
        && matches!(inner.arguments[0].as_expression(), Some(Expression::Identifier(id)) if id.name == p.name)
}

/// `X[i][k]()` → Some(k) for a family reference.
fn family_member(nodes: &AstNodes<'_>, reference: NodeId) -> Option<u32> {
    let mut up = nodes.ancestors(reference);
    let AstKind::ComputedMemberExpression(_) = up.next()?.kind() else { return None };
    let second = up.next()?;
    let AstKind::ComputedMemberExpression(m) = second.kind() else { return None };
    let Expression::NumericLiteral(n) = &m.expression else { return None };
    let AstKind::CallExpression(c) = up.next()?.kind() else { return None };
    (c.callee.span() == m.span).then_some(n.value as u32)
}

fn is_intrinsic(name: &JSXElementName<'_>) -> bool {
    match name {
        JSXElementName::Identifier(_) => true,
        JSXElementName::IdentifierReference(id) => id.name.chars().next().is_some_and(|c| c.is_ascii_lowercase()),
        _ => false,
    }
}

/// The client text of a site (or memo body) at `span`: memo reads inlined,
/// captures replaced by `$i`. Collects the cells read.
#[allow(clippy::too_many_arguments)]
fn site_text(
    source: &str,
    nodes: &AstNodes<'_>,
    scoping: &Scoping,
    span: Span,
    memos: &HashMap<SymbolId, NodeId>,
    cell_of: &dyn Fn(SymbolId) -> Option<usize>,
    functions: &HashMap<SymbolId, (NodeId, Span)>,
    imported: &HashSet<SymbolId>,
    runtime: &HashMap<SymbolId, String>,
    reads: &mut Vec<usize>,
    captures: &mut Vec<(Span, String)>,
    ok: &mut bool,
    depth: usize,
) -> String {
    if depth > 8 {
        *ok = false;
        return String::new();
    }
    let root = scoping.root_scope_id();
    let mut inner: Vec<(Span, String)> = Vec::new();
    for n in nodes.iter() {
        let AstKind::IdentifierReference(ident) = n.kind() else { continue };
        if ident.span.start < span.start || ident.span.end > span.end {
            continue;
        }
        let Some(symbol) = ident.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()) else {
            continue; // a global
        };
        let decl = scoping.symbol_declaration(symbol);
        let declared_inside = nodes.get_node(decl).kind().span().start >= span.start
            && nodes.get_node(decl).kind().span().end <= span.end;
        if declared_inside {
            continue;
        }
        if let Some(c) = cell_of(symbol) {
            if !reads.contains(&c) {
                reads.push(c);
            }
            if matches!(super_member(nodes, n.id()), Some(1)) {
                *ok = false; // a family setter inside a site
            }
            continue;
        }
        if scoping.symbol_scope_id(symbol) == root {
            if runtime.contains_key(&symbol) {
                continue;
            }
            // Module functions and data, imports: not on the client.
            let _ = (functions, imported);
            *ok = false;
            continue;
        }
        if let Some(memo) = memos.get(&symbol) {
            let parent = nodes.parent_node(n.id());
            let AstKind::CallExpression(call) = parent.kind() else {
                *ok = false;
                continue;
            };
            if call.callee.span() != ident.span || !call.arguments.is_empty() {
                *ok = false;
                continue;
            }
            let AstKind::ArrowFunctionExpression(a) = nodes.get_node(*memo).kind() else {
                *ok = false;
                continue;
            };
            let body_span = match a.body.as_expression() {
                Some(e) => e.span(),
                None => a.body.span(),
            };
            let text = site_text(
                source, nodes, scoping, body_span, memos, cell_of, functions, imported, runtime, reads, captures, ok,
                depth + 1,
            );
            let text = if a.body.as_expression().is_some() { format!("({text})") } else { format!("(() => {text})()") };
            inner.push((call.span, text));
            continue;
        }
        // A component-local value: capture it (`props.key` as a unit).
        let parent = nodes.parent_node(n.id());
        let (capture_span, capture_text) = match parent.kind() {
            AstKind::StaticMemberExpression(m) if m.object.span() == ident.span && is_param(nodes, decl) => {
                (m.span, source[m.span.start as usize..m.span.end as usize].to_string())
            }
            _ => {
                if is_param(nodes, decl) && matches!(nodes.get_node(decl).kind(), AstKind::FormalParameter(_) | AstKind::FormalParameters(_)) {
                    // a whole props object: not a primitive
                }
                (ident.span, ident.name.to_string())
            }
        };
        let index = match captures.iter().position(|(_, t)| *t == capture_text) {
            Some(i) => i,
            None => {
                captures.push((capture_span, capture_text));
                captures.len() - 1
            }
        };
        inner.push((capture_span, format!("${index}")));
    }
    splice(source, span, inner)
}

fn super_member(nodes: &AstNodes<'_>, reference: NodeId) -> Option<u32> {
    family_member(nodes, reference)
}

fn is_param(nodes: &AstNodes<'_>, decl: NodeId) -> bool {
    nodes
        .ancestors(decl)
        .take(3)
        .any(|a| matches!(a.kind(), AstKind::FormalParameter(_) | AstKind::FormalParameters(_)))
}

fn json_key(name: &str) -> String {
    json_string(name)
}

fn json_string(s: &str) -> String {
    let mut w = JsonWriter::default();
    w.string(s);
    w.out
}

#[cfg(test)]
mod tests {
    use super::compile_resumable;

    fn run(source: &str, islands: &[&str]) -> String {
        let islands: Vec<String> = islands.iter().map(|s| s.to_string()).collect();
        compile_resumable(source, Some("app.jsx"), &islands).unwrap()
    }

    const APP: &str = r#"
import { createMemo, createSignal } from "solid-js";
export const [selected, setSelected] = createSignal(-1);
export const [count, setCount] = createSignal(0);
export const [theme] = createSignal("dark");
export const labels = ["a", "b"].map(l => createSignal(l));
export function select(id) { setSelected(id); }
export function bump() { setCount(count() + 1); labels[0][1]("x"); }
function Row(props) {
  const id = props.id;
  const isSel = createMemo(() => selected() === id);
  return <li class={isSel() ? "on" : ""} title={theme()}>{labels[props.id][0]()}</li>;
}
export function List() {
  return <ul>{[0, 1].map(i => <Row id={i} />)}</ul>;
}
export function Counter() {
  return <p><b>{count()}</b><i>{theme()}</i></p>;
}
"#;

    #[test]
    fn derives_the_live_closure_sites_and_both_modules() {
        let out = run(APP, &["List", "Counter"]);
        assert!(out.contains(r#""resumable":true"#), "{out}");
        // theme is never written: not live, not serialized, no site.
        assert!(out.contains(r#""liveCells":["selected","count","labels"]"#), "{out}");
        assert!(out.contains(r#""serializedCells":["selected","count","labels"]"#), "{out}");
        assert!(out.contains(r#""sites":3"#), "{out}");
        // memo inlined, captures per instance (`id` and `props.id`).
        assert!(out.contains("f: ($0) => ((selected() === $0) ? \\\"on\\\" : \\\"\\\")"), "{out}");
        assert!(out.contains("f: ($0) => (labels[$0][0]())"), "{out}");
        // Two sites on one element share its marker.
        assert!(out.contains("<li data-q={_$q([[0, [id]], [1, [props.id]]])}"), "{out}");
        assert!(out.contains("<b data-q={_$q([[2, []]])}>"), "{out}");
        // No component code on the client; handlers verbatim.
        let client_start = out.find(r#""client":"#).unwrap();
        let client = &out[client_start..];
        assert!(!client.contains("function Row") && !client.contains("function List"), "{client}");
        assert!(client.contains("export function bump()"), "{client}");
    }

    #[test]
    fn refuses_what_it_cannot_resume() {
        let cases = [
            // a live value flowing into a component prop
            (r#"import { createSignal } from "solid-js";
const [a, setA] = createSignal(0);
export function set() { setA(1); }
function Child(props) { return <p>{props.v}</p>; }
export function App() { return <Child v={a()} />; }"#, "passed to a component"),
            // a live site mixed with other children
            (r#"import { createSignal } from "solid-js";
const [a, setA] = createSignal(0);
export function set() { setA(1); }
export function App() { return <p>count: {a()}</p>; }"#, "sole child"),
            // JSX event handlers
            (r#"import { createSignal } from "solid-js";
const [a, setA] = createSignal(0);
export function set() { setA(1); }
export function App() { return <button onClick={set}>{a()}</button>; }"#, "event handlers"),
            // a handler reading server-only module data
            (r#"import { createSignal } from "solid-js";
const DATA = globalThis.data;
const [a, setA] = createSignal(0);
export function set() { setA(DATA.x); }
export function App() { return <p>{a()}</p>; }"#, "cannot rebuild"),
            // an escaping setter
            (r#"import { createSignal } from "solid-js";
const [a, setA] = createSignal(0);
export function set() { queueMicrotask(setA); }
export function App() { return <p>{a()}</p>; }"#, "escapes"),
        ];
        for (source, reason) in cases {
            let out = run(source, &["App"]);
            assert!(out.contains(r#""resumable":false"#), "{source}\n{out}");
            assert!(out.contains(reason), "{reason}\n{out}");
        }
    }
}
