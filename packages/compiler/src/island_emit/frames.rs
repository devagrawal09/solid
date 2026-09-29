//! Compiler-derived server components (frames).
//!
//! documentation/plans/ssr-hydration-redesign.md, "Compiler-derived server
//! components". There is no `"use server"` on markup: a frame is cut where
//! server data enters an inert subtree — an async memo whose value is one
//! server call (`return … yield* attempt(() => serverFn(args)) …`), whose
//! arguments change on the client (they read an island's cells, or a route
//! component's params / location), and whose readers are inert. Its region
//! is the smallest element enclosing every reader (a route component's
//! whole view); its **arguments are exactly the server call's arguments**.
//!
//! - The server renders the region with `data-f="<id>"` and exports one
//!   generated server function per frame (registered like a `"use server"`
//!   reference, declared `GET`), which renders the same string template from
//!   the arguments alone.
//! - The client never materializes the memo: an island frame's driver (the
//!   memo's reads before its `attempt`, in the island that owns them)
//!   refetches the region when the arguments change; a route frame's
//!   arguments are computed by the navigation runtime from the route's
//!   params / location.
//!
//! A candidate that is not a frame keeps today's compile (client code: an
//! adopted tier-2 memo, or inert server HTML) and its reason is listed in
//! the manifest.
use std::collections::{BTreeSet, HashMap, HashSet};

use oxc_ast::ast::{Expression, JSXElement, Statement};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::SymbolId;
use oxc_span::{GetSpan, Span};

use super::graph::{Analysis, Key, Refs, SiteKind, refs_expr, refs_stmt};
use super::jsx::{self, Tag};
use super::model::{FnRef, Item, Model, binding_symbols, call_of, yield_delegate};

pub(crate) struct Frame<'a> {
    /// The generated server function's id (`<Component>-<hash>`), also the
    /// region's `data-f`.
    pub sid: String,
    pub comp: usize,
    /// The memo's setup item.
    pub memo: usize,
    pub region: &'a JSXElement<'a>,
    /// A route component's frame (arguments from params / location).
    pub route: bool,
    /// The server function the memo calls (local binding name).
    pub callee: String,
    pub call_args: Vec<&'a Expression<'a>>,
    /// Per call argument: the pre-statement local it names, if one.
    pub arg_locals: Vec<Option<SymbolId>>,
    /// The memo body's statements before its final `return`.
    pub pre: Vec<&'a Statement<'a>>,
    /// The final `return`'s expression (holds the one `attempt`).
    pub ret: &'a Expression<'a>,
    /// The server function's exported name.
    pub server_fn: String,
    /// Live keys the arguments read (an island frame's drivers).
    pub drivers: BTreeSet<Key>,
    pub tainted: bool,
    /// The driver site (island frames): index in `facts[comp].sites`.
    pub site: Option<usize>,
    /// Setup items of `comp` the region needs (the frame function
    /// evaluates them), the memo excluded.
    pub items: BTreeSet<usize>,
}

pub(crate) struct Reject {
    pub comp: usize,
    pub memo: usize,
    pub reason: String,
}

/// FNV-1a, base 36 (build-stable ids).
fn hash36(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    let mut n = h % 2_176_782_336; // 36^6
    let mut out = Vec::new();
    for _ in 0..6 {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Every key a set of keys reads through memos (their dependencies).
fn closure(a: &Analysis<'_>, keys: &BTreeSet<Key>) -> BTreeSet<Key> {
    let mut out = keys.clone();
    let mut stack: Vec<Key> = keys.iter().copied().collect();
    while let Some(k) = stack.pop() {
        if let Some(deps) = a.memo_deps.get(&k) {
            for d in deps {
                if out.insert(*d) {
                    stack.push(*d);
                }
            }
        }
    }
    out
}

fn reads_key(a: &Analysis<'_>, comp: usize, r: &Refs, key: Key) -> bool {
    closure(a, &a.av_of(comp, r).reads).contains(&key)
}

/// The shape a frame needs: `… return E` with exactly one
/// `yield* attempt(() => f(args))` in `E` and none before.
struct Shape<'a> {
    pre: Vec<&'a Statement<'a>>,
    ret: &'a Expression<'a>,
    attempt: Span,
    call: &'a oxc_ast::ast::CallExpression<'a>,
}

fn shape<'a>(m: &Model<'a>, body: FnRef<'a>) -> Result<Shape<'a>, String> {
    let _ = m;
    let stmts = body.statements();
    let (pre, last) = match stmts.split_last() {
        Some((last, pre)) => (pre, last),
        None => return Err("the memo has no statements".into()),
    };
    let Statement::ReturnStatement(r) = last else {
        return Err("the memo does not end with a `return`".into());
    };
    let Some(ret) = &r.argument else {
        return Err("the memo returns nothing".into());
    };
    // `attempt(…)` calls anywhere in the body.
    struct Calls<'a> {
        out: Vec<&'a oxc_ast::ast::CallExpression<'a>>,
    }
    impl<'a> Visit<'a> for Calls<'a> {
        fn visit_call_expression(&mut self, c: &oxc_ast::ast::CallExpression<'a>) {
            if matches!(c.callee.without_parentheses(), Expression::Identifier(id) if id.name == "attempt")
            {
                let c: &'a oxc_ast::ast::CallExpression<'a> =
                    unsafe { &*(c as *const oxc_ast::ast::CallExpression<'a>) };
                self.out.push(c);
            }
            walk::walk_call_expression(self, c);
        }
    }
    let mut in_pre = Calls { out: Vec::new() };
    for s in pre {
        in_pre.visit_statement(s);
    }
    if !in_pre.out.is_empty() {
        return Err("an `attempt` before the memo's final `return`".into());
    }
    let mut in_ret = Calls { out: Vec::new() };
    in_ret.visit_expression(ret);
    let [attempt] = in_ret.out.as_slice() else {
        return Err("the memo's `return` does not hold exactly one `attempt`".into());
    };
    let Some(f) = attempt.arguments.first().and_then(|a| a.as_expression()) else {
        return Err("`attempt` without a function".into());
    };
    let Some(f) = FnRef::from_expr(f) else {
        return Err("`attempt`'s argument is not a function".into());
    };
    let call_expr = match f.concise() {
        Some(e) => e,
        None => match f.statements() {
            [Statement::ReturnStatement(r)] => match &r.argument {
                Some(e) => e,
                None => return Err("`attempt`'s function returns nothing".into()),
            },
            _ => return Err("`attempt`'s function is not one call".into()),
        },
    };
    let Some(call) = call_of(call_expr) else {
        return Err("`attempt`'s function is not one call".into());
    };
    Ok(Shape {
        pre: pre.iter().collect(),
        ret,
        attempt: attempt.span,
        call,
    })
}

/// Intrinsic elements of a view (any depth, render callbacks included).
fn elements<'a>(e: &'a Expression<'a>) -> Vec<&'a JSXElement<'a>> {
    struct V<'a> {
        out: Vec<&'a JSXElement<'a>>,
    }
    impl<'a> Visit<'a> for V<'a> {
        fn visit_jsx_element(&mut self, el: &JSXElement<'a>) {
            let el: &'a JSXElement<'a> = unsafe { &*(el as *const JSXElement<'a>) };
            self.out.push(el);
            walk::walk_jsx_element(self, el);
        }
    }
    let mut v = V { out: Vec::new() };
    v.visit_expression(e);
    v.out
}

fn inside(outer: Span, inner: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// Detect the module's frames (between liveness and the union-find). An
/// island frame's memo leaves the live set (its readers become inert: the
/// region), and a driver site joins the island that owns its arguments.
pub(crate) fn detect<'a>(m: &Model<'a>, a: &mut Analysis<'a>, filename: Option<&str>) {
    let mut frames: Vec<Frame<'a>> = Vec::new();
    let mut rejects: Vec<Reject> = Vec::new();
    for (ci, c) in m.comps.iter().enumerate() {
        for (ii, item) in c.setup.iter().enumerate() {
            let Item::Memo {
                body,
                is_async: true,
                name,
                prefer_client,
                ..
            } = item
            else {
                continue;
            };
            let key = (ci, ii);
            let island = a.live.contains(&key);
            let route = c.route_props;
            if !island && !route {
                // Server-authoritative: inert server HTML, never refetched.
                continue;
            }
            let reject = |why: String, rejects: &mut Vec<Reject>| {
                rejects.push(Reject {
                    comp: ci,
                    memo: ii,
                    reason: why,
                })
            };
            let sh = match shape(m, *body) {
                Ok(s) => s,
                Err(e) => {
                    reject(
                        format!("`{name}`: {e} (not one server call)"),
                        &mut rejects,
                    );
                    continue;
                }
            };
            let callee_sym = m.symbol_of_expr(&sh.call.callee);
            let Some(sf) = callee_sym.and_then(|s| m.server_fns.get(&s)) else {
                reject(
                    format!(
                        "`{name}`: `{}` is not a server function, so its data does not cross the network per argument change (stays client code)",
                        super::model::short(m.text(sh.call.callee.span()))
                    ),
                    &mut rejects,
                );
                continue;
            };
            if *prefer_client || c.prefer_client {
                reject(
                    format!("`{name}`: `@frame prefer: \"client\"` (the subtree stays client code)"),
                    &mut rejects,
                );
                continue;
            }
            // --- arguments: the pre statements' locals and reads ------------------------
            let mut pre_locals: HashSet<SymbolId> = HashSet::new();
            let mut pre_refs = Refs::default();
            for s in &sh.pre {
                if let Statement::VariableDeclaration(v) = s {
                    for d in &v.declarations {
                        let mut out = Vec::new();
                        binding_symbols(&d.id, &mut out);
                        pre_locals.extend(out);
                    }
                }
                let r = super::graph::refs_stmt_props(m, c.props, s);
                pre_refs.syms.extend(r.syms);
                pre_refs.props.extend(r.props);
                pre_refs.props_bare |= r.props_bare;
            }
            let mut arg_locals = Vec::new();
            for arg in &sh.call.arguments {
                let Some(e) = arg.as_expression() else {
                    arg_locals.push(None);
                    continue;
                };
                let r = refs_expr(m, c.props, e);
                pre_refs.syms.extend(r.syms);
                pre_refs.props.extend(r.props);
                pre_refs.props_bare |= r.props_bare;
                arg_locals.push(
                    m.symbol_of_expr(e)
                        .filter(|s| pre_locals.contains(s)),
                );
            }
            if sh.call.arguments.iter().any(|a| a.as_expression().is_none()) {
                reject(format!("`{name}`: a spread argument to the server call"), &mut rejects);
                continue;
            }
            // The `return` may read a pre local only through an argument.
            let bound: HashSet<SymbolId> = arg_locals.iter().flatten().copied().collect();
            let ret_refs = {
                struct Outside<'m, 'a> {
                    m: &'m Model<'a>,
                    skip: Span,
                    syms: Vec<SymbolId>,
                }
                impl<'a> Visit<'a> for Outside<'_, 'a> {
                    fn visit_identifier_reference(
                        &mut self,
                        id: &oxc_ast::ast::IdentifierReference<'a>,
                    ) {
                        if !inside(self.skip, id.span)
                            && let Some(s) = self.m.symbol_of(id)
                        {
                            self.syms.push(s);
                        }
                    }
                }
                let mut o = Outside {
                    m,
                    skip: sh.attempt,
                    syms: Vec::new(),
                };
                o.visit_expression(sh.ret);
                o.syms
            };
            if let Some(s) = ret_refs
                .iter()
                .find(|s| pre_locals.contains(s) && !bound.contains(s))
            {
                reject(
                    format!(
                        "`{name}`: its value reads `{}`, a client input that is not an argument of the server call",
                        m.sym_name(*s)
                    ),
                    &mut rejects,
                );
                continue;
            }
            // Route arguments are computed by the navigation runtime: from
            // the route's props and module-level code only.
            let setup_syms: HashMap<SymbolId, usize> = c
                .setup
                .iter()
                .enumerate()
                .flat_map(|(i, it)| it.declares().into_iter().map(move |s| (s, i)))
                .collect();
            if route
                && let Some((s, _)) = pre_refs
                    .syms
                    .iter()
                    .find(|(s, _)| setup_syms.contains_key(s))
            {
                reject(
                    format!(
                        "`{name}`: its arguments read `{}` from the component's setup (a route frame's arguments come from the route's params and location)",
                        m.sym_name(*s)
                    ),
                    &mut rejects,
                );
                continue;
            }
            let drivers: BTreeSet<Key> = {
                let (k, _) = a.live_reads(ci, &pre_refs);
                k
            };
            // --- readers and the region ---------------------------------------------------
            let Some(view) = c.view else { continue };
            let f = &a.facts[ci];
            let mut reader_spans: Vec<Span> = Vec::new();
            for s in &f.sites {
                if matches!(s.kind, SiteKind::Effect(..)) {
                    continue;
                }
                if reads_key(a, ci, &s.refs, key) {
                    reader_spans.push(s.span);
                }
            }
            for call in &f.calls {
                if call.props.iter().any(|(_, e)| {
                    e.is_some_and(|e| reads_key(a, ci, &refs_expr(m, c.props, e), key))
                }) {
                    reader_spans.push(call.span);
                }
            }
            let region = if route {
                match jsx::root_of(view) {
                    Some(jsx::Root::Element(el))
                        if matches!(jsx::tag_of(m, &el.opening_element.name), Tag::Intrinsic(_)) =>
                    {
                        Some(el)
                    }
                    _ => {
                        reject(
                            format!(
                                "`{name}`: the route component's view is not one element (a route frame is its whole view)"
                            ),
                            &mut rejects,
                        );
                        continue;
                    }
                }
            } else if reader_spans.is_empty() {
                None
            } else {
                elements(view)
                    .into_iter()
                    .filter(|el| {
                        matches!(jsx::tag_of(m, &el.opening_element.name), Tag::Intrinsic(_))
                            && reader_spans.iter().all(|s| inside(el.span, *s))
                    })
                    .min_by_key(|el| el.span.end - el.span.start)
            };
            let Some(region) = region else {
                reject(
                    format!("`{name}`: no element encloses every reader of its value"),
                    &mut rejects,
                );
                continue;
            };
            // --- guards ------------------------------------------------------------------------
            let mut why: Option<String> = None;
            // Client control flow over island state around the region.
            for s in &f.sites {
                if matches!(s.kind, SiteKind::Show | SiteKind::For)
                    && !a.live_reads(ci, &s.refs).0.is_empty()
                    && jsx_parent_region(view, s.span).is_some_and(|sp| inside(sp, region.span))
                {
                    why = Some(format!(
                        "`{name}`: its region sits inside a <{}> over island state (client control flow: stays in the island chunk)",
                        if s.kind == SiteKind::Show { "Show" } else { "For" }
                    ));
                    break;
                }
            }
            // Readers outside the region, or live readers anywhere.
            if why.is_none() {
                // Memos whose value derives from this one: their liveness
                // is this memo's.
                let dependents: HashSet<Key> = a
                    .memo_deps
                    .keys()
                    .filter(|k| **k != key && closure(a, &BTreeSet::from([**k])).contains(&key))
                    .copied()
                    .collect();
                for call in &f.calls {
                    if !inside(region.span, call.span)
                        && call.props.iter().any(|(_, e)| {
                            e.is_some_and(|e| reads_key(a, ci, &refs_expr(m, c.props, e), key))
                        })
                    {
                        why = Some(format!(
                            "`{name}`: a component rendered outside the frame region reads it"
                        ));
                    }
                }
                for (cj, fj) in a.facts.iter().enumerate() {
                    if why.is_some() {
                        break;
                    }
                    for s in &fj.sites {
                        if matches!(s.kind, SiteKind::Effect(..)) || !reads_key(a, cj, &s.refs, key) {
                            if let SiteKind::Effect(..) = s.kind
                                && reads_key(a, cj, &s.refs, key)
                            {
                                why = Some(format!(
                                    "`{name}`: an effect in `{}` reads its value (a live island also needs it: not a frame)",
                                    m.comps[cj].name
                                ));
                            }
                            continue;
                        }
                        if let SiteKind::Handler(_) = s.kind {
                            why = Some(format!(
                                "`{name}`: a handler in `{}` reads its value (a live island also needs it: not a frame)",
                                m.comps[cj].name
                            ));
                            break;
                        }
                        let other = a
                            .live_reads(cj, &s.refs)
                            .0
                            .into_iter()
                            .any(|k| k != key && !dependents.contains(&k));
                        if other {
                            why = Some(format!(
                                "`{name}`: `{}` in `{}` reads it together with island state (a live island also reads it: not a frame)",
                                super::model::short(m.text(s.span)),
                                m.comps[cj].name
                            ));
                            break;
                        }
                        if cj == ci && !inside(region.span, s.span) {
                            why = Some(format!(
                                "`{name}`: `{}` reads it outside the frame region",
                                super::model::short(m.text(s.span))
                            ));
                            break;
                        }
                    }
                    if why.is_some() {
                        break;
                    }
                }
            }
            // Live sites of this component inside the region (an island
            // frame): they would belong to the island that drives it.
            if why.is_none() && !route {
                for s in &f.sites {
                    if !inside(region.span, s.span) || reads_key(a, ci, &s.refs, key) {
                        continue;
                    }
                    let live = matches!(s.kind, SiteKind::Handler(_))
                        || !a.live_reads(ci, &s.refs).0.is_empty()
                        || a.env_of(ci, &s.refs).is_some();
                    if live {
                        why = Some(format!(
                            "`{name}`: its region holds `{}`, a live site of `{}` itself",
                            super::model::short(m.text(s.span)),
                            c.name
                        ));
                        break;
                    }
                }
            }
            // The region reads the component's props / setup state outside
            // the server call (the frame function has only the arguments).
            let mut items: BTreeSet<usize> = BTreeSet::new();
            if why.is_none() {
                let mut stack: Vec<SymbolId> = Vec::new();
                for s in &f.sites {
                    if !inside(region.span, s.span) {
                        continue;
                    }
                    if let Some((p, _)) = s.refs.props.first() {
                        why = Some(format!(
                            "`{name}`: the region reads `props.{p}` outside the server call"
                        ));
                        break;
                    }
                    stack.extend(s.refs.syms.iter().map(|x| x.0));
                }
                for call in &f.calls {
                    if !inside(region.span, call.span) {
                        continue;
                    }
                    for (_, e) in &call.props {
                        if let Some(e) = e {
                            let r = refs_expr(m, c.props, e);
                            if let Some((p, _)) = r.props.first() {
                                why = Some(format!(
                                    "`{name}`: the region passes `props.{p}` on (the frame function has only the server call's arguments)"
                                ));
                            }
                            stack.extend(r.syms.iter().map(|x| x.0));
                        }
                    }
                }
                for (_, v) in &f.providers {
                    if let Some(e) = v {
                        stack.extend(refs_expr(m, c.props, e).syms.iter().map(|x| x.0));
                    }
                }
                let mut seen = HashSet::new();
                while why.is_none()
                    && let Some(s) = stack.pop()
                {
                    if !seen.insert(s) {
                        continue;
                    }
                    let Some(&i) = setup_syms.get(&s) else { continue };
                    if i == ii {
                        continue;
                    }
                    items.insert(i);
                    let r = &f.item_refs[i];
                    match &c.setup[i] {
                        Item::Context { .. } => {
                            why = Some(format!(
                                "`{name}`: the region reads a context provided outside the frame"
                            ));
                        }
                        _ if !r.props.is_empty() || r.props_bare => {
                            why = Some(format!(
                                "`{name}`: the region reads `{}`, computed from the component's props",
                                m.sym_name(s)
                            ));
                        }
                        _ => stack.extend(r.syms.iter().map(|x| x.0)),
                    }
                }
            }
            if let Some(w) = why {
                reject(w, &mut rejects);
                continue;
            }
            let sid = format!(
                "{}-{}",
                if c.name == "default" { "route" } else { c.name.as_str() },
                hash36(&format!(
                    "{}#{}#{}",
                    filename.unwrap_or(""),
                    c.name,
                    name
                ))
            );
            frames.push(Frame {
                sid,
                comp: ci,
                memo: ii,
                region,
                route,
                callee: m.text(sh.call.callee.span()).to_string(),
                call_args: sh
                    .call
                    .arguments
                    .iter()
                    .filter_map(|x| x.as_expression())
                    .collect(),
                arg_locals,
                pre: sh.pre,
                ret: sh.ret,
                server_fn: sf.name.clone(),
                drivers,
                tainted: sf.tainted,
                site: None,
                items,
            });
        }
    }
    // Island frames: the memo leaves the live set; its readers are inert
    // (server HTML inside the region); a driver site joins the island.
    let framed: HashSet<Key> = frames
        .iter()
        .filter(|f| !f.route)
        .map(|f| (f.comp, f.memo))
        .collect();
    if !framed.is_empty() {
        a.live = a.written.clone();
        loop {
            let mut changed = false;
            for (k, deps) in &a.memo_deps {
                if framed.contains(k) || a.live.contains(k) {
                    continue;
                }
                if deps.iter().any(|d| a.live.contains(d)) {
                    a.live.insert(*k);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        for (fi, fr) in frames.iter_mut().enumerate() {
            if fr.route {
                continue;
            }
            let c = &m.comps[fr.comp];
            let mut r = Refs::default();
            for s in &fr.pre {
                let x = super::graph::refs_stmt_props(m, c.props, s);
                r.syms.extend(x.syms);
                r.props.extend(x.props);
            }
            for e in &fr.call_args {
                let x = refs_expr(m, c.props, e);
                r.syms.extend(x.syms);
                r.props.extend(x.props);
            }
            let f = &mut a.facts[fr.comp];
            let si = f.sites.len();
            f.site_at.insert(fr.region.span.start, si);
            f.sites.push(super::graph::Site {
                kind: SiteKind::Frame(fi),
                span: fr.region.span,
                expr: None,
                refs: r,
                regions: vec![],
                param: None,
            });
            fr.site = Some(si);
        }
    }
    a.frames = frames;
    a.frame_rejects = rejects;
}

/// The span of the `<Show>` / `<For>` element whose input starts at
/// `input` (the site span), found in the view.
fn jsx_parent_region(view: &Expression<'_>, input: Span) -> Option<Span> {
    struct V {
        input: Span,
        out: Option<Span>,
    }
    impl<'a> Visit<'a> for V {
        fn visit_jsx_element(&mut self, el: &JSXElement<'a>) {
            if el.opening_element.span.start < self.input.start
                && self.input.end <= el.opening_element.span.end
            {
                self.out = Some(el.span);
            }
            walk::walk_jsx_element(self, el);
        }
    }
    let mut v = V { input, out: None };
    v.visit_expression(view);
    v.out
}

/// Does `stmt` read (outside nested functions) the client environment? Used
/// by the taint guard to report.
#[allow(dead_code)]
pub(crate) fn stmt_refs<'a>(m: &Model<'a>, s: &'a Statement<'a>) -> Refs {
    refs_stmt(m, s)
}

/// `yield* X` → X, for route argument functions (props are plain values).
#[allow(dead_code)]
pub(crate) fn unyield<'b, 'a>(e: &'b Expression<'a>) -> &'b Expression<'a> {
    yield_delegate(e).unwrap_or(e)
}


// --- taint ------------------------------------------------------------------------------

/// Keys whose value derives from a `@taint`ed server function's result.
fn tainted_keys(m: &Model<'_>, a: &Analysis<'_>) -> BTreeSet<Key> {
    let mut base = BTreeSet::new();
    for (ci, c) in m.comps.iter().enumerate() {
        for (ii, item) in c.setup.iter().enumerate() {
            let body = match item {
                Item::Memo { body, .. } => body.body_span(),
                Item::Cell { init: Some(e), .. } => e.span(),
                _ => continue,
            };
            // A call of a tainted server function anywhere in it.
            let calls_tainted = m.server_fns.iter().any(|(s, f)| {
                f.tainted && {
                    let name = m.sym_name(*s);
                    let text = m.text(body);
                    text.match_indices(&format!("{name}(")).any(|(i, _)| {
                        i == 0
                            || !text[..i].chars().next_back().is_some_and(|c| {
                                c.is_alphanumeric() || c == '_' || c == '$' || c == '.'
                            })
                    })
                }
            });
            if calls_tainted {
                base.insert((ci, ii));
            }
        }
    }
    // Everything reading them (memos and cells over them).
    let mut out = base.clone();
    loop {
        let mut changed = false;
        for (ci, c) in m.comps.iter().enumerate() {
            for (ii, item) in c.setup.iter().enumerate() {
                if out.contains(&(ci, ii)) || !matches!(item, Item::Memo { .. } | Item::Cell { .. }) {
                    continue;
                }
                let reads = closure(a, &a.av_of(ci, &a.facts[ci].item_refs[ii]).reads);
                if reads.iter().any(|k| out.contains(k)) {
                    out.insert((ci, ii));
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    out
}

/// The first value an island would serialize that derives from a tainted
/// server function (a build error).
pub(crate) fn taint_violation(
    m: &Model<'_>,
    a: &Analysis<'_>,
    codes: &[(usize, super::client::GroupCode)],
) -> Option<String> {
    let tainted = tainted_keys(m, a);
    if tainted.is_empty() {
        return None;
    }
    let hit = |reads: &BTreeSet<Key>| closure(a, reads).into_iter().find(|k| tainted.contains(k));
    let name_of = |k: Key| match &m.comps[k.0].setup[k.1] {
        Item::Memo { name, .. } | Item::Cell { name, .. } => format!("{}.{name}", m.comps[k.0].name),
        _ => m.comps[k.0].name.clone(),
    };
    for (gi, code) in codes {
        let g = &a.groups[*gi];
        let root = g.root;
        for s in &code.serial {
            let found = match s {
                super::client::Serial::Prop(p) => a
                    .prop_av
                    .get(&(root, p.clone()))
                    .and_then(|v| hit(&v.reads))
                    .map(|k| (format!("props.{p}"), k)),
                super::client::Serial::Cell(ii) => {
                    let k = (root, *ii);
                    let mut reads = BTreeSet::from([k]);
                    reads.extend(a.av_of(root, &a.facts[root].item_refs[*ii]).reads);
                    hit(&reads).map(|t| (name_of(k), t))
                }
                super::client::Serial::Ctx(n) => a
                    .ctx_av
                    .iter()
                    .find(|(s, _)| m.sym_name(**s) == n)
                    .and_then(|(_, v)| hit(&v.reads))
                    .map(|k| (format!("context {n}"), k)),
            };
            if let Some((what, k)) = found {
                return Some(format!(
                    "island `{}` ({}) would serialize {what}, which derives from `{}`: the value of a server function marked `@taint` (server-only data never reaches the client). Read it only in inert markup (a frame renders it on the server), or move the field the island needs into an untainted function.",
                    g.id,
                    m.comps[root].name,
                    name_of(k)
                ));
            }
        }
    }
    None
}

// --- route arguments (the navigation runtime's table) -----------------------------------

/// `yield* x` reads a plain value: route props are plain objects in the
/// navigation runtime; module-level names are copied.
struct ArgsEnv<'m, 'a> {
    m: &'m Model<'a>,
    tops: std::cell::RefCell<BTreeSet<SymbolId>>,
}

impl<'a> super::tx::Env<'a> for ArgsEnv<'_, 'a> {
    fn read(&self, tx: &super::tx::Tx<'_, 'a>, arg: &'a Expression<'a>) -> super::tx::R<String> {
        tx.expr(self, arg)
    }
    fn ident(
        &self,
        _tx: &super::tx::Tx<'_, 'a>,
        id: &oxc_ast::ast::IdentifierReference<'a>,
    ) -> Option<String> {
        if let Some(s) = self.m.symbol_of(id)
            && self.m.top_of.contains_key(&s)
        {
            self.tops.borrow_mut().insert(s);
        }
        None
    }
}

/// The route frames' argument functions, with the module-level code they
/// use: `export const $$routeArgs = { "<id>": props => [...] }`.
pub(crate) fn route_client(m: &Model<'_>, a: &Analysis<'_>) -> Result<Option<String>, String> {
    let routes: Vec<&Frame<'_>> = a.frames.iter().filter(|f| f.route).collect();
    if routes.is_empty() {
        return Ok(None);
    }
    let env = ArgsEnv {
        m,
        tops: Default::default(),
    };
    let tx = super::tx::Tx { m };
    let mut fns = Vec::new();
    for fr in routes {
        let c = &m.comps[fr.comp];
        let props = c.props.map_or("props".to_string(), |p| m.sym_name(p).to_string());
        let mut body = String::new();
        for s in &fr.pre {
            body.push_str(&tx.stmt(&env, s)?);
            body.push('\n');
        }
        let args: Vec<String> = fr
            .call_args
            .iter()
            .map(|e| tx.expr(&env, e))
            .collect::<Result<_, _>>()?;
        fns.push(format!(
            "{}: ({props}) => {{\n{body}return [{}];\n}}",
            super::client_js_str(&fr.sid),
            args.join(", ")
        ));
    }
    let tops = copy_tops(m, &env.tops.borrow())?;
    Ok(Some(format!(
        "{tops}export const $$routeArgs = {{\n{}\n}};\n",
        fns.join(",\n")
    )))
}

/// Module-level declarations (transitively) and imports the argument
/// functions use, TypeScript erased.
fn copy_tops(m: &Model<'_>, syms: &BTreeSet<SymbolId>) -> Result<String, String> {
    let mut need: BTreeSet<usize> = BTreeSet::new();
    let mut stack: Vec<SymbolId> = syms.iter().copied().collect();
    let mut seen: BTreeSet<SymbolId> = BTreeSet::new();
    while let Some(s) = stack.pop() {
        if !seen.insert(s) {
            continue;
        }
        let Some(&ti) = m.top_of.get(&s) else { continue };
        let t = &m.top[ti];
        if t.comp.is_some() || m.server_fns.contains_key(&s) {
            return Err(format!(
                "a route frame's arguments use `{}` (a component or server function)",
                m.sym_name(s)
            ));
        }
        if need.insert(ti) && !t.import {
            for (x, _) in refs_stmt(m, t.stmt).syms {
                stack.push(x);
            }
        }
    }
    struct Plain;
    impl<'a> super::tx::Env<'a> for Plain {
        fn read(&self, tx: &super::tx::Tx<'_, 'a>, arg: &'a Expression<'a>) -> super::tx::R<String> {
            Err(format!("`yield*` in module-level code: `{}`", tx.m.text(arg.span())))
        }
    }
    let tx = super::tx::Tx { m };
    let mut out = String::new();
    for ti in need {
        let t = &m.top[ti];
        if let Statement::ImportDeclaration(imp) = t.stmt {
            let mut named = Vec::new();
            let mut default = None;
            for sp in imp.specifiers.iter().flatten() {
                use oxc_ast::ast::ImportDeclarationSpecifier as S;
                match sp {
                    S::ImportSpecifier(s) if s.local.symbol_id.get().is_some_and(|x| seen.contains(&x)) => {
                        named.push(format!("{} as {}", s.imported.name(), s.local.name));
                    }
                    S::ImportDefaultSpecifier(s) if s.local.symbol_id.get().is_some_and(|x| seen.contains(&x)) => {
                        default = Some(s.local.name.to_string());
                    }
                    _ => {}
                }
            }
            let src = super::client_js_str(imp.source.value.as_str());
            if let Some(d) = default {
                out.push_str(&format!("import {d} from {src};\n"));
            }
            if !named.is_empty() {
                out.push_str(&format!("import {{ {} }} from {src};\n", named.join(", ")));
            }
            continue;
        }
        let decl = match t.stmt {
            Statement::ExportDeclaration(e) => Some(&e.declaration),
            s => s.as_declaration(),
        };
        if decl.is_some_and(|d| d.is_type()) {
            continue;
        }
        // `export const x = …` → `const x = …` (the table module exports only its table).
        let text = match t.stmt {
            Statement::ExportDeclaration(e) => {
                let full = tx.stmt(&Plain, t.stmt)?;
                let decl_text = &m.src[e.declaration.span().start as usize..e.span.end as usize];
                let _ = decl_text;
                full.trim_start().strip_prefix("export ").unwrap_or(&full).to_string()
            }
            _ => tx.stmt(&Plain, t.stmt)?,
        };
        out.push_str(&text);
        out.push('\n');
    }
    Ok(out)
}

// --- manifest -----------------------------------------------------------------------------

/// The manifest's `frames`, `frameCandidates` and `router` sections.
pub(crate) fn manifest(
    w: &mut crate::capabilities::JsonWriter,
    m: &Model<'_>,
    a: &Analysis<'_>,
    codes: &[(usize, super::client::GroupCode)],
    emitted: bool,
) {
    w.key("frames");
    w.begin_array();
    if emitted {
        for fr in &a.frames {
            let c = &m.comps[fr.comp];
            w.begin_object();
            w.key("id");
            w.string(&fr.sid);
            w.key("root");
            w.string(&c.name);
            w.key("memo");
            if let Item::Memo { name, .. } = &c.setup[fr.memo] {
                w.string(name);
            } else {
                w.null();
            }
            w.key("region");
            w.string(&describe_el(m, fr.region));
            w.key("driver");
            w.string(if fr.route { "route" } else { "island" });
            w.key("arguments");
            w.begin_array();
            for e in &fr.call_args {
                w.string(&super::model::short(m.text(e.span())));
            }
            w.end_array();
            w.key("argumentsFrom");
            w.begin_array();
            let mut from: BTreeSet<String> = BTreeSet::new();
            for s in &fr.pre {
                for (p, _) in super::graph::refs_stmt_props(m, c.props, s).props {
                    from.insert(format!("props.{p}"));
                }
            }
            for k in &fr.drivers {
                if let Item::Cell { name, .. } | Item::Memo { name, .. } = &m.comps[k.0].setup[k.1] {
                    from.insert(format!("{}.{name}", m.comps[k.0].name));
                }
            }
            for x in from {
                w.string(&x);
            }
            w.end_array();
            w.key("serverFunctions");
            w.begin_array();
            w.string(&fr.server_fn);
            w.end_array();
            w.key("tainted");
            w.boolean(fr.tainted);
            // Islands whose anchors the frame's HTML carries.
            w.key("islands");
            w.begin_array();
            for (gi, g) in a.groups.iter().enumerate() {
                let inside = nested_in(m, a, fr, g.root);
                if !inside {
                    continue;
                }
                w.begin_object();
                w.key("id");
                w.string(&g.id);
                w.key("root");
                w.string(&m.comps[g.root].name);
                w.key("key");
                match key_kind(m, a, g.root) {
                    Some(k) => w.string(k),
                    None => w.null(),
                }
                w.key("serialized");
                w.begin_array();
                if let Some((_, code)) = codes.iter().find(|(x, _)| *x == gi) {
                    for s in &code.serial {
                        match s {
                            super::client::Serial::Prop(p) => w.string(&format!("props.{p}")),
                            super::client::Serial::Ctx(n) => w.string(&format!("context {n}")),
                            super::client::Serial::Cell(ii) => match &m.comps[g.root].setup[*ii] {
                                Item::Cell { name, .. } => w.string(&format!("cell {name}")),
                                Item::Memo { name, .. } => w.string(&format!("memo {name}")),
                                _ => {}
                            },
                        }
                    }
                }
                w.end_array();
                w.end_object();
            }
            w.end_array();
            // Components of other modules rendered inside the region (their
            // islands are in their own modules' manifests).
            w.key("renders");
            w.begin_array();
            // name → (in a server row, passed a `$key`)
            let mut seen: std::collections::BTreeMap<String, (bool, bool)> = Default::default();
            let rows = in_rows(a);
            let mut stack = vec![fr.comp];
            let mut visited = BTreeSet::new();
            while let Some(x) = stack.pop() {
                if !visited.insert(x) {
                    continue;
                }
                for call in &a.facts[x].calls {
                    if x == fr.comp && !inside(fr.region.span, call.span) {
                        continue;
                    }
                    match &call.tag {
                        Tag::Comp(k) => stack.push(*k),
                        Tag::Opaque(n) => {
                            let row = rows.contains(&x)
                                || call
                                    .regions
                                    .iter()
                                    .any(|r| a.facts[x].sites[*r].kind == SiteKind::For);
                            let key = call.props.iter().any(|(p, _)| p == "$key");
                            let e = seen.entry(n.clone()).or_default();
                            e.0 |= row;
                            e.1 |= key;
                        }
                        _ => {}
                    }
                }
            }
            for (n, (row, key)) in seen {
                w.begin_object();
                w.key("component");
                w.string(&n);
                w.key("key");
                if key {
                    w.string("$key");
                } else if row {
                    w.string("row item id");
                } else {
                    w.null();
                }
                w.end_object();
            }
            w.end_array();
            // Authorization: every frame is a public endpoint taking its
            // arguments; access checks belong in the data functions.
            w.key("public");
            w.boolean(true);
            w.key("guard");
            w.null();
            w.end_object();
        }
    }
    w.end_array();
    w.key("frameCandidates");
    w.begin_array();
    for r in &a.frame_rejects {
        w.begin_object();
        w.key("root");
        w.string(&m.comps[r.comp].name);
        w.key("memo");
        if let Item::Memo { name, .. } = &m.comps[r.comp].setup[r.memo] {
            w.string(name);
        } else {
            w.null();
        }
        w.key("reason");
        w.string(&r.reason);
        w.end_object();
    }
    w.end_array();
    w.key("router");
    match &m.router {
        None => w.null(),
        Some(r) => {
            w.begin_object();
            w.key("routes");
            w.begin_array();
            for rt in &r.routes {
                w.begin_object();
                w.key("paths");
                w.begin_array();
                for p in &rt.paths {
                    w.string(p);
                }
                w.end_array();
                w.key("component");
                w.string(&rt.comp_name);
                w.key("module");
                match &rt.module {
                    Some(x) => w.string(x),
                    None => w.null(),
                }
                w.key("preload");
                w.boolean(rt.preload);
                // @solidjs/router exposes no route guard: nothing to list.
                w.key("guard");
                w.null();
                w.end_object();
            }
            w.end_array();
            w.end_object();
        }
    }
}

/// `<div class="item-view">` (with its line) for reports.
fn describe_el(m: &Model<'_>, el: &JSXElement<'_>) -> String {
    let tag = match jsx::tag_of(m, &el.opening_element.name) {
        Tag::Intrinsic(t) => t,
        _ => "?".into(),
    };
    let class = jsx::attrs(el).ok().and_then(|attrs| {
        attrs.iter().find_map(|a| match (&a.name[..], &a.value) {
            ("class", jsx::AttrVal::Str(s)) => Some(s.clone()),
            _ => None,
        })
    });
    let line = m.src[..el.span.start as usize].matches('\n').count() + 1;
    match class {
        Some(c) => format!("<{tag} class=\"{c}\"> (line {line})"),
        None => format!("<{tag}> (line {line})"),
    }
}

/// Is component `root` rendered inside the frame's region (or, for a route
/// frame, is it the route component itself)?
fn nested_in(m: &Model<'_>, a: &Analysis<'_>, fr: &Frame<'_>, root: usize) -> bool {
    let _ = m;
    if root == fr.comp {
        return fr.route;
    }
    let mut stack: Vec<usize> = a.facts[fr.comp]
        .calls
        .iter()
        .filter(|c| inside(fr.region.span, c.span))
        .filter_map(|c| match c.tag {
            Tag::Comp(k) => Some(k),
            _ => None,
        })
        .collect();
    let mut seen = HashSet::new();
    while let Some(x) = stack.pop() {
        if x == root {
            return true;
        }
        if !seen.insert(x) {
            continue;
        }
        for c in &a.facts[x].calls {
            if let Tag::Comp(k) = c.tag {
                stack.push(k);
            }
        }
    }
    false
}

/// How an island rooted at `root` is keyed across a frame's refetches:
/// an explicit `$key` at a call site, or a server row's item (`id`).
fn key_kind(m: &Model<'_>, a: &Analysis<'_>, root: usize) -> Option<&'static str> {
    for f in &a.facts {
        for c in &f.calls {
            if c.tag == Tag::Comp(root) && c.props.iter().any(|(n, _)| n == "$key") {
                return Some("$key");
            }
        }
    }
    let rows = in_rows(a).contains(&root);
    // A scope extracted from a row block is its row.
    if rows || m.comps[root].name.contains("$For") {
        Some("row item id")
    } else {
        None
    }
}

/// Components rendered in a server row (a `<For>`), directly or under a
/// component that is: the row's item keys their islands.
fn in_rows(a: &Analysis<'_>) -> HashSet<usize> {
    let mut in_rows: HashSet<usize> = HashSet::new();
    let mut stack: Vec<usize> = Vec::new();
    for f in &a.facts {
        for c in &f.calls {
            if let Tag::Comp(k) = c.tag
                && c.regions.iter().any(|r| f.sites[*r].kind == SiteKind::For)
            {
                stack.push(k);
            }
        }
    }
    while let Some(x) = stack.pop() {
        if !in_rows.insert(x) {
            continue;
        }
        for c in &a.facts[x].calls {
            if let Tag::Comp(k) = c.tag {
                stack.push(k);
            }
        }
    }
    in_rows
}
