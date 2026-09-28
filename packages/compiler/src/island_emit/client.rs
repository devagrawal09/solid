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
    BindingPattern, CallExpression, Expression, IdentifierReference, ImportDeclarationSpecifier, JSXElement,
    ObjectPropertyKind, PropertyKey, Statement,
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
}

pub(crate) struct GroupCode {
    pub code: String,
    pub tier: u8,
    pub runtime: String,
    /// Values the root instance reads from the anchor's `data-s`.
    pub serial: Vec<Serial>,
    /// An element anchor (`data-i` on the root's first element) or a comment.
    pub element_anchor: bool,
    /// Every handler sits under the anchor element (lazy activation possible).
    pub lazy_ok: bool,
    /// The anchor element's subtree may contain other islands' anchors.
    pub nests: bool,
    /// Module-level mutable declarations the chunk copies (by top index).
    pub mutable_top: Vec<usize>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Serial {
    Prop(String),
    Cell(usize),
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
}

/// One emission scope: the activation function or a region builder.
struct Scope {
    nav: Vec<String>,
    fresh_nav: Vec<String>,
    vars: HashMap<(usize, u32), String>,
    buckets: HashMap<usize, Bucket>,
    order: Vec<usize>,
    /// Builder scope: a fresh-or-adopt region content (`$x` is the element,
    /// `$f` true when freshly created).
    builder: bool,
    root_var: String,
}

#[derive(Clone, Copy)]
enum Slot<'a> {
    Elem(&'a JSXElement<'a>, usize),
    Text,
    Hole(&'a Expression<'a>, usize, bool),
    Region(&'a JSXElement<'a>, usize, bool),
    Opaque(Option<usize>, Option<usize>),
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
    rt: BTreeSet<&'static str>,
    top_syms: BTreeSet<SymbolId>,
    templates: Vec<String>,
    settled: Vec<String>,
    serial: Vec<Serial>,
    lazy_ok: bool,
    element_anchor: bool,
    shapes: HashMap<usize, (Option<usize>, Option<usize>)>,
    /// Module-level `let` / `var` statements copied into the chunk.
    mutable_top: Vec<usize>,
}

const HELPERS: &[(&str, &str)] = &[
    ("$r", "const $r = v => typeof v === \"function\" ? v() : v;"),
    ("$s", "const $s = v => v == null || typeof v === \"boolean\" ? \"\" : \"\" + v;"),
    (
        "$mk",
        // The k-th top-level `<!--$-->…<!--/-->` pair's end marker under
        // `p` (or among the siblings after `a`).
        "const $mk = (p, k, a) => { let d = 0, n = a ? a.nextSibling : p.firstChild; for (; n; n = n.nextSibling) if (n.nodeType === 8) { if (n.data === \"$\") d++; else if (n.data === \"/\" && !--d && !k--) return n; } };",
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
        "$start",
        "const $start = e => { let d = 0, n = e; while ((n = n.previousSibling)) if (n.nodeType === 8) { if (n.data === \"/\") d++; else if (n.data === \"$\" && !d--) return n; } };",
    ),
    (
        "$show",
        "const $show = (e, w, b) => { let d; $E(() => !!w(), (on, p) => { if (p === undefined) { if (on) $R(x => { d = x; const n = e.previousSibling; b(n.nodeType === 1 ? n : null) }); return; } if (on === p) return; if (on) $R(x => { d = x; e.before(b(null)); }); else { d(); d = undefined; const s = $start(e); while (s.nextSibling !== e) s.nextSibling.remove(); } }); };",
    ),
    (
        "$list",
        "const $list = (e, each, row) => { let rows = new Map(); $E(each, (items, p) => { if (p === undefined) { let n = $start(e).nextSibling; for (const it of items) { while (n.nodeType !== 1) n = n.nextSibling; const cur = n; rows.set(it, $R(d => ({ n: row(it, cur), d }))); n = cur.nextSibling; } return; } const next = new Map(); for (const it of items) next.set(it, rows.get(it) || $R(d => ({ n: row(it, null), d }))); for (const [it, r] of rows) if (!next.has(it)) { r.d(); r.n.remove(); } let c = $start(e).nextSibling; for (const r of next.values()) { if (r.n === c) c = c.nextSibling; else e.parentNode.insertBefore(r.n, c); } rows = next; }); };",
    ),
    (
        "$cls",
        "const $cls = v => { if (!v || typeof v !== \"object\") return v == null || v === false ? \"\" : \"\" + v; const o = {}, f = l => { for (const x of l) Array.isArray(x) ? f(x) : x && typeof x === \"object\" ? Object.assign(o, x) : typeof x !== \"boolean\" && (x || x === 0) && (o[x] = 1); }; Array.isArray(v) ? f(v) : Object.assign(o, v); return Object.keys(o).filter(k => o[k]).join(\" \"); };",
    ),
];

fn helper_deps(h: &str) -> &'static [&'static str] {
    match h {
        "$tx" => &["$s"],
        "$show" => &["$start"],
        "$list" => &["$start"],
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

pub(crate) fn emit_group<'a>(
    m: &Model<'a>,
    a: &Analysis<'a>,
    gi: usize,
    tier: u8,
    opts: &ClientOpts,
) -> R<GroupCode> {
    let g = &a.groups[gi];
    let mut ce = Ce {
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
        rt: BTreeSet::new(),
        top_syms: BTreeSet::new(),
        templates: Vec::new(),
        settled: Vec::new(),
        serial: Vec::new(),
        lazy_ok: true,
        element_anchor: true,
        shapes: HashMap::new(),
        mutable_top: Vec::new(),
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
    top: BTreeSet<SymbolId>,
    serial: Vec<Serial>,
}

impl<'e, 'x, 'a> CEnv<'e, 'x, 'a> {
    fn lookup(&self, s: SymbolId) -> Option<(String, Kind)> {
        self.extra.get(&s).cloned().or_else(|| self.ce.insts[self.inst].names.get(&s).cloned())
    }
    fn prop(&self, name: &str) -> R<PBind> {
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
                        Err(format!("yield* of `{}` (not in the island's scope)", id.name))
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
                    let head = match self.prop(s.property.name.as_str())? {
                        PBind::Acc(v) | PBind::Get(v) => format!("{v}()"),
                        PBind::Val(v) => v,
                    };
                    let rest = &tx.m.src[s.span.end as usize..arg.span().end as usize];
                    // Translate any computed keys in the rest verbatim (rare).
                    return Ok(format!("{head}{rest}"));
                }
                let root_text = tx.expr(self, root)?;
                let rest = &tx.m.src[root.span().end as usize..arg.span().end as usize];
                self.uses.borrow_mut().helpers.insert("$r");
                Ok(format!("$r({root_text}){rest}"))
            }
            Expression::CallExpression(c) => {
                if let Some(n) = self.ce.m.runtime_name(&c.callee) {
                    match n {
                        "$cleanup" => {
                            self.uses.borrow_mut().rt.insert("onCleanup");
                            let args = self.args(tx, c)?;
                            return Ok(format!("$C({args})"));
                        }
                        "$flush" => {
                            self.uses.borrow_mut().rt.insert("flush");
                            return Ok("$F()".into());
                        }
                        other => return Err(format!("`yield* {other}(…)` in client code")),
                    }
                }
                // A setter call's receipt: the call returns the new value.
                tx.expr(self, arg)
            }
            _ => Err(format!("yield* of `{}`", super::model::short(tx.m.text(arg.span())))),
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
    fn props_member(&self, _tx: &Tx<'_, 'a>, name: &str) -> R<Option<String>> {
        if name == "children" {
            return Err("`props.children` read by client code".into());
        }
        Ok(Some(match self.prop(name)? {
            PBind::Acc(v) | PBind::Val(v) => v,
            PBind::Get(v) => format!("{v}()"),
        }))
    }
    fn call(&self, tx: &Tx<'_, 'a>, c: &'a CallExpression<'a>) -> R<Option<String>> {
        if let Some(n) = self.ce.m.runtime_name(&c.callee) {
            if n == "$event" {
                let Some(f) = c.arguments.first().and_then(|a| a.as_expression()).and_then(FnRef::from_expr) else {
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
        Err(format!("`yield*` in module-level code: `{}`", super::model::short(tx.m.text(arg.span()))))
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
                let f = c.arguments.first().and_then(|a| a.as_expression()).ok_or("$cleanup without a function")?;
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
    fn call(&self, tx: &Tx<'_, 'a>, c: &'a CallExpression<'a>) -> R<Option<String>> {
        self.inner.call(tx, c)
    }
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

    fn fresh(&mut self, base: &str) -> String {
        self.uid += 1;
        format!("{base}{}", self.uid)
    }

    fn translate(&mut self, inst: usize, extra: &HashMap<SymbolId, (String, Kind)>, f: impl FnOnce(&Tx<'x, 'a>, &CEnv<'_, 'x, 'a>) -> R<String>) -> R<String> {
        let tx = self.tx();
        let (res, uses) = {
            let env = CEnv { ce: self, inst, extra, uses: Default::default() };
            let r = f(&tx, &env);
            (r, env.uses.into_inner())
        };
        let out = res?;
        if out.contains("__UNSUPPORTED_RUNTIME_") {
            let name = out.split("__UNSUPPORTED_RUNTIME_").nth(1).unwrap_or("").split(|c: char| !c.is_alphanumeric() && c != '$' && c != '_').next().unwrap_or("");
            return Err(format!("runtime `{name}` in client code"));
        }
        self.helpers.extend(uses.helpers);
        self.rt.extend(uses.rt);
        self.top_syms.extend(uses.top);
        for s in uses.serial {
            if !self.serial.contains(&s) {
                self.serial.push(s);
            }
        }
        Ok(out)
    }

    fn expr(&mut self, inst: usize, extra: &HashMap<SymbolId, (String, Kind)>, e: &'a Expression<'a>) -> R<String> {
        self.translate(inst, extra, |tx, env| tx.expr(env, e))
    }

    fn bucket(&mut self, inst: usize) -> &mut Bucket {
        let s = &mut self.scopes[self.cur];
        if !s.buckets.contains_key(&inst) {
            s.order.push(inst);
        }
        s.buckets.entry(inst).or_default()
    }

    fn run(mut self) -> R<GroupCode> {
        let root = self.g.root;
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
            fresh_nav: vec![],
            vars: HashMap::new(),
            buckets: HashMap::new(),
            order: vec![],
            builder: false,
            root_var: "$a".into(),
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
            if !self.rt.is_empty() || true {
                let mut names = vec!["cell as $cell".to_string(), "hole as $hole".to_string()];
                if self.rt.contains("set") {
                    names.push("set as $set".into());
                }
                if self.rt.contains("get") {
                    names.push("get as $get".into());
                }
                if self.rt.contains("flush") {
                    names.push("flush as $F".into());
                }
                imports.push(format!("import {{ {} }} from {};", names.join(", "), js_str(&runtime)));
            }
            if self.rt.iter().any(|r| matches!(*r, "onCleanup" | "untrack")) {
                return Err("tier 0 with a cleanup / untrack".into());
            }
        } else {
            let mut names = vec!["createRoot as $R".to_string(), "createRenderEffect as $E".to_string(), "flush as $F".to_string()];
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
            imports.push(format!("import {{ {} }} from {};", names.join(", "), js_str(&runtime)));
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
        for (i, t) in self.templates.iter().enumerate() {
            let _ = writeln!(out, "const $t{i} = $tpl({});", js_str(t));
        }
        let data = if serial.is_empty() {
            String::new()
        } else if self.element_anchor {
            "const $d = JSON.parse($a.getAttribute(\"data-s\"));\n".to_string()
        } else {
            return Err("serialized values on a comment anchor".into());
        };
        let nav = self.scopes[0].nav.join("\n");
        if tier == 0 {
            let _ = write!(out, "export function activate($a) {{\n{data}{nav}\n{body}\n{}}}\n", settled.join("\n"));
        } else {
            let _ = write!(
                out,
                "export function activate($a) {{\n{data}{nav}\nreturn $R($x => {{\n{body}\n{}return $x;\n}});\n}}\n",
                settled.join("\n")
            );
            out.push_str("export const flush = $F;\n");
        }
        Ok(GroupCode {
            code: out,
            tier,
            runtime,
            serial,
            element_anchor: self.element_anchor,
            nests: anchor_nests(m, view),
            mutable_top: self.mutable_top.clone(),
            lazy_ok: self.lazy_ok && self.element_anchor && self.g.window_events.len() + self.g.events.len() > 0 && !self.g.hot,
            notes: vec![],
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
            let Some(&ti) = self.m.top_of.get(&s) else { continue };
            let t = &self.m.top[ti];
            if t.comp.is_some() {
                return Err(format!("client code references component `{}` as a value", self.m.sym_name(s)));
            }
            if t.runtime_import {
                return Err(format!("client code references runtime `{}`", self.m.sym_name(s)));
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

    /// Items of a component the island's client code needs (transitively).
    fn needed_items(&self, comp: usize) -> BTreeSet<usize> {
        let c = &self.m.comps[comp];
        let f = &self.a.facts[comp];
        let mut syms: Vec<SymbolId> = Vec::new();
        let mut need: BTreeSet<usize> = BTreeSet::new();
        for (ci, si) in &self.g.sites {
            if *ci == comp {
                syms.extend(f.sites[*si].refs.syms.iter().map(|x| x.0));
                if let SiteKind::Effect(ii, _) = f.sites[*si].kind {
                    need.insert(ii);
                }
            }
        }
        // Everything any client-rendered expression of the view may touch
        // (inert holes inside fresh regions, props of inlined children,
        // provider values): the view's sites and calls.
        for s in &f.sites {
            syms.extend(s.refs.syms.iter().map(|x| x.0));
        }
        for call in &f.calls {
            for (_, e) in &call.props {
                if let Some(e) = e {
                    syms.extend(super::graph::refs_expr(self.m, c.props, e).syms.iter().map(|x| x.0));
                }
            }
        }
        for (_, v) in &f.providers {
            if let Some(e) = v {
                syms.extend(super::graph::refs_expr(self.m, c.props, e).syms.iter().map(|x| x.0));
            }
        }
        for (ii, item) in c.setup.iter().enumerate() {
            if matches!(item, Item::Cleanup { .. } | Item::Stmt { .. }) {
                need.insert(ii);
            }
        }
        let mut stack: Vec<usize> = need.iter().copied().collect();
        let owner: HashMap<SymbolId, usize> = c
            .setup
            .iter()
            .enumerate()
            .flat_map(|(i, it)| it.declares().into_iter().map(move |s| (s, i)))
            .collect();
        for s in syms {
            if let Some(i) = owner.get(&s) {
                stack.push(*i);
            }
        }
        while let Some(i) = stack.pop() {
            if !need.insert(i) && !stack.is_empty() {
                // already processed
            }
            for (s, _) in &f.item_refs[i].syms {
                if let Some(j) = owner.get(s)
                    && !need.contains(j)
                {
                    stack.push(*j);
                }
            }
            need.insert(i);
        }
        need
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
                Some((Item::Local { .. }, i)) => {
                    if !self.evaluable(comp, &self.a.facts[comp].item_refs[i], depth + 1) {
                        return false;
                    }
                }
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
        let need = self.needed_items(comp);
        let t0 = self.tier == 0;
        // Declare names (and kinds) for every item first: bodies may refer
        // to later items (hoisted functions, events used by earlier locals).
        for (ii, item) in c.setup.iter().enumerate() {
            match item {
                Item::Cell { get, set, .. } => {
                    let gn = self.name_for(inst, *get);
                    self.insts[inst].names.insert(*get, (gn.clone(), if t0 { Kind::Cell0 } else { Kind::Acc }));
                    if let Some(s) = set {
                        let sn = self.name_for(inst, *s);
                        self.insts[inst].names.insert(*s, (sn, if t0 { Kind::Set0(gn) } else { Kind::Val }));
                    }
                }
                Item::Memo { sym, .. } => {
                    let n = self.name_for(inst, *sym);
                    self.insts[inst].names.insert(*sym, (n, Kind::Acc));
                }
                Item::Event { sym, .. } => {
                    let n = self.name_for(inst, *sym);
                    self.insts[inst].names.insert(*sym, (n, Kind::Val));
                }
                Item::Context { symbols, .. } | Item::Local { symbols, .. } => {
                    let kind = if let Item::Local { decl: LocalDecl::Func(_), .. } = item { Kind::Val } else { Kind::Unknown };
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
            let line = match item {
                Item::Cell { get, set, init, host, label, .. } => {
                    if *host != CellHost::Signal {
                        return Err("store / optimistic cell in a compiled island".into());
                    }
                    let gn = self.insts[inst].names[get].0.clone();
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
                    if t0 {
                        match (self.opts.debug, label) {
                            (true, Some(l)) => format!("const {gn} = $cell({init_text}, {});", js_str(l)),
                            (true, None) => format!("const {gn} = $cell({init_text}, {});", js_str(self.m.sym_name(*get))),
                            _ => format!("const {gn} = $cell({init_text});"),
                        }
                    } else {
                        let pat = match set {
                            Some(s) => format!("[{gn}, {}]", self.insts[inst].names[s].0),
                            None => format!("[{gn}]"),
                        };
                        if let Some(l) = label {
                            // Probe host (instrumented builds): keep the host call.
                            let callee = self.probe_callee(ii, comp)?;
                            self.top_syms.extend(callee.1);
                            format!("const {pat} = {}({}, {init_text});", callee.0, js_str(l))
                        } else {
                            self.rt.insert("createSignal");
                            format!("const {pat} = $S({init_text});")
                        }
                    }
                }
                Item::Memo { sym, body, is_async, .. } => {
                    if *is_async {
                        return Err("async memo in a compiled island".into());
                    }
                    if t0 {
                        return Err("memo at tier 0".into());
                    }
                    self.rt.insert("createMemo");
                    let f = self.translate(inst, &none, |tx, env| tx.func(env, *body, false))?;
                    format!("const {} = $M({f});", self.insts[inst].names[sym].0)
                }
                Item::Event { sym, body, .. } => {
                    let f = self.translate(inst, &none, |tx, env| tx.func(env, *body, false))?;
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
                    if ["for (", "for(", "while (", "while(", "do {"].iter().any(|k| text.contains(k)) && text.contains("yield*") {
                        return Err("`$effect` reads in a loop (not split)".into());
                    }
                    let (code, reads) = {
                        let tx = self.tx();
                        let env = CEnv { ce: self, inst, extra: &none, uses: Default::default() };
                        let eff = EffEnv { inner: &env, reads: Default::default(), body: body_span };
                        let r = tx.body(&eff, *body);
                        let reads = eff.reads.into_inner();
                        let uses = env.uses.into_inner();
                        (r.map(|c| (c, uses)), reads)
                    };
                    let (code, uses) = code?;
                    self.helpers.extend(uses.helpers);
                    self.rt.extend(uses.rt);
                    self.top_syms.extend(uses.top);
                    self.rt.insert("createEffect");
                    let body_inner = code.trim().strip_prefix('{').and_then(|b| b.strip_suffix('}')).unwrap_or(&code);
                    format!(
                        "$Ef(() => [{}], $v => {{ const $cl = [];{body_inner}\nreturn () => {{ for (const f of $cl) f(); }}; }});",
                        reads.join(", ")
                    )
                }
                Item::Context { pattern, ctx, .. } => {
                    let Some(bind) = self.insts[inst].ctx.get(ctx).cloned() else {
                        return Err(format!(
                            "context `{}` read in the island without a provider inside it",
                            self.m.sym_name(*ctx)
                        ));
                    };
                    let pat = self.pattern(inst, pattern)?;
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
                        let name = f.id.as_ref().and_then(|i| i.symbol_id.get()).map(|s| self.insts[inst].names[&s].0.clone());
                        let func = self.translate(inst, &none, |tx, env| tx.func(env, FnRef::Func(f), f.r#async))?;
                        format!("const {} = {func};", name.unwrap_or_default())
                    }
                },
                Item::Stmt { stmt, .. } => self.translate(inst, &none, |tx, env| tx.stmt(env, stmt))?,
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

    fn probe_callee(&self, item: usize, comp: usize) -> R<(String, Vec<SymbolId>)> {
        let Item::Cell { span, .. } = &self.m.comps[comp].setup[item] else { unreachable!() };
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
        fn walk(ce: &Ce<'_, '_>, inst: usize, p: &BindingPattern<'_>, edits: &mut Vec<(Span, String)>) -> R<()> {
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
                BindingPattern::AssignmentPattern(_) => return Err("default values in a context / local pattern".into()),
            }
            Ok(())
        }
        walk(self, inst, p, &mut edits)?;
        // Strip a type annotation (`const x: T = …`) — keep it, TS is fine.
        Ok(crate::store_scalars::splice(self.m.src, p.span(), edits))
    }

    // --- layout -----------------------------------------------------------------
    fn flatten_root(&mut self, e: &'a Expression<'a>, inst: usize, out: &mut Vec<Slot<'a>>) -> R<()> {
        match jsx::root_of(e) {
            Some(Root::Element(el)) => self.flatten_el(el, inst, out),
            Some(Root::Fragment(f)) => {
                let kids = jsx::children(&f.children)?;
                self.flatten(&kids, inst, out)
            }
            None => {
                let live = self.a.is_live_site(self.insts[inst].comp, e.span().start);
                out.push(Slot::Hole(e, inst, live));
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
                    let live = self.a.is_live_site(comp, e.span().start);
                    let refs = super::graph::refs_expr(self.m, self.m.comps[comp].props, e);
                    if refs.has_jsx {
                        if live {
                            return Err("a live expression producing JSX (use <Show> / <For>)".into());
                        }
                        out.push(Slot::Opaque(None, Some(0)));
                        continue;
                    }
                    out.push(Slot::Hole(e, inst, live));
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

    fn flatten_el(&mut self, el: &'a JSXElement<'a>, inst: usize, out: &mut Vec<Slot<'a>>) -> R<()> {
        let comp = self.insts[inst].comp;
        match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(_) => out.push(Slot::Elem(el, inst)),
            Tag::Builtin(b) if b == "Show" || b == "For" => {
                let attrs = jsx::attrs(el)?;
                let input = if b == "Show" { "when" } else { "each" };
                let live = match jsx::attr(&attrs, input).map(|a| &a.value) {
                    Some(AttrVal::Expr(e)) => self.a.is_live_site(comp, e.span().start),
                    _ => false,
                };
                if live {
                    out.push(Slot::Region(el, inst, true));
                } else {
                    if self.span_has_group_sites(comp, el.span) {
                        return Err(format!("island sites inside a <{b}> over server values"));
                    }
                    let sh = self.shape_el(el, comp, 0);
                    out.push(Slot::Opaque(sh.0, sh.1));
                }
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
                    let Some(AttrVal::Expr(v)) = jsx::attr(&attrs, "value").map(|a| &a.value) else {
                        return Err("context provider without a value expression".into());
                    };
                    let var = self.fresh("$c");
                    let none = HashMap::new();
                    let value = self.expr(inst, &none, v)?;
                    self.bucket(inst).seq.push(Seq::Line(format!("const {var} = {value};")));
                    // The binding stays for the whole instance: its subtree is
                    // laid out lazily (one provider per context per component).
                    if self.insts[inst].ctx.insert(ctx, CtxBind { var }).is_some() {
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
                let other_root = self.a.root_of.get(&k).is_some_and(|gs| gs.iter().any(|g| *g != self.gi));
                let fresh = self.scopes[self.cur].builder;
                if fresh || ((is_member || self.contains_group_sites(comp, &kids)) && !(other_root && !is_member)) {
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
        }
        Ok(())
    }

    fn kids_render_members(&self, kids: &[Child<'a>]) -> bool {
        kids.iter().any(|k| match k {
            Child::Element(el) => match jsx::tag_of(self.m, &el.opening_element.name) {
                Tag::Comp(c) => self.g.members.contains(&c) || jsx::children(&el.children).is_ok_and(|ks| self.kids_render_members(&ks)),
                _ => jsx::children(&el.children).is_ok_and(|ks| self.kids_render_members(&ks)),
            },
            Child::Fragment(f) => jsx::children(&f.children).is_ok_and(|ks| self.kids_render_members(&ks)),
            _ => false,
        })
    }

    /// Inline a component instance: bind its props to the caller's expressions.
    fn instantiate(&mut self, k: usize, el: &'a JSXElement<'a>, caller: usize, kids: Vec<Child<'a>>) -> R<usize> {
        let attrs = jsx::attrs(el)?;
        let id = self.insts.len();
        let suffix = format!("${id}");
        let mut props = HashMap::new();
        let none = HashMap::new();
        for at in &attrs {
            let b = match &at.value {
                AttrVal::True => PBind::Val("true".into()),
                AttrVal::Str(s) => PBind::Val(js_str(s)),
                AttrVal::Expr(e) => self.bind_prop(caller, e, &none)?,
                AttrVal::Element(_) | AttrVal::Fragment(_) => return Err("JSX-valued prop of an island component".into()),
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

    fn bind_prop(&mut self, caller: usize, e: &'a Expression<'a>, extra: &HashMap<SymbolId, (String, Kind)>) -> R<PBind> {
        let e = e.without_parentheses();
        if let Some(s) = self.m.symbol_of_expr(e) {
            let found = extra.get(&s).cloned().or_else(|| self.insts[caller].names.get(&s).cloned());
            if let Some((n, k)) = found {
                return Ok(match k {
                    Kind::Acc => PBind::Acc(n),
                    Kind::Cell0 | Kind::Set0(_) => return Err("tier-0 cell passed as a prop".into()),
                    _ => PBind::Val(n),
                });
            }
        }
        if let Expression::StaticMemberExpression(me) = e
            && self.m.comps[self.insts[caller].comp].props.is_some()
            && self.m.symbol_of_expr(&me.object) == self.m.comps[self.insts[caller].comp].props
        {
            let env_prop = {
                let env = CEnv { ce: self, inst: caller, extra, uses: Default::default() };
                let r = env.prop(me.property.name.as_str());
                let u = env.uses.into_inner();
                (r, u)
            };
            for s in env_prop.1.serial {
                if !self.serial.contains(&s) {
                    self.serial.push(s);
                }
            }
            return env_prop.0;
        }
        let text = self.translate(caller, extra, |tx, env| tx.expr(env, e))?;
        let reads = super::graph::refs_expr(self.m, self.m.comps[self.insts[caller].comp].props, e);
        let var = self.fresh("$p");
        let has_read = self.m.text(e.span()).contains("yield*") || !reads.props.is_empty();
        let line = if has_read { format!("const {var} = () => {text};") } else { format!("const {var} = {text};") };
        self.push_line(caller, line);
        Ok(if has_read { PBind::Get(var) } else { PBind::Val(var) })
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
                None => (Some(0), if self.a.is_live_site(k, v.span().start) { Some(1) } else { Some(0) }),
            },
            None => (None, None),
        };
        self.shapes.insert(k, s);
        s
    }

    fn shape_el(&mut self, el: &'a JSXElement<'a>, comp: usize, depth: u32) -> (Option<usize>, Option<usize>) {
        match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(_) => (Some(1), Some(0)),
            Tag::Comp(k) => self.shape_comp(k, depth),
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
            Tag::Builtin(b) if b == "Loading" || b == "Errored" || b == "Show" => match jsx::children(&el.children) {
                Ok(ks) => self.shape_kids(&ks, comp, depth),
                Err(_) => (None, None),
            },
            Tag::Provider(_) => match jsx::children(&el.children) {
                Ok(ks) => self.shape_kids(&ks, comp, depth),
                Err(_) => (None, None),
            },
            _ => (None, None),
        }
    }

    fn shape_kids(&mut self, kids: &[Child<'a>], comp: usize, depth: u32) -> (Option<usize>, Option<usize>) {
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
                        (Some(0), Some(usize::from(self.a.is_live_site(comp, x.span().start) && !false)))
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
    /// `parent`: the container element's var (None = the island root level).
    fn container(&mut self, parent: Option<String>, slots: &[Slot<'a>]) -> R<()> {
        // Element indexes and pair indexes, from the start where possible.
        let n = slots.len();
        let contrib = |s: &Slot<'a>| -> (Option<usize>, Option<usize>) {
            match s {
                Slot::Elem(..) => (Some(1), Some(0)),
                Slot::Text => (Some(0), Some(0)),
                Slot::Hole(_, _, live) => (Some(0), Some(usize::from(*live))),
                Slot::Region(_, _, live) => (None, Some(usize::from(*live))),
                Slot::Opaque(e, p) => (*e, *p),
            }
        };
        let sum = |range: &[Slot<'a>], f: &dyn Fn(&Slot<'a>) -> Option<usize>| -> Option<usize> {
            range.iter().try_fold(0usize, |acc, s| f(s).map(|x| acc + x))
        };
        let sole = parent.is_some() && slots.len() == 1 && matches!(slots[0], Slot::Hole(..));
        for i in 0..n {
            let slot = slots[i];
            match slot {
                Slot::Elem(el, inst) => {
                    // Needed? Only if it (or its subtree) has group work.
                    if !self.elem_needed(el, inst) {
                        continue;
                    }
                    let before = sum(&slots[..i], &|s| contrib(s).0);
                    let after = sum(&slots[i + 1..], &|s| contrib(s).0);
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
                            } else if b < 3 {
                                format!("{p}.firstElementChild{}", ".nextElementSibling".repeat(b))
                            } else {
                                format!("{p}.children[{b}]")
                            }
                        }
                        (Some(p), None, Some(af)) => {
                            format!("{p}.lastElementChild{}", ".previousElementSibling".repeat(af))
                        }
                        _ => return Err("an island element after a variable-size region with no fixed path".into()),
                    };
                    if parent.is_none() && before != Some(0) {
                        // Handlers outside the anchor element cannot be found
                        // by the loader: activate such islands eagerly.
                        if self.subtree_has_handlers(el, inst) {
                            self.lazy_ok = false;
                        }
                    }
                    let decl = format!("const {var} = {nav};");
                    self.scope_nav(decl);
                    self.element(el, inst, &var)?;
                }
                Slot::Hole(e, inst, live) => {
                    if sole {
                        let el_var = parent.clone().unwrap();
                        self.text_hole(e, inst, live, TextTarget::Sole(el_var))?;
                    } else if live {
                        let k = sum(&slots[..i], &|s| contrib(s).1).ok_or("a live hole after a variable region")?;
                        let end = self.marker(&parent, k);
                        self.text_hole(e, inst, true, TextTarget::Pair(end))?;
                    } else if self.scopes[self.cur].builder {
                        // Inert hole in fresh content: a placeholder.
                        let k = slots[..i]
                            .iter()
                            .filter(|s| matches!(s, Slot::Hole(_, _, false)))
                            .count();
                        let p = parent.clone().ok_or("inert hole at a builder's root level")?;
                        self.helpers.insert("$pk");
                        self.text_hole(e, inst, false, TextTarget::Placeholder(p, k))?;
                    }
                }
                Slot::Region(el, inst, _) => {
                    let k = sum(&slots[..i], &|s| contrib(s).1).ok_or("a region after a variable region")?;
                    let end = self.marker(&parent, k);
                    self.region(el, inst, end)?;
                }
                Slot::Text | Slot::Opaque(..) => {}
            }
        }
        Ok(())
    }

    fn scope_nav(&mut self, line: String) {
        self.scopes[self.cur].nav.push(line);
    }

    fn marker(&mut self, parent: &Option<String>, k: usize) -> String {
        self.helpers.insert("$mk");
        let var = self.fresh("$m");
        let nav = match parent {
            Some(p) => format!("const {var} = $mk({p}, {k});"),
            None => format!("const {var} = $mk(null, {k}, $a);"),
        };
        self.scope_nav(nav);
        var
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
        // Inlined members rendered inside (through components or slots).
        match jsx::children(&el.children) {
            Ok(ks) => self.kids_render_members(&ks) || self.kids_have_member_slot(inst, &ks),
            Err(_) => true,
        }
    }

    fn kids_have_member_slot(&self, inst: usize, kids: &[Child<'a>]) -> bool {
        kids.iter().any(|k| match k {
            Child::Expr(e) if self.is_slot(inst, e) => match &self.insts[inst].slot {
                Some((ck, ci)) => self.contains_group_sites(self.insts[*ci].comp, ck) || self.kids_render_members(ck),
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
        let none = HashMap::new();
        for at in &attrs {
            let AttrVal::Expr(e) = &at.value else { continue };
            if jsx::is_event_attr(&at.name) {
                let h = self.expr(inst, &none, e)?;
                let ev = jsx::event_name(&at.name);
                self.bucket(inst).handlers.push(format!("{var}.addEventListener({}, {h});", js_str(&ev)));
                continue;
            }
            if jsx::static_child(e).is_some() || at.name == "ref" {
                continue;
            }
            let live = self.a.is_live_site(comp, e.span().start);
            if !live && !fresh {
                continue;
            }
            self.attr_parts(&tag, &at.name, e, inst, var, live)?;
        }
        let kids = jsx::children(&el.children)?;
        let mut slots = Vec::new();
        self.flatten(&kids, inst, &mut slots)?;
        self.container(Some(var.to_string()), &slots)?;
        Ok(())
    }

    fn cells_of(&self, inst: usize, e: &Expression<'a>) -> BTreeSet<String> {
        let comp = self.insts[inst].comp;
        let r = super::graph::refs_expr(self.m, self.m.comps[comp].props, e);
        let (keys, _) = self.a.live_reads(comp, &r);
        keys.iter()
            .filter_map(|k| match &self.m.comps[k.0].setup[k.1] {
                Item::Cell { get, .. } => self.insts.iter().find(|i| i.comp == k.0).and_then(|i| i.names.get(get)).map(|x| x.0.clone()),
                _ => None,
            })
            .collect()
    }

    fn attr_parts(&mut self, tag: &str, name: &str, e: &'a Expression<'a>, inst: usize, var: &str, live: bool) -> R<()> {
        let none = HashMap::new();
        let cells = self.cells_of(inst, e);
        let mut push = |ce: &mut Self, compute: String, apply: String| {
            ce.bucket(inst).attrs.push(AttrPart { compute, apply, cells: cells.clone(), live });
        };
        if name == "class" {
            // Literal arrays / objects: per-key toggles (static tokens are in
            // the markup already).
            let mut keyed: Vec<(String, &'a Expression<'a>)> = Vec::new();
            let mut ok = true;
            let mut collect = |o: &'a oxc_ast::ast::ObjectExpression<'a>, keyed: &mut Vec<(String, &'a Expression<'a>)>| -> bool {
                for p in &o.properties {
                    let ObjectPropertyKind::ObjectProperty(p) = p else { return false };
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
                        push(self, format!("!!({c})"), format!("{var}.classList.toggle({}, v)", js_str(token)));
                    }
                }
                return Ok(());
            }
            self.helpers.insert("$cls");
            let c = self.expr(inst, &none, e)?;
            push(self, format!("$cls({c})"), format!("{var}.className = v"));
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
                        push(
                            self,
                            c,
                            format!("v != null ? {var}.style.setProperty({k}, v) : {var}.style.removeProperty({k})", k = js_str(&key)),
                        );
                    }
                    return Ok(());
                }
            }
            return Err("a non-literal `style` object in an island".into());
        }
        let c = self.expr(inst, &none, e)?;
        if is_prop_attr(tag, name) {
            push(self, c, format!("{var}.{name} = v"));
        } else {
            let n = js_str(name);
            push(
                self,
                c,
                format!("v == null || v === false ? {var}.removeAttribute({n}) : {var}.setAttribute({n}, v === true ? \"\" : v)"),
            );
        }
        Ok(())
    }

    fn text_hole(&mut self, e: &'a Expression<'a>, inst: usize, live: bool, target: TextTarget) -> R<()> {
        let none = HashMap::new();
        let c = self.expr(inst, &none, e)?;
        self.helpers.insert("$s");
        let apply = match &target {
            TextTarget::Sole(el) => format!("{el}.textContent = $s(v)"),
            TextTarget::Pair(end) => {
                self.helpers.insert("$tx");
                format!("$tx({end}, v)")
            }
            TextTarget::Placeholder(p, k) => format!("$pk({p}, {k}).replaceWith($s(v))"),
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
        if self.tier == 0 {
            let line = format!(
                "$hole([{}], () => {c}, v => {{ {apply}; }});",
                cells.iter().cloned().collect::<Vec<_>>().join(", ")
            );
            self.bucket(inst).seq.push(Seq::Line(line));
        } else {
            let skip = if fresh { "$f ? 0 : 1" } else { "1" };
            let line = format!("{{ let $k = {skip}; $E(() => {c}, v => {{ if ($k) {{ $k = 0; return; }} {apply}; }}); }}");
            self.bucket(inst).seq.push(Seq::Line(line));
        }
        Ok(())
    }

    fn region(&mut self, el: &'a JSXElement<'a>, inst: usize, end: String) -> R<()> {
        if self.tier == 0 {
            return Err("dynamic structure at tier 0".into());
        }
        let attrs = jsx::attrs(el)?;
        let is_show = matches!(jsx::tag_of(self.m, &el.opening_element.name), Tag::Builtin(ref b) if b == "Show");
        if jsx::attr(&attrs, "fallback").is_some() {
            return Err("a live <Show>/<For> with a fallback".into());
        }
        let input = if is_show { "when" } else { "each" };
        let Some(AttrVal::Expr(input_expr)) = jsx::attr(&attrs, input).map(|a| &a.value) else {
            return Err("region input".into());
        };
        let none = HashMap::new();
        let input_text = self.expr(inst, &none, input_expr)?;
        let kids = jsx::children(&el.children)?;
        let (content, param): (Vec<Child<'a>>, Option<SymbolId>) = if is_show {
            if kids.iter().any(|k| matches!(k, Child::Expr(e) if FnRef::from_expr(e).is_some())) {
                return Err("a live <Show> with a render callback".into());
            }
            (kids, None)
        } else {
            let [Child::Expr(f)] = kids.as_slice() else { return Err("<For> children must be one callback".into()) };
            let Some(f) = FnRef::from_expr(f) else { return Err("<For> children must be a callback".into()) };
            if f.params().items.len() > 1 {
                return Err("<For> callback with an index".into());
            }
            let p = f.params().items.first().and_then(|p| match &p.pattern {
                BindingPattern::BindingIdentifier(id) => id.symbol_id.get(),
                _ => None,
            });
            let Some(root) = fn_root(f) else { return Err("<For> callback must return JSX".into()) };
            let child = match root {
                Root::Element(e) => Child::Element(e),
                Root::Fragment(fr) => Child::Fragment(fr),
            };
            (vec![child], p)
        };
        // Builder scope.
        let param_name = param.map(|p| {
            let n = format!("{}{}", self.m.sym_name(p), self.fresh("$"));
            (p, n)
        });
        if let Some((p, n)) = &param_name {
            self.insts[inst].names.insert(*p, (n.clone(), Kind::Val));
        }
        let saved = self.cur;
        self.scopes.push(Scope {
            nav: vec![],
            fresh_nav: vec![],
            vars: HashMap::new(),
            buckets: HashMap::new(),
            order: vec![],
            builder: true,
            root_var: "$x".into(),
        });
        self.cur = self.scopes.len() - 1;
        let mut slots = Vec::new();
        self.flatten(&content, inst, &mut slots)?;
        let elems: Vec<&Slot<'a>> = slots.iter().filter(|s| !matches!(s, Slot::Text)).collect();
        let [Slot::Elem(root_el, root_inst)] = elems.as_slice() else {
            self.cur = saved;
            return Err("region content must be a single element".into());
        };
        let (root_el, root_inst) = (*root_el, *root_inst);
        let tpl = self.template_html(root_el, self.insts[root_inst].comp)?;
        let ti = self.templates.len();
        self.templates.push(tpl);
        self.helpers.insert("$tpl");
        self.element(root_el, root_inst, "$x")?;
        let body = self.assemble(self.cur, inst);
        let nav = self.scopes[self.cur].nav.join("\n");
        self.cur = saved;
        let builder = match &param_name {
            Some((_, n)) => format!("({n}, $e) => {{ const $f = !$e, $x = $e || $t{ti}();\n{nav}\n{body}\nreturn $x; }}"),
            None => format!("($e) => {{ const $f = !$e, $x = $e || $t{ti}();\n{nav}\n{body}\nreturn $x; }}"),
        };
        let line = if is_show {
            self.helpers.insert("$show");
            format!("$show({end}, () => {input_text}, {builder});")
        } else {
            self.helpers.insert("$list");
            format!("$list({end}, () => {input_text}, {builder});")
        };
        self.bucket(inst).seq.push(Seq::Line(line));
        Ok(())
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
                                if let Some(Expression::StringLiteral(s)) = x.as_expression().map(|x| x.without_parentheses()) {
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
        if kids.iter().any(|k| matches!(k, Child::Expr(e) if is_slot(e))) {
            return Err("`props.children` inside fresh island content".into());
        }
        let sole = kids.len() == 1 && matches!(kids[0], Child::Expr(e) if jsx::static_child(e).is_none());
        for k in &kids {
            match *k {
                Child::Text(sp) => out.push_str(&jsx::esc_text(&jsx::jsx_text(self.m, sp))),
                Child::Expr(e) => {
                    if let Some(s) = jsx::static_child(e) {
                        out.push_str(&jsx::esc_text(&s));
                    } else if sole {
                    } else if self.a.is_live_site(comp, e.span().start) {
                        out.push_str("<!--$--><!--/-->");
                    } else {
                        out.push_str("<!--!-->");
                    }
                }
                Child::Element(c) => match jsx::tag_of(self.m, &c.opening_element.name) {
                    Tag::Intrinsic(_) => self.tpl_el(c, comp, out)?,
                    Tag::Builtin(b) if b == "Show" || b == "For" => out.push_str("<!--$--><!--/-->"),
                    Tag::Comp(k) => {
                        // Inlined in fresh content: its view's static markup.
                        let view = self.m.comps[k].view.ok_or("component without a view")?;
                        match jsx::root_of(view) {
                            Some(Root::Element(e)) => self.tpl_el(e, k, out)?,
                            _ => return Err("fresh component content must be a single element".into()),
                        }
                    }
                    _ => return Err("unsupported element in fresh island content".into()),
                },
                Child::Fragment(_) => return Err("fragment in fresh island content".into()),
            }
        }
        let _ = write!(out, "</{tag}>");
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
        let Some(b) = self.scopes[scope].buckets.remove(&inst) else { return };
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
            if self.tier == 0 {
                let cells: BTreeSet<String> = live.iter().flat_map(|p| p.cells.iter().cloned()).collect();
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
                    let fields: Vec<String> = live.iter().enumerate().map(|(i, p)| format!("_{i}: {}", p.compute)).collect();
                    let applies: Vec<String> = live
                        .iter()
                        .enumerate()
                        .map(|(i, p)| format!("if (o._{i} !== q?._{i}) {{ const v = o._{i}; {}; }}", p.apply))
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
                let skip = if fresh { "$f ? 0 : 1" } else { "1" };
                let _ = writeln!(out, "{{ let $k = {skip}; $E(() => {}, v => {{ if ($k) {{ $k = 0; return; }} {}; }}); }}", p.compute, p.apply);
            } else {
                let skip = if fresh { "$f ? 0 : 1" } else { "1" };
                let fields: Vec<String> = live.iter().enumerate().map(|(i, p)| format!("_{i}: {}", p.compute)).collect();
                let applies: Vec<String> = live
                    .iter()
                    .enumerate()
                    .map(|(i, p)| format!("if (o._{i} !== q?._{i}) {{ const v = o._{i}; {}; }}", p.apply))
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
        if let Some(s) = f.concise()
        {
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

/// The view's first rendered node is an intrinsic element of its own JSX.
/// May the anchor element's subtree contain another island's anchor (a
/// component, a slot, or markup built by an expression inside it)?
fn anchor_nests<'a>(m: &Model<'_>, view: &'a Expression<'a>) -> bool {
    fn el_nests(m: &Model<'_>, el: &JSXElement<'_>) -> bool {
        let Ok(kids) = jsx::children(&el.children) else { return true };
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
        super::graph::find_jsx(unsafe { &*(e as *const Expression<'_>) }, &mut roots, &mut complete);
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
pub(crate) fn anchor_element<'a>(m: &Model<'_>, view: &'a Expression<'a>) -> Option<&'a JSXElement<'a>> {
    fn first<'a>(m: &Model<'_>, kids: &'a [oxc_ast::ast::JSXChild<'a>]) -> Option<&'a JSXElement<'a>> {
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
