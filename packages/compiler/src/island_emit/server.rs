//! Server emission: every component becomes a string-template function
//! `(props, $c) => string` (async only when it awaits server data).
//!
//! No owner, no hydration keys, no hole thunks, nothing serialized for inert
//! regions. Only island-relevant marks are added: the anchor (`data-i` on
//! the island root's first element, or `<!--i:…-->`), the island's
//! serialized values (`data-s`, only what its client code reads from props
//! or server-initialized cells), `<!--$-->…<!--/-->` around live text holes
//! that share their element and around live `Show` / `For` regions, and
//! `data-pd` on elements whose lazily loaded handler calls
//! `preventDefault()`. Context travels as a `Map` argument (`$c`).
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use oxc_ast::ast::{Expression, JSXElement, Statement, VariableDeclarator};
use oxc_semantic::SymbolId;
use oxc_span::{GetSpan, Span};

use super::client::{GroupCode, Serial, first_is_element};
use super::graph::{Analysis, SiteKind, refs_expr};
use super::jsx::{self, AttrVal, Child, Root, Tag};
use super::model::{FnRef, Item, LocalDecl, Model};
use super::tx::{Env, R, Tx};
use crate::store_scalars::splice;

pub(crate) const SERVER_HELPERS: &str = r#"
function _$esc(s) { return /[&<]/.test(s) ? s.replace(/&/g, "&amp;").replace(/</g, "&lt;") : s; }
function _$e(v) { if (typeof v === "string") return _$esc(v); if (v == null || typeof v === "boolean") return ""; if (typeof v === "number") return "" + v; if (Array.isArray(v)) { let s = ""; for (const x of v) s += _$e(x); return s; } if (typeof v === "function") return _$e(v()); if (typeof v === "object" && "t" in v) return v.t; return _$esc(String(v)); }
function _$raw(v) { return typeof v === "string" ? v : _$e(v); }
function _$ea(v) { v = String(v); return /[&"<]/.test(v) ? v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") : v; }
function _$a(n, v) { return v == null || v === false ? "" : v === true ? " " + n : " " + n + '="' + _$ea(v) + '"'; }
function _$cls(v) { if (typeof v === "number") return "" + v; if (!v) return ""; if (typeof v === "string") return _$ea(v); const o = {}; const f = l => { for (const x of l) Array.isArray(x) ? f(x) : x && typeof x === "object" ? Object.assign(o, x) : typeof x !== "boolean" && (x || x === 0) && (o[x] = true); }; Array.isArray(v) ? f(v) : Object.assign(o, v); let r = ""; for (const k in o) if (k && k !== "undefined" && o[k]) r += (r ? " " : "") + _$ea(k); return r; }
function _$sty(v) { if (!v) return ""; if (typeof v === "string") return _$ea(v); let r = ""; const k = Object.keys(v); for (let i = 0; i < k.length; i++) { const x = v[k[i]]; if (x != undefined) { if (i) r += ";"; r += _$ea(k[i]) + ":" + _$ea(x); } } return r; }
function _$r(v) { return typeof v === "function" ? v() : v; }
function _$m(f) { let s = 0, v; return () => (s ? v : ((s = 1), (v = f()))); }
function _$v(x) { return () => x; }
function _$cell(x) { return [() => x, y => y]; }
function _$noop() {}
function _$ctx(c, k) { return c && c.has(k) ? c.get(k) : k.defaultValue; }
function _$forR(l, f, fb) { if (!l || !l.length) return _$e(fb); let s = ""; for (let i = 0; i < l.length; i++) s += f(l[i], () => i); return s; }
function _$for(l, f, fb) { if (!l || !l.length) return _$e(fb); let s = ""; for (let i = 0; i < l.length; i++) s += _$e(f(l[i], () => i)); return s; }
async function _$forA(l, f, fb) { if (!l || !l.length) return _$e(fb); const r = await Promise.all(l.map((x, i) => f(x, () => i))); let s = ""; for (const x of r) s += _$e(x); return s; }
function _$err(f, fb) { try { return _$e(f()); } catch (e) { return _$e(typeof fb === "function" ? fb(() => e, () => {}) : fb); } }
async function _$errA(f, fb) { try { return _$e(await f()); } catch (e) { return _$e(typeof fb === "function" ? fb(() => e, () => {}) : fb); } }
async function _$proj(f, seed) { const d = seed === undefined ? {} : structuredClone(seed); const r = await f(d); return r === undefined ? d : r; }
function _$cv(v, n) { const ok = x => x === null || ["string", "number", "boolean"].includes(typeof x) || (Array.isArray(x) ? x.every(ok) : typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype && Object.values(x).every(ok)); if (v !== undefined && !ok(v)) throw new Error("island context `" + n + "` is provided outside the island with a value that is not serializable"); return v; }
function _$pick(o, ks) { const r = {}; for (const k of ks) if (k in o) r[k] = o[k]; return r; }
function _$ld($c, f, fb) { const s = $c && $c.get(Symbol.for("solid.islands.stream")); return s ? s.boundary($c, f, fb, _$e) : f($c); }
function _$errS($c, f, fb) { const s = $c && $c.get(Symbol.for("solid.islands.stream")); return s ? s.errored($c, f, fb, _$e) : _$errA(() => f($c), fb); }
"#;

struct Se<'x, 'a> {
    m: &'x Model<'a>,
    a: &'x Analysis<'a>,
    is_async: Vec<bool>,
    /// Island ids rooted at each component, with their client needs.
    roots: HashMap<usize, Vec<(String, &'x GroupCode, usize)>>,
    /// Handler elements whose handler prevents default (by span start).
    pd: HashSet<u32>,
    /// Components whose view has a `<Loading>` over server data (streamed).
    streams: std::cell::RefCell<HashSet<usize>>,
    /// Each group's effective tier (its chunk's).
    tiers: HashMap<usize, u8>,
    /// Some island serializes a pruned prop (the `_$pp` helper is needed).
    pruned: std::cell::Cell<bool>,
    /// An island anchor carries a key (`_$k`).
    keys: std::cell::Cell<bool>,
    /// The module renders its router (`_$router`).
    router: std::cell::Cell<bool>,
    /// The module has frames: server rows carry their item's key (`$c`).
    keyed: bool,
}

/// Island keys: a component's `$key` prop, else the enclosing server
/// row's item key (a path of `id`s), carried in the render context.
pub(crate) const KEY_HELPERS: &str = r#"const _$RK = Symbol.for("solid.frames.key");
function _$k(p, $c) { const k = p && p.$key != null ? p.$key : $c && $c.get(_$RK); return k == null ? "" : ' data-k="' + _$ea(k) + '"'; }
function _$rk($c, x) { if (!x || typeof x !== "object" || x.id == null) return $c; const p = $c && $c.get(_$RK); return new Map($c).set(_$RK, p != null ? p + "/" + x.id : "" + x.id); }
function _$forK($c, l, f, fb) { if (!l || !l.length) return _$e(fb); let s = ""; for (let i = 0; i < l.length; i++) s += f(l[i], () => i, _$rk($c, l[i])); return s; }
function _$forFK($c, l, f, fb) { if (!l || !l.length) return _$e(fb); let s = ""; for (let i = 0; i < l.length; i++) s += _$e(f(l[i], () => i, _$rk($c, l[i]))); return s; }
async function _$forAK($c, l, f, fb) { if (!l || !l.length) return _$e(fb); const r = await Promise.all(l.map((x, i) => f(x, () => i, _$rk($c, x)))); let s = ""; for (const x of r) s += _$e(x); return s; }
"#;

/// The module's router: match the request's URL (`$c`) against the route
/// table and render the layout around the matched route in its outlet.
pub(crate) const ROUTER_HELPERS: &str = r#"function _$match(p, path) { const a = p.split("/").filter(Boolean), b = path.split("/").filter(Boolean), params = {}; for (let i = 0; i < a.length; i++) { const s = a[i]; if (s[0] === "*") { params[s.slice(1) || "*"] = b.slice(i).join("/"); return params; } if (s[0] === ":") { const opt = s.endsWith("?"); if (b[i] === undefined) { if (opt) continue; return null; } params[s.slice(1, opt ? -1 : undefined)] = decodeURIComponent(b[i]); continue; } if (s !== b[i]) return null; } return a.length >= b.length ? params : null; }
function _$loc(u) { return { pathname: u.pathname, search: u.search, hash: u.hash, query: Object.fromEntries(u.searchParams) }; }
async function _$router($c, routes, layout) { const u = new URL(($c && $c.get(Symbol.for("solid.islands.url"))) || "/", "http://localhost"); let html = ""; out: for (const [paths, C] of routes) for (const p of paths) { const params = _$match(p, u.pathname); if (params) { html = await C({ params, location: _$loc(u) }, $c); break out; } } return layout({ children: { t: "<!--o-->" + html + "<!--/o-->" } }); }
"#;

/// `(c)` → `c, $i, $c`; `(c, i)` → `c, i, $c`: a keyed row callback's
/// parameters (the row's render context last).
fn keyed_params(params: &str) -> String {
    let p = params.trim();
    if p.is_empty() {
        "_, $i, $c".into()
    } else if p.contains(',') {
        format!("{p}, $c")
    } else {
        format!("{p}, $i, $c")
    }
}

/// `[["title"], ["by", "name"]]`.
pub(crate) fn paths_js(paths: &std::collections::BTreeSet<Vec<String>>) -> String {
    let parts: Vec<String> = paths
        .iter()
        .map(|p| {
            format!(
                "[{}]",
                p.iter()
                    .map(|k| super::client_js_str(k))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect();
    format!("[{}]", parts.join(", "))
}

/// A value pruned to the paths client code reads (`paths_js`): plain
/// objects keep only those keys, anything else is kept whole.
pub(crate) const PRUNE_HELPER: &str = "function _$pp(v, ps) { if (v === null || typeof v !== \"object\" || Array.isArray(v)) return v; const g = {}; for (const [k, ...r] of ps) g[k] = r.length && g[k] !== 0 ? (g[k] || []).concat([r]) : 0; const o = {}; for (const k in g) if (k in v) o[k] = g[k] === 0 ? v[k] : _$pp(v[k], g[k]); return o; }\n";

struct SEnv<'e, 'x, 'a> {
    se: &'e Se<'x, 'a>,
    comp: usize,
}

impl<'a> Env<'a> for SEnv<'_, '_, 'a> {
    fn read(&self, tx: &Tx<'_, 'a>, arg: &'a Expression<'a>) -> R<String> {
        let arg = arg.without_parentheses();
        match arg {
            Expression::Identifier(id) => {
                let s = self.se.m.symbol_of(id);
                let acc = s.is_some_and(|s| {
                    self.se.m.comps[self.comp].setup.iter().any(|it| match it {
                        Item::Cell { get, .. } => *get == s && !it.store_like(),
                        Item::Memo { sym, .. } => *sym == s,
                        _ => false,
                    })
                });
                Ok(if acc {
                    format!("{}()", id.name)
                } else {
                    format!("_$r({})", id.name)
                })
            }
            Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_) => {
                let mut root = arg;
                let mut first: Option<&'a Expression<'a>> = None;
                loop {
                    match root {
                        Expression::StaticMemberExpression(s) => {
                            first = Some(root);
                            root = &s.object;
                        }
                        Expression::ComputedMemberExpression(c) => {
                            first = Some(root);
                            root = &c.object;
                        }
                        _ => break,
                    }
                }
                let props = self.se.m.comps[self.comp].props;
                if props.is_some()
                    && self.se.m.symbol_of_expr(root) == props
                    && let Some(Expression::StaticMemberExpression(f)) = first
                {
                    let rest = &tx.m.src[f.span.end as usize..arg.span().end as usize];
                    return Ok(format!(
                        "_$r({}.{}){rest}",
                        tx.m.text(root.span()),
                        f.property.name
                    ));
                }
                let root_text = tx.expr(self, root)?;
                let rest = &tx.m.src[root.span().end as usize..arg.span().end as usize];
                Ok(format!("_$r(_$r({root_text}){rest})"))
            }
            Expression::CallExpression(c) => {
                match self.se.m.runtime_name(&c.callee) {
                    Some("$cleanup" | "$flush") => return Ok("void 0".into()),
                    Some("readStore") => {
                        let (Some(store), Some(sel)) = (
                            c.arguments.first().and_then(|a| a.as_expression()),
                            c.arguments.get(1).and_then(|a| a.as_expression()),
                        ) else {
                            return Err("readStore without a store and a selector".into());
                        };
                        let st = tx.expr(self, store)?;
                        let f = tx.expr(self, sel)?;
                        return Ok(format!("({f})(_$r({st}))"));
                    }
                    Some("attempt") => {
                        let f = c
                            .arguments
                            .first()
                            .and_then(|a| a.as_expression())
                            .ok_or("attempt without a function")?;
                        let f = tx.expr(self, f)?;
                        return Ok(format!("(await ({f})())"));
                    }
                    Some(other) if other.starts_with('$') => {
                        return Err(format!("`yield* {other}` on the server"));
                    }
                    _ => {}
                }
                if let Some(s) = self.se.m.symbol_of_expr(&c.callee)
                    && let Some(k) = self.se.m.comp_of.get(&s)
                {
                    // `yield* Child(props)`: render the child.
                    let props = c.arguments.first().and_then(|a| a.as_expression());
                    let p = match props {
                        Some(p) => tx.expr(self, p)?,
                        None => "{}".into(),
                    };
                    let aw = if self.se.is_async[*k] { "await " } else { "" };
                    return Ok(format!(
                        "{{ t: {aw}{}({p}, $c) }}",
                        self.se.m.comps[*k].name
                    ));
                }
                let inner = tx.expr(self, arg)?;
                Ok(inner)
            }
            _ => {
                let inner = tx.expr(self, arg)?;
                Ok(format!("_$r({inner})"))
            }
        }
    }
    fn call(&self, _tx: &Tx<'_, 'a>, c: &'a oxc_ast::ast::CallExpression<'a>) -> R<Option<String>> {
        if self.se.m.runtime_name(&c.callee) == Some("$event") {
            return Ok(Some("_$noop".into()));
        }
        Ok(None)
    }
    fn jsx(&self, tx: &Tx<'_, 'a>, e: &'a Expression<'a>) -> R<String> {
        let mut out = String::new();
        self.se.root(self.comp, e, &mut out, None)?;
        let _ = tx;
        Ok(format!("({{ t: `{out}` }})"))
    }
}

/// A frame function's environment: the memo's one `attempt` is the server
/// call over the frame's arguments (`$a`).
struct FrameEnv<'e, 'x, 'a> {
    inner: SEnv<'e, 'x, 'a>,
    callee: String,
}

impl<'a> Env<'a> for FrameEnv<'_, '_, 'a> {
    fn read(&self, tx: &Tx<'_, 'a>, arg: &'a Expression<'a>) -> R<String> {
        if let Expression::CallExpression(c) = arg.without_parentheses()
            && self.inner.se.m.runtime_name(&c.callee) == Some("attempt")
        {
            return Ok(format!("(await {}(...$a))", self.callee));
        }
        self.inner.read(tx, arg)
    }
    fn call(&self, tx: &Tx<'_, 'a>, c: &'a oxc_ast::ast::CallExpression<'a>) -> R<Option<String>> {
        self.inner.call(tx, c)
    }
    fn jsx(&self, tx: &Tx<'_, 'a>, e: &'a Expression<'a>) -> R<String> {
        self.inner.jsx(tx, e)
    }
}

fn tl(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('`', "\\`")
        .replace("${", "\\${")
}

impl<'x, 'a> Se<'x, 'a> {
    fn tx(&self) -> Tx<'x, 'a> {
        Tx { m: self.m }
    }
    fn expr(&self, comp: usize, e: &'a Expression<'a>) -> R<String> {
        let env = SEnv { se: self, comp };
        self.tx().expr(&env, e)
    }

    /// A JSX root (element / fragment / expression) into template text.
    fn root(
        &self,
        comp: usize,
        e: &'a Expression<'a>,
        out: &mut String,
        anchor: Option<&str>,
    ) -> R<()> {
        match jsx::root_of(e) {
            Some(Root::Element(el)) => self.element(comp, el, out, anchor),
            Some(Root::Fragment(f)) => {
                let kids = jsx::children(&f.children)?;
                self.kids(comp, &kids, out, anchor, false)
            }
            None => {
                if let Some(a) = anchor {
                    out.push_str(a);
                }
                let v = self.expr(comp, e)?;
                if self.a.is_live_site(comp, e.span().start) {
                    let _ = write!(out, "<!--$-->${{_$e({v})}}<!--/-->");
                } else {
                    let _ = write!(out, "${{_$e({v})}}");
                }
                Ok(())
            }
        }
    }

    fn kids(
        &self,
        comp: usize,
        kids: &[Child<'a>],
        out: &mut String,
        mut anchor: Option<&str>,
        sole: bool,
    ) -> R<()> {
        for k in kids {
            match *k {
                Child::Text(sp) => out.push_str(&tl(&jsx::esc_text(&jsx::jsx_text(self.m, sp)))),
                Child::Expr(e) => {
                    if let Some(s) = jsx::static_child(e) {
                        out.push_str(&tl(&jsx::esc_text(&s)));
                        continue;
                    }
                    if let Expression::StaticMemberExpression(me) = e.without_parentheses()
                        && me.property.name == "children"
                        && self.m.comps[comp].props.is_some()
                        && self.m.symbol_of_expr(&me.object) == self.m.comps[comp].props
                    {
                        let _ = write!(out, "${{_$e({}.children)}}", self.m.text(me.object.span()));
                        continue;
                    }
                    let v = self.expr(comp, e)?;
                    if !sole && self.a.is_live_site(comp, e.span().start) {
                        let _ = write!(out, "<!--$-->${{_$e({v})}}<!--/-->");
                    } else {
                        let _ = write!(out, "${{_$e({v})}}");
                    }
                }
                Child::Element(el) => {
                    let takes = match jsx::tag_of(self.m, &el.opening_element.name) {
                        Tag::Intrinsic(_) | Tag::Provider(_) => true,
                        Tag::Builtin(b) => b == "Loading" || b == "Errored",
                        _ => false,
                    };
                    if takes {
                        self.element(comp, el, out, anchor.take())?;
                    } else {
                        self.element(comp, el, out, None)?;
                    }
                }
                Child::Fragment(f) => {
                    let ks = jsx::children(&f.children)?;
                    self.kids(comp, &ks, out, anchor.take(), false)?;
                }
            }
        }
        Ok(())
    }

    /// An `<Errored>` around live content of a tier-2 island group (its
    /// sites, or a member it renders): the client keeps a boundary there.
    fn live_boundary(&self, comp: usize, span: Span) -> bool {
        let inside = |sp: Span| span.start <= sp.start && sp.end <= span.end;
        self.a.groups.iter().enumerate().any(|(gi, g)| {
            self.tiers.get(&gi).copied().unwrap_or(g.tier) >= 2
                && (g
                    .sites
                    .iter()
                    .any(|(c, s)| *c == comp && inside(self.a.facts[*c].sites[*s].span))
                    || self.a.facts[comp].calls.iter().any(|call| {
                        inside(call.span)
                            && matches!(call.tag, Tag::Comp(k) if g.members.contains(&k))
                    }))
        })
    }

    fn subtree_async(&self, span: Span, comp: usize) -> bool {
        if self.a.facts[comp]
            .router
            .is_some_and(|r| span.start <= r.start && r.end <= span.end)
        {
            return true;
        }
        self.a.facts[comp].calls.iter().any(|c| {
            span.start <= c.span.start
                && c.span.end <= span.end
                && match c.tag {
                    Tag::Comp(k) => self.is_async[k],
                    Tag::Opaque(_) => true,
                    _ => false,
                }
        })
    }

    fn element(
        &self,
        comp: usize,
        el: &'a JSXElement<'a>,
        out: &mut String,
        anchor: Option<&str>,
    ) -> R<()> {
        let attrs = jsx::attrs(el)?;
        match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(tag) => {
                let _ = write!(out, "<{tag}");
                if let Some(a) = anchor {
                    out.push_str(a);
                }
                if let Some(fr) = self
                    .a
                    .frames
                    .iter()
                    .find(|f| f.comp == comp && f.region.span == el.span)
                {
                    let _ = write!(out, " data-f=\"{}\"", fr.sid);
                }
                let mut content: Option<String> = None;
                let mut pd = false;
                for at in &attrs {
                    let name = at.name.as_str();
                    match &at.value {
                        AttrVal::True => {
                            let _ = write!(out, " {name}");
                        }
                        AttrVal::Str(s) => {
                            let v = crate::shared::utils::normalize_static_attribute_value(name, s);
                            if name == "innerHTML" {
                                content = Some(tl(&v));
                            } else if name == "textContent" {
                                content = Some(tl(&jsx::esc_text(&v)));
                            } else {
                                let _ = write!(out, " {name}=\"{}\"", tl(&jsx::esc_attr(&v)));
                            }
                        }
                        AttrVal::Expr(e) => {
                            if jsx::is_event_attr(name) {
                                pd |= self.pd.contains(&e.span().start);
                                continue;
                            }
                            if name == "ref" || name.starts_with("prop:") {
                                continue;
                            }
                            if let Some(s) = jsx::static_child(e)
                                && name != "innerHTML"
                                && name != "textContent"
                            {
                                let _ = write!(out, " {name}=\"{}\"", tl(&jsx::esc_attr(&s)));
                                continue;
                            }
                            let v = self.expr(comp, e)?;
                            match name {
                                "class" => {
                                    let _ = write!(out, " class=\"${{_$cls({v})}}\"");
                                }
                                "style" => {
                                    let _ = write!(out, " style=\"${{_$sty({v})}}\"");
                                }
                                "innerHTML" => content = Some(format!("${{_$raw({v}) ?? \"\"}}")),
                                "textContent" => content = Some(format!("${{_$e({v})}}")),
                                n => {
                                    let n = n.strip_prefix("attr:").unwrap_or(n);
                                    let _ =
                                        write!(out, "${{_$a({}, {v})}}", super::client_js_str(n));
                                }
                            }
                        }
                        AttrVal::Element(_) | AttrVal::Fragment(_) => {
                            return Err(format!("JSX as the value of attribute `{name}`"));
                        }
                    }
                }
                if pd {
                    out.push_str(" data-pd");
                }
                out.push('>');
                if jsx::is_void(&tag) {
                    return Ok(());
                }
                if let Some(c) = content {
                    out.push_str(&c);
                } else {
                    let kids = jsx::children(&el.children)?;
                    let sole = kids.len() == 1
                        && matches!(kids[0], Child::Expr(e) if jsx::static_child(e).is_none());
                    self.kids(comp, &kids, out, None, sole)?;
                }
                let _ = write!(out, "</{tag}>");
                Ok(())
            }
            Tag::Comp(k) => {
                if let Some(a) = anchor {
                    out.push_str(a);
                }
                let props = self.props_object(comp, el, &attrs)?;
                let aw = if self.is_async[k] { "await " } else { "" };
                let name = &self.m.comps[k].name;
                if self.m.comps[k].sym.is_none() {
                    return Err(format!(
                        "a default-exported $component rendered in its module (`{name}`)"
                    ));
                }
                let _ = write!(out, "${{{aw}{name}({props}, $c)}}");
                Ok(())
            }
            Tag::Opaque(name) => {
                if let Some(a) = anchor {
                    out.push_str(a);
                }
                let props = self.props_object(comp, el, &attrs)?;
                let callee = self.m.text(el.opening_element.name.span());
                let _ = name;
                let _ = write!(out, "${{_$raw(await {callee}({props}, $c))}}");
                Ok(())
            }
            Tag::Router => {
                if let Some(a) = anchor {
                    out.push_str(a);
                }
                let router = self.m.router.as_ref().ok_or("a <Router> without a router")?;
                let kids = jsx::children(&el.children)?;
                let Some(f) = (match kids.as_slice() {
                    [Child::Expr(e)] => FnRef::from_expr(e),
                    _ => None,
                }) else {
                    return Err("a <Router> without a layout callback".into());
                };
                let Some(body) = jsx_body(f) else {
                    return Err("a <Router> layout that is not one JSX expression".into());
                };
                let params = self.tx().params(&SEnv { se: self, comp }, f)?;
                let mut inner = String::new();
                self.root(comp, body, &mut inner, None)?;
                let routes: Vec<String> = router
                    .routes
                    .iter()
                    .filter(|r| r.comp.is_some())
                    .map(|r| {
                        format!(
                            "[[{}], {}]",
                            r.paths
                                .iter()
                                .map(|p| super::client_js_str(p))
                                .collect::<Vec<_>>()
                                .join(", "),
                            r.comp_name
                        )
                    })
                    .collect();
                self.router.set(true);
                let _ = write!(
                    out,
                    "${{await _$router($c, [{}], async ({params}) => `{inner}`)}}",
                    routes.join(", ")
                );
                Ok(())
            }
            Tag::Provider(ctx) => {
                let value = match jsx::attr(&attrs, "value").map(|a| &a.value) {
                    Some(AttrVal::Expr(e)) => self.expr(comp, e)?,
                    Some(AttrVal::Str(s)) => super::client_js_str(s),
                    _ => "undefined".into(),
                };
                let kids = jsx::children(&el.children)?;
                let mut inner = String::new();
                self.kids(comp, &kids, &mut inner, anchor, false)?;
                let is_async = self.subtree_async(el.span, comp);
                let ctx_name = self.m.sym_name(ctx);
                if is_async {
                    let _ = write!(
                        out,
                        "${{await (async ($c) => `{inner}`)(new Map($c).set({ctx_name}, {value}))}}"
                    );
                } else {
                    let _ = write!(
                        out,
                        "${{(($c) => `{inner}`)(new Map($c).set({ctx_name}, {value}))}}"
                    );
                }
                Ok(())
            }
            Tag::Builtin(b) => {
                let is_async = self.subtree_async(el.span, comp);
                let aw = if is_async { "await " } else { "" };
                let asy = if is_async { "async " } else { "" };
                match b.as_str() {
                    "Loading" => {
                        let kids = jsx::children(&el.children)?;
                        if !is_async {
                            // Nothing to wait for: the content renders in place.
                            return self.kids(comp, &kids, out, anchor, false);
                        }
                        // A boundary over server data: streamed out of order
                        // when the render has a stream (`_$ld`), its fallback
                        // in the shell; awaited in place otherwise.
                        self.streams.borrow_mut().insert(comp);
                        let mut inner = String::new();
                        self.kids(comp, &kids, &mut inner, anchor, false)?;
                        let fb = self.fallback_raw(comp, &attrs)?;
                        let _ = write!(
                            out,
                            "${{await _$ld($c, async ($c) => `{inner}`, () => {fb})}}"
                        );
                        Ok(())
                    }
                    "Errored" => {
                        let kids = jsx::children(&el.children)?;
                        let mut inner = String::new();
                        self.kids(comp, &kids, &mut inner, anchor, false)?;
                        let fb = self.fallback(comp, &attrs)?;
                        // Around a tier-2 island's live content the client
                        // keeps an error boundary: mark its region.
                        let live = self.live_boundary(comp, el.span);
                        if live {
                            out.push_str("<!--$-->");
                        }
                        if is_async {
                            // Streamed boundaries inside route their failures here.
                            let _ = write!(
                                out,
                                "${{await _$errS($c, async ($c) => ({{ t: `{inner}` }}), {fb})}}"
                            );
                        } else {
                            let _ = write!(out, "${{_$err(() => ({{ t: `{inner}` }}), {fb})}}");
                        }
                        if live {
                            out.push_str("<!--/-->");
                        }
                        Ok(())
                    }
                    "Show" | "For" => {
                        let input = if b == "Show" { "when" } else { "each" };
                        let Some(AttrVal::Expr(ie)) = jsx::attr(&attrs, input).map(|a| &a.value)
                        else {
                            return Err(format!("<{b}> without `{input}`"));
                        };
                        // A live region, or a structural one (over server
                        // data, holding an island's rows): marked.
                        let live = self.a.is_live_site(comp, ie.span().start)
                            || self.a.structural.contains_key(&(comp, ie.span().start));
                        let iv = self.expr(comp, ie)?;
                        let fb = self.fallback(comp, &attrs)?;
                        let kids = jsx::children(&el.children)?;
                        let func = match kids.as_slice() {
                            [Child::Expr(e)] => FnRef::from_expr(e),
                            _ => None,
                        };
                        if live {
                            out.push_str("<!--$-->");
                        }
                        if b == "Show" && func.is_none() && !is_async {
                            // Markup children: a plain conditional of templates.
                            let mut inner = String::new();
                            self.kids(comp, &kids, &mut inner, None, false)?;
                            let fb = self.fallback_raw(comp, &attrs)?;
                            let _ = write!(out, "${{({iv}) ? `{inner}` : {fb}}}");
                        } else if b == "Show" {
                            let keyed = jsx::attr(&attrs, "keyed").is_some();
                            let child = match func {
                                Some(f) => {
                                    let ft = self.func(comp, f, is_async)?;
                                    let arg = if keyed { "$w" } else { "() => $w" };
                                    format!("{aw}({ft})({arg})")
                                }
                                None => {
                                    let mut inner = String::new();
                                    self.kids(comp, &kids, &mut inner, None, false)?;
                                    format!("{{ t: `{inner}` }}")
                                }
                            };
                            let _ = write!(
                                out,
                                "${{_$e({aw}({asy}($w) => $w ? {child} : {fb})({iv}))}}"
                            );
                        } else {
                            let Some(f) = func else {
                                return Err("<For> children must be a callback".into());
                            };
                            if let (Some(body), false) = (jsx_body(f), is_async) {
                                // A row template: the callback returns markup, joined raw.
                                let params = self.tx().params(&SEnv { se: self, comp }, f)?;
                                let mut inner = String::new();
                                self.root(comp, body, &mut inner, None)?;
                                if self.keyed && !live {
                                    // Each row's islands are keyed by its item.
                                    let _ = write!(
                                        out,
                                        "${{_$forK($c, {iv}, ({}) => `{inner}`, {fb})}}",
                                        keyed_params(&params)
                                    );
                                } else {
                                    let _ = write!(
                                        out,
                                        "${{_$forR({iv}, ({params}) => `{inner}`, {fb})}}"
                                    );
                                }
                            } else if self.keyed && !live {
                                let params = self.tx().params(&SEnv { se: self, comp }, f)?;
                                let body = self.tx().body(&SEnv { se: self, comp }, f)?;
                                let body = if f.is_concise() { format!("({body})") } else { body };
                                let asy = if is_async { "async " } else { "" };
                                let helper = if is_async { "_$forAK" } else { "_$forFK" };
                                let _ = write!(
                                    out,
                                    "${{{aw}{helper}($c, {iv}, {asy}({}) => {body}, {fb})}}",
                                    keyed_params(&params)
                                );
                            } else {
                                let ft = self.func(comp, f, is_async)?;
                                let helper = if is_async { "_$forA" } else { "_$for" };
                                let _ = write!(out, "${{{aw}{helper}({iv}, {ft}, {fb})}}");
                            }
                        }
                        if live {
                            out.push_str("<!--/-->");
                        }
                        Ok(())
                    }
                    other => Err(format!("<{other}> in islands mode")),
                }
            }
        }
    }

    /// A fallback as a raw-markup string expression.
    fn fallback_raw(&self, comp: usize, attrs: &[jsx::Attr<'a>]) -> R<String> {
        Ok(match jsx::attr(attrs, "fallback").map(|a| &a.value) {
            None => "\"\"".into(),
            Some(AttrVal::Element(e)) => {
                let mut inner = String::new();
                self.element(comp, e, &mut inner, None)?;
                format!("`{inner}`")
            }
            Some(AttrVal::Fragment(f)) => {
                let mut inner = String::new();
                let ks = jsx::children(&f.children)?;
                self.kids(comp, &ks, &mut inner, None, false)?;
                format!("`{inner}`")
            }
            _ => format!("_$e({})", self.fallback(comp, attrs)?),
        })
    }

    fn fallback(&self, comp: usize, attrs: &[jsx::Attr<'a>]) -> R<String> {
        Ok(match jsx::attr(attrs, "fallback").map(|a| &a.value) {
            None => "\"\"".into(),
            Some(AttrVal::Str(s)) => super::client_js_str(s),
            Some(AttrVal::Expr(e)) => self.expr(comp, e)?,
            Some(AttrVal::Element(e)) => {
                let mut inner = String::new();
                self.element(comp, e, &mut inner, None)?;
                format!("{{ t: `{inner}` }}")
            }
            Some(AttrVal::Fragment(f)) => {
                let mut inner = String::new();
                let ks = jsx::children(&f.children)?;
                self.kids(comp, &ks, &mut inner, None, false)?;
                format!("{{ t: `{inner}` }}")
            }
            Some(AttrVal::True) => "true".into(),
        })
    }

    fn func(&self, comp: usize, f: FnRef<'a>, is_async: bool) -> R<String> {
        let env = SEnv { se: self, comp };
        self.tx().func(&env, f, is_async)
    }

    fn props_object(
        &self,
        comp: usize,
        el: &'a JSXElement<'a>,
        attrs: &[jsx::Attr<'a>],
    ) -> R<String> {
        let mut parts = Vec::new();
        for at in attrs {
            let key = super::client_js_str(&at.name);
            let v = match &at.value {
                AttrVal::True => "true".into(),
                AttrVal::Str(s) => super::client_js_str(s),
                AttrVal::Expr(e) => self.expr(comp, e)?,
                AttrVal::Element(e) => {
                    let mut inner = String::new();
                    self.element(comp, e, &mut inner, None)?;
                    format!("{{ t: `{inner}` }}")
                }
                AttrVal::Fragment(f) => {
                    let mut inner = String::new();
                    let ks = jsx::children(&f.children)?;
                    self.kids(comp, &ks, &mut inner, None, false)?;
                    format!("{{ t: `{inner}` }}")
                }
            };
            parts.push(format!("{key}: {v}"));
        }
        let kids = jsx::children(&el.children)?;
        if !kids.is_empty() {
            let v = match kids.as_slice() {
                [Child::Expr(e)] if FnRef::from_expr(e).is_some() => self.expr(comp, e)?,
                _ => {
                    let mut inner = String::new();
                    self.kids(comp, &kids, &mut inner, None, false)?;
                    format!("{{ t: `{inner}` }}")
                }
            };
            parts.push(format!("children: {v}"));
        }
        Ok(format!("{{ {} }}", parts.join(", ")))
    }

    /// The component's string function.
    fn component(&self, ci: usize) -> R<String> {
        let c = &self.m.comps[ci];
        let props = c
            .props
            .map_or("_$p".to_string(), |p| self.m.sym_name(p).to_string());
        let mut body = String::new();
        let env = SEnv { se: self, comp: ci };
        let tx = self.tx();
        for item in &c.setup {
            body.push_str(&self.setup_line(ci, item)?);
        }
        for s in &c.view_stmts {
            let _ = writeln!(body, "{}", tx.stmt(&env, s)?);
        }
        self.finish_component(ci, &props, body)
    }

    /// One setup item's server statement(s).
    fn setup_line(&self, ci: usize, item: &'a Item<'a>) -> R<String> {
        let mut body = String::new();
        let env = SEnv { se: self, comp: ci };
        let tx = self.tx();
        {
            match item {
                Item::Cell {
                    get,
                    set,
                    init,
                    rest,
                    ..
                } => {
                    let init_text = match init {
                        Some(e) => tx.expr(&env, e)?,
                        None => "undefined".into(),
                    };
                    let g = self.m.sym_name(*get);
                    let pat = match set {
                        Some(s) => format!("[{g}, {}]", self.m.sym_name(*s)),
                        None => format!("[{g}]"),
                    };
                    if item.derived() {
                        // A projection / derived cell: server-authoritative,
                        // its settled value awaited (like an async memo).
                        if item.store_like() {
                            let seed = match rest.first() {
                                Some(e) => tx.expr(&env, e)?,
                                None => "undefined".into(),
                            };
                            let _ = writeln!(
                                body,
                                "const {pat} = [await _$proj({init_text}, {seed}), _$noop];"
                            );
                        } else {
                            let _ = writeln!(
                                body,
                                "const {pat} = [_$v(await ({init_text})()), _$noop];"
                            );
                        }
                    } else if item.store_like() {
                        let _ = writeln!(body, "const {pat} = [{init_text}, _$noop];");
                    } else {
                        let _ = writeln!(body, "const {pat} = _$cell({init_text});");
                    }
                }
                Item::Memo {
                    sym,
                    body: f,
                    is_async,
                    ..
                } => {
                    let name = self.m.sym_name(*sym);
                    if *is_async {
                        let fb = tx.func(&env, *f, true)?;
                        let _ = writeln!(body, "const {name} = _$v(await ({fb})());");
                    } else {
                        let fb = tx.func(&env, *f, false)?;
                        let _ = writeln!(body, "const {name} = _$m({fb});");
                    }
                }
                Item::Event { sym, .. } => {
                    let _ = writeln!(body, "const {} = _$noop;", self.m.sym_name(*sym));
                }
                Item::Effect { .. } | Item::Cleanup { .. } => {}
                Item::Context { pattern, ctx, .. } => {
                    let _ = writeln!(
                        body,
                        "const {} = _$ctx($c, {});",
                        self.m.text(pattern.span()),
                        self.m.sym_name(*ctx)
                    );
                }
                Item::Local { decl, .. } => match decl {
                    LocalDecl::Var(d) => {
                        let _ = writeln!(body, "let {};", declarator(self, &env, d)?);
                    }
                    LocalDecl::Func(f) => {
                        let name = f.id.as_ref().map_or(String::new(), |i| i.name.to_string());
                        let func = tx.func(&env, FnRef::Func(f), f.r#async)?;
                        let _ = writeln!(body, "const {name} = {func};");
                    }
                },
                Item::Stmt { stmt, .. } => {
                    let _ = writeln!(body, "{}", tx.stmt(&env, stmt)?);
                }
            }
        }
        Ok(body)
    }

    /// One generated server function per frame: the region's string
    /// template from the server call's arguments alone, registered like a
    /// `"use server"` reference and declared `GET` (a read: its response is
    /// the region's HTML, `x-content-raw`).
    fn frame_functions(&self, module: &str) -> R<String> {
        let mut out = String::new();
        let mut regs = Vec::new();
        for (fi, fr) in self.a.frames.iter().enumerate() {
            let c = &self.m.comps[fr.comp];
            let mut body = String::from("const $c = new Map();\n");
            for (i, l) in fr.arg_locals.iter().enumerate() {
                if let Some(s) = l {
                    let _ = writeln!(body, "const {} = $a[{i}];", self.m.sym_name(*s));
                }
            }
            for (ii, item) in c.setup.iter().enumerate() {
                if ii == fr.memo {
                    let Item::Memo { sym, .. } = item else {
                        return Err("frame memo".into());
                    };
                    let env = FrameEnv {
                        inner: SEnv {
                            se: self,
                            comp: fr.comp,
                        },
                        callee: fr.callee.clone(),
                    };
                    let ret = self.tx().expr(&env, fr.ret)?;
                    let _ = writeln!(
                        body,
                        "const {} = _$v(await (async () => ({ret}))());",
                        self.m.sym_name(*sym)
                    );
                    continue;
                }
                if fr.items.contains(&ii) {
                    body.push_str(&self.setup_line(fr.comp, item)?);
                }
            }
            let mut tpl = String::new();
            self.element(fr.comp, fr.region, &mut tpl, None)?;
            let _ = writeln!(
                out,
                "const $$frame{fi} = async (...$a) => {{\n{body}return `{tpl}`;\n}};"
            );
            let sid = super::client_js_str(&fr.sid);
            regs.push(format!(
                "{sid}: _$fget(_$fcsr(_$frsr({sid}, async (...$a) => _$fres(await $$frame{fi}(...$a)))))"
            ));
        }
        let _ = writeln!(
            out,
            "import {{ registerServerReference as _$frsr, createServerReference as _$fcsr, GET as _$fget }} from {};",
            super::client_js_str(module)
        );
        out.push_str("function _$fres(h) { return new Response(h, { headers: { \"content-type\": \"text/html; charset=utf-8\", \"x-content-raw\": \"1\" } }); }\n");
        let _ = writeln!(out, "export const $$frames = {{ {} }};", regs.join(", "));
        Ok(out)
    }

    /// The component's function from its setup text: anchor, template.
    fn finish_component(&self, ci: usize, props: &str, body: String) -> R<String> {
        let c = &self.m.comps[ci];
        // Island anchor for groups rooted here.
        let mut anchor = None;
        let mut comment = None;
        if let Some(gs) = self.roots.get(&ci) {
            let ids: Vec<&str> = gs.iter().map(|(id, _, _)| id.as_str()).collect();
            let mut data = Vec::new();
            for (id, code, _) in gs {
                if code.serial.is_empty() {
                    continue;
                }
                let mut fields = Vec::new();
                for s in &code.serial {
                    match s {
                        Serial::Prop(p) => match code.prop_paths.get(p) {
                            // Only the paths client code reads.
                            Some(Some(paths)) if !paths.is_empty() => {
                                self.pruned.set(true);
                                fields.push(format!(
                                    "{}: _$pp(_$r({props}[{}]), {})",
                                    super::client_js_str(p),
                                    super::client_js_str(p),
                                    paths_js(paths)
                                ))
                            }
                            _ => fields.push(format!(
                                "{}: _$r({props}[{}])",
                                super::client_js_str(p),
                                super::client_js_str(p)
                            )),
                        },
                        Serial::Ctx(n) => fields.push(format!(
                            "{}: _$cv(_$ctx($c, {n}), {})",
                            super::client_js_str(&format!("$ctx:{n}")),
                            super::client_js_str(n)
                        )),
                        Serial::Cell(ii) => {
                            // An adopted async memo: its settled value.
                            if let Item::Memo { sym, .. } = &c.setup[*ii] {
                                let n = self.m.sym_name(*sym);
                                fields.push(format!(
                                    "{}: {n}()",
                                    super::client_js_str(&format!("${n}"))
                                ));
                                continue;
                            }
                            let item = &c.setup[*ii];
                            let Item::Cell { get, set, .. } = item else {
                                continue;
                            };
                            let n = self.m.sym_name(*get);
                            // A store's getter is its value on the server;
                            // only the keys its code touches are serialized.
                            let v = if item.store_like() {
                                match super::store_paths::store_keys(self.m, c, *get, *set) {
                                    Some(keys) => format!(
                                        "_$pick({n}, [{}])",
                                        keys.iter()
                                            .map(|k| super::client_js_str(k))
                                            .collect::<Vec<_>>()
                                            .join(", ")
                                    ),
                                    None => n.to_string(),
                                }
                            } else {
                                format!("{n}()")
                            };
                            fields.push(format!("{}: {v}", super::client_js_str(&format!("${n}"))));
                        }
                    }
                }
                data.push(format!(
                    "{}: {{ {} }}",
                    super::client_js_str(id),
                    fields.join(", ")
                ));
            }
            let view = c.view.ok_or("island root without a view")?;
            if first_is_element(self.m, view) {
                // A key (`$key`, or the enclosing server row's): a frame's
                // refetch hands the island's state to its new anchor.
                self.keys.set(true);
                let mut a = format!(" data-i=\"{}\"${{_$k({props}, $c)}}", ids.join(" "));
                if !data.is_empty() {
                    let _ = write!(
                        a,
                        " data-s=\"${{_$ea(JSON.stringify({{ {} }}))}}\"",
                        data.join(", ")
                    );
                }
                anchor = Some(a);
            } else {
                if !data.is_empty() {
                    return Err("serialized island values need an element anchor".into());
                }
                comment = Some(format!("<!--i:{}-->", ids.join(" ")));
            }
        }
        let mut tpl = String::new();
        if let Some(cm) = &comment {
            tpl.push_str(cm);
        }
        if let Some(v) = c.view {
            self.root(ci, v, &mut tpl, anchor.as_deref())?;
        }
        let asy = if self.is_async[ci] { "async " } else { "" };
        Ok(format!(
            "{asy}function ({props} = {{}}, $c) {{\n{body}return `{tpl}`;\n}}"
        ))
    }
}

/// The JSX a render callback returns (concise, or a single `return`).
fn jsx_body<'a>(f: FnRef<'a>) -> Option<&'a Expression<'a>> {
    let e = match f.concise() {
        Some(e) => e,
        None => match f.statements() {
            [Statement::ReturnStatement(r)] => r.argument.as_ref()?,
            _ => return None,
        },
    };
    jsx::root_of(e).map(|_| e)
}

fn declarator<'a>(
    se: &Se<'_, 'a>,
    env: &SEnv<'_, '_, 'a>,
    d: &'a VariableDeclarator<'a>,
) -> R<String> {
    let tx = se.tx();
    // The declarator's span, with its initializer translated.
    let id = se.m.text(d.id.span());
    match &d.init {
        Some(i) => Ok(format!("{id} = {}", tx.expr(env, i)?)),
        None => Ok(id.to_string()),
    }
}

/// Server module text: the source with every component replaced by its
/// string function, plus the helpers.
/// The server module, and per component whether its view streams a boundary.
pub(crate) fn emit_server<'a>(
    m: &Model<'a>,
    a: &Analysis<'a>,
    codes: &[(usize, GroupCode)],
    fopts: &super::IslandOptions,
) -> R<(String, Vec<bool>)> {
    let n = m.comps.len();
    // Async components: async memos, or rendering an async / opaque one.
    let mut is_async: Vec<bool> = m
        .comps
        .iter()
        .map(|c| {
            c.setup
                .iter()
                .any(|it| matches!(it, Item::Memo { is_async: true, .. }) || it.derived())
        })
        .collect();
    for (ci, f) in a.facts.iter().enumerate() {
        if f.router.is_some() {
            is_async[ci] = true;
        }
    }
    loop {
        let mut changed = false;
        for ci in 0..n {
            if is_async[ci] {
                continue;
            }
            if a.facts[ci].calls.iter().any(|c| match c.tag {
                Tag::Comp(k) => is_async[k],
                Tag::Opaque(_) => true,
                _ => false,
            }) || awaits_in_setup(m, ci)
            {
                is_async[ci] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut roots: HashMap<usize, Vec<(String, &GroupCode, usize)>> = HashMap::new();
    let mut pd = HashSet::new();
    for (gi, code) in codes {
        let g = &a.groups[*gi];
        roots
            .entry(g.root)
            .or_default()
            .push((g.id.clone(), code, *gi));
        if code.lazy_ok {
            for (c, s) in &g.sites {
                let site = &a.facts[*c].sites[*s];
                if matches!(site.kind, SiteKind::Handler(_)) && handler_prevents(m, site) {
                    pd.insert(site.span.start);
                }
            }
        }
    }
    let se = Se {
        m,
        a,
        is_async,
        roots,
        pd,
        streams: Default::default(),
        tiers: codes.iter().map(|(gi, c)| (*gi, c.tier)).collect(),
        pruned: Default::default(),
        keys: Default::default(),
        router: Default::default(),
        keyed: !a.frames.is_empty(),
    };
    let mut edits: Vec<(Span, String)> = Vec::new();
    for (ci, c) in m.comps.iter().enumerate() {
        let f = se.component(ci)?;
        let text = if c.block {
            f
        } else {
            // Plain function components keep their declaration form.
            match m.top.iter().find(|t| t.comp == Some(ci)).map(|t| t.stmt) {
                Some(Statement::FunctionDeclaration(_))
                | Some(Statement::ExportDeclaration(_))
                | Some(Statement::ExportDefaultDeclaration(_))
                    if m.text(c.replace).starts_with("function")
                        || m.text(c.replace).starts_with("async") =>
                {
                    f.replacen("function (", &format!("function {}(", c.name), 1)
                }
                _ => f,
            }
        };
        edits.push((c.replace, text));
    }
    // The router renders through the compiled route table (`_$router`).
    if let Some(r) = &m.router {
        edits.push((r.init, "void 0".into()));
    }
    let program_span = Span::new(0, m.src.len() as u32);
    let mut out = splice(m.src, program_span, edits);
    out.push('\n');
    out.push_str(SERVER_HELPERS);
    if se.pruned.get() {
        out.push_str(PRUNE_HELPER);
    }
    if se.keys.get() || se.keyed {
        out.push_str(KEY_HELPERS);
    }
    if se.router.get() {
        out.push_str(ROUTER_HELPERS);
    }
    if !a.frames.is_empty() {
        out.push_str(&se.frame_functions(&fopts.server_functions_module)?);
    }
    let _ = refs_expr;
    let streams = se.streams.borrow();
    Ok((out, (0..n).map(|c| streams.contains(&c)).collect()))
}

/// Server-side awaits in a component's setup or view statements (an
/// `attempt` outside an event handler, which the server never runs).
fn awaits_in_setup(m: &Model<'_>, ci: usize) -> bool {
    let c = &m.comps[ci];
    c.setup.iter().any(|it| {
        !matches!(it, Item::Event { .. } | Item::Effect { .. })
            && m.text(it.span()).contains("attempt(")
    }) || c
        .view_stmts
        .iter()
        .any(|s| m.text(s.span()).contains("attempt("))
        || c.view
            .is_some_and(|v| m.text(v.span()).contains("attempt("))
}

fn handler_prevents(m: &Model<'_>, site: &super::graph::Site<'_>) -> bool {
    if site.refs.prevent_default {
        return true;
    }
    let syms: Vec<SymbolId> = site.refs.syms.iter().map(|x| x.0).collect();
    m.comps.iter().any(|c| {
        c.setup.iter().any(|it| matches!(it, Item::Event { sym, body, .. } if syms.contains(sym) && m.text(body.body_span()).contains("preventDefault")))
    })
}
