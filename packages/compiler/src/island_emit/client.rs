//! Client emission: one activation module per island group.
//!
//! The module walks the server's DOM from the island anchor by static paths
//! (element indexes; `<!--$-->…<!--/-->` pairs only around live text holes
//! that share their element and around live `Show` / `For` regions),
//! rebuilds the group's cells (from constants, client-evaluable
//! initializers, or the anchor's `data-s` values), binds **live** holes only
//! (their first run writes nothing: the server DOM already shows it),
//! attaches handlers, and builds dynamic regions with adopt-or-create
//! builders. Component boundaries disappear: every member component's view is
//! inlined into the group's activation, with props bound to the caller's
//! expressions.
//!
//! Tier 0 lowers cells to slots and holes to `(compute, apply)` pairs on the
//! t0 helper; tiers 1 and 2 emit the same code against the kernel's API,
//! bound to the tier-1 kernel or the full core by the import specifier.
use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;

use oxc_ast::ast::{
    BindingPattern, CallExpression, Expression, IdentifierReference, ImportDeclarationSpecifier,
    JSXElement, ObjectPropertyKind, PropertyKey, Statement,
};
use oxc_semantic::SymbolId;
use oxc_span::{GetSpan, Span};

use super::graph::{Analysis, Group, SiteKind};
use super::jsx::{self, AttrVal, Child, Root, Tag};
use super::model::{CellHost, FnRef, Item, LocalDecl, Model, call_of};
use super::tx::{Env, R, Tx};

pub(crate) struct ClientOpts {
    pub t0: String,
    pub kernel: String,
    pub core: String,
    /// Tier-1 groups bind to the core instead of the kernel (page dedupe).
    pub tier1_core: bool,
    /// Instrumented output: tier-0 cells carry their labels and reads go
    /// through `get` (the conformance harness traces them).
    pub debug: bool,
    /// Dev builds: the chunk also exports `verify(anchor)`, which walks the
    /// island's static addresses on the server markup and reports every node
    /// that is not what the client code expects.
    pub verify: bool,
    /// The frames applier (an island frame's driver imports it lazily).
    pub frames_module: String,
    /// `activate(anchor, state)` and a state getter on the anchor (keyed
    /// islands keep their state across a frame's refetch).
    pub keyed_state: bool,
}

pub(crate) struct GroupCode {
    pub code: String,
    pub tier: u8,
    pub runtime: String,
    /// Values the root instance reads from the anchor's `data-s`.
    pub serial: Vec<Serial>,
    /// Per serialized prop, the paths the client reads (`None`: whole).
    pub prop_paths: HashMap<String, Option<BTreeSet<Vec<String>>>>,
    /// An element anchor (`data-i` on the root's first element) or a comment.
    pub element_anchor: bool,
    /// Every handler sits under the anchor element (lazy activation possible).
    pub lazy_ok: bool,
    /// The anchor element's subtree may contain other islands' anchors.
    pub nests: bool,
    /// Module-level declarations the chunk copies (by top index).
    pub mutable_top: Vec<usize>,
    /// The chunk takes and exposes keyed state.
    pub transplant: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Serial {
    Prop(String),
    Cell(usize),
    /// A context the island reads with no provider inside it: its value at
    /// the island's root (the same at every member, since no provider in the
    /// island sits between), serialized when it holds no reactive state.
    Ctx(String),
}

#[derive(Clone, Debug)]
enum Kind {
    /// An accessor (`x()` reads).
    Acc,
    /// A plain value (functions, objects).
    Val,
    /// Unknown: reads go through `$r` (call when a function).
    Unknown,
    /// A tier-0 cell (`x.v` reads).
    Cell0,
    /// A tier-0 setter of the named cell variable.
    Set0(String),
}

#[derive(Clone, Debug)]
enum PBind {
    Acc(String),
    Val(String),
    Get(String),
}

#[derive(Clone)]
struct CtxBind {
    var: String,
    /// Kinds of the provider value's array elements / object properties
    /// (a literal `[a, b]` / `{ a, b }` of names), for static reads.
    kinds: Vec<(Option<String>, Kind)>,
}

struct Inst<'a> {
    comp: usize,
    names: HashMap<SymbolId, (String, Kind)>,
    props: HashMap<String, PBind>,
    /// Children JSX passed by the caller, rendered in the caller's instance.
    slot: Option<(Vec<Child<'a>>, usize)>,
    ctx: HashMap<SymbolId, CtxBind>,
    root: bool,
    suffix: String,
}

#[derive(Default)]
struct Bucket {
    setup: Vec<String>,
    handlers: Vec<String>,
    seq: Vec<Seq>,
    attrs: Vec<AttrPart>,
    /// Holes (tier 0) / effects emitted before the combined attr effect.
    tail: Vec<String>,
}

enum Seq {
    Line(String),
    Inst(usize),
}

struct AttrPart {
    /// Compute expression.
    compute: String,
    /// Apply statement over `v` (the part's value).
    apply: String,
    cells: BTreeSet<String>,
    live: bool,
    /// Reads the client environment: applied at activation too.
    env: bool,
}

/// One emission scope: the activation function or a region builder.
struct Scope {
    nav: Vec<String>,
    buckets: HashMap<usize, Bucket>,
    order: Vec<usize>,
    /// Builder scope: a fresh-or-adopt region content (`$x` is the element,
    /// `$f` true when freshly created).
    builder: bool,
}

#[derive(Clone, Copy)]
enum Slot<'a> {
    Elem(&'a JSXElement<'a>, usize),
    Text,
    /// (expression, instance, live, bound by this island)
    Hole(&'a Expression<'a>, usize, bool, bool),
    Region(&'a JSXElement<'a>, usize, bool),
    Opaque(Option<usize>, Option<usize>),
    /// An `<Errored>` around the island's live content (tier 2): its content
    /// slots (`Ce::bounds[i]`), laid out in place between a marker pair,
    /// activated inside a client error boundary.
    Boundary(&'a JSXElement<'a>, usize, usize),
    /// A structural region (`Analysis::structural`): a `<Show>` / `<For>`
    /// over server data holding the island's sites or members, between a
    /// marker pair; the island adopts its branch / rows in place.
    Struct(&'a JSXElement<'a>, usize),
    /// A `<Portal>`: nothing in place; its content is built and mounted
    /// elsewhere.
    Portal(&'a JSXElement<'a>, usize),
}

struct Ce<'x, 'a> {
    m: &'x Model<'a>,
    a: &'x Analysis<'a>,
    g: &'x Group,
    gi: usize,
    tier: u8,
    opts: &'x ClientOpts,
    insts: Vec<Inst<'a>>,
    scopes: Vec<Scope>,
    cur: usize,
    uid: usize,
    helpers: BTreeSet<&'static str>,
    /// Event types the island's handlers are delegated for (`$dg`).
    events: BTreeSet<String>,
    rt: BTreeSet<&'static str>,
    /// Core-only runtime exports the chunk imports (tier 2: `name as $$name`).
    core: BTreeSet<String>,
    /// The group needs the full core (stores, async, optimistic writes,
    /// actions, boundaries in live regions).
    t2: bool,
    top_syms: BTreeSet<SymbolId>,
    /// Client templates: markup and, for SVG / MathML content, the wrapper
    /// element it parses under (an HTML `<template>` would create it in the
    /// HTML namespace).
    templates: Vec<(String, Option<&'static str>)>,
    /// Namespace of the children of the element being laid out: 0 HTML,
    /// 1 SVG, 2 MathML.
    ns: u8,
    settled: Vec<String>,
    serial: Vec<Serial>,
    lazy_ok: bool,
    element_anchor: bool,
    shapes: HashMap<usize, (Option<usize>, Option<usize>)>,
    /// Module-level `let` / `var` statements copied into the chunk.
    mutable_top: Vec<usize>,
    /// A setup side-effect statement was emitted inside the current region.
    stmt_in_region: bool,
    /// Dev verifier: (node variable, expected node, where it comes from) for
    /// the activation scope's addresses.
    checks: Vec<(String, String, String)>,
    /// Client error boundaries: (scope of their content, content slots).
    bounds: Vec<(usize, Vec<Slot<'a>>)>,
    /// Emitting a client-built `<Errored>` fallback: its holes track (the
    /// error accessor commits after the fallback is built).
    in_fallback: bool,
    /// Structural row functions being emitted: (the `<For>`'s span, the
    /// component it is in, the function's name). A scope that renders itself
    /// in such a `<For>` reuses the function (every level runs it).
    structs: Vec<(Span, usize, String)>,
    /// Per member component: the props its code in this island uses (a
    /// prop only handed on to another island's component is not bound).
    used: HashMap<usize, BTreeSet<String>>,
    /// Per serialized root prop: the paths client code reads (`None`: the
    /// whole value).
    prop_paths: HashMap<String, Option<BTreeSet<Vec<String>>>>,
    /// Keyed state: each plain cell's current-value expression, in the
    /// order `activate(anchor, state)` reads them; `None` once the island
    /// holds state that cannot move (stores, regions).
    transplant: Option<Vec<String>>,
    /// An island frame's driver is emitted (`$frame`).
    frame_driver: bool,
    /// Frames the `$event` being translated refreshes (single flight: its
    /// server calls carry them).
    flight: Vec<usize>,
}

const HELPERS: &[(&str, &str)] = &[
    ("$r", "const $r = v => typeof v === \"function\" ? v() : v;"),
    (
        "$s",
        "const $s = v => v == null || typeof v === \"boolean\" ? \"\" : \"\" + v;",
    ),
    (
        "$mk",
        // The k-th top-level `<!--$-->…<!--/-->` pair's end marker under
        // `p` (or among the siblings after `a`).
        "const $mk = (p, k, a) => { let d = 0, n = a ? a.nextSibling : p.firstChild; for (; n; n = n.nextSibling) if (n.nodeType === 8) { if (n.data === \"$\") d++; else if (n.data === \"/\" && !--d && !k--) return n; } };",
    ),
    (
        "$mke",
        // The end marker of the pair enclosing `a` (the first unbalanced one after it).
        "const $mke = a => { let d = 0; for (let n = a.nextSibling; n; n = n.nextSibling) if (n.nodeType === 8) { if (n.data === \"$\") d++; else if (n.data === \"/\" && !d--) return n; } };",
    ),
    (
        "$pk",
        "const $pk = (p, k) => { for (let n = p.firstChild; n; n = n.nextSibling) if (n.nodeType === 8 && n.data === \"!\" && !k--) return n; };",
    ),
    (
        "$tx",
        "const $tx = (e, v) => { const t = e.previousSibling; v = $s(v); if (t.nodeType === 3) v ? (t.data = v) : t.remove(); else if (v) e.before(v); };",
    ),
    (
        "$tpl",
        "const $tpl = h => { const t = document.createElement(\"template\"); t.innerHTML = h; return () => t.content.firstChild.cloneNode(true); };",
    ),
    (
        "$tplw",
        // SVG / MathML content: parsed under its wrapper element.
        "const $tplw = (h, w) => { const t = document.createElement(\"template\"); t.innerHTML = \"<\" + w + \">\" + h + \"</\" + w + \">\"; return () => t.content.firstChild.firstChild.cloneNode(true); };",
    ),
    (
        "$start",
        "const $start = e => { let d = 0, n = e; while ((n = n.previousSibling)) if (n.nodeType === 8) { if (n.data === \"/\") d++; else if (n.data === \"$\" && !d--) return n; } };",
    ),
    (
        "$show",
        // Adopts the server's content (or creates it in fresh content, whose
        // region is an empty marker pair). Content created after activation
        // is owned by the island (its cleanups run when the island is
        // disposed).
        "const $show = (e, w, b) => { let d; const o = $O(); $E(() => !!w(), (on, p) => { if (p === undefined) { if (on) $R(x => { d = x; const n = e.previousSibling; n.nodeType === 1 ? b(w, n) : e.before(b(w, null)); }); return; } if (on === p) return; if (on) $W(o, () => $R(x => { d = x; e.before(b(w, null)); })); else { d(); d = undefined; const s = $start(e); while (s.nextSibling !== e) s.nextSibling.remove(); } }); };",
    ),
    (
        "$showf",
        // A `Show` with a fallback: either branch is adopted at activation
        // (an element, or the text of a string fallback), and each flip
        // disposes one branch and builds the other (owned by the island).
        "const $showf = (e, w, b, f) => { let d; const o = $O(); const mk = (g, a) => $R(x => { d = x; const n = g(w, a); a || e.before(n); }); $E(() => !!w(), (on, p) => { if (p === undefined) { const n = e.previousSibling; mk(on ? b : f, n.nodeType === 8 && n.data === \"$\" ? null : n); return; } if (on === p) return; d(); const s = $start(e); while (s.nextSibling !== e) s.nextSibling.remove(); $W(o, () => mk(on ? b : f, null)); }); };",
    ),
    (
        "$list",
        // Keyed rows; `plain` rows create no reactive work, so they get no root.
        // The input is copied in the compute (a store array tracks its items).
        "const $list = (e, each, row, plain) => { let rows = new Map(); const o = $O(); const mk = plain ? (it, n) => ({ n: row(it, n) }) : (it, n) => $W(o, () => $R(d => ({ n: row(it, n), d }))); $E(() => { const l = each(); return l ? Array.from(l) : []; }, (items, p) => { if (p === undefined) { let n = $start(e).nextSibling; for (const it of items) { while (n !== e && n.nodeType !== 1) n = n.nextSibling; const r = mk(it, n === e ? null : n); rows.set(it, r); if (n === e) e.before(r.n); else n = r.n.nextSibling; } return; } const next = new Map(); for (const it of items) next.set(it, rows.get(it) || mk(it, null)); for (const [it, r] of rows) if (!next.has(it)) { r.d && r.d(); r.n.remove(); } let c = $start(e).nextSibling; for (const r of next.values()) { if (r.n === c) c = c.nextSibling; else e.parentNode.insertBefore(r.n, c); } rows = next; }); };",
    ),
    (
        "$listf",
        // `$list` with a fallback: shown (adopted, or built) while the list
        // is empty, disposed when rows arrive.
        "const $listf = (e, each, row, plain, fb) => { let rows = new Map(), F; const o = $O(); const mk = plain ? (it, n) => ({ n: row(it, n) }) : (it, n) => $W(o, () => $R(d => ({ n: row(it, n), d }))); const fo = a => { F = $W(o, () => $R(d => ({ n: fb(a), d }))); a || e.before(F.n); }; $E(() => { const l = each(); return l ? Array.from(l) : []; }, (items, p) => { if (p === undefined) { let n = $start(e).nextSibling; if (!items.length) return fo(n === e ? null : n); for (const it of items) { while (n !== e && n.nodeType !== 1) n = n.nextSibling; const r = mk(it, n === e ? null : n); rows.set(it, r); if (n === e) e.before(r.n); else n = r.n.nextSibling; } return; } if (F && items.length) { F.d(); F.n.remove(); F = undefined; } const next = new Map(); for (const it of items) next.set(it, rows.get(it) || mk(it, null)); for (const [it, r] of rows) if (!next.has(it)) { r.d && r.d(); r.n.remove(); } let c = $start(e).nextSibling; for (const r of next.values()) { if (r.n === c) c = c.nextSibling; else e.parentNode.insertBefore(r.n, c); } rows = next; if (!items.length && !F) fo(null); }); };",
    ),
    (
        "$listi",
        // Keyed rows whose callback takes the index: each row owns an index
        // signal, written when the row moves.
        "const $listi = (e, each, row, fb) => { let rows = new Map(), F; const o = $O(); const mk = (it, j, n) => $W(o, () => $R(d => { const [g, s] = $S(j); return { n: row(it, n, g), d, s }; })); const fo = a => { F = $W(o, () => $R(d => ({ n: fb(a), d }))); a || e.before(F.n); }; $E(() => { const l = each(); return l ? Array.from(l) : []; }, (items, p) => { if (p === undefined) { let n = $start(e).nextSibling; if (!items.length) return fb && fo(n === e ? null : n); items.forEach((it, j) => { while (n !== e && n.nodeType !== 1) n = n.nextSibling; const r = mk(it, j, n === e ? null : n); rows.set(it, r); if (n === e) e.before(r.n); else n = r.n.nextSibling; }); return; } if (F && items.length) { F.d(); F.n.remove(); F = undefined; } const next = new Map(); items.forEach((it, j) => { const r = rows.get(it); if (r) r.s(j); next.set(it, r || mk(it, j, null)); }); for (const [it, r] of rows) if (!next.has(it)) { r.d(); r.n.remove(); } let c = $start(e).nextSibling; for (const r of next.values()) { if (r.n === c) c = c.nextSibling; else e.parentNode.insertBefore(r.n, c); } rows = next; if (!items.length && fb && !F) fo(null); }); };",
    ),
    (
        "$listu",
        // `keyed={false}` rows, by position: each row owns its item's signal
        // (written when the item at its position changes); rows are added
        // and removed at the end.
        "const $listu = (e, each, row, fb) => { let rows = [], F; const o = $O(); const mk = (it, j, n) => $W(o, () => $R(d => { const [g, s] = $S([it]); const r = { v: it, d, s }; r.n = row(() => g()[0], n, j); return r; })); const fo = a => { F = $W(o, () => $R(d => ({ n: fb(a), d }))); a || e.before(F.n); }; $E(() => { const l = each(); return l ? Array.from(l) : []; }, (items, p) => { if (p === undefined) { let n = $start(e).nextSibling; if (!items.length) return fb && fo(n === e ? null : n); items.forEach((it, j) => { while (n !== e && n.nodeType !== 1) n = n.nextSibling; const r = mk(it, j, n === e ? null : n); rows.push(r); if (n === e) e.before(r.n); else n = r.n.nextSibling; }); return; } if (F && items.length) { F.d(); F.n.remove(); F = undefined; } items.forEach((it, j) => { if (j < rows.length) { const r = rows[j]; if (r.v !== it) { r.v = it; r.s([it]); } } else { const r = mk(it, j, null); rows.push(r); e.before(r.n); } }); while (rows.length > items.length) { const r = rows.pop(); r.d(); r.n.remove(); } if (!items.length && fb && !F) fo(null); }); };",
    ),
    (
        "$sw",
        // `<Switch>`: the first `when` that holds picks its branch (the last
        // builder is the fallback, if any); a change of choice disposes the
        // branch and builds the next one. At activation the server's branch
        // (an element, or a string fallback's text) is adopted.
        "const $sw = (e, ws, bs) => { let d; const o = $O(); const mk = (i, a) => { const b = bs[i < 0 ? ws.length : i]; if (b) $W(o, () => $R(x => { d = x; const n = b(ws[i], a); a || e.before(n); })); }; $E(() => { for (let i = 0; i < ws.length; i++) if (ws[i]()) return i; return -1; }, (i, p) => { if (p === undefined) { const n = e.previousSibling; return mk(i, n.nodeType === 8 && n.data === \"$\" ? null : n); } if (i === p) return; if (d) { d(); d = undefined; } const s = $start(e); while (s.nextSibling !== e) s.nextSibling.remove(); mk(i, null); }); };",
    ),
    (
        "$portal",
        // `<Portal>`: content built on the client, appended to its mount,
        // removed with its owner.
        "const $portal = (m, b) => { const n = b(null); m.appendChild(n); $C(() => n.remove()); };",
    ),
    (
        "$err",
        // A client error boundary around adopted content: the content's
        // activation runs inside it; a failure detaches the content (kept,
        // still bound) and shows the fallback; a reset that recovers puts the
        // same content back.
        "const $err = (e, content, fb) => { let kept, shown; const acc = $$createErrorBoundary(() => ($U(content), 1), (err, reset) => [err, reset]); $E(acc, v => { if (v === 1) { if (kept) { shown.remove(); for (const n of kept) e.before(n); kept = shown = undefined; } return; } if (!kept) { kept = []; for (let n = $start(e).nextSibling; n !== e; n = n.nextSibling) kept.push(n); for (const n of kept) n.remove(); } else shown.remove(); shown = fb(v[0], v[1]); e.before(shown); }); };",
    ),
    (
        "$rows",
        // Structural rows (a `<For>` over server data inside an island): the
        // server's row elements, in order, each activated by `row(item, node)`.
        "const $rows = (e, l, row) => { let n = $start(e).nextSibling; if (l) for (const it of l) { while (n.nodeType !== 1) n = n.nextSibling; row(it, n); n = n.nextSibling; } };",
    ),
    (
        "$ld",
        // A client pending boundary (a `<Loading>` the client creates over
        // async state): the content's activation runs inside it; while it is
        // pending the content is detached (kept, still bound) and the
        // fallback shows.
        "const $ld = (e, content, fb) => { let kept, shown; const acc = $$createLoadingBoundary(() => ($U(content), 1), () => 0); $E(acc, v => { if (v === 1) { if (kept) { shown.remove(); for (const n of kept) e.before(n); kept = shown = undefined; } return; } if (!kept) { kept = []; for (let n = $start(e).nextSibling; n !== e; n = n.nextSibling) kept.push(n); for (const n of kept) n.remove(); shown = fb(); e.before(shown); } }); };",
    ),
    (
        "$dg",
        // Delegated handlers (`node.$$type = h`, Solid's protocol): one
        // listener per event type on the document (`document.$$E` lists the
        // types), walking from the target up as Solid's `eventHandler` does
        // (`$$typeData`, `handleEvent`, disabled nodes skipped) and stopping
        // at `stopPropagation`. It is an outer delegation root: where a
        // Solid root below already walked the event (a hydrated fallback
        // module, its portals: `_$SOLID_EVENT_OWNER`), it resumes above that
        // root, so no handler runs twice. The islands loader's capture
        // listener runs first and stops an event whose islands are not
        // active yet (activate, then replay: the replay reaches this one).
        DELEGATE,
    ),
    (
        "$ref",
        "const $ref = (r, e) => Array.isArray(r) ? r.flat(Infinity).forEach(f => f && f(e)) : r(e);",
    ),
    (
        "$cls",
        "const $cls = v => { if (!v || typeof v !== \"object\") return v == null || v === false ? \"\" : \"\" + v; const o = {}, f = l => { for (const x of l) Array.isArray(x) ? f(x) : x && typeof x === \"object\" ? Object.assign(o, x) : typeof x !== \"boolean\" && (x || x === 0) && (o[x] = 1); }; Array.isArray(v) ? f(v) : Object.assign(o, v); return Object.keys(o).filter(k => o[k]).join(\" \"); };",
    ),
];

/// Runtime exports only the full core has (tier 2), imported by name.
pub(crate) const CORE_ONLY: &[&str] = &[
    "createPlainStore",
    "createStore",
    "createOptimistic",
    "createOptimisticStore",
    "createProjection",
    "action",
    "refresh",
    "reconcile",
    "snapshot",
    "isPending",
    "latest",
    "resolve",
    "createErrorBoundary",
    "createLoadingBoundary",
];

/// The `$dg` helper (see `HELPERS`).
pub(crate) const DELEGATE: &str = "const $dg = t => { const D = (self.$$D ||= e => { let n = e.target, p = e._$SOLID_EVENT_OWNER; const k = \"$$\" + e.type; if (p) { if (p === true || !document.contains(p)) return; n = p === n ? p.parentNode : p; } Object.defineProperty(e, \"currentTarget\", { configurable: true, get: () => n || document }); for (; n; n = n.parentNode) { const h = n[k]; if (h && !n.disabled) { const d = n[k + \"Data\"]; d !== undefined ? h.call(n, d, e) : typeof h === \"function\" ? h.call(n, e) : h.handleEvent(e); if (e.cancelBubble) return; } } }), s = (document.$$E ||= new Set()); for (const x of t) s.has(x) || (s.add(x), document.addEventListener(x, D)); };";

fn helper_deps(h: &str) -> &'static [&'static str] {
    match h {
        "$tx" => &["$s"],
        "$show" => &["$start"],
        "$list" => &["$start"],
        "$showf" => &["$start"],
        "$listf" => &["$start"],
        "$listi" => &["$start"],
        "$listu" => &["$start"],
        "$sw" => &["$start"],
        "$err" => &["$start"],
        "$rows" => &["$start"],
        "$ld" => &["$start"],
        _ => &[],
    }
}

fn js_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn is_prop_attr(tag: &str, name: &str) -> bool {
    matches!(
        (tag, name),
        ("input", "checked" | "value" | "indeterminate")
            | ("select", "value")
            | ("textarea", "value")
            | ("option", "selected" | "value")
            | ("video" | "audio", "muted")
            | (_, "innerHTML" | "textContent")
    )
}

/// `core`: the group runs on the full core (its analysis tier, or raised by
/// `minTier`): core-only features (stores, client error boundaries) compile.
pub(crate) fn emit_group<'a>(
    m: &Model<'a>,
    a: &Analysis<'a>,
    gi: usize,
    tier: u8,
    opts: &ClientOpts,
    core: bool,
) -> R<GroupCode> {
    let g = &a.groups[gi];
    let ce = Ce {
        m,
        a,
        g,
        gi,
        tier,
        opts,
        insts: Vec::new(),
        scopes: Vec::new(),
        cur: 0,
        uid: 0,
        helpers: BTreeSet::new(),
        events: BTreeSet::new(),
        rt: BTreeSet::new(),
        core: BTreeSet::new(),
        t2: g.tier >= 2 || core,
        top_syms: BTreeSet::new(),
        templates: Vec::new(),
        ns: 0,
        settled: Vec::new(),
        serial: Vec::new(),
        lazy_ok: true,
        element_anchor: true,
        shapes: HashMap::new(),
        mutable_top: Vec::new(),
        stmt_in_region: false,
        checks: Vec::new(),
        bounds: Vec::new(),
        in_fallback: false,
        structs: Vec::new(),
        used: HashMap::new(),
        prop_paths: HashMap::new(),
        transplant: opts.keyed_state.then(Vec::new),
        frame_driver: false,
        flight: Vec::new(),
    };
    ce.run()
}

struct CEnv<'e, 'x, 'a> {
    ce: &'e Ce<'x, 'a>,
    inst: usize,
    /// Extra renames (builder parameters).
    extra: &'e HashMap<SymbolId, (String, Kind)>,
    uses: std::cell::RefCell<Uses>,
}

#[derive(Default)]
struct Uses {
    helpers: BTreeSet<&'static str>,
    rt: BTreeSet<&'static str>,
    core: BTreeSet<String>,
    top: BTreeSet<SymbolId>,
    serial: Vec<Serial>,
    /// Per serialized prop: the static paths client code reads (`None`:
    /// used whole).
    prop_paths: Vec<(String, Option<Vec<String>>)>,
}

impl<'e, 'x, 'a> CEnv<'e, 'x, 'a> {
    fn lookup(&self, s: SymbolId) -> Option<(String, Kind)> {
        self.extra
            .get(&s)
            .cloned()
            .or_else(|| self.ce.insts[self.inst].names.get(&s).cloned())
    }
    fn prop(&self, name: &str) -> R<PBind> {
        self.prop_at(name, None)
    }
    /// `props.name`, read along `path` (`[name, …]`; `None`: whole).
    fn prop_at(&self, name: &str, path: Option<&[String]>) -> R<PBind> {
        let inst = &self.ce.insts[self.inst];
        if let Some(b) = inst.props.get(name) {
            return Ok(b.clone());
        }
        if inst.root {
            let mut u = self.uses.borrow_mut();
            let s = Serial::Prop(name.to_string());
            if !u.serial.contains(&s) {
                u.serial.push(s);
            }
            u.prop_paths
                .push((name.to_string(), path.map(|p| p[1..].to_vec())));
            return Ok(PBind::Val(format!("$d[{}]", js_str(name))));
        }
        // A prop the caller did not pass.
        Ok(PBind::Val("undefined".into()))
    }
}

impl<'a> Env<'a> for CEnv<'_, '_, 'a> {
    fn read(&self, tx: &Tx<'_, 'a>, arg: &'a Expression<'a>) -> R<String> {
        let arg = arg.without_parentheses();
        match arg {
            Expression::Identifier(id) => {
                let Some(s) = self.ce.m.symbol_of(id) else {
                    return Err(format!("yield* of an unresolved name `{}`", id.name));
                };
                match self.lookup(s) {
                    Some((n, Kind::Acc)) => Ok(format!("{n}()")),
                    Some((n, Kind::Cell0)) => Ok(if self.ce.opts.debug {
                        self.uses.borrow_mut().rt.insert("get");
                        format!("$get({n})")
                    } else {
                        format!("{n}.v")
                    }),
                    Some((n, Kind::Val)) => Ok(n),
                    Some((n, Kind::Unknown)) => {
                        self.uses.borrow_mut().helpers.insert("$r");
                        Ok(format!("$r({n})"))
                    }
                    Some((_, Kind::Set0(_))) => Err("yield* of a setter".into()),
                    None => {
                        if self.ce.m.top_of.contains_key(&s) {
                            self.uses.borrow_mut().top.insert(s);
                            self.uses.borrow_mut().helpers.insert("$r");
                            return Ok(format!("$r({})", id.name));
                        }
                        Err(format!(
                            "yield* of `{}` (not in the island's scope)",
                            id.name
                        ))
                    }
                }
            }
            Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_) => {
                // Split the chain into its root and the rest.
                let mut chain: Vec<&'a Expression<'a>> = vec![arg];
                let mut root = arg;
                loop {
                    match root {
                        Expression::StaticMemberExpression(s) => root = &s.object,
                        Expression::ComputedMemberExpression(c) => root = &c.object,
                        _ => break,
                    }
                    chain.push(root);
                }
                // `props.x.rest`
                if let Some(first) = chain.iter().rev().nth(1)
                    && let Expression::StaticMemberExpression(s) = first
                    && self.is_props(tx, &s.object)
                {
                    let path = super::tx::props_chain(self, tx, arg).map(|x| x.1);
                    let head = match self.prop_at(s.property.name.as_str(), path.as_deref())? {
                        PBind::Acc(v) | PBind::Get(v) => format!("{v}()"),
                        // A value of unknown kind (a caller's local, a row
                        // item): `yield*` reads an accessor by calling it.
                        PBind::Val(v) if plain_value(&v) => v,
                        PBind::Val(v) => {
                            self.uses.borrow_mut().helpers.insert("$r");
                            format!("$r({v})")
                        }
                    };
                    let rest = &tx.m.src[s.span.end as usize..arg.span().end as usize];
                    // Translate any computed keys in the rest verbatim (rare).
                    return Ok(format!("{head}{rest}"));
                }
                let root_text = tx.expr(self, root)?;
                let rest = &tx.m.src[root.span().end as usize..arg.span().end as usize];
                self.uses.borrow_mut().helpers.insert("$r");
                // `yield*` of a member of a plain object reads it: an accessor
                // there (a factory's `{ n, double }`) is called.
                Ok(format!("$r($r({root_text}){rest})"))
            }
            Expression::CallExpression(c) => {
                if let Some(n) = self.ce.m.runtime_name(&c.callee) {
                    match n {
                        // A structural store read: the selector over the
                        // (tracked) store proxy.
                        "readStore" => {
                            let (Some(store), Some(sel)) = (
                                c.arguments.first().and_then(|a| a.as_expression()),
                                c.arguments.get(1).and_then(|a| a.as_expression()),
                            ) else {
                                return Err("readStore without a store and a selector".into());
                            };
                            let st = tx.expr(self, store)?;
                            let f = tx.expr(self, sel)?;
                            return Ok(format!("({f})({st})"));
                        }
                        "$cleanup" => {
                            self.uses.borrow_mut().rt.insert("onCleanup");
                            let args = self.args(tx, c)?;
                            return Ok(format!("$C({args})"));
                        }
                        "$flush" => {
                            self.uses.borrow_mut().rt.insert("flush");
                            return Ok("$F()".into());
                        }
                        // In an event (or an async memo's run): await the
                        // work; a rejection throws at the `yield*`.
                        "attempt" => {
                            let f = c
                                .arguments
                                .first()
                                .and_then(|a| a.as_expression())
                                .ok_or("attempt without a function")?;
                            // A server call in an event that refreshes
                            // frames: the frames ride its response (single
                            // flight).
                            if !self.ce.flight.is_empty()
                                && let Some(fr) = FnRef::from_expr(f)
                                && let Some(body) = fr.concise().or_else(|| match fr.statements() {
                                    [Statement::ReturnStatement(r)] => r.argument.as_ref(),
                                    _ => None,
                                })
                                && let Some(call) = call_of(body)
                                && self
                                    .ce
                                    .m
                                    .symbol_of_expr(&call.callee)
                                    .is_some_and(|s| self.ce.m.server_fns.contains_key(&s))
                            {
                                let callee = tx.expr(self, &call.callee)?;
                                let args = self.args(tx, call)?;
                                let flight: Vec<String> = self
                                    .ce
                                    .flight
                                    .iter()
                                    .map(|fi| format!("[$fe{fi}, $fa{fi}()]"))
                                    .collect();
                                self.uses.borrow_mut().helpers.insert("$fcall");
                                return Ok(format!(
                                    "(await $fcall({callee}, [{args}], [{}]))",
                                    flight.join(", ")
                                ));
                            }
                            let f = tx.expr(self, f)?;
                            return Ok(format!("(await ({f})())"));
                        }
                        other => return Err(format!("`yield* {other}(…)` in client code")),
                    }
                }
                // A setter call's receipt: the call returns the new value.
                tx.expr(self, arg)
            }
            _ => Err(format!(
                "yield* of `{}`",
                super::model::short(tx.m.text(arg.span()))
            )),
        }
    }
    fn ident(&self, _tx: &Tx<'_, 'a>, id: &IdentifierReference<'a>) -> Option<String> {
        let s = self.ce.m.symbol_of(id)?;
        if let Some((n, k)) = self.lookup(s) {
            return match k {
                Kind::Set0(cell) => {
                    self.uses.borrow_mut().rt.insert("set");
                    Some(format!("(v => $set({cell}, v))"))
                }
                _ if n == id.name.as_str() => None,
                _ => Some(n),
            };
        }
        if let Some(n) = self.ce.m.runtime.get(&s) {
            let mapped = match n.as_str() {
                "untrack" => Some(("untrack", "$U")),
                "flush" => Some(("flush", "$F")),
                "onCleanup" => Some(("onCleanup", "$C")),
                _ => None,
            };
            if let Some((r, alias)) = mapped {
                self.uses.borrow_mut().rt.insert(r);
                return Some(alias.into());
            }
            // Island code runs in the browser.
            if n == "isServer" {
                return Some("false".into());
            }
            if self.ce.t2 && CORE_ONLY.contains(&n.as_str()) {
                self.uses.borrow_mut().core.insert(n.clone());
                return Some(format!("$${n}"));
            }
            return Some(format!("__UNSUPPORTED_RUNTIME_{n}"));
        }
        if self.ce.m.top_of.contains_key(&s) {
            self.uses.borrow_mut().top.insert(s);
        }
        None
    }
    fn is_props(&self, _tx: &Tx<'_, 'a>, e: &Expression<'a>) -> bool {
        let props = self.ce.m.comps[self.ce.insts[self.inst].comp].props;
        props.is_some() && self.ce.m.symbol_of_expr(e) == props
    }
    fn props_member(&self, tx: &Tx<'_, 'a>, name: &str) -> R<Option<String>> {
        self.props_member_path(tx, name, None)
    }
    fn props_member_path(
        &self,
        _tx: &Tx<'_, 'a>,
        name: &str,
        path: Option<&[String]>,
    ) -> R<Option<String>> {
        if name == "children" {
            return Err("`props.children` read by client code".into());
        }
        Ok(Some(match self.prop_at(name, path)? {
            PBind::Acc(v) | PBind::Val(v) => v,
            PBind::Get(v) => format!("{v}()"),
        }))
    }
    fn call(&self, tx: &Tx<'_, 'a>, c: &'a CallExpression<'a>) -> R<Option<String>> {
        if let Some(n) = self.ce.m.runtime_name(&c.callee) {
            // `refresh(memo)` of an island frame: refetch its region (a
            // no-op when this event's server call already brought it back).
            if n == "refresh"
                && let [arg] = c.arguments.as_slice()
                && let Some(s) = arg.as_expression().and_then(|e| self.ce.m.symbol_of_expr(e))
                && let Some(fi) = self.ce.a.frames.iter().position(|f| f.memo_sym == Some(s) && !f.route)
            {
                if !self.ce.frame_in_group(fi) {
                    return Err(format!(
                        "`refresh({})`: the frame is not in this island",
                        self.ce.m.sym_name(s)
                    ));
                }
                self.uses.borrow_mut().helpers.insert("$frefresh");
                return Ok(Some(format!("$frefresh($fe{fi}, $fa{fi}())")));
            }
            if n == "$event" {
                let Some(f) = c
                    .arguments
                    .first()
                    .and_then(|a| a.as_expression())
                    .and_then(FnRef::from_expr)
                else {
                    return Err("$event without a function".into());
                };
                return Ok(Some(tx.func(self, f, false)?));
            }
            return Ok(None);
        }
        // Tier 0: accessor / setter calls on slots.
        if let Some(s) = self.ce.m.symbol_of_expr(&c.callee) {
            match self.lookup(s) {
                Some((n, Kind::Cell0)) if c.arguments.is_empty() => {
                    return Ok(Some(if self.ce.opts.debug {
                        self.uses.borrow_mut().rt.insert("get");
                        format!("$get({n})")
                    } else {
                        format!("{n}.v")
                    }));
                }
                Some((_, Kind::Set0(cell))) => {
                    self.uses.borrow_mut().rt.insert("set");
                    let args = self.args(tx, c)?;
                    return Ok(Some(format!("$set({cell}, {args})")));
                }
                _ => {}
            }
        }
        Ok(None)
    }
}

/// Module-level code copied into a chunk: verbatim, TypeScript erased.
struct PlainEnv;

impl<'a> Env<'a> for PlainEnv {
    fn read(&self, tx: &Tx<'_, 'a>, arg: &'a Expression<'a>) -> R<String> {
        Err(format!(
            "`yield*` in module-level code: `{}`",
            super::model::short(tx.m.text(arg.span()))
        ))
    }
}

/// The effect half of a split `$effect`: reads become `$v[i]` (their
/// translated text goes to the compute half), `$cleanup(f)` registers `f`.
struct EffEnv<'e, 'c, 'x, 'a> {
    inner: &'e CEnv<'c, 'x, 'a>,
    reads: std::cell::RefCell<Vec<String>>,
    body: Span,
}

impl<'a> Env<'a> for EffEnv<'_, '_, '_, 'a> {
    fn read(&self, tx: &Tx<'_, 'a>, arg: &'a Expression<'a>) -> R<String> {
        if let Expression::CallExpression(c) = arg.without_parentheses() {
            if self.inner.ce.m.runtime_name(&c.callee) == Some("$cleanup") {
                let f = c
                    .arguments
                    .first()
                    .and_then(|a| a.as_expression())
                    .ok_or("$cleanup without a function")?;
                return Ok(format!("$cl.push({})", tx.expr(self, f)?));
            }
            // A setter receipt: a write, not a read.
            return tx.expr(self.inner, arg);
        }
        // Refuse reads of bindings the effect itself declares.
        let mut root = arg.without_parentheses();
        while let Expression::StaticMemberExpression(s) = root {
            root = &s.object;
        }
        if let Some(s) = self.inner.ce.m.symbol_of_expr(root) {
            let decl = self.inner.ce.m.scoping.symbol_span(s);
            if self.body.start <= decl.start && decl.end <= self.body.end {
                return Err("`$effect` reads a binding it declares (not split)".into());
            }
        }
        let text = self.inner.read(tx, arg)?;
        let mut reads = self.reads.borrow_mut();
        reads.push(text);
        Ok(format!("$v[{}]", reads.len() - 1))
    }
    fn ident(&self, tx: &Tx<'_, 'a>, id: &IdentifierReference<'a>) -> Option<String> {
        self.inner.ident(tx, id)
    }
    fn is_props(&self, tx: &Tx<'_, 'a>, e: &Expression<'a>) -> bool {
        self.inner.is_props(tx, e)
    }
    fn props_member(&self, tx: &Tx<'_, 'a>, name: &str) -> R<Option<String>> {
        self.inner.props_member(tx, name)
    }
    fn props_member_path(
        &self,
        tx: &Tx<'_, 'a>,
        name: &str,
        path: Option<&[String]>,
    ) -> R<Option<String>> {
        self.inner.props_member_path(tx, name, path)
    }
    fn call(&self, tx: &Tx<'_, 'a>, c: &'a CallExpression<'a>) -> R<Option<String>> {
        self.inner.call(tx, c)
    }
}

/// A prop binding that is never a function: a literal or a serialized value.
fn plain_value(v: &str) -> bool {
    v.starts_with('"')
        || v.starts_with("$d[")
        || v.chars().next().is_some_and(|c| c.is_ascii_digit())
        || matches!(v, "true" | "false" | "undefined" | "null")
}

/// An adopted async memo's first run: its `attempt` is the server's value.
struct AdoptEnv<'e, 'c, 'x, 'a> {
    inner: &'e CEnv<'c, 'x, 'a>,
    value: String,
}

impl<'a> Env<'a> for AdoptEnv<'_, '_, '_, 'a> {
    fn read(&self, tx: &Tx<'_, 'a>, arg: &'a Expression<'a>) -> R<String> {
        if let Expression::CallExpression(c) = arg.without_parentheses()
            && self.inner.ce.m.runtime_name(&c.callee) == Some("attempt")
        {
            return Ok(self.value.clone());
        }
        self.inner.read(tx, arg)
    }
    fn ident(&self, tx: &Tx<'_, 'a>, id: &IdentifierReference<'a>) -> Option<String> {
        self.inner.ident(tx, id)
    }
    fn is_props(&self, tx: &Tx<'_, 'a>, e: &Expression<'a>) -> bool {
        self.inner.is_props(tx, e)
    }
    fn props_member(&self, tx: &Tx<'_, 'a>, name: &str) -> R<Option<String>> {
        self.inner.props_member(tx, name)
    }
    fn props_member_path(
        &self,
        tx: &Tx<'_, 'a>,
        name: &str,
        path: Option<&[String]>,
    ) -> R<Option<String>> {
        self.inner.props_member_path(tx, name, path)
    }
    fn call(&self, tx: &Tx<'_, 'a>, c: &'a CallExpression<'a>) -> R<Option<String>> {
        self.inner.call(tx, c)
    }
}

/// An async memo whose value is its one `attempt`'s result: exactly one
/// `attempt`, as the final `return yield* attempt(…)`.
fn adoptable(body: FnRef<'_>) -> bool {
    let stmts = body.statements();
    let Some(Statement::ReturnStatement(r)) = stmts.last() else {
        return false;
    };
    let Some(arg) = &r.argument else {
        return false;
    };
    let is_attempt = super::model::yield_delegate(arg)
        .and_then(call_of)
        .is_some_and(|c| matches!(c.callee.without_parentheses(), Expression::Identifier(id) if id.name == "attempt"));
    is_attempt
        && !stmts[..stmts.len() - 1]
            .iter()
            .any(|s| contains_attempt_call(s))
}

fn contains_attempt_call(s: &Statement<'_>) -> bool {
    struct F(bool);
    impl<'a> oxc_ast_visit::Visit<'a> for F {
        fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
            if matches!(c.callee.without_parentheses(), Expression::Identifier(id) if id.name == "attempt")
            {
                self.0 = true;
            }
            oxc_ast_visit::walk::walk_call_expression(self, c);
        }
    }
    let mut f = F(false);
    oxc_ast_visit::Visit::visit_statement(&mut f, s);
    f.0
}

impl<'a> CEnv<'_, '_, 'a> {
    fn args(&self, tx: &Tx<'_, 'a>, c: &'a CallExpression<'a>) -> R<String> {
        let mut out = Vec::new();
        for a in &c.arguments {
            match a.as_expression() {
                Some(e) => out.push(tx.expr(self, e)?),
                None => return Err("spread argument".into()),
            }
        }
        Ok(out.join(", "))
    }
}

impl<'x, 'a> Ce<'x, 'a> {
    fn tx(&self) -> Tx<'x, 'a> {
        Tx { m: self.m }
    }

    /// Merge what a translation used: serialized values and the paths read.
    fn merge_uses(&mut self, uses: Uses) {
        self.helpers.extend(uses.helpers);
        self.rt.extend(uses.rt);
        self.core.extend(uses.core);
        self.top_syms.extend(uses.top);
        for s in uses.serial {
            if !self.serial.contains(&s) {
                self.serial.push(s);
            }
        }
        for (name, path) in uses.prop_paths {
            let e = self
                .prop_paths
                .entry(name)
                .or_insert_with(|| Some(BTreeSet::new()));
            match (e.as_mut(), path) {
                (Some(set), Some(p)) if !p.is_empty() => {
                    set.insert(p);
                }
                (Some(_), _) => *e = None,
                (None, _) => {}
            }
        }
    }

    fn fresh(&mut self, base: &str) -> String {
        self.uid += 1;
        format!("{base}{}", self.uid)
    }

    fn translate(
        &mut self,
        inst: usize,
        extra: &HashMap<SymbolId, (String, Kind)>,
        f: impl FnOnce(&Tx<'x, 'a>, &CEnv<'_, 'x, 'a>) -> R<String>,
    ) -> R<String> {
        let tx = self.tx();
        let (res, uses) = {
            let env = CEnv {
                ce: self,
                inst,
                extra,
                uses: Default::default(),
            };
            let r = f(&tx, &env);
            (r, env.uses.into_inner())
        };
        let mut out = res?;
        // A server-authoritative async memo of the island's root read by its
        // client code (a structural list over it): its settled value,
        // serialized on the anchor.
        while let Some(i) = out.find("__SERVER_MEMO_") {
            let rest = &out[i + "__SERVER_MEMO_".len()..];
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            let Ok(ii) = digits.parse::<usize>() else { break };
            let Item::Memo { sym, .. } = &self.m.comps[self.g.root].setup[ii] else { break };
            let n = self.m.sym_name(*sym).to_string();
            let s = Serial::Cell(ii);
            if !self.serial.contains(&s) {
                self.serial.push(s);
            }
            let end = i + "__SERVER_MEMO_".len() + digits.len() + 2;
            out.replace_range(i..end, &format!("$d[{}]", js_str(&format!("${n}"))));
        }
        if let Some(i) = out.find("__SERVER_VALUE_") {
            let name: String = out[i + "__SERVER_VALUE_".len()..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '$' || *c == '_')
                .collect();
            return Err(format!(
                "client code reads `{name}`, a server-authoritative async memo"
            ));
        }
        if out.contains("__UNSUPPORTED_RUNTIME_") {
            let name = out
                .split("__UNSUPPORTED_RUNTIME_")
                .nth(1)
                .unwrap_or("")
                .split(|c: char| !c.is_alphanumeric() && c != '$' && c != '_')
                .next()
                .unwrap_or("");
            return Err(format!("runtime `{name}` in client code"));
        }
        self.merge_uses(uses);
        Ok(out)
    }

    fn expr(
        &mut self,
        inst: usize,
        extra: &HashMap<SymbolId, (String, Kind)>,
        e: &'a Expression<'a>,
    ) -> R<String> {
        self.translate(inst, extra, |tx, env| tx.expr(env, e))
    }

    fn bucket(&mut self, inst: usize) -> &mut Bucket {
        let s = &mut self.scopes[self.cur];
        if !s.buckets.contains_key(&inst) {
            s.order.push(inst);
        }
        s.buckets.entry(inst).or_default()
    }

    /// The props each member's code in this island uses: read by its sites
    /// or setup items, used in a call's props, or handed on unchanged
    /// (`attr={props.x}`) to a member that uses `attr` (a fixpoint over
    /// recursive members).
    fn used_props(&self) -> HashMap<usize, BTreeSet<String>> {
        let mut used: HashMap<usize, BTreeSet<String>> = HashMap::new();
        // Forwarding edges: (member, its prop) ← (callee, callee's prop).
        let mut edges: Vec<(usize, String, usize, String)> = Vec::new();
        for &c in &self.g.members {
            let f = &self.a.facts[c];
            let set = used.entry(c).or_default();
            for site in &f.sites {
                set.extend(site.refs.props.iter().map(|(n, _)| n.clone()));
                if site.refs.props_bare {
                    set.insert("*".into());
                }
            }
            for r in &f.item_refs {
                set.extend(r.props.iter().map(|(n, _)| n.clone()));
                if r.props_bare {
                    set.insert("*".into());
                }
            }
            let props = self.m.comps[c].props;
            for call in &f.calls {
                for (attr, e) in &call.props {
                    let Some(e) = e else { continue };
                    if let Tag::Comp(k) = call.tag
                        && self.g.members.contains(&k)
                        && let Expression::StaticMemberExpression(me) = e.without_parentheses()
                        && props.is_some()
                        && self.m.symbol_of_expr(&me.object) == props
                    {
                        edges.push((c, me.property.name.to_string(), k, attr.clone()));
                        continue;
                    }
                    if !matches!(call.tag, Tag::Comp(k) if self.g.members.contains(&k)) {
                        // Another island's component (rendered as it is), or
                        // one inlined for its slot: handed on, not used here.
                        if let Tag::Comp(k) = call.tag
                            && self.a.root_of.get(&k).is_some_and(|gs| !gs.contains(&self.gi))
                        {
                            continue;
                        }
                    }
                    let r = super::graph::refs_expr(self.m, props, e);
                    set.extend(r.props.iter().map(|(n, _)| n.clone()));
                    if r.props_bare {
                        set.insert("*".into());
                    }
                }
            }
        }
        loop {
            let mut changed = false;
            for (c, x, k, attr) in &edges {
                let callee_uses = used
                    .get(k)
                    .is_some_and(|u| u.contains(attr) || u.contains("*"));
                if callee_uses && used.get_mut(c).is_some_and(|u| u.insert(x.clone())) {
                    changed = true;
                }
            }
            if !changed {
                break used;
            }
        }
    }

    /// Does member `k`'s code use prop `name`?
    fn uses_prop(&self, k: usize, name: &str) -> bool {
        match self.used.get(&k) {
            Some(u) => u.contains(name) || u.contains("*"),
            None => true,
        }
    }

    fn run(mut self) -> R<GroupCode> {
        let root = self.g.root;
        self.used = self.used_props();
        let m = self.m;
        let comp = &m.comps[root];
        let view = comp.view.ok_or("the island root has no view")?;
        // Root instance.
        self.insts.push(Inst {
            comp: root,
            names: HashMap::new(),
            props: HashMap::new(),
            slot: None,
            ctx: HashMap::new(),
            root: true,
            suffix: String::new(),
        });
        self.scopes.push(Scope {
            nav: vec![],
            buckets: HashMap::new(),
            order: vec![],
            builder: false,
        });
        self.cur = 0;
        // Anchor: an element anchor when the view's first node is an
        // intrinsic element of the root's own JSX.
        self.element_anchor = first_is_element(m, view);
        self.setup(0)?;
        let mut slots = Vec::new();
        self.flatten_root(view, 0, &mut slots)?;
        self.container(None, &slots)?;
        let body = self.assemble(0, 0);
        let settled = std::mem::take(&mut self.settled);
        let serial = self.serial.clone();

        // --- module text ---------------------------------------------------------
        let tier = self.tier;
        let runtime = match tier {
            0 => self.opts.t0.clone(),
            1 if !self.opts.tier1_core => self.opts.kernel.clone(),
            _ => self.opts.core.clone(),
        };
        let mut out = String::new();
        let mut imports: Vec<String> = Vec::new();
        if tier == 0 {
            {
                let hole = if self.transplant.is_some() { "hole as $hole0" } else { "hole as $hole" };
                let mut names = vec!["cell as $cell".to_string(), hole.to_string()];
                if self.rt.contains("set") {
                    names.push("set as $set".into());
                }
                if self.rt.contains("get") {
                    names.push("get as $get".into());
                }
                if self.rt.contains("flush") {
                    names.push("flush as $F".into());
                }
                imports.push(format!(
                    "import {{ {} }} from {};",
                    names.join(", "),
                    js_str(&runtime)
                ));
            }
            if self
                .rt
                .iter()
                .any(|r| matches!(*r, "onCleanup" | "untrack"))
            {
                return Err("tier 0 with a cleanup / untrack".into());
            }
        } else {
            let mut names = vec![
                "createRoot as $R".to_string(),
                "createRenderEffect as $E".to_string(),
                "flush as $F".to_string(),
            ];
            if ["$list", "$show", "$listf", "$showf", "$listi", "$listu", "$sw"]
                .iter()
                .any(|h| self.helpers.contains(h))
            {
                names.push("getOwner as $O".into());
                names.push("runWithOwner as $W".into());
            }
            for (r, alias) in [
                ("createSignal", "$S"),
                ("createMemo", "$M"),
                ("onCleanup", "$C"),
                ("createEffect", "$Ef"),
                ("untrack", "$U"),
            ] {
                if self.rt.contains(r) {
                    names.push(format!("{r} as {alias}"));
                }
            }
            if !self.core.is_empty() && !self.t2 {
                return Err(format!(
                    "core-only runtime ({}) in a tier-{tier} island",
                    self.core.iter().cloned().collect::<Vec<_>>().join(", ")
                ));
            }
            for n in &self.core {
                names.push(format!("{n} as $${n}"));
            }
            imports.push(format!(
                "import {{ {} }} from {};",
                names.join(", "),
                js_str(&runtime)
            ));
        }
        for i in imports {
            out.push_str(&i);
            out.push('\n');
        }
        out.push_str(&self.copy_top()?);
        let mut helpers: BTreeSet<&str> = self.helpers.clone();
        loop {
            let before = helpers.len();
            for h in helpers.clone() {
                helpers.extend(helper_deps(h).iter().copied());
            }
            if helpers.len() == before {
                break;
            }
        }
        for (name, code) in HELPERS {
            if helpers.contains(name) {
                out.push_str(code);
                out.push('\n');
            }
        }
        for (i, (t, w)) in self.templates.iter().enumerate() {
            match w {
                Some(w) => {
                    let _ = writeln!(out, "const $t{i} = $tplw({}, {});", js_str(t), js_str(w));
                }
                None => {
                    let _ = writeln!(out, "const $t{i} = $tpl({});", js_str(t));
                }
            }
        }
        let data = if serial.is_empty() {
            String::new()
        } else if self.element_anchor {
            // The anchor carries every island rooted there, keyed by id.
            format!(
                "const $d = JSON.parse($a.getAttribute(\"data-s\"))[{}];\n",
                js_str(&self.g.id)
            )
        } else {
            return Err("serialized values on a comment anchor".into());
        };
        let nav = self.scopes[0].nav.join("\n");
        if self.opts.verify {
            // Dev: walk the same addresses, check every node, report.
            let mut v = String::from(
                "export function verify($a) {\nconst $e = [], $x = (n, w, p) => { const t = w.startsWith(\"<!--\") ? n && n.nodeType === 8 && n.data === \"/\" : n && n.nodeType === 1 && \"<\" + n.localName + \">\" === w.split(\" \")[0]; if (!t) $e.push(\"expected \" + w + \" at \" + p + \", found \" + (n ? (n.nodeType === 1 ? \"<\" + n.localName + \">\" : n.nodeType === 8 ? \"<!--\" + n.data + \"-->\" : \"text \" + JSON.stringify(n.data)) : \"nothing\")); };\ntry {\n",
            );
            if !serial.is_empty() {
                let _ = writeln!(
                    v,
                    "if (!$a.getAttribute || !$a.getAttribute(\"data-s\")) $e.push(\"missing data-s (serialized values) on the anchor\"); else if (!({} in JSON.parse($a.getAttribute(\"data-s\")))) $e.push(\"data-s has no entry for this island\");",
                    js_str(&self.g.id)
                );
            }
            for (var, want, path) in &self.checks {
                if var == "$a" {
                    let _ = writeln!(v, "$x($a, {}, {});", js_str(want), js_str(path));
                }
            }
            // Messages name each node by its full path from the anchor.
            let mut full: HashMap<String, String> = HashMap::new();
            let resolve = |e: &str, full: &HashMap<String, String>| -> String {
                let mut out = String::new();
                let b = e.as_bytes();
                let mut i = 0;
                while i < b.len() {
                    if b[i] == b'$' && i + 1 < b.len() && (b[i + 1] == b'n' || b[i + 1] == b'm') {
                        let j =
                            i + 2 + b[i + 2..].iter().take_while(|c| c.is_ascii_digit()).count();
                        if j > i + 2
                            && let Some(p) = full.get(&e[i..j])
                        {
                            out.push_str(p);
                            i = j;
                            continue;
                        }
                    }
                    out.push(b[i] as char);
                    i += 1;
                }
                out
            };
            let mut checked: BTreeSet<&str> = BTreeSet::new();
            // Boundaries in the activation scope (not in fresh content).
            let boundary_navs: Vec<&String> = self
                .bounds
                .iter()
                .filter(|(sc, _)| !self.scopes[*sc].builder)
                .flat_map(|(sc, _)| self.scopes[*sc].nav.iter())
                .collect();
            for line in self.scopes[0].nav.iter().chain(boundary_navs) {
                v.push_str(line);
                v.push('\n');
                if let Some(rest) = line.strip_prefix("const ")
                    && let Some((var, expr)) = rest.split_once(" = ")
                {
                    let p = resolve(expr.trim_end_matches(';'), &full);
                    full.insert(var.to_string(), p);
                }
                for (var, want, _) in &self.checks {
                    if line.starts_with(&format!("const {var} =")) && checked.insert(var.as_str()) {
                        let _ = writeln!(v, "$x({var}, {}, {});", js_str(want), js_str(&full[var]));
                    }
                }
            }
            v.push_str("} catch (err) { $e.push(\"the static walk failed: \" + err.message); }\nreturn $e;\n}\n");
            out.push_str(&v);
        }
        let fm = js_str(&self.opts.frames_module);
        if self.frame_driver {
            // The frames applier loads on a frame's first refetch.
            let _ = writeln!(out, "const $frame = (e, v) => import({fm}).then(m => m.frame(e, v));");
        }
        if self.helpers.contains("$frefresh") {
            let _ = writeln!(out, "const $frefresh = (e, v) => import({fm}).then(m => m.refresh(e, v));");
        }
        if self.helpers.contains("$fcall") {
            // A server call carrying the frames its event refreshes.
            let _ = writeln!(out, "const $fcall = (f, a, fl) => import({fm}).then(m => m.call(f, a, fl));");
        }
        // Keyed state: `activate(anchor, state)` seeds the cells and applies
        // every hole; the anchor exposes the current values.
        let (params, st_in, st_out) = match &self.transplant {
            Some(list) => (
                "$a, $st",
                if tier == 0 {
                    "const $hole = $st ? (c, h, p) => { $hole0(c, h, p); p(h()); } : $hole0;\n"
                        .to_string()
                } else {
                    String::new()
                },
                format!(
                    "($a.$ss ||= {{}})[{}] = () => [{}];\n",
                    js_str(&self.g.id),
                    list.join(", ")
                ),
            ),
            // `$st` is read by the holes' first-run skips: always a parameter.
            None if self.opts.keyed_state => ("$a, $st", String::new(), String::new()),
            None => ("$a", String::new(), String::new()),
        };
        let st_in = if tier == 0 || self.transplant.is_none() { st_in } else { String::new() };
        // The page-level listeners of the island's delegated handlers.
        let data = if self.events.is_empty() {
            data
        } else {
            format!(
                "$dg([{}]);\n{data}",
                self.events.iter().map(|e| js_str(e)).collect::<Vec<_>>().join(", ")
            )
        };
        if tier == 0 {
            let _ = write!(
                out,
                "export function activate({params}) {{\n{st_in}{data}{nav}\n{body}\n{}{st_out}}}\n",
                settled.join("\n")
            );
        } else {
            let _ = write!(
                out,
                "export function activate({params}) {{\n{data}{nav}\nreturn $R($x => {{\n{body}\n{}{st_out}return $x;\n}});\n}}\n",
                settled.join("\n")
            );
            out.push_str("export const flush = $F;\n");
        }
        Ok(GroupCode {
            code: out,
            tier,
            runtime,
            serial,
            prop_paths: self.prop_paths.clone(),
            element_anchor: self.element_anchor,
            nests: anchor_nests(m, view),
            mutable_top: self.mutable_top.clone(),
            transplant: self.transplant.is_some(),
            lazy_ok: self.lazy_ok
                && self.element_anchor
                && self.g.window_events.len() + self.g.events.len() > 0
                && !self.g.hot,
        })
    }

    // --- module-level declarations the chunk needs --------------------------------------
    fn copy_top(&mut self) -> R<String> {
        // Transitive closure over top-level statements.
        let mut need: BTreeSet<usize> = BTreeSet::new();
        let mut stack: Vec<SymbolId> = self.top_syms.iter().copied().collect();
        let mut seen: BTreeSet<SymbolId> = BTreeSet::new();
        while let Some(s) = stack.pop() {
            if !seen.insert(s) {
                continue;
            }
            let Some(&ti) = self.m.top_of.get(&s) else {
                continue;
            };
            let t = &self.m.top[ti];
            if t.comp.is_some() {
                return Err(format!(
                    "client code references component `{}` as a value",
                    self.m.sym_name(s)
                ));
            }
            if t.runtime_import {
                return Err(format!(
                    "client code references runtime `{}`",
                    self.m.sym_name(s)
                ));
            }
            if need.insert(ti) && !t.import {
                let r = super::graph::refs_stmt(self.m, t.stmt);
                for (x, _) in r.syms {
                    stack.push(x);
                }
            }
        }
        let mut out = String::new();
        for ti in need {
            let t = &self.m.top[ti];
            if let Statement::ImportDeclaration(imp) = t.stmt {
                let mut named = Vec::new();
                let mut default = None;
                let mut ns = None;
                for sp in imp.specifiers.iter().flatten() {
                    match sp {
                        ImportDeclarationSpecifier::ImportSpecifier(s) => {
                            if s.local.symbol_id.get().is_some_and(|x| seen.contains(&x)) {
                                let imported = s.imported.name();
                                named.push(if imported == s.local.name {
                                    imported.to_string()
                                } else {
                                    format!("{imported} as {}", s.local.name)
                                });
                            }
                        }
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                            if s.local.symbol_id.get().is_some_and(|x| seen.contains(&x)) {
                                default = Some(s.local.name.to_string());
                            }
                        }
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                            if s.local.symbol_id.get().is_some_and(|x| seen.contains(&x)) {
                                ns = Some(s.local.name.to_string());
                            }
                        }
                    }
                }
                let src = js_str(imp.source.value.as_str());
                if let Some(d) = default {
                    let _ = writeln!(out, "import {d} from {src};");
                }
                if let Some(n) = ns {
                    let _ = writeln!(out, "import * as {n} from {src};");
                }
                if !named.is_empty() {
                    let _ = writeln!(out, "import {{ {} }} from {src};", named.join(", "));
                }
                continue;
            }
            if let Statement::ExportDeclaration(e) = t.stmt
                && let oxc_ast::ast::Declaration::VariableDeclaration(v) = &e.declaration
                && v.kind != oxc_ast::ast::VariableDeclarationKind::Const
            {
                self.mutable_top.push(ti);
            } else if let Statement::VariableDeclaration(v) = t.stmt
                && v.kind != oxc_ast::ast::VariableDeclarationKind::Const
            {
                self.mutable_top.push(ti);
            }
            // Type-only declarations have no runtime part.
            let decl = match t.stmt {
                Statement::ExportDeclaration(e) => Some(&e.declaration),
                s => s.as_declaration(),
            };
            if decl.is_some_and(|d| d.is_type()) {
                continue;
            }
            let text = {
                let tx = self.tx();
                tx.stmt(&PlainEnv, t.stmt)?
            };
            out.push_str(&text);
            out.push('\n');
        }
        Ok(out)
    }

    // --- setup --------------------------------------------------------------------
    fn name_for(&self, inst: usize, s: SymbolId) -> String {
        format!("{}{}", self.m.sym_name(s), self.insts[inst].suffix)
    }

    /// Items of a component the island's client code needs (transitively):
    /// what the group's own sites reference, plus what the component's
    /// inert holes, calls and providers may touch. A cell (or memo) of
    /// another island is never one of them: that island owns it, and a
    /// second copy here would go out of phase with it.
    fn needed_items(&self, comp: usize) -> R<BTreeSet<usize>> {
        let c = &self.m.comps[comp];
        let f = &self.a.facts[comp];
        let owner: HashMap<SymbolId, usize> = c
            .setup
            .iter()
            .enumerate()
            .flat_map(|(i, it)| it.declares().into_iter().map(move |s| (s, i)))
            .collect();
        let foreign = |i: usize| {
            self.a.live.contains(&(comp, i))
                && self.a.group_of_key.get(&(comp, i)) != Some(&self.gi)
        };
        let mut syms: Vec<SymbolId> = Vec::new();
        let mut need: BTreeSet<usize> = BTreeSet::new();
        for (ci, si) in &self.g.sites {
            if *ci != comp {
                continue;
            }
            let site = &f.sites[*si];
            for (s, _) in &site.refs.syms {
                // The partitioner joins a site with every live cell it
                // touches: one that reads two islands' cells merged them.
                if let Some(i) = owner.get(s)
                    && foreign(*i)
                {
                    return Err(format!(
                        "`{}`: `{}` (in island `{}`) is read by a site of island `{}` (not merged)",
                        c.name,
                        self.m.sym_name(*s),
                        self.a.groups[self.a.group_of_key[&(comp, *i)]].id,
                        self.g.id
                    ));
                }
                syms.push(*s);
            }
            if let SiteKind::Effect(ii, _) = site.kind {
                need.insert(ii);
            }
        }
        // Everything any client-rendered expression of the view may touch
        // (inert holes inside fresh regions, props of inlined children,
        // provider values): the view's inert sites and calls.
        // A member component may be inlined into fresh region content (a
        // row), where all its holes are computed; the root's inert holes
        // matter only inside its own live regions.
        let all = comp != self.g.root;
        for (si, s) in f.sites.iter().enumerate() {
            if self.a.site_live[comp][si] {
                continue;
            }
            let in_region = s
                .regions
                .iter()
                .any(|r| self.a.group_of_site.get(&(comp, *r)) == Some(&self.gi));
            if all || in_region {
                syms.extend(s.refs.syms.iter().map(|x| x.0));
            }
        }
        for call in &f.calls {
            for (attr, e) in &call.props {
                if let Tag::Comp(k) = call.tag
                    && !self.uses_prop(k, attr)
                {
                    continue;
                }
                if let Some(e) = e {
                    syms.extend(
                        super::graph::refs_expr(self.m, c.props, e)
                            .syms
                            .iter()
                            .map(|x| x.0),
                    );
                }
            }
        }
        for (_, v) in &f.providers {
            if let Some(e) = v {
                syms.extend(
                    super::graph::refs_expr(self.m, c.props, e)
                        .syms
                        .iter()
                        .map(|x| x.0),
                );
            }
        }
        for (ii, item) in c.setup.iter().enumerate() {
            if matches!(item, Item::Cleanup { .. } | Item::Stmt { .. }) {
                need.insert(ii);
            }
        }
        let mut stack: Vec<usize> = need.iter().copied().collect();
        for s in syms {
            if let Some(i) = owner.get(&s)
                && !foreign(*i)
            {
                stack.push(*i);
            }
        }
        while let Some(i) = stack.pop() {
            need.insert(i);
            for (s, _) in &f.item_refs[i].syms {
                if let Some(j) = owner.get(s)
                    && !need.contains(j)
                    && !foreign(*j)
                {
                    stack.push(*j);
                }
            }
        }
        Ok(need)
    }

    fn evaluable(&self, comp: usize, r: &super::graph::Refs, depth: u32) -> bool {
        if !r.props.is_empty() || r.props_bare || depth > 8 {
            return false;
        }
        let c = &self.m.comps[comp];
        for (s, _) in &r.syms {
            if let Some(ti) = self.m.top_of.get(s) {
                let t = &self.m.top[*ti];
                if t.runtime_import || t.comp.is_some() {
                    return false;
                }
                continue;
            }
            let item = c.setup.iter().position(|it| it.declares().contains(s));
            match item.map(|i| (&c.setup[i], i)) {
                Some((Item::Local { .. }, i))
                    if !self.evaluable(comp, &self.a.facts[comp].item_refs[i], depth + 1) =>
                {
                    return false;
                }
                Some((Item::Local { .. }, _)) => {}
                Some((Item::Cell { .. } | Item::Memo { .. } | Item::Event { .. }, _)) => {}
                Some(_) => return false,
                // Locals of nested functions (parameters…) are fine.
                None => {}
            }
        }
        true
    }

    fn setup(&mut self, inst: usize) -> R<()> {
        let comp = self.insts[inst].comp;
        let c = &self.m.comps[comp];
        let need = self.needed_items(comp)?;
        let t0 = self.tier == 0;
        // Declare names (and kinds) for every item first: bodies may refer
        // to later items (hoisted functions, events used by earlier locals).
        for (ii, item) in c.setup.iter().enumerate() {
            match item {
                Item::Cell { get, set, .. } => {
                    let gn = self.name_for(inst, *get);
                    let kind = if item.store_like() {
                        Kind::Val
                    } else if t0 {
                        Kind::Cell0
                    } else {
                        Kind::Acc
                    };
                    self.insts[inst].names.insert(*get, (gn.clone(), kind));
                    if let Some(s) = set {
                        let sn = self.name_for(inst, *s);
                        self.insts[inst]
                            .names
                            .insert(*s, (sn, if t0 { Kind::Set0(gn) } else { Kind::Val }));
                    }
                }
                Item::Memo { sym, is_async, .. } => {
                    // A server-authoritative async memo has no client value:
                    // client code that reads it is refused (`translate`).
                    let server = *is_async && !self.a.live.contains(&(comp, ii));
                    if server && self.insts[inst].root {
                        // Its settled value, serialized when read (`translate`).
                        self.insts[inst]
                            .names
                            .insert(*sym, (format!("__SERVER_MEMO_{ii}__"), Kind::Val));
                        continue;
                    }
                    let n = if server {
                        format!("__SERVER_VALUE_{}", self.m.sym_name(*sym))
                    } else {
                        self.name_for(inst, *sym)
                    };
                    self.insts[inst].names.insert(*sym, (n, Kind::Acc));
                }
                Item::Event { sym, .. } => {
                    let n = self.name_for(inst, *sym);
                    self.insts[inst].names.insert(*sym, (n, Kind::Val));
                }
                Item::Context { symbols, .. } | Item::Local { symbols, .. } => {
                    let kind = if let Item::Local {
                        decl: LocalDecl::Func(_),
                        ..
                    } = item
                    {
                        Kind::Val
                    } else {
                        Kind::Unknown
                    };
                    for s in symbols {
                        let n = self.name_for(inst, *s);
                        self.insts[inst].names.insert(*s, (n, kind.clone()));
                    }
                }
                _ => {}
            }
            let _ = ii;
        }
        let none = HashMap::new();
        for (ii, item) in c.setup.iter().enumerate() {
            if !need.contains(&ii) {
                continue;
            }
            if let Item::Memo { is_async: true, .. } = item
                && !self.a.live.contains(&(comp, ii))
            {
                continue;
            }
            let line = match item {
                Item::Cell {
                    get,
                    set,
                    init,
                    host,
                    label,
                    label_expr,
                    ..
                } => {
                    // A store nothing writes (after a keyed split, its rows
                    // own their keys) is a plain value: its initial state.
                    let frozen = *host == CellHost::Store && !self.a.live.contains(&(comp, ii));
                    if *host != CellHost::Signal && !self.t2 && !frozen {
                        return Err("store / optimistic cell below tier 2".into());
                    }
                    let gn = self.insts[inst].names[get].0.clone();
                    if *host == CellHost::Optimistic {
                        let line = self.optimistic_cell(inst, comp, ii)?;
                        self.bucket(inst).setup.push(line);
                        continue;
                    }
                    let init_text = match init {
                        None => "undefined".to_string(),
                        Some(e) => {
                            let r = &self.a.facts[comp].item_refs[ii];
                            if self.evaluable(comp, r, 0) {
                                self.expr(inst, &none, e)?
                            } else if self.insts[inst].root {
                                let s = Serial::Cell(ii);
                                if !self.serial.contains(&s) {
                                    self.serial.push(s);
                                }
                                format!("$d[{}]", js_str(&format!("${}", self.m.sym_name(*get))))
                            } else {
                                return Err(format!(
                                    "cell `{}` initialized from server values in a non-root island component",
                                    self.m.sym_name(*get)
                                ));
                            }
                        }
                    };
                    // A computed probe label (instrumented builds): translated
                    // where the cell is created (a row's label from its item).
                    let label_text = match (label, label_expr) {
                        (Some(l), _) => Some(js_str(l)),
                        (None, Some(e)) => Some(self.expr(inst, &none, e)?),
                        _ => None,
                    };
                    // Keyed state: a transplanted value wins over the initializer.
                    let init_text = match (&mut self.transplant, frozen, *host, self.scopes[self.cur].builder) {
                        (Some(list), false, CellHost::Signal, false) => {
                            let i = list.len();
                            list.push(if t0 { format!("{gn}.v") } else { format!("{gn}()") });
                            format!("$st ? $st[{i}] : {init_text}")
                        }
                        (Some(_), false, _, _) => {
                            self.transplant = None;
                            init_text
                        }
                        _ => init_text,
                    };
                    if frozen {
                        format!("const {gn} = {init_text};")
                    } else if t0 {
                        match (self.opts.debug, &label_text) {
                            (true, Some(l)) => format!("const {gn} = $cell({init_text}, {l});"),
                            _ => format!("const {gn} = $cell({init_text});"),
                        }
                    } else {
                        let pat = match set {
                            Some(s) => format!("[{gn}, {}]", self.insts[inst].names[s].0),
                            None => format!("[{gn}]"),
                        };
                        if *host == CellHost::Store {
                            // A plain store (the core's; `$store` lowers to it).
                            self.core.insert("createPlainStore".into());
                            format!("const {pat} = $$createPlainStore({init_text});")
                        } else if let Some(l) = &label_text {
                            // Probe host (instrumented builds): keep the host call.
                            let callee = self.probe_callee(ii, comp)?;
                            self.top_syms.extend(callee.1);
                            format!("const {pat} = {}({l}, {init_text});", callee.0)
                        } else {
                            self.rt.insert("createSignal");
                            format!("const {pat} = $S({init_text});")
                        }
                    }
                }
                Item::Memo {
                    sym,
                    body,
                    is_async,
                    ..
                } => {
                    if t0 {
                        return Err("memo at tier 0".into());
                    }
                    if *is_async {
                        // A live async memo (tier 2): adopted (P2). Its first
                        // run subscribes to the reads before its `attempt`
                        // and returns the server's settled value (from the
                        // anchor) without running the attempt; later runs
                        // are the async body.
                        if !self.t2 {
                            return Err("async memo below tier 2".into());
                        }
                        if !self.insts[inst].root {
                            return Err(format!(
                                "live async memo `{}` in a non-root island component",
                                self.m.sym_name(*sym)
                            ));
                        }
                        if !adoptable(*body) {
                            return Err(format!(
                                "async memo `{}` is not adoptable (its value must be the result of one final `return yield* attempt(…)`)",
                                self.m.sym_name(*sym)
                            ));
                        }
                        let key = js_str(&format!("${}", self.m.sym_name(*sym)));
                        let s = Serial::Cell(ii);
                        if !self.serial.contains(&s) {
                            self.serial.push(s);
                        }
                        let adopt = {
                            let tx = self.tx();
                            let env = CEnv {
                                ce: self,
                                inst,
                                extra: &none,
                                uses: Default::default(),
                            };
                            let ad = AdoptEnv {
                                inner: &env,
                                value: format!("$d[{key}]"),
                            };
                            let r = tx.body(&ad, *body);
                            let uses = env.uses.into_inner();
                            r.map(|c| (c, uses))
                        };
                        let (adopt, uses) = adopt?;
                        self.merge_uses(uses);
                        let run =
                            self.translate(inst, &none, |tx, env| tx.func(env, *body, true))?;
                        self.rt.insert("createMemo");
                        let v = self.fresh("$ad");
                        let n = &self.insts[inst].names[sym].0;
                        format!(
                            "let {v} = 1; const {n} = $M(() => {v} ? ({v} = 0, (() => {adopt})()) : ({run})());"
                        )
                    } else {
                        self.rt.insert("createMemo");
                        let f =
                            self.translate(inst, &none, |tx, env| tx.func(env, *body, false))?;
                        format!("const {} = $M({f});", self.insts[inst].names[sym].0)
                    }
                }
                Item::Event { sym, body, .. } => {
                    // A handler that `attempt`s async work suspends there: an
                    // async function awaiting it (the driver's semantics).
                    let asy = self.a.facts[comp].item_refs[ii]
                        .calls
                        .iter()
                        .any(|c| c == "attempt");
                    // The island frames this event refreshes (single flight).
                    self.flight = self
                        .a
                        .frames
                        .iter()
                        .enumerate()
                        .filter(|(fi, f)| f.refreshers.contains(sym) && self.frame_in_group(*fi))
                        .map(|(fi, _)| fi)
                        .collect();
                    let f = self.translate(inst, &none, |tx, env| tx.func(env, *body, asy));
                    self.flight.clear();
                    let f = f?;
                    format!("const {} = {f};", self.insts[inst].names[sym].0)
                }
                Item::Effect { body, settled, .. } => {
                    if t0 {
                        return Err("effect at tier 0".into());
                    }
                    if *settled {
                        let b = self.translate(inst, &none, |tx, env| tx.body(env, *body))?;
                        self.settled.push(b);
                        continue;
                    }
                    // The effect split (generator-blocks-v2.md, Effects): every
                    // read moves into the compute half, in order; the body is
                    // the effect half over the values; `$cleanup`s are its
                    // returned cleanup.
                    let body_span = body.body_span();
                    if FnRef::is_concise(body) {
                        return Err("concise `$effect` body".into());
                    }
                    let text = self.m.text(body_span);
                    if ["for (", "for(", "while (", "while(", "do {"]
                        .iter()
                        .any(|k| text.contains(k))
                        && text.contains("yield*")
                    {
                        return Err("`$effect` reads in a loop (not split)".into());
                    }
                    let (code, reads) = {
                        let tx = self.tx();
                        let env = CEnv {
                            ce: self,
                            inst,
                            extra: &none,
                            uses: Default::default(),
                        };
                        let eff = EffEnv {
                            inner: &env,
                            reads: Default::default(),
                            body: body_span,
                        };
                        let r = tx.body(&eff, *body);
                        let reads = eff.reads.into_inner();
                        let uses = env.uses.into_inner();
                        (r.map(|c| (c, uses)), reads)
                    };
                    let (code, uses) = code?;
                    self.merge_uses(uses);
                    self.rt.insert("createEffect");
                    let body_inner = code
                        .trim()
                        .strip_prefix('{')
                        .and_then(|b| b.strip_suffix('}'))
                        .unwrap_or(&code);
                    format!(
                        "$Ef(() => [{}], $v => {{ const $cl = [];{body_inner}\nreturn () => {{ for (const f of $cl) f(); }}; }});",
                        reads.join(", ")
                    )
                }
                Item::Context { pattern, ctx, .. } => {
                    let Some(bind) = self.insts[inst].ctx.get(ctx).cloned() else {
                        // Provided outside the island: a server value, unless
                        // a provider anywhere gives it reactive state.
                        let name = self.m.sym_name(*ctx).to_string();
                        if self
                            .a
                            .ctx_av
                            .get(ctx)
                            .is_some_and(|v| !v.reads.is_empty() || !v.writes.is_empty())
                        {
                            return Err(format!(
                                "context `{name}` read in the island without a provider inside it (its value holds reactive state)"
                            ));
                        }
                        let s = Serial::Ctx(name.clone());
                        if !self.serial.contains(&s) {
                            self.serial.push(s);
                        }
                        let pat = self.pattern(inst, pattern)?;
                        let line =
                            format!("const {pat} = $d[{}];", js_str(&format!("$ctx:{name}")));
                        self.bucket(inst).setup.push(line);
                        continue;
                    };
                    let pat = self.pattern(inst, pattern)?;
                    self.bind_context_kinds(inst, pattern, &bind.kinds);
                    format!("const {pat} = {};", bind.var)
                }
                Item::Local { decl, .. } => match decl {
                    LocalDecl::Var(d) => {
                        let pat = self.pattern(inst, &d.id)?;
                        match &d.init {
                            Some(e) => {
                                let v = self.expr(inst, &none, e)?;
                                format!("let {pat} = {v};")
                            }
                            None => format!("let {pat};"),
                        }
                    }
                    LocalDecl::Func(f) => {
                        let name =
                            f.id.as_ref()
                                .and_then(|i| i.symbol_id.get())
                                .map(|s| self.insts[inst].names[&s].0.clone());
                        let func = self.translate(inst, &none, |tx, env| {
                            tx.func(env, FnRef::Func(f), f.r#async)
                        })?;
                        format!("const {} = {func};", name.unwrap_or_default())
                    }
                },
                Item::Stmt { stmt, .. } => {
                    self.translate(inst, &none, |tx, env| tx.stmt(env, stmt))?
                }
                Item::Cleanup { arg, .. } => {
                    if t0 {
                        return Err("cleanup at tier 0".into());
                    }
                    self.rt.insert("onCleanup");
                    let v = self.expr(inst, &none, arg)?;
                    format!("$C({v});")
                }
            };
            self.bucket(inst).setup.push(line);
        }
        Ok(())
    }

    /// An optimistic / projection cell (tier 2). A derived one (computed by
    /// a function) is adopted: its first run returns the server's settled
    /// value from the anchor instead of running the function (P2); later
    /// runs (`refresh`) run it. Its function must read no reactive state
    /// before that (the adopted run would not subscribe to it).
    fn optimistic_cell(&mut self, inst: usize, comp: usize, ii: usize) -> R<String> {
        let none = HashMap::new();
        let item = &self.m.comps[comp].setup[ii];
        let Item::Cell {
            get,
            set,
            init,
            ctor,
            rest,
            ..
        } = item
        else {
            unreachable!()
        };
        if !CORE_ONLY.contains(&ctor.as_str()) && ctor != "createSignal" {
            return Err(format!("`{ctor}` cell in a compiled island"));
        }
        let gn = self.insts[inst].names[get].0.clone();
        let pat = match set {
            Some(s) => format!("[{gn}, {}]", self.insts[inst].names[s].0),
            None => format!("[{gn}]"),
        };
        let mut args = Vec::new();
        for e in rest {
            args.push(self.expr(inst, &none, e)?);
        }
        let first = match init {
            None => "undefined".to_string(),
            Some(e) if item.derived() => {
                let av = self.a.av_of(comp, &self.a.facts[comp].item_refs[ii]);
                if !av.reads.is_empty() {
                    return Err(format!(
                        "`{}` is computed from reactive state (its adoption would not subscribe)",
                        self.m.sym_name(*get)
                    ));
                }
                if !self.insts[inst].root {
                    return Err(format!(
                        "derived cell `{}` in a non-root island component",
                        self.m.sym_name(*get)
                    ));
                }
                let s = Serial::Cell(ii);
                if !self.serial.contains(&s) {
                    self.serial.push(s);
                }
                let f = self.expr(inst, &none, e)?;
                let v = self.fresh("$ad");
                let key = js_str(&format!("${}", self.m.sym_name(*get)));
                self.bucket(inst).setup.push(format!("let {v} = 1;"));
                format!("(($f) => (...a) => {v} ? ({v} = 0, $d[{key}]) : $f(...a))({f})")
            }
            Some(e) => {
                let r = &self.a.facts[comp].item_refs[ii];
                if self.evaluable(comp, r, 0) {
                    self.expr(inst, &none, e)?
                } else if self.insts[inst].root {
                    let s = Serial::Cell(ii);
                    if !self.serial.contains(&s) {
                        self.serial.push(s);
                    }
                    format!("$d[{}]", js_str(&format!("${}", self.m.sym_name(*get))))
                } else {
                    return Err(format!(
                        "cell `{}` initialized from server values in a non-root island component",
                        self.m.sym_name(*get)
                    ));
                }
            }
        };
        // `createSignal(fn)` (a derived signal) is the core's writable memo.
        let ctor = if ctor == "createSignal" {
            "createSignal"
        } else {
            ctor.as_str()
        };
        let callee = if ctor == "createSignal" {
            self.rt.insert("createSignal");
            "$S".to_string()
        } else {
            self.core.insert(ctor.to_string());
            format!("$${ctor}")
        };
        let mut all = vec![first];
        all.extend(args);
        Ok(format!("const {pat} = {callee}({});", all.join(", ")))
    }

    /// Element / property kinds of a literal provider value.
    fn literal_kinds(&self, inst: usize, v: &Expression<'a>) -> Vec<(Option<String>, Kind)> {
        let kind_of = |e: &Expression<'a>| -> Kind {
            self.m
                .symbol_of_expr(e)
                .and_then(|s| self.insts[inst].names.get(&s))
                .map_or(Kind::Unknown, |(_, k)| match k {
                    Kind::Acc => Kind::Acc,
                    Kind::Val => Kind::Val,
                    _ => Kind::Unknown,
                })
        };
        match v.without_parentheses() {
            Expression::ArrayExpression(a) => a
                .elements
                .iter()
                .map(|el| (None, el.as_expression().map_or(Kind::Unknown, kind_of)))
                .collect(),
            Expression::ObjectExpression(o) => o
                .properties
                .iter()
                .filter_map(|p| match p {
                    ObjectPropertyKind::ObjectProperty(p) => match &p.key {
                        PropertyKey::StaticIdentifier(k) => {
                            Some((Some(k.name.to_string()), kind_of(&p.value)))
                        }
                        _ => None,
                    },
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Accessors destructured from a literal provider value read statically.
    fn bind_context_kinds(
        &mut self,
        inst: usize,
        p: &BindingPattern<'a>,
        kinds: &[(Option<String>, Kind)],
    ) {
        let mut set = |id: &oxc_ast::ast::BindingIdentifier<'a>, k: &Kind| {
            if let Some(s) = id.symbol_id.get()
                && let Some(entry) = self.insts[inst].names.get_mut(&s)
                && matches!(k, Kind::Acc | Kind::Val)
            {
                entry.1 = k.clone();
            }
        };
        match p {
            BindingPattern::ArrayPattern(a) => {
                for (i, el) in a.elements.iter().enumerate() {
                    if let Some(BindingPattern::BindingIdentifier(id)) = el
                        && let Some((None, k)) = kinds.get(i)
                    {
                        set(id, k);
                    }
                }
            }
            BindingPattern::ObjectPattern(o) => {
                for prop in &o.properties {
                    if let (
                        PropertyKey::StaticIdentifier(key),
                        BindingPattern::BindingIdentifier(id),
                    ) = (&prop.key, &prop.value)
                        && let Some((_, k)) = kinds
                            .iter()
                            .find(|(n, _)| n.as_deref() == Some(key.name.as_str()))
                    {
                        set(id, k);
                    }
                }
            }
            _ => {}
        }
    }

    fn probe_callee(&self, item: usize, comp: usize) -> R<(String, Vec<SymbolId>)> {
        let Item::Cell { span, .. } = &self.m.comps[comp].setup[item] else {
            unreachable!()
        };
        // Find the call in the declaration text: `obj.method(`.
        let text = self.m.text(*span);
        for (o, p) in &self.m.probe_hosts {
            let callee = format!("{o}.{p}");
            if text.contains(&format!("{callee}(")) {
                let syms: Vec<SymbolId> = self
                    .m
                    .top
                    .iter()
                    .flat_map(|t| t.symbols.iter().copied())
                    .filter(|s| self.m.sym_name(*s) == o)
                    .collect();
                return Ok((callee, syms));
            }
        }
        Err("probe host not found".into())
    }

    /// A binding pattern with this instance's names.
    fn pattern(&self, inst: usize, p: &BindingPattern<'a>) -> R<String> {
        let mut edits: Vec<(Span, String)> = Vec::new();
        fn walk(
            ce: &Ce<'_, '_>,
            inst: usize,
            p: &BindingPattern<'_>,
            edits: &mut Vec<(Span, String)>,
        ) -> R<()> {
            match p {
                BindingPattern::BindingIdentifier(id) => {
                    if let Some(s) = id.symbol_id.get()
                        && let Some((n, _)) = ce.insts[inst].names.get(&s)
                        && n != id.name.as_str()
                    {
                        edits.push((id.span, n.clone()));
                    }
                }
                BindingPattern::ObjectPattern(o) => {
                    for prop in &o.properties {
                        if prop.shorthand
                            && let BindingPattern::BindingIdentifier(id) = &prop.value
                            && let Some(s) = id.symbol_id.get()
                            && let Some((n, _)) = ce.insts[inst].names.get(&s)
                            && n != id.name.as_str()
                        {
                            let key = match &prop.key {
                                PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                                _ => id.name.to_string(),
                            };
                            edits.push((prop.span, format!("{key}: {n}")));
                            continue;
                        }
                        walk(ce, inst, &prop.value, edits)?;
                    }
                    if let Some(r) = &o.rest {
                        walk(ce, inst, &r.argument, edits)?;
                    }
                }
                BindingPattern::ArrayPattern(a) => {
                    for el in a.elements.iter().flatten() {
                        walk(ce, inst, el, edits)?;
                    }
                    if let Some(r) = &a.rest {
                        walk(ce, inst, &r.argument, edits)?;
                    }
                }
                BindingPattern::AssignmentPattern(_) => {
                    return Err("default values in a context / local pattern".into());
                }
            }
            Ok(())
        }
        walk(self, inst, p, &mut edits)?;
        // Strip a type annotation (`const x: T = …`) — keep it, TS is fine.
        Ok(crate::store_scalars::splice(self.m.src, p.span(), edits))
    }

    // --- layout -----------------------------------------------------------------
    fn flatten_root(
        &mut self,
        e: &'a Expression<'a>,
        inst: usize,
        out: &mut Vec<Slot<'a>>,
    ) -> R<()> {
        match jsx::root_of(e) {
            Some(Root::Element(el)) => self.flatten_el(el, inst, out),
            Some(Root::Fragment(f)) => {
                let kids = jsx::children(&f.children)?;
                self.flatten(&kids, inst, out)
            }
            None => {
                let comp = self.insts[inst].comp;
                let live = self.a.is_live_site(comp, e.span().start);
                let mine = !self.site_other(comp, e.span().start, "a hole")?;
                out.push(Slot::Hole(e, inst, live, mine));
                Ok(())
            }
        }
    }

    fn flatten(&mut self, kids: &[Child<'a>], inst: usize, out: &mut Vec<Slot<'a>>) -> R<()> {
        for k in kids {
            match *k {
                Child::Text(_) => out.push(Slot::Text),
                Child::Expr(e) => {
                    if jsx::static_child(e).is_some() {
                        out.push(Slot::Text);
                        continue;
                    }
                    if self.is_slot(inst, e) {
                        match self.insts[inst].slot.clone() {
                            Some((ckids, cinst)) => {
                                if self.contains_group_sites(self.insts[cinst].comp, &ckids) {
                                    self.flatten(&ckids, cinst, out)?;
                                } else {
                                    let sh = self.shape_kids(&ckids, self.insts[cinst].comp, 0);
                                    out.push(Slot::Opaque(sh.0, sh.1));
                                }
                            }
                            None => out.push(Slot::Opaque(None, None)),
                        }
                        continue;
                    }
                    let comp = self.insts[inst].comp;
                    let live = self.in_fallback || self.a.is_live_site(comp, e.span().start);
                    let mine = !self.site_other(comp, e.span().start, "a hole")?;
                    let refs = super::graph::refs_expr(self.m, self.m.comps[comp].props, e);
                    if refs.has_jsx {
                        if live && mine {
                            return Err(
                                "a live expression producing JSX (use <Show> / <For>)".into()
                            );
                        }
                        out.push(Slot::Opaque(None, Some(usize::from(live))));
                        continue;
                    }
                    out.push(Slot::Hole(e, inst, live, mine));
                }
                Child::Element(el) => self.flatten_el(el, inst, out)?,
                Child::Fragment(f) => {
                    let kids = jsx::children(&f.children)?;
                    self.flatten(&kids, inst, out)?;
                }
            }
        }
        Ok(())
    }

    fn is_slot(&self, inst: usize, e: &Expression<'a>) -> bool {
        let props = self.m.comps[self.insts[inst].comp].props;
        if let Expression::StaticMemberExpression(me) = e.without_parentheses()
            && me.property.name == "children"
            && props.is_some()
            && self.m.symbol_of_expr(&me.object) == props
        {
            return true;
        }
        false
    }

    fn contains_group_sites(&self, comp: usize, kids: &[Child<'a>]) -> bool {
        let spans: Vec<Span> = kids.iter().map(|k| k.span()).collect();
        self.g.sites.iter().any(|(c, s)| {
            *c == comp && {
                let sp = self.a.facts[*c].sites[*s].span;
                spans.iter().any(|k| k.start <= sp.start && sp.end <= k.end)
            }
        })
    }

    fn span_has_group_sites(&self, comp: usize, span: Span) -> bool {
        self.g.sites.iter().any(|(c, s)| {
            *c == comp && {
                let sp = self.a.facts[*c].sites[*s].span;
                span.start <= sp.start && sp.end <= span.end
            }
        })
    }

    fn flatten_el(
        &mut self,
        el: &'a JSXElement<'a>,
        inst: usize,
        out: &mut Vec<Slot<'a>>,
    ) -> R<()> {
        let comp = self.insts[inst].comp;
        match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(_) => out.push(Slot::Elem(el, inst)),
            Tag::Builtin(b) if b == "Portal" => out.push(Slot::Portal(el, inst)),
            Tag::Builtin(b) if b == "Show" || b == "For" || b == "Switch" => {
                let attrs = jsx::attrs(el)?;
                let input = if b == "Show" { "when" } else { "each" };
                // The region's site: its input expression (a `Switch`'s
                // element).
                let key = if b == "Switch" {
                    Some(el.span.start)
                } else {
                    match jsx::attr(&attrs, input).map(|a| &a.value) {
                        Some(AttrVal::Expr(e)) => Some(e.span().start),
                        _ => None,
                    }
                };
                let (live, mine) = match key {
                    Some(k) => (
                        self.a.is_live_site(comp, k),
                        !self.site_other(comp, k, &format!("a <{b}>"))?,
                    ),
                    None => (false, true),
                };
                if live && !mine {
                    // Another island's region: its DOM is that island's. A
                    // site or member of this island inside it is a
                    // partition the union-find should have merged.
                    if self.span_has_group_sites(comp, el.span)
                        || jsx::children(&el.children).is_ok_and(|ks| self.kids_render_members(&ks))
                    {
                        return Err(format!(
                            "`{}`: island sites inside another island's <{b}> (not merged)",
                            self.m.comps[comp].name
                        ));
                    }
                    out.push(Slot::Opaque(None, Some(1)));
                } else if live {
                    out.push(Slot::Region(el, inst, true));
                } else if let Some(AttrVal::Expr(e)) = jsx::attr(&attrs, input).map(|a| &a.value)
                    && self.a.structural.get(&(comp, e.span().start)) == Some(&self.gi)
                {
                    out.push(Slot::Struct(el, inst));
                } else {
                    if self.span_has_group_sites(comp, el.span) {
                        return Err(format!("island sites inside a <{b}> over server values"));
                    }
                    let sh = self.shape_el(el, comp, 0);
                    out.push(Slot::Opaque(sh.0, sh.1));
                }
            }
            Tag::Builtin(b)
                if (b == "Errored" && self.t2 && self.boundary_live(comp, el))
                    || (b == "Loading"
                        && self.a.pending_boundaries.contains(&(comp, el.span.start))) =>
            {
                if !self.t2 {
                    return Err("a client pending boundary below tier 2".into());
                }
                // Its content activates inside a client error boundary: a
                // scope of its own (the members it renders set up there),
                // adopted or fresh as its enclosing scope is.
                let kids = jsx::children(&el.children)?;
                let saved = self.cur;
                let builder = self.scopes[self.cur].builder;
                self.scopes.push(Scope {
                    nav: vec![],
                    buckets: HashMap::new(),
                    order: vec![],
                    builder,
                });
                let bscope = self.scopes.len() - 1;
                self.cur = bscope;
                let mut inner = Vec::new();
                let r = self.flatten(&kids, inst, &mut inner);
                self.cur = saved;
                r?;
                let bi = self.bounds.len();
                self.bounds.push((bscope, inner));
                out.push(Slot::Boundary(el, inst, bi));
            }
            Tag::Builtin(b) if b == "Loading" || b == "Errored" => {
                let kids = jsx::children(&el.children)?;
                self.flatten(&kids, inst, out)?;
            }
            Tag::Builtin(b) => return Err(format!("<{b}> in an island")),
            Tag::Provider(ctx) => {
                let attrs = jsx::attrs(el)?;
                let kids = jsx::children(&el.children)?;
                if self.contains_group_sites(comp, &kids) || self.kids_render_members(&kids) {
                    let var = self.fresh("$c");
                    let none = HashMap::new();
                    let (value, kinds) = match jsx::attr(&attrs, "value").map(|a| &a.value) {
                        Some(AttrVal::Expr(v)) => {
                            (self.expr(inst, &none, v)?, self.literal_kinds(inst, v))
                        }
                        Some(AttrVal::Str(v)) => (js_str(v), Vec::new()),
                        Some(AttrVal::True) => ("true".into(), Vec::new()),
                        _ => return Err("context provider without a value expression".into()),
                    };
                    self.bucket(inst)
                        .seq
                        .push(Seq::Line(format!("const {var} = {value};")));
                    // The binding stays for the whole instance: its subtree is
                    // laid out lazily (one provider per context per component).
                    if self.insts[inst]
                        .ctx
                        .insert(ctx, CtxBind { var, kinds })
                        .is_some()
                    {
                        return Err("a context provided twice in one island component".into());
                    }
                    self.flatten(&kids, inst, out)?;
                } else {
                    self.flatten(&kids, inst, out)?;
                }
            }
            Tag::Comp(k) => {
                let is_member = self.g.members.contains(&k);
                let kids = jsx::children(&el.children)?;
                let other_root = self
                    .a
                    .root_of
                    .get(&k)
                    .is_some_and(|gs| gs.iter().any(|g| *g != self.gi));
                let fresh = self.scopes[self.cur].builder;
                if fresh || is_member || (self.contains_group_sites(comp, &kids) && !other_root) {
                    let child = self.instantiate(k, el, inst, kids)?;
                    let view = self.m.comps[k].view.ok_or("component without a view")?;
                    self.flatten_root(view, child, out)?;
                } else {
                    let sh = self.shape_comp(k, 0);
                    out.push(Slot::Opaque(sh.0, sh.1));
                }
            }
            Tag::Opaque(_) => {
                if self.span_has_group_sites(comp, el.span) {
                    return Err("island sites passed into a component outside the module".into());
                }
                out.push(Slot::Opaque(None, None));
            }
            Tag::Router => {
                if self.span_has_group_sites(comp, el.span) {
                    return Err("island sites inside a <Router> layout".into());
                }
                out.push(Slot::Opaque(None, None));
            }
        }
        Ok(())
    }

    fn kids_render_members(&self, kids: &[Child<'a>]) -> bool {
        kids.iter().any(|k| match k {
            Child::Element(el) => match jsx::tag_of(self.m, &el.opening_element.name) {
                Tag::Comp(c) => {
                    self.g.members.contains(&c)
                        || jsx::children(&el.children).is_ok_and(|ks| self.kids_render_members(&ks))
                }
                _ => jsx::children(&el.children).is_ok_and(|ks| self.kids_render_members(&ks)),
            },
            Child::Fragment(f) => {
                jsx::children(&f.children).is_ok_and(|ks| self.kids_render_members(&ks))
            }
            _ => false,
        })
    }

    /// Inline a component instance: bind its props to the caller's expressions.
    fn instantiate(
        &mut self,
        k: usize,
        el: &'a JSXElement<'a>,
        caller: usize,
        kids: Vec<Child<'a>>,
    ) -> R<usize> {
        let attrs = jsx::attrs(el)?;
        let id = self.insts.len();
        let suffix = format!("${id}");
        let mut props = HashMap::new();
        let none = HashMap::new();
        for at in &attrs {
            if at.name != "children" && !self.uses_prop(k, &at.name) {
                continue;
            }
            let b = match &at.value {
                AttrVal::True => PBind::Val("true".into()),
                AttrVal::Str(s) => PBind::Val(js_str(s)),
                AttrVal::Expr(e) => self.bind_prop(caller, e, &none)?,
                AttrVal::Element(_) | AttrVal::Fragment(_) => {
                    return Err("JSX-valued prop of an island component".into());
                }
            };
            props.insert(at.name.clone(), b);
        }
        let ctx = self.insts[caller].ctx.clone();
        self.insts.push(Inst {
            comp: k,
            names: HashMap::new(),
            props,
            slot: Some((kids, caller)),
            ctx,
            root: false,
            suffix,
        });
        // The child's code runs where it renders: after the caller's code so far.
        self.bucket(caller).seq.push(Seq::Inst(id));
        self.setup(id)?;
        Ok(id)
    }

    fn bind_prop(
        &mut self,
        caller: usize,
        e: &'a Expression<'a>,
        extra: &HashMap<SymbolId, (String, Kind)>,
    ) -> R<PBind> {
        let e = e.without_parentheses();
        if let Some(s) = self.m.symbol_of_expr(e) {
            let found = extra
                .get(&s)
                .cloned()
                .or_else(|| self.insts[caller].names.get(&s).cloned());
            if let Some((n, k)) = found {
                return Ok(match k {
                    Kind::Acc => PBind::Acc(n),
                    Kind::Cell0 | Kind::Set0(_) => {
                        return Err("tier-0 cell passed as a prop".into());
                    }
                    _ => PBind::Val(n),
                });
            }
        }
        if let Expression::StaticMemberExpression(me) = e
            && self.m.comps[self.insts[caller].comp].props.is_some()
            && self.m.symbol_of_expr(&me.object) == self.m.comps[self.insts[caller].comp].props
        {
            let env_prop = {
                let env = CEnv {
                    ce: self,
                    inst: caller,
                    extra,
                    uses: Default::default(),
                };
                let r = env.prop(me.property.name.as_str());
                let u = env.uses.into_inner();
                (r, u)
            };
            self.merge_uses(env_prop.1);
            return env_prop.0;
        }
        let text = self.translate(caller, extra, |tx, env| tx.expr(env, e))?;
        let reads = super::graph::refs_expr(self.m, self.m.comps[self.insts[caller].comp].props, e);
        let var = self.fresh("$p");
        // A read (`yield*`, a prop, or a value over a store — a row's
        // `item.v`) is a getter; anything else is evaluated once.
        let has_read = self.m.text(e.span()).contains("yield*")
            || !reads.props.is_empty()
            || !self
                .a
                .live_reads(self.insts[caller].comp, &reads)
                .0
                .is_empty();
        let line = if has_read {
            format!("const {var} = () => {text};")
        } else {
            format!("const {var} = {text};")
        };
        self.push_line(caller, line);
        Ok(if has_read {
            PBind::Get(var)
        } else {
            PBind::Val(var)
        })
    }

    fn push_line(&mut self, inst: usize, line: String) {
        self.bucket(inst).seq.push(Seq::Line(line));
    }

    // --- shapes (element count, top-level marker pairs) --------------------------------
    fn shape_comp(&mut self, k: usize, depth: u32) -> (Option<usize>, Option<usize>) {
        if let Some(s) = self.shapes.get(&k) {
            return *s;
        }
        if depth > 16 {
            return (None, None);
        }
        self.shapes.insert(k, (None, None));
        let s = match self.m.comps[k].view {
            Some(v) => match jsx::root_of(v) {
                Some(Root::Element(el)) => self.shape_el(el, k, depth + 1),
                Some(Root::Fragment(f)) => match jsx::children(&f.children) {
                    Ok(ks) => self.shape_kids(&ks, k, depth + 1),
                    Err(_) => (None, None),
                },
                None => (
                    Some(0),
                    if self.a.is_live_site(k, v.span().start) {
                        Some(1)
                    } else {
                        Some(0)
                    },
                ),
            },
            None => (None, None),
        };
        self.shapes.insert(k, s);
        s
    }

    fn shape_el(
        &mut self,
        el: &'a JSXElement<'a>,
        comp: usize,
        depth: u32,
    ) -> (Option<usize>, Option<usize>) {
        match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(_) => (Some(1), Some(0)),
            Tag::Comp(k) => self.shape_comp(k, depth),
            Tag::Builtin(b) if b == "Portal" => (Some(0), Some(0)),
            Tag::Builtin(b) if b == "Switch" => {
                if self.a.is_live_site(comp, el.span.start) {
                    (None, Some(1))
                } else {
                    // Inert: one branch's content, in place.
                    let mut pairs = Some(0);
                    if let Ok(ks) = jsx::children(&el.children) {
                        for k in &ks {
                            if let Child::Element(mel) = k
                                && let Ok(mk) = jsx::children(&mel.children)
                                && self.shape_kids(&mk, comp, depth + 1).1 != Some(0)
                            {
                                pairs = None;
                            }
                        }
                    }
                    (None, pairs)
                }
            }
            Tag::Builtin(b) if b == "Show" || b == "For" => {
                let live = jsx::attrs(el).ok().is_some_and(|attrs| {
                    matches!(jsx::attr(&attrs, if b == "Show" { "when" } else { "each" }).map(|a| &a.value),
                        Some(AttrVal::Expr(e)) if self.a.is_live_site(comp, e.span().start))
                });
                if live {
                    (None, Some(1))
                } else {
                    // Inert: its content has no top-level pairs unless a
                    // component inside renders some.
                    let inner = match jsx::children(&el.children) {
                        Ok(ks) => {
                            let mut pairs = Some(0);
                            for k in &ks {
                                if let Child::Element(e) = k {
                                    let s = self.shape_el(e, comp, depth + 1);
                                    if s.1 != Some(0) {
                                        pairs = None;
                                    }
                                }
                                if let Child::Expr(e) = k
                                    && let Some(f) = FnRef::from_expr(e)
                                    && let Some(r) = fn_root(f)
                                {
                                    let s = match r {
                                        Root::Element(x) => self.shape_el(x, comp, depth + 1),
                                        Root::Fragment(x) => match jsx::children(&x.children) {
                                            Ok(ks2) => self.shape_kids(&ks2, comp, depth + 1),
                                            Err(_) => (None, None),
                                        },
                                    };
                                    if s.1 != Some(0) {
                                        pairs = None;
                                    }
                                }
                            }
                            pairs
                        }
                        Err(_) => None,
                    };
                    (None, inner)
                }
            }
            Tag::Builtin(b) if b == "Loading" || b == "Errored" || b == "Show" => {
                match jsx::children(&el.children) {
                    Ok(ks) => self.shape_kids(&ks, comp, depth),
                    Err(_) => (None, None),
                }
            }
            Tag::Provider(_) => match jsx::children(&el.children) {
                Ok(ks) => self.shape_kids(&ks, comp, depth),
                Err(_) => (None, None),
            },
            _ => (None, None),
        }
    }

    fn shape_kids(
        &mut self,
        kids: &[Child<'a>],
        comp: usize,
        depth: u32,
    ) -> (Option<usize>, Option<usize>) {
        let (mut e, mut p) = (Some(0usize), Some(0usize));
        let add = |a: Option<usize>, b: Option<usize>| a.zip(b).map(|(x, y)| x + y);
        for k in kids {
            let s = match k {
                Child::Text(_) => (Some(0), Some(0)),
                Child::Expr(x) => {
                    if jsx::static_child(x).is_some() {
                        (Some(0), Some(0))
                    } else if let Expression::StaticMemberExpression(me) = x.without_parentheses()
                        && me.property.name == "children"
                    {
                        (None, None)
                    } else if super::graph::refs_expr(self.m, self.m.comps[comp].props, x).has_jsx {
                        (None, None)
                    } else {
                        (
                            Some(0),
                            Some(usize::from(self.a.is_live_site(comp, x.span().start))),
                        )
                    }
                }
                Child::Element(el) => self.shape_el(el, comp, depth),
                Child::Fragment(f) => match jsx::children(&f.children) {
                    Ok(ks) => self.shape_kids(&ks, comp, depth),
                    Err(_) => (None, None),
                },
            };
            e = add(e, s.0);
            p = add(p, s.1);
        }
        (e, p)
    }

    // --- emission over containers ----------------------------------------------------------
    /// (elements, top-level marker pairs) a slot adds to its container.
    fn contrib(&self, s: &Slot<'a>) -> (Option<usize>, Option<usize>) {
        match s {
            Slot::Elem(..) => (Some(1), Some(0)),
            Slot::Text => (Some(0), Some(0)),
            Slot::Hole(_, _, live, _) => (Some(0), Some(usize::from(*live))),
            Slot::Region(_, _, live) => (None, Some(usize::from(*live))),
            Slot::Struct(..) => (None, Some(1)),
            Slot::Opaque(e, p) => (*e, *p),
            Slot::Portal(..) => (Some(0), Some(0)),
            // Its content's elements, in place; one marker pair around it.
            Slot::Boundary(_, _, bi) => (
                self.bounds[*bi]
                    .1
                    .iter()
                    .try_fold(0usize, |acc, x| self.contrib(x).0.map(|e| acc + e)),
                Some(1),
            ),
        }
    }

    /// `parent`: the container element's var (None = the island root level).
    fn container(&mut self, parent: Option<String>, slots: &[Slot<'a>]) -> R<()> {
        self.container_at(parent, slots, 0, None, 0)
    }

    /// Inert-hole placeholders (`<!--!-->`, fresh content) a slot holds.
    fn placeholders(&self, s: &Slot<'a>) -> usize {
        match s {
            Slot::Hole(_, _, false, _) => 1,
            Slot::Boundary(_, _, bi) => self.bounds[*bi]
                .1
                .iter()
                .map(|x| self.placeholders(x))
                .sum(),
            _ => 0,
        }
    }

    /// Slots laid out in `parent` after `base` elements (and `ph_base`
    /// placeholders); marker pairs counted after the node `after` (a
    /// boundary's start marker) when given.
    fn container_at(
        &mut self,
        parent: Option<String>,
        slots: &[Slot<'a>],
        base: usize,
        after_node: Option<String>,
        ph_base: usize,
    ) -> R<()> {
        // Element indexes and pair indexes, from the start where possible.
        let n = slots.len();
        let contribs: Vec<(Option<usize>, Option<usize>)> =
            slots.iter().map(|s| self.contrib(s)).collect();
        let elems_in = |a: usize, b: usize| -> Option<usize> {
            contribs[a..b]
                .iter()
                .try_fold(0usize, |acc, c| c.0.map(|x| acc + x))
        };
        let pairs_in = |a: usize, b: usize| -> Option<usize> {
            contribs[a..b]
                .iter()
                .try_fold(0usize, |acc, c| c.1.map(|x| acc + x))
        };
        let nested = base > 0 || after_node.is_some();
        let sole =
            parent.is_some() && !nested && slots.len() == 1 && matches!(slots[0], Slot::Hole(..));
        // The last element variable at a known index: the next one chains
        // from it (`prev.nextElementSibling`) instead of walking from the parent.
        let mut last: Option<(usize, String)> = None;
        for i in 0..n {
            let slot = slots[i];
            match slot {
                Slot::Elem(el, inst) => {
                    // Needed? Only if it (or its subtree) has group work.
                    if !self.elem_needed(el, inst) {
                        continue;
                    }
                    let before = elems_in(0, i).map(|b| b + base);
                    // Inside a boundary the container's end is not known here.
                    let after = if nested { None } else { elems_in(i + 1, n) };
                    let var = self.fresh("$n");
                    let nav = match (&parent, before, after) {
                        (None, Some(b), _) => {
                            if !self.element_anchor {
                                // A comment anchor precedes the root's nodes.
                                format!("$a{}", ".nextElementSibling".repeat(b + 1))
                            } else if b == 0 {
                                "$a".to_string()
                            } else {
                                format!("$a{}", ".nextElementSibling".repeat(b))
                            }
                        }
                        (Some(p), Some(b), _) => {
                            if b == 0 {
                                format!("{p}.firstElementChild")
                            } else if let Some((lb, lv)) =
                                last.as_ref().filter(|(lb, _)| *lb < b && b - lb < 3)
                            {
                                format!("{lv}{}", ".nextElementSibling".repeat(b - lb))
                            } else if b < 3 {
                                format!("{p}.firstElementChild{}", ".nextElementSibling".repeat(b))
                            } else {
                                format!("{p}.children[{b}]")
                            }
                        }
                        (Some(p), None, Some(af)) => {
                            format!(
                                "{p}.lastElementChild{}",
                                ".previousElementSibling".repeat(af)
                            )
                        }
                        _ => {
                            return Err(
                                "an island element after a variable-size region with no fixed path"
                                    .into(),
                            );
                        }
                    };
                    if parent.is_none() && before != Some(0) {
                        // Handlers outside the anchor element cannot be found
                        // by the loader: activate such islands eagerly.
                        if self.subtree_has_handlers(el, inst) {
                            self.lazy_ok = false;
                        }
                    }
                    if !self.scopes[self.cur].builder {
                        let what = self.describe(el, inst);
                        let target = if nav == "$a" {
                            "$a".to_string()
                        } else {
                            var.clone()
                        };
                        self.checks.push((target, what, nav.clone()));
                    }
                    if nav == "$a" {
                        // The anchor element itself.
                        self.element(el, inst, "$a")?;
                        continue;
                    }
                    let decl = format!("const {var} = {nav};");
                    self.scope_nav(decl);
                    if let (Some(_), Some(b)) = (&parent, before) {
                        last = Some((b, var.clone()));
                    }
                    self.element(el, inst, &var)?;
                }
                Slot::Hole(e, inst, live, mine) => {
                    if live && !mine {
                        // Another island's hole (its marker pair is counted).
                    } else if sole {
                        let el_var = parent.clone().unwrap();
                        self.text_hole(e, inst, live, TextTarget::Sole(el_var))?;
                    } else if live {
                        let k = pairs_in(0, i).ok_or("a live hole after a variable region")?;
                        let end = self.marker_at(&parent, k, &after_node);
                        self.text_hole(e, inst, true, TextTarget::Pair(end))?;
                    } else if self.scopes[self.cur].builder {
                        // Inert hole in fresh content: a placeholder.
                        let k = ph_base
                            + slots[..i]
                                .iter()
                                .map(|s| self.placeholders(s))
                                .sum::<usize>();
                        let p = parent
                            .clone()
                            .ok_or("inert hole at a builder's root level")?;
                        self.helpers.insert("$pk");
                        self.text_hole(e, inst, false, TextTarget::Placeholder(p, k))?;
                    }
                }
                Slot::Region(el, inst, _) => {
                    let k = pairs_in(0, i).ok_or("a region after a variable region")?;
                    let end = self.marker_at(&parent, k, &after_node);
                    self.region(el, inst, end)?;
                }
                Slot::Struct(el, inst) => {
                    let k = pairs_in(0, i).ok_or("a region after a variable region")?;
                    let end = self.marker_at(&parent, k, &after_node);
                    let before = elems_in(0, i).map(|b| b + base);
                    self.structure(el, inst, end, parent.clone(), before)?;
                }
                Slot::Boundary(el, inst, bi) => {
                    let k = pairs_in(0, i).ok_or("a boundary after a variable region")?;
                    let before =
                        elems_in(0, i).ok_or("a boundary after a variable-size region")? + base;
                    let end = if parent.is_none()
                        && after_node.is_none()
                        && before == 0
                        && self.element_anchor
                    {
                        // The boundary encloses the anchor element: its end is
                        // the first unbalanced end marker after the anchor.
                        self.helpers.insert("$mke");
                        let var = self.fresh("$m");
                        self.scope_nav(format!("const {var} = $mke($a);"));
                        if !self.scopes[self.cur].builder {
                            self.checks.push((
                                var.clone(),
                                "<!--/--> (the <Errored> region's end)".into(),
                                "$mke($a)".into(),
                            ));
                        }
                        var
                    } else {
                        self.marker_at(&parent, k, &after_node)
                    };
                    let (bscope, inner) = self.bounds[bi].clone();
                    let saved = self.cur;
                    self.cur = bscope;
                    let start = self.fresh("$bs");
                    self.helpers.insert("$start");
                    self.scope_nav(format!("const {start} = $start({end});"));
                    let ph = ph_base
                        + slots[..i]
                            .iter()
                            .map(|s| self.placeholders(s))
                            .sum::<usize>();
                    let r = self.container_at(parent.clone(), &inner, before, Some(start), ph);
                    self.cur = saved;
                    r?;
                    self.boundary(el, inst, bscope, end)?;
                }
                Slot::Portal(el, inst) => self.portal(el, inst)?,
                Slot::Text | Slot::Opaque(..) => {}
            }
        }
        Ok(())
    }

    /// A live hole or attribute this island binds: its site is in the
    /// group (or any, inside a client-built fallback).
    fn site_live(&self, comp: usize, start: u32) -> bool {
        self.in_fallback || self.site_group(comp, start) == Some(self.gi)
    }

    /// The group of the live site at `start` in `comp` (None: inert).
    fn site_group(&self, comp: usize, start: u32) -> Option<usize> {
        let si = *self.a.facts[comp].site_at.get(&start)?;
        self.a.group_of_site.get(&(comp, si)).copied()
    }

    /// A live site of another island. The partitioner keeps such a site
    /// out of this island's code; inside content this island creates
    /// (fresh region rows, a client-built fallback) it would have to be
    /// computed here, over the other island's cells: refused.
    fn site_other(&self, comp: usize, start: u32, what: &str) -> R<bool> {
        let other = matches!(self.site_group(comp, start), Some(g) if g != self.gi);
        if other && (self.scopes[self.cur].builder || self.in_fallback) {
            return Err(format!(
                "`{}`: {what} of another island inside content this island creates",
                self.m.comps[comp].name
            ));
        }
        Ok(other)
    }

    /// An `<Errored>` over live content whose sites belong to this group
    /// (the server marks its region with a marker pair for it).
    fn boundary_live(&self, comp: usize, el: &'a JSXElement<'a>) -> bool {
        self.span_has_group_sites(comp, el.span)
            || jsx::children(&el.children).is_ok_and(|ks| self.kids_render_members(&ks))
    }

    /// Emit a client error boundary: its content's activation (the scope's
    /// code) runs inside it; the fallback is built on the client.
    fn boundary(
        &mut self,
        el: &'a JSXElement<'a>,
        inst: usize,
        bscope: usize,
        end: String,
    ) -> R<()> {
        let nav = self.scopes[bscope].nav.join("\n");
        let body = self.assemble(bscope, inst);
        // Code that landed in other instances' buckets of this scope.
        let order = self.scopes[bscope].order.clone();
        let mut rest = String::new();
        for i in order {
            rest.push_str(&self.assemble(bscope, i));
        }
        let fb = self.error_fallback(el, inst)?;
        let loading = matches!(jsx::tag_of(self.m, &el.opening_element.name), Tag::Builtin(ref b) if b == "Loading");
        let (helper, ctor) = if loading {
            ("$ld", "createLoadingBoundary")
        } else {
            ("$err", "createErrorBoundary")
        };
        self.helpers.insert(helper);
        self.core.insert(ctor.into());
        self.rt.insert("untrack");
        self.bucket(inst).seq.push(Seq::Line(format!(
            "{helper}({end}, () => {{\n{nav}\n{body}{rest}}}, {fb});"
        )));
        Ok(())
    }

    /// The `<Errored>` fallback as a client builder `(err, reset) => node`.
    fn error_fallback(&mut self, el: &'a JSXElement<'a>, inst: usize) -> R<String> {
        let attrs = jsx::attrs(el)?;
        let (root, params): (&'a JSXElement<'a>, Vec<(SymbolId, Kind)>) =
            match jsx::attr(&attrs, "fallback").map(|a| &a.value) {
                None => return Ok("() => document.createTextNode(\"\")".into()),
                Some(AttrVal::Element(e)) => (*e, Vec::new()),
                Some(AttrVal::Str(s)) => {
                    return Ok(format!("() => document.createTextNode({})", js_str(s)));
                }
                Some(AttrVal::Expr(e)) if matches!(jsx::root_of(e), Some(Root::Element(_))) => {
                    let Some(Root::Element(r)) = jsx::root_of(e) else {
                        unreachable!()
                    };
                    (r, Vec::new())
                }
                Some(AttrVal::Expr(e)) => {
                    let Some(f) = FnRef::from_expr(e) else {
                        return Err(
                            "a boundary fallback that is not JSX or a render callback".into()
                        );
                    };
                    let Some(Root::Element(r)) = fn_root(f) else {
                        return Err("an <Errored> fallback callback must return one element".into());
                    };
                    let mut ps = Vec::new();
                    for (i, p) in f.params().items.iter().enumerate() {
                        let BindingPattern::BindingIdentifier(id) = &p.pattern else {
                            return Err(
                                "an <Errored> fallback with a destructured parameter".into()
                            );
                        };
                        let Some(sym) = id.symbol_id.get() else {
                            continue;
                        };
                        ps.push((sym, if i == 0 { Kind::Acc } else { Kind::Val }));
                    }
                    (r, ps)
                }
                _ => {
                    return Err("an <Errored> fallback that is not JSX or a render callback".into());
                }
            };
        if !matches!(
            jsx::tag_of(self.m, &root.opening_element.name),
            Tag::Intrinsic(_)
        ) {
            return Err("an <Errored> fallback whose root is not an element".into());
        }
        let mut names = Vec::new();
        for (sym, kind) in &params {
            let n = format!("{}{}", self.m.sym_name(*sym), self.fresh("$"));
            self.insts[inst]
                .names
                .insert(*sym, (n.clone(), kind.clone()));
            names.push(n);
        }
        while names.len() < 2 {
            names.push(format!("$_{}", names.len()));
        }
        let saved = self.cur;
        self.scopes.push(Scope {
            nav: vec![],
            buckets: HashMap::new(),
            order: vec![],
            builder: true,
        });
        self.cur = self.scopes.len() - 1;
        let comp = self.insts[inst].comp;
        let was = std::mem::replace(&mut self.in_fallback, true);
        let r = (|| -> R<(usize, String, String)> {
            let ti = self.push_template(root, comp)?;
            self.element(root, inst, "$x")?;
            let body = self.assemble(self.cur, inst);
            let nav = self.scopes[self.cur].nav.join("\n");
            Ok((ti, nav, body))
        })();
        self.in_fallback = was;
        self.cur = saved;
        let (ti, nav, body) = r?;
        Ok(format!(
            "({}, {}) => {{ const $f = 1, $x = $t{ti}();\n{nav}\n{body}\nreturn $x; }}",
            names[0], names[1]
        ))
    }

    fn scope_nav(&mut self, line: String) {
        self.scopes[self.cur].nav.push(line);
    }

    /// The k-th top-level pair's end marker in `parent`, or among the
    /// siblings after `after` (a boundary's start marker).
    fn marker_at(&mut self, parent: &Option<String>, k: usize, after: &Option<String>) -> String {
        self.helpers.insert("$mk");
        let var = self.fresh("$m");
        let nav = match (parent, after) {
            (_, Some(a)) => format!("$mk(null, {k}, {a})"),
            (Some(p), None) => format!("$mk({p}, {k})"),
            (None, None) => format!("$mk(null, {k}, $a)"),
        };
        if !self.scopes[self.cur].builder {
            self.checks.push((
                var.clone(),
                format!("<!--/--> (live region or hole #{k})"),
                nav.clone(),
            ));
        }
        self.scope_nav(format!("const {var} = {nav};"));
        var
    }

    /// `<tag> (Component, line N)` for the dev verifier's messages.
    fn describe(&self, el: &JSXElement<'a>, inst: usize) -> String {
        let tag = match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(t) => t,
            _ => "?".into(),
        };
        let line = self.m.src[..el.span.start as usize].matches('\n').count() + 1;
        format!(
            "<{tag}> ({}, line {line})",
            self.m.comps[self.insts[inst].comp].name
        )
    }

    fn subtree_has_handlers(&self, el: &'a JSXElement<'a>, inst: usize) -> bool {
        let comp = self.insts[inst].comp;
        self.g.sites.iter().any(|(c, s)| {
            *c == comp
                && matches!(self.a.facts[*c].sites[*s].kind, SiteKind::Handler(_))
                && el.span.start <= self.a.facts[*c].sites[*s].span.start
                && self.a.facts[*c].sites[*s].span.end <= el.span.end
        }) || self.g.members.iter().any(|m| *m != comp)
    }

    fn elem_needed(&self, el: &'a JSXElement<'a>, inst: usize) -> bool {
        if self.scopes[self.cur].builder {
            return true;
        }
        let comp = self.insts[inst].comp;
        if self.span_has_group_sites(comp, el.span) {
            return true;
        }
        // A structural region of this island inside (its rows' members).
        if self.a.structural.iter().any(|((c, at), g)| {
            *c == comp && *g == self.gi && el.span.start <= *at && *at < el.span.end
        }) {
            return true;
        }
        // Inlined members rendered inside (through components or slots).
        match jsx::children(&el.children) {
            Ok(ks) => self.kids_render_members(&ks) || self.kids_have_member_slot(inst, &ks),
            Err(_) => true,
        }
    }

    fn kids_have_member_slot(&self, inst: usize, kids: &[Child<'a>]) -> bool {
        kids.iter().any(|k| match k {
            Child::Expr(e) if self.is_slot(inst, e) => match &self.insts[inst].slot {
                Some((ck, ci)) => {
                    self.contains_group_sites(self.insts[*ci].comp, ck)
                        || self.kids_render_members(ck)
                }
                None => false,
            },
            Child::Element(el) => match jsx::children(&el.children) {
                Ok(ks) => self.kids_have_member_slot(inst, &ks),
                Err(_) => false,
            },
            _ => false,
        })
    }

    fn element(&mut self, el: &'a JSXElement<'a>, inst: usize, var: &str) -> R<()> {
        let comp = self.insts[inst].comp;
        let tag = match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(t) => t,
            _ => unreachable!(),
        };
        let attrs = jsx::attrs(el)?;
        let fresh = self.scopes[self.cur].builder;
        let ns = self.ns_of(&tag);
        let none = HashMap::new();
        // An island frame's region: the driver refetches it when the server
        // call's arguments change (its content is server HTML: not walked).
        if let Some(&si) = self.a.facts[comp].site_at.get(&el.span.start)
            && let SiteKind::Frame(fi) = self.a.facts[comp].sites[si].kind
            && self.a.group_of_site.get(&(comp, si)) == Some(&self.gi)
        {
            if fresh {
                return Err("an island frame inside content the island creates".into());
            }
            self.frame_driver(inst, fi, var)?;
            return Ok(());
        }
        // `ref` first (the DOM compiler runs it ahead of the element's other
        // expressions): a setup local is assigned, anything else is called.
        // Only this island's refs (another island rooted in the same
        // component binds its own).
        for at in &attrs {
            if at.name != "ref" {
                continue;
            }
            let AttrVal::Expr(e) = &at.value else {
                continue;
            };
            if self.site_other(comp, e.span().start, "a ref")? {
                continue;
            }
            self.helpers.insert("$ref");
            let v = self.expr(inst, &none, e)?;
            let lval = matches!(
                e.without_parentheses(),
                Expression::Identifier(_) | Expression::StaticMemberExpression(_)
            ) && super::graph::ref_target(self.m, &self.m.comps[comp], e).is_some();
            let line = if lval {
                format!("typeof {v} === \"function\" ? $ref({v}, {var}) : ({v} = {var});")
            } else {
                format!("$ref({v}, {var});")
            };
            self.bucket(inst).handlers.push(line);
        }
        for at in &attrs {
            let AttrVal::Expr(e) = &at.value else {
                continue;
            };
            if jsx::is_event_attr(&at.name) {
                if self.site_other(comp, e.span().start, "a handler")? {
                    continue;
                }
                let h = self.expr(inst, &none, e)?;
                let ev = jsx::event_name(&at.name);
                // Solid's delegated events are delegated (one page-level
                // listener per event type, `$dg`): a click reaching nested
                // islands runs all their handlers in one listener, so the
                // page flushes once. Other events (non-bubbling ones among
                // them) keep a listener on the element, as in Solid.
                let line = if crate::shared::constants::delegated_events(&ev) {
                    self.helpers.insert("$dg");
                    let line = format!("{var}.$${ev} = {h};");
                    self.events.insert(ev);
                    line
                } else {
                    format!("{var}.addEventListener({}, {h});", js_str(&ev))
                };
                self.bucket(inst).handlers.push(line);
                continue;
            }
            if jsx::static_child(e).is_some() || at.name == "ref" {
                continue;
            }
            if self.site_other(comp, e.span().start, "an attribute")? {
                continue;
            }
            let live = self.site_live(comp, e.span().start);
            if !live && !fresh {
                continue;
            }
            self.attr_parts(&tag, &at.name, e, inst, var, live, ns)?;
        }
        let kids = jsx::children(&el.children)?;
        let saved_ns = self.ns;
        self.ns = if tag == "foreignObject" { 0 } else { ns };
        let r = (|| {
            let mut slots = Vec::new();
            self.flatten(&kids, inst, &mut slots)?;
            self.container(Some(var.to_string()), &slots)
        })();
        self.ns = saved_ns;
        r
    }

    /// An island frame's driver: computes the server call's arguments (the
    /// memo's statements before its `attempt`) and, when they change,
    /// refetches the region through the lazily loaded frames applier.
    fn frame_driver(&mut self, inst: usize, fi: usize, var: &str) -> R<()> {
        let fr = &self.a.frames[fi];
        let none = HashMap::new();
        let mut body = String::new();
        for s in fr.pre.clone() {
            let t = self.translate(inst, &none, |tx, env| tx.stmt(env, s))?;
            body.push_str(&t);
            body.push('\n');
        }
        let mut args = Vec::new();
        for e in fr.call_args.clone() {
            args.push(self.expr(inst, &none, e)?);
        }
        let compute = format!("() => {{\n{body}return JSON.stringify([{}]);\n}}", args.join(", "));
        let comp = self.insts[inst].comp;
        let site = fr.site.ok_or("frame driver site")?;
        let r = self.a.facts[comp].sites[site].refs.clone();
        let cells = self.cells_of_refs(inst, &r);
        // The region and its arguments, named: handlers that refresh the
        // frame use them too.
        self.bucket(inst)
            .seq
            .push(Seq::Line(format!("const $fe{fi} = {var}, $fa{fi} = {compute};")));
        if fr.drivers.is_empty() {
            // Nothing on the client changes its arguments: only refreshes.
            return Ok(());
        }
        self.frame_driver = true;
        let line = if self.tier == 0 {
            format!(
                "$hole([{}], $fa{fi}, v => {{ $frame($fe{fi}, v); }});",
                cells.iter().cloned().collect::<Vec<_>>().join(", ")
            )
        } else {
            format!(
                "{{ let $k = 1; $E($fa{fi}, v => {{ if ($k) {{ $k = 0; return; }} $frame($fe{fi}, v); }}); }}"
            )
        };
        self.bucket(inst).seq.push(Seq::Line(line));
        Ok(())
    }

    /// Is frame `fi`'s driver site in this island?
    fn frame_in_group(&self, fi: usize) -> bool {
        let fr = &self.a.frames[fi];
        fr.site
            .is_some_and(|s| self.a.group_of_site.get(&(fr.comp, s)) == Some(&self.gi))
    }

    fn cells_of(&self, inst: usize, e: &Expression<'a>) -> BTreeSet<String> {
        let comp = self.insts[inst].comp;
        let r = super::graph::refs_expr(self.m, self.m.comps[comp].props, e);
        self.cells_of_refs(inst, &r)
    }

    fn cells_of_refs(&self, inst: usize, r: &super::graph::Refs) -> BTreeSet<String> {
        let comp = self.insts[inst].comp;
        let (keys, _) = self.a.live_reads(comp, r);
        keys.iter()
            .filter_map(|k| match &self.m.comps[k.0].setup[k.1] {
                Item::Cell { get, .. } => self
                    .insts
                    .iter()
                    .find(|i| i.comp == k.0)
                    .and_then(|i| i.names.get(get))
                    .map(|x| x.0.clone()),
                _ => None,
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn attr_parts(
        &mut self,
        tag: &str,
        name: &str,
        e: &'a Expression<'a>,
        inst: usize,
        var: &str,
        live: bool,
        ns: u8,
    ) -> R<()> {
        let none = HashMap::new();
        let cells = self.cells_of(inst, e);
        let env = live && self.a.is_env_site(self.insts[inst].comp, e.span().start);
        let push = |ce: &mut Self, compute: String, apply: String| {
            ce.bucket(inst).attrs.push(AttrPart {
                compute,
                apply,
                cells: cells.clone(),
                live,
                env,
            });
        };
        if name == "class" {
            // Literal arrays / objects: per-key toggles (static tokens are in
            // the markup already).
            let mut keyed: Vec<(String, &'a Expression<'a>)> = Vec::new();
            let mut ok = true;
            let collect = |o: &'a oxc_ast::ast::ObjectExpression<'a>,
                           keyed: &mut Vec<(String, &'a Expression<'a>)>|
             -> bool {
                for p in &o.properties {
                    let ObjectPropertyKind::ObjectProperty(p) = p else {
                        return false;
                    };
                    let key = match &p.key {
                        PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                        PropertyKey::StringLiteral(s) => s.value.to_string(),
                        _ => return false,
                    };
                    if p.computed {
                        return false;
                    }
                    keyed.push((key, &p.value));
                }
                true
            };
            match e.without_parentheses() {
                Expression::ObjectExpression(o) => ok = collect(o, &mut keyed),
                Expression::ArrayExpression(arr) => {
                    for el in &arr.elements {
                        match el.as_expression().map(|x| x.without_parentheses()) {
                            Some(Expression::StringLiteral(_)) => {}
                            Some(Expression::ObjectExpression(o)) => ok &= collect(o, &mut keyed),
                            _ => ok = false,
                        }
                    }
                }
                _ => ok = false,
            }
            if ok {
                for (key, v) in keyed {
                    let c = self.expr(inst, &none, v)?;
                    for token in key.split_whitespace() {
                        push(
                            self,
                            format!("!!({c})"),
                            format!("{var}.classList.toggle({}, v)", js_str(token)),
                        );
                    }
                }
                return Ok(());
            }
            self.helpers.insert("$cls");
            let c = self.expr(inst, &none, e)?;
            // An SVG / MathML element's `className` is not a string.
            let apply = if ns == 0 {
                format!("{var}.className = v")
            } else {
                format!("{var}.setAttribute(\"class\", v)")
            };
            push(self, format!("$cls({c})"), apply);
            return Ok(());
        }
        if name == "style" {
            if let Expression::ObjectExpression(o) = e.without_parentheses() {
                let mut all = true;
                let mut parts = Vec::new();
                for p in &o.properties {
                    let ObjectPropertyKind::ObjectProperty(p) = p else {
                        all = false;
                        break;
                    };
                    let key = match &p.key {
                        PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                        PropertyKey::StringLiteral(s) => s.value.to_string(),
                        _ => {
                            all = false;
                            break;
                        }
                    };
                    parts.push((key, &p.value));
                }
                if all {
                    for (key, v) in parts {
                        let c = self.expr(inst, &none, v)?;
                        let apply = if is_stringy(v) {
                            format!("{var}.style.setProperty({k}, v)", k = js_str(&key))
                        } else {
                            format!(
                                "v != null ? {var}.style.setProperty({k}, v) : {var}.style.removeProperty({k})",
                                k = js_str(&key)
                            )
                        };
                        push(self, c, apply);
                    }
                    return Ok(());
                }
            }
            return Err("a non-literal `style` object in an island".into());
        }
        let c = self.expr(inst, &none, e)?;
        if ns == 0 && is_prop_attr(tag, name) {
            push(self, c, format!("{var}.{name} = v"));
        } else if let Some(local) = name.strip_prefix("xlink:") {
            let xl = js_str("http://www.w3.org/1999/xlink");
            push(
                self,
                c,
                format!(
                    "v == null || v === false ? {var}.removeAttributeNS({xl}, {l}) : {var}.setAttributeNS({xl}, {n}, v)",
                    l = js_str(local),
                    n = js_str(name)
                ),
            );
        } else {
            let n = js_str(name);
            push(
                self,
                c,
                format!(
                    "v == null || v === false ? {var}.removeAttribute({n}) : {var}.setAttribute({n}, v === true ? \"\" : v)"
                ),
            );
        }
        Ok(())
    }

    fn text_hole(
        &mut self,
        e: &'a Expression<'a>,
        inst: usize,
        live: bool,
        target: TextTarget,
    ) -> R<()> {
        let none = HashMap::new();
        // Static text on adopted markup is never touched: not translated
        // either, so what it reads (a prop) is not serialized for nothing.
        if !live && !self.scopes[self.cur].builder {
            return Ok(());
        }
        let c = self.expr(inst, &none, e)?;
        // A value that is always a string needs no text coercion.
        let s = if is_stringy(e) {
            "v".to_string()
        } else {
            self.helpers.insert("$s");
            "$s(v)".to_string()
        };
        let apply = match &target {
            TextTarget::Sole(el) => format!("{el}.textContent = {s}"),
            TextTarget::Pair(end) => {
                self.helpers.insert("$tx");
                format!("$tx({end}, v)")
            }
            TextTarget::Placeholder(p, k) => format!("$pk({p}, {k}).replaceWith({s})"),
        };
        let fresh = self.scopes[self.cur].builder;
        if !live {
            // Fresh content only: computed once.
            if fresh {
                let line = format!("if ($f) {{ const v = {c}; {apply}; }}");
                self.bucket(inst).seq.push(Seq::Line(line));
            }
            return Ok(());
        }
        let cells = self.cells_of(inst, e);
        // A client-environment read: the server's text is only the first
        // paint, so activation computes and writes it.
        let env = self.a.is_env_site(self.insts[inst].comp, e.span().start);
        if self.tier == 0 && env {
            let line = format!(
                "{{ const $h = () => {c}, $p = v => {{ {apply}; }}; $p($h()); $hole([{}], $h, $p); }}",
                cells.iter().cloned().collect::<Vec<_>>().join(", ")
            );
            self.bucket(inst).seq.push(Seq::Line(line));
        } else if self.tier == 0 {
            let line = format!(
                "$hole([{}], () => {c}, v => {{ {apply}; }});",
                cells.iter().cloned().collect::<Vec<_>>().join(", ")
            );
            self.bucket(inst).seq.push(Seq::Line(line));
        } else {
            let skip = if env {
                "0"
            } else if fresh {
                "$f ? 0 : 1"
            } else if self.opts.keyed_state {
                "$st ? 0 : 1"
            } else {
                "1"
            };
            let line = format!(
                "{{ let $k = {skip}; $E(() => {c}, v => {{ if ($k) {{ $k = 0; return; }} {apply}; }}); }}"
            );
            self.bucket(inst).seq.push(Seq::Line(line));
        }
        Ok(())
    }

    /// A `Show` / `Match` branch's content: its markup children, or its
    /// render callback's markup (the parameter is the `when` accessor).
    fn branch_content(
        &self,
        attrs: &[jsx::Attr<'a>],
        kids: Vec<Child<'a>>,
        what: &str,
    ) -> R<(Vec<Child<'a>>, Option<SymbolId>)> {
        match kids.as_slice() {
            [Child::Expr(e)] if FnRef::from_expr(e).is_some() => {
                if jsx::attr(attrs, "keyed").is_some() {
                    return Err(format!("a live keyed <{what}> with a render callback"));
                }
                let f = FnRef::from_expr(e).unwrap();
                let p = f.params().items.first().and_then(|p| match &p.pattern {
                    BindingPattern::BindingIdentifier(id) => id.symbol_id.get(),
                    _ => None,
                });
                let Some(root) = fn_root(f) else {
                    return Err(format!("a live <{what}> render callback must return JSX"));
                };
                let child = match root {
                    Root::Element(e) => Child::Element(e),
                    Root::Fragment(fr) => Child::Fragment(fr),
                };
                Ok((vec![child], p))
            }
            _ if kids
                .iter()
                .any(|k| matches!(k, Child::Expr(e) if FnRef::from_expr(e).is_some())) =>
            {
                Err(format!(
                    "a live <{what}> with a render callback among other children"
                ))
            }
            _ => Ok((kids, None)),
        }
    }

    /// A live region's fallback: built on the client from its JSX (or its
    /// text) when the region empties, adopted at activation when the server
    /// showed it.
    fn region_fallback(
        &mut self,
        attrs: &[jsx::Attr<'a>],
        inst: usize,
        head: &str,
    ) -> R<Option<String>> {
        Ok(match jsx::attr(attrs, "fallback").map(|a| &a.value) {
            None => None,
            Some(AttrVal::Expr(e))
                if matches!(e.without_parentheses(), Expression::NullLiteral(_))
                    || matches!(e.without_parentheses(), Expression::Identifier(id) if id.name == "undefined") =>
            {
                None
            }
            Some(v) => {
                let not_markup =
                    "a live <Show>/<For>/<Switch> fallback that is not an element or a string";
                Some(match v {
                    AttrVal::Str(t) => {
                        format!("{head} => $e || document.createTextNode({})", js_str(t))
                    }
                    AttrVal::Element(e) => self.builder(vec![Child::Element(e)], inst, head)?,
                    AttrVal::Expr(e) => match jsx::root_of(e) {
                        Some(Root::Element(x)) => {
                            self.builder(vec![Child::Element(x)], inst, head)?
                        }
                        _ => return Err(not_markup.into()),
                    },
                    _ => return Err(not_markup.into()),
                })
            }
        })
    }

    /// A render parameter's client name, bound in the instance.
    fn bind_param(&mut self, inst: usize, p: Option<SymbolId>, kind: Kind) -> Option<String> {
        p.map(|p| {
            let n = format!("{}{}", self.m.sym_name(p), self.fresh("$"));
            self.insts[inst].names.insert(p, (n.clone(), kind));
            n
        })
    }

    /// A live `<Switch>`: one region showing the first `<Match>` whose `when`
    /// holds (adopted at activation, rebuilt when the choice changes).
    fn switch_region(&mut self, el: &'a JSXElement<'a>, inst: usize, end: String) -> R<()> {
        let attrs = jsx::attrs(el)?;
        let none = HashMap::new();
        let mut whens = Vec::new();
        let mut builders = Vec::new();
        let saved_stmt = std::mem::replace(&mut self.stmt_in_region, false);
        for k in jsx::children(&el.children)? {
            let Child::Element(mel) = k else {
                return Err("a <Switch> child other than a <Match>".into());
            };
            let mattrs = jsx::attrs(mel)?;
            let Some(AttrVal::Expr(we)) = jsx::attr(&mattrs, "when").map(|a| &a.value) else {
                return Err("<Match> without `when`".into());
            };
            whens.push(format!("() => {}", self.expr(inst, &none, we)?));
            let kids = jsx::children(&mel.children)?;
            let (content, param) = self.branch_content(&mattrs, kids, "Match")?;
            let head = match self.bind_param(inst, param, Kind::Acc) {
                Some(n) => format!("({n}, $e)"),
                None => "(_, $e)".to_string(),
            };
            builders.push(self.builder(content, inst, &head)?);
        }
        if let Some(fb) = self.region_fallback(&attrs, inst, "(_, $e)")? {
            builders.push(fb);
        }
        let stmt_here = self.stmt_in_region;
        self.stmt_in_region = saved_stmt || stmt_here;
        self.helpers.insert("$sw");
        let line = format!(
            "$sw({end}, [{}], [{}]);",
            whens.join(", "),
            builders.join(", ")
        );
        self.bucket(inst).seq.push(Seq::Line(line));
        Ok(())
    }

    /// A `<Portal>`: its content is built on the client (the server rendered
    /// nothing) and appended to its mount (`document.body` by default).
    fn portal(&mut self, el: &'a JSXElement<'a>, inst: usize) -> R<()> {
        if self.tier == 0 {
            return Err("a <Portal> at tier 0".into());
        }
        let comp = self.insts[inst].comp;
        let attrs = jsx::attrs(el)?;
        let none = HashMap::new();
        let mount = match jsx::attr(&attrs, "mount").map(|a| &a.value) {
            Some(AttrVal::Expr(e)) => {
                let r = super::graph::refs_expr(self.m, self.m.comps[comp].props, e);
                if !self.a.live_reads(comp, &r).0.is_empty() {
                    return Err("a <Portal> whose mount reads live state".into());
                }
                self.expr(inst, &none, e)?
            }
            _ => "document.body".into(),
        };
        let kids = jsx::children(&el.children)?;
        // Built fresh, in its own scope (a builder called with no node).
        let saved_ns = std::mem::replace(&mut self.ns, 0);
        let builder = self.builder(kids, inst, "($e)");
        self.ns = saved_ns;
        let builder = builder?;
        self.helpers.insert("$portal");
        self.rt.insert("onCleanup");
        self.bucket(inst)
            .seq
            .push(Seq::Line(format!("$portal({mount}, {builder});")));
        Ok(())
    }

    fn region(&mut self, el: &'a JSXElement<'a>, inst: usize, end: String) -> R<()> {
        if self.tier == 0 {
            return Err("dynamic structure at tier 0".into());
        }
        // A live region adopts the server's rows: its state cannot move.
        self.transplant = None;
        let tag = jsx::tag_of(self.m, &el.opening_element.name);
        if matches!(tag, Tag::Builtin(ref b) if b == "Switch") {
            return self.switch_region(el, inst, end);
        }
        let attrs = jsx::attrs(el)?;
        let is_show = matches!(tag, Tag::Builtin(ref b) if b == "Show");
        let input = if is_show { "when" } else { "each" };
        let Some(AttrVal::Expr(input_expr)) = jsx::attr(&attrs, input).map(|a| &a.value) else {
            return Err("region input".into());
        };
        let none = HashMap::new();
        let input_text = self.expr(inst, &none, input_expr)?;
        let kids = jsx::children(&el.children)?;
        // `<For keyed={false}>`: rows by position (item accessor, index number).
        let unkeyed = !is_show
            && matches!(
                jsx::attr(&attrs, "keyed").map(|a| &a.value),
                Some(AttrVal::Expr(e)) if matches!(e.without_parentheses(), Expression::BooleanLiteral(b) if !b.value)
            );
        let (content, param, index): (Vec<Child<'a>>, Option<SymbolId>, Option<SymbolId>) =
            if is_show {
                let (c, p) = self.branch_content(&attrs, kids, "Show")?;
                (c, p, None)
            } else {
                let [Child::Expr(f)] = kids.as_slice() else {
                    return Err("<For> children must be one callback".into());
                };
                let Some(f) = FnRef::from_expr(f) else {
                    return Err("<For> children must be a callback".into());
                };
                if f.params().items.len() > 2 {
                    return Err("<For> callback with more than (item, index)".into());
                }
                let id_of = |i: usize| {
                    f.params().items.get(i).map(|p| match &p.pattern {
                        BindingPattern::BindingIdentifier(id) => id.symbol_id.get().ok_or(()),
                        _ => Err(()),
                    })
                };
                let p = match id_of(0) {
                    Some(Ok(s)) => Some(s),
                    Some(Err(())) => return Err("<For> callback with a destructured item".into()),
                    None => None,
                };
                let q = match id_of(1) {
                    Some(Ok(s)) => Some(s),
                    Some(Err(())) => return Err("<For> callback with a destructured index".into()),
                    None => None,
                };
                let Some(root) = fn_root(f) else {
                    return Err("<For> callback must return JSX".into());
                };
                let child = match root {
                    Root::Element(e) => Child::Element(e),
                    Root::Fragment(fr) => Child::Fragment(fr),
                };
                (vec![child], p, q)
            };
        // A row's item is a value (an accessor for `keyed={false}` rows); a
        // `Show` callback's parameter is the `when` accessor; a row's index
        // is an accessor (a number for `keyed={false}` rows).
        let item_kind = if is_show || unkeyed {
            Kind::Acc
        } else {
            Kind::Val
        };
        let param_name = self.bind_param(inst, param, item_kind);
        let index_name = self.bind_param(inst, index, if unkeyed { Kind::Val } else { Kind::Acc });
        // Builders take (parameter, adopted node[, index]): a row's item, a
        // `Show`'s `when` accessor.
        let item_arg = param_name.clone().unwrap_or_else(|| "_".into());
        let head = match (&param_name, &index_name) {
            (_, Some(q)) => format!("({item_arg}, $e, {q})"),
            (Some(n), None) => format!("({n}, $e)"),
            (None, None) if is_show || unkeyed => "(_, $e)".to_string(),
            (None, None) => "($e)".to_string(),
        };
        let saved_stmt = std::mem::replace(&mut self.stmt_in_region, false);
        let builder = self.builder(content, inst, &head)?;
        let fb_head = if is_show { "(_, $e)" } else { "($e)" };
        let fb = self.region_fallback(&attrs, inst, fb_head)?;
        let stmt_here = self.stmt_in_region;
        self.stmt_in_region = saved_stmt || stmt_here;
        let line = if is_show {
            match fb {
                Some(f) => {
                    self.helpers.insert("$showf");
                    format!("$showf({end}, () => {input_text}, {builder}, {f});")
                }
                None => {
                    self.helpers.insert("$show");
                    format!("$show({end}, () => {input_text}, {builder});")
                }
            }
        } else if unkeyed || index_name.is_some() {
            // Rows with a reactive index (or by position): each row owns a
            // signal the list writes when the row moves (or its item changes).
            let helper = if unkeyed { "$listu" } else { "$listi" };
            self.helpers.insert(helper);
            self.rt.insert("createSignal");
            let f = fb.unwrap_or_else(|| "0".into());
            format!("{helper}({end}, () => {input_text}, {builder}, {f});")
        } else {
            // A row whose code creates no computation, cleanup or nested
            // region needs no owner of its own.
            let reactive = [
                "$E(", "$M(", "$C(", "$Ef(", "$S(", "$show(", "$showf(", "$list(", "$listf(",
                "$R(", "$listi(", "$listu(", "$sw(", "$portal(",
            ]
            .iter()
            .any(|k| builder.contains(k))
                || stmt_here;
            match fb {
                Some(f) => {
                    self.helpers.insert("$listf");
                    let plain = if reactive { "0" } else { "1" };
                    format!("$listf({end}, () => {input_text}, {builder}, {plain}, {f});")
                }
                None => {
                    self.helpers.insert("$list");
                    let plain = if reactive { "" } else { ", 1" };
                    format!("$list({end}, () => {input_text}, {builder}{plain});")
                }
            }
        };
        self.bucket(inst).seq.push(Seq::Line(line));
        Ok(())
    }

    /// An adopt-or-create builder `head => { … return $x; }` over fresh
    /// content that must be one element (a component whose view is one).
    fn builder(&mut self, content: Vec<Child<'a>>, inst: usize, head: &str) -> R<String> {
        let saved = self.cur;
        self.scopes.push(Scope {
            nav: vec![],
            buckets: HashMap::new(),
            order: vec![],
            builder: true,
        });
        self.cur = self.scopes.len() - 1;
        let r = self.builder_in_scope(content, inst, head);
        self.cur = saved;
        r
    }

    fn builder_in_scope(&mut self, content: Vec<Child<'a>>, inst: usize, head: &str) -> R<String> {
        let mut slots = Vec::new();
        self.flatten(&content, inst, &mut slots)?;
        let elems: Vec<&Slot<'a>> = slots.iter().filter(|s| !matches!(s, Slot::Text)).collect();
        let [Slot::Elem(root_el, root_inst)] = elems.as_slice() else {
            return Err("region content must be a single element".into());
        };
        let (root_el, root_inst) = (*root_el, *root_inst);
        let ti = self.push_template(root_el, self.insts[root_inst].comp)?;
        self.element(root_el, root_inst, "$x")?;
        let body = self.assemble(self.cur, inst);
        let nav = self.scopes[self.cur].nav.join("\n");
        Ok(format!(
            "{head} => {{ const $f = !$e, $x = $e || $t{ti}();\n{nav}\n{body}\nreturn $x; }}"
        ))
    }

    /// A structural region: a `<Show>` / `<For>` over server data that holds
    /// this island's sites or members. Its input never changes, so nothing
    /// is re-rendered: a branch's content is activated in place when its
    /// condition holds, a list's rows are activated one by one on the
    /// server's row elements by a row function (a recursive row scope calls
    /// the same function for its own rows).
    fn structure(
        &mut self,
        el: &'a JSXElement<'a>,
        inst: usize,
        end: String,
        parent: Option<String>,
        before: Option<usize>,
    ) -> R<()> {
        let attrs = jsx::attrs(el)?;
        let is_show = matches!(jsx::tag_of(self.m, &el.opening_element.name), Tag::Builtin(ref b) if b == "Show");
        let input = if is_show { "when" } else { "each" };
        let Some(AttrVal::Expr(input_expr)) = jsx::attr(&attrs, input).map(|a| &a.value) else {
            return Err("region input".into());
        };
        let none = HashMap::new();
        let input_text = self.expr(inst, &none, input_expr)?;
        let kids = jsx::children(&el.children)?;
        let comp = self.insts[inst].comp;
        let saved = self.cur;
        if is_show {
            if kids
                .iter()
                .any(|k| matches!(k, Child::Expr(e) if FnRef::from_expr(e).is_some()))
            {
                return Err("a <Show> render callback over server data inside an island".into());
            }
            let before = before.ok_or("an island's <Show> after a variable-size region")?;
            self.scopes.push(Scope {
                nav: vec![],
                buckets: HashMap::new(),
                order: vec![],
                builder: false,
            });
            let sc = self.scopes.len() - 1;
            self.cur = sc;
            self.helpers.insert("$start");
            let start = self.fresh("$s");
            self.scope_nav(format!("const {start} = $start({end});"));
            let mut slots = Vec::new();
            let r = self
                .flatten(&kids, inst, &mut slots)
                .and_then(|_| self.container_at(parent, &slots, before, Some(start), 0));
            let body = self.assemble(sc, inst);
            let nav = self.scopes[sc].nav.join("\n");
            self.cur = saved;
            r?;
            self.bucket(inst)
                .seq
                .push(Seq::Line(format!("if ({input_text}) {{\n{nav}\n{body}}}")));
            return Ok(());
        }
        // A list: one row function.
        self.helpers.insert("$rows");
        if let Some((_, _, name)) = self
            .structs
            .iter()
            .find(|(sp, c, _)| *sp == el.span && *c == comp)
        {
            // This scope's own rows at a deeper level (the partitioner
            // checked the props are handed on unchanged).
            let line = format!("$rows({end}, {input_text}, {name});");
            self.bucket(inst).seq.push(Seq::Line(line));
            return Ok(());
        }
        let [Child::Expr(f)] = kids.as_slice() else {
            return Err("<For> children must be one callback".into());
        };
        let Some(f) = FnRef::from_expr(f) else {
            return Err("<For> children must be a callback".into());
        };
        if f.params().items.len() > 1 {
            return Err("<For> callback with an index".into());
        }
        let p = f.params().items.first().and_then(|p| match &p.pattern {
            BindingPattern::BindingIdentifier(id) => id.symbol_id.get(),
            _ => None,
        });
        let Some(root) = fn_root(f) else {
            return Err("<For> callback must return JSX".into());
        };
        let child = match root {
            Root::Element(e) => Child::Element(e),
            Root::Fragment(fr) => Child::Fragment(fr),
        };
        let name = self.fresh("$r");
        let item = match p {
            Some(p) => {
                let n = format!("{}{}", self.m.sym_name(p), self.fresh("$"));
                self.insts[inst].names.insert(p, (n.clone(), Kind::Val));
                n
            }
            None => "_".to_string(),
        };
        self.structs.push((el.span, comp, name.clone()));
        self.scopes.push(Scope {
            nav: vec![],
            buckets: HashMap::new(),
            order: vec![],
            builder: false,
        });
        let sc = self.scopes.len() - 1;
        self.cur = sc;
        let mut slots = Vec::new();
        let r = (|| -> R<()> {
            self.flatten(&[child], inst, &mut slots)?;
            let elems: Vec<&Slot<'a>> = slots.iter().filter(|s| !matches!(s, Slot::Text)).collect();
            let [Slot::Elem(root_el, root_inst)] = elems.as_slice() else {
                return Err("an island's rows over server data must be one element each".into());
            };
            let (root_el, root_inst) = (*root_el, *root_inst);
            self.element(root_el, root_inst, "$x")
        })();
        let body = self.assemble(sc, inst);
        let nav = self.scopes[sc].nav.join("\n");
        self.cur = saved;
        self.structs.pop();
        r?;
        let line = format!(
            "const {name} = ({item}, $x) => {{\n{nav}\n{body}}};\n$rows({end}, {input_text}, {name});"
        );
        self.bucket(inst).seq.push(Seq::Line(line));
        Ok(())
    }

    /// The namespace of an element `tag` laid out in the current context
    /// (`self.ns`: its parent's children's namespace).
    fn ns_of(&self, tag: &str) -> u8 {
        if tag == "svg" {
            1
        } else if tag == "math" {
            2
        } else if self.ns != 0 {
            self.ns
        } else if crate::shared::constants::svg_elements(tag) {
            1
        } else if crate::shared::constants::mathml_elements(tag) {
            2
        } else {
            0
        }
    }

    /// Register the client template of fresh content rooted at `el`.
    fn push_template(&mut self, el: &'a JSXElement<'a>, comp: usize) -> R<usize> {
        let tpl = self.template_html(el, comp)?;
        let tag = match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(t) => t,
            _ => return Err("template root".into()),
        };
        let wrap = match self.ns_of(&tag) {
            1 if tag != "svg" => Some("svg"),
            2 if tag != "math" => Some("math"),
            _ => None,
        };
        let ti = self.templates.len();
        self.templates.push((tpl, wrap));
        self.helpers
            .insert(if wrap.is_some() { "$tplw" } else { "$tpl" });
        Ok(ti)
    }

    /// Static client HTML of fresh region content: holes empty, live text
    /// holes as marker pairs, inert ones as `<!--!-->` placeholders.
    fn template_html(&mut self, el: &'a JSXElement<'a>, comp: usize) -> R<String> {
        let mut out = String::new();
        self.tpl_el(el, comp, &mut out)?;
        Ok(out)
    }

    fn tpl_el(&mut self, el: &'a JSXElement<'a>, comp: usize, out: &mut String) -> R<()> {
        let Tag::Intrinsic(tag) = jsx::tag_of(self.m, &el.opening_element.name) else {
            return Err("template root".into());
        };
        out.push('<');
        out.push_str(&tag);
        let attrs = jsx::attrs(el)?;
        for at in &attrs {
            match &at.value {
                AttrVal::True => {
                    let _ = write!(out, " {}", at.name);
                }
                AttrVal::Str(s) => {
                    let v = crate::shared::utils::normalize_static_attribute_value(&at.name, s);
                    let _ = write!(out, " {}=\"{}\"", at.name, jsx::esc_attr(&v));
                }
                AttrVal::Expr(e) => {
                    if let Some(s) = jsx::static_child(e) {
                        let _ = write!(out, " {}=\"{}\"", at.name, jsx::esc_attr(&s));
                    } else if at.name == "class" {
                        // Static tokens of a literal class list.
                        let mut tokens = Vec::new();
                        if let Expression::ArrayExpression(arr) = e.without_parentheses() {
                            for x in &arr.elements {
                                if let Some(Expression::StringLiteral(s)) =
                                    x.as_expression().map(|x| x.without_parentheses())
                                {
                                    tokens.push(s.value.to_string());
                                }
                            }
                        }
                        if !tokens.is_empty() {
                            let _ = write!(out, " class=\"{}\"", jsx::esc_attr(&tokens.join(" ")));
                        }
                    }
                }
                _ => {}
            }
        }
        out.push('>');
        if jsx::is_void(&tag) {
            return Ok(());
        }
        let kids = jsx::children(&el.children)?;
        let props = self.m.comps[comp].props;
        let is_slot = |e: &Expression<'_>| matches!(e.without_parentheses(), Expression::StaticMemberExpression(me) if me.property.name == "children" && props.is_some() && self.m.symbol_of_expr(&me.object) == props);
        if kids
            .iter()
            .any(|k| matches!(k, Child::Expr(e) if is_slot(e)))
        {
            return Err("`props.children` inside fresh island content".into());
        }
        let sole =
            kids.len() == 1 && matches!(kids[0], Child::Expr(e) if jsx::static_child(e).is_none());
        self.tpl_kids(&kids, comp, out, sole)?;
        let _ = write!(out, "</{tag}>");
        Ok(())
    }

    /// Template markup of fresh content's children.
    fn tpl_kids(&mut self, kids: &[Child<'a>], comp: usize, out: &mut String, sole: bool) -> R<()> {
        for k in kids {
            match *k {
                Child::Text(sp) => out.push_str(&jsx::esc_text(&jsx::jsx_text(self.m, sp))),
                Child::Expr(e) => {
                    if let Some(s) = jsx::static_child(e) {
                        out.push_str(&jsx::esc_text(&s));
                    } else if sole {
                    } else if self.site_live(comp, e.span().start) {
                        out.push_str("<!--$--><!--/-->");
                    } else {
                        out.push_str("<!--!-->");
                    }
                }
                Child::Element(c) => match jsx::tag_of(self.m, &c.opening_element.name) {
                    Tag::Intrinsic(_) => self.tpl_el(c, comp, out)?,
                    Tag::Builtin(b) if b == "Show" || b == "For" || b == "Switch" => {
                        out.push_str("<!--$--><!--/-->")
                    }
                    // Mounted elsewhere: nothing in place.
                    Tag::Builtin(b) if b == "Portal" => {}
                    // A client error boundary's region; an inert one is
                    // its content in place.
                    Tag::Builtin(b) if b == "Errored" || b == "Loading" => {
                        let ks = jsx::children(&c.children)?;
                        let live = if b == "Loading" {
                            self.a.pending_boundaries.contains(&(comp, c.span.start))
                        } else {
                            self.t2 && self.boundary_live(comp, c)
                        };
                        if live {
                            out.push_str("<!--$-->");
                        }
                        self.tpl_kids(&ks, comp, out, false)?;
                        if live {
                            out.push_str("<!--/-->");
                        }
                    }
                    Tag::Comp(k) => {
                        // Inlined in fresh content: its view's static markup.
                        let view = self.m.comps[k].view.ok_or("component without a view")?;
                        match jsx::root_of(view) {
                            Some(Root::Element(e)) => self.tpl_el(e, k, out)?,
                            _ => {
                                return Err(
                                    "fresh component content must be a single element".into()
                                );
                            }
                        }
                    }
                    _ => return Err("unsupported element in fresh island content".into()),
                },
                Child::Fragment(_) => return Err("fragment in fresh island content".into()),
            }
        }
        Ok(())
    }

    /// Code of one scope's instance buckets, starting at `inst`.
    fn assemble(&mut self, scope: usize, inst: usize) -> String {
        let mut out = String::new();
        self.assemble_into(scope, inst, &mut out);
        // Buckets never reached through `Seq::Inst` (none expected).
        out
    }

    fn assemble_into(&mut self, scope: usize, inst: usize, out: &mut String) {
        let Some(b) = self.scopes[scope].buckets.remove(&inst) else {
            return;
        };
        for l in &b.setup {
            out.push_str(l);
            out.push('\n');
        }
        for l in &b.handlers {
            out.push_str(l);
            out.push('\n');
        }
        for s in &b.seq {
            match s {
                Seq::Line(l) => {
                    out.push_str(l);
                    out.push('\n');
                }
                Seq::Inst(i) => self.assemble_into(scope, *i, out),
            }
        }
        for l in &b.tail {
            out.push_str(l);
            out.push('\n');
        }
        let fresh = self.scopes[scope].builder;
        let live: Vec<&AttrPart> = b.attrs.iter().filter(|p| p.live).collect();
        let inert: Vec<&AttrPart> = b.attrs.iter().filter(|p| !p.live).collect();
        if !inert.is_empty() {
            let mut s = String::from("if ($f) {");
            for p in &inert {
                let _ = write!(s, " {{ const v = {}; {}; }}", p.compute, p.apply);
            }
            s.push_str(" }\n");
            out.push_str(&s);
        }
        if !live.is_empty() {
            let env = live.iter().any(|p| p.env);
            if self.tier == 0 && env {
                // Client-environment parts: computed and written at activation.
                let cells: BTreeSet<String> =
                    live.iter().flat_map(|p| p.cells.iter().cloned()).collect();
                let fields: Vec<String> = live
                    .iter()
                    .enumerate()
                    .map(|(i, p)| format!("_{i}: {}", p.compute))
                    .collect();
                let applies: Vec<String> = live
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        format!(
                            "if (o._{i} !== q?._{i}) {{ const v = o._{i}; {}; }}",
                            p.apply
                        )
                    })
                    .collect();
                let _ = writeln!(
                    out,
                    "{{ const $h = () => ({{ {} }}), $p = (o, q) => {{ {} }}; $p($h()); $hole([{}], $h, $p); }}",
                    fields.join(", "),
                    applies.join(" "),
                    cells.into_iter().collect::<Vec<_>>().join(", ")
                );
            } else if self.tier == 0 {
                let cells: BTreeSet<String> =
                    live.iter().flat_map(|p| p.cells.iter().cloned()).collect();
                if live.len() == 1 {
                    let p = live[0];
                    let _ = writeln!(
                        out,
                        "$hole([{}], () => {}, v => {{ {}; }});",
                        cells.into_iter().collect::<Vec<_>>().join(", "),
                        p.compute,
                        p.apply
                    );
                } else {
                    let fields: Vec<String> = live
                        .iter()
                        .enumerate()
                        .map(|(i, p)| format!("_{i}: {}", p.compute))
                        .collect();
                    let applies: Vec<String> = live
                        .iter()
                        .enumerate()
                        .map(|(i, p)| {
                            format!(
                                "if (o._{i} !== q?._{i}) {{ const v = o._{i}; {}; }}",
                                p.apply
                            )
                        })
                        .collect();
                    let _ = writeln!(
                        out,
                        "$hole([{}], () => ({{ {} }}), (o, q) => {{ {} }});",
                        cells.into_iter().collect::<Vec<_>>().join(", "),
                        fields.join(", "),
                        applies.join(" ")
                    );
                }
            } else if live.len() == 1 {
                let p = live[0];
                let skip = if env {
                    "0"
                } else if fresh {
                    "$f ? 0 : 1"
                } else if self.opts.keyed_state {
                    "$st ? 0 : 1"
                } else {
                    "1"
                };
                let _ = writeln!(
                    out,
                    "{{ let $k = {skip}; $E(() => {}, v => {{ if ($k) {{ $k = 0; return; }} {}; }}); }}",
                    p.compute, p.apply
                );
            } else {
                let skip = if env {
                    "0"
                } else if fresh {
                    "$f ? 0 : 1"
                } else if self.opts.keyed_state {
                    "$st ? 0 : 1"
                } else {
                    "1"
                };
                let fields: Vec<String> = live
                    .iter()
                    .enumerate()
                    .map(|(i, p)| format!("_{i}: {}", p.compute))
                    .collect();
                let applies: Vec<String> = live
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        format!(
                            "if (o._{i} !== q?._{i}) {{ const v = o._{i}; {}; }}",
                            p.apply
                        )
                    })
                    .collect();
                let _ = writeln!(
                    out,
                    "{{ let $k = {skip}; $E(() => ({{ {} }}), (o, q) => {{ if ($k) {{ $k = 0; return; }} {} }}); }}",
                    fields.join(", "),
                    applies.join(" ")
                );
            }
        }
    }
}

enum TextTarget {
    Sole(String),
    Pair(String),
    Placeholder(String, usize),
}

fn fn_root<'a>(f: FnRef<'a>) -> Option<Root<'a>> {
    if f.is_concise() {
        if let Some(s) = f.concise() {
            return jsx::root_of(s);
        }
        return None;
    }
    let stmts = f.statements();
    match stmts {
        [Statement::ReturnStatement(r)] => r.argument.as_ref().and_then(jsx::root_of),
        _ => None,
    }
}

/// Is the expression's value always a string (literals, templates, `+` with
/// a string literal, conditionals / `||` of such)?
fn is_stringy(e: &Expression<'_>) -> bool {
    match e.without_parentheses() {
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => true,
        Expression::ConditionalExpression(c) => {
            is_stringy(&c.consequent) && is_stringy(&c.alternate)
        }
        Expression::BinaryExpression(b) => {
            b.operator == oxc_ast::ast::BinaryOperator::Addition
                && (is_stringy(&b.left) || is_stringy(&b.right))
        }
        _ => false,
    }
}

/// The view's first rendered node is an intrinsic element of its own JSX.
/// May the anchor element's subtree contain another island's anchor (a
/// component, a slot, or markup built by an expression inside it)?
fn anchor_nests<'a>(m: &Model<'_>, view: &'a Expression<'a>) -> bool {
    fn el_nests(m: &Model<'_>, el: &JSXElement<'_>) -> bool {
        let Ok(kids) = jsx::children(&el.children) else {
            return true;
        };
        kids.iter().any(|k| match k {
            Child::Text(_) => false,
            Child::Expr(e) => jsx::static_child(e).is_none() && (matches!(e.without_parentheses(), Expression::StaticMemberExpression(me) if me.property.name == "children") || contains_jsx(e)),
            Child::Element(c) => !matches!(jsx::tag_of(m, &c.opening_element.name), Tag::Intrinsic(_)) || el_nests(m, c),
            Child::Fragment(_) => true,
        })
    }
    fn contains_jsx(e: &Expression<'_>) -> bool {
        let mut roots = Vec::new();
        let mut complete = true;
        super::graph::find_jsx(
            unsafe { &*(e as *const Expression<'_>) },
            &mut roots,
            &mut complete,
        );
        !roots.is_empty() || !complete
    }
    let first = anchor_element(m, view);
    first.is_none_or(|el| el_nests(m, el))
}

pub(crate) fn first_is_element(m: &Model<'_>, view: &Expression<'_>) -> bool {
    anchor_element(m, view).is_some()
}

/// The island root's first rendered node when it is an intrinsic element of
/// the root's own JSX, looking through fragments, context providers and
/// `Loading` / `Errored` wrappers (they render their children in place).
pub(crate) fn anchor_element<'a>(
    m: &Model<'_>,
    view: &'a Expression<'a>,
) -> Option<&'a JSXElement<'a>> {
    fn first<'a>(
        m: &Model<'_>,
        kids: &'a [oxc_ast::ast::JSXChild<'a>],
    ) -> Option<&'a JSXElement<'a>> {
        match jsx::children(kids).ok()?.first().copied()? {
            Child::Element(el) => from_el(m, el),
            Child::Fragment(f) => first(m, &f.children),
            _ => None,
        }
    }
    fn from_el<'a>(m: &Model<'_>, el: &'a JSXElement<'a>) -> Option<&'a JSXElement<'a>> {
        match jsx::tag_of(m, &el.opening_element.name) {
            Tag::Intrinsic(_) => Some(el),
            Tag::Provider(_) => first(m, &el.children),
            Tag::Builtin(b) if b == "Loading" || b == "Errored" => first(m, &el.children),
            _ => None,
        }
    }
    match jsx::root_of(view)? {
        Root::Element(el) => from_el(m, el),
        Root::Fragment(f) => first(m, &f.children),
    }
}

#[allow(dead_code)]
fn _unused(_: &CallExpression<'_>) {
    let _ = call_of;
}
