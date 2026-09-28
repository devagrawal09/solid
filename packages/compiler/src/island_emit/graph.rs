//! The island partitioner and tier selector.
//!
//! 1. **Facts.** Every view hole, handler, `Show` / `For` input, effect and
//!    memo is a *site* with the symbols and `props.*` members it references.
//! 2. **Flows.** Each binding carries an abstract value: the cells (and
//!    memos) it may read and write when evaluated or called. Props join over
//!    call sites, context values over providers; a fixpoint closes them.
//!    This over-approximates: any reference counts, whether or not it is
//!    called.
//! 3. **Liveness.** A cell is live when some event handler, effect or
//!    settled body may write it (a cell nothing writes is
//!    server-authoritative). A memo is live when it reads a live cell. A hole
//!    is live when it reads a live cell or memo.
//! 4. **Islands.** Live sites and the live cells / memos they touch are
//!    joined (union-find): each connected group is one island, cut from the
//!    graph rather than from components — two unrelated cells in one
//!    component are two islands, and one island may span a parent and its
//!    children. The island's root is the component that creates its state
//!    and renders every member.
//! 5. **Tiers** (documentation/plans/island-runtime-tiers.md §1): tier 0 (no
//!    reactive runtime) for a one-component island whose cells only its own
//!    handlers write and whose holes read unconditionally with no memo,
//!    effect or dynamic structure; tier 2 for stores, async, optimistic
//!    writes, actions and boundaries; tier 1 (the kernel) otherwise. A group
//!    takes the highest tier any member needs.
use std::collections::{BTreeSet, HashMap, HashSet};

use oxc_ast::ast::{
    ArrowFunctionExpression, CallExpression, ConditionalExpression, Expression, Function,
    IdentifierReference, IfStatement, JSXElement, LogicalExpression, StaticMemberExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{ScopeFlags, SymbolId};
use oxc_span::{GetSpan, Span};

use super::jsx::{self, AttrVal, Child, Root, Tag};
use super::model::{CellHost, FnRef, Item, LocalDecl, Model};

pub(crate) type Key = (usize, usize);

#[derive(Default, Clone, Debug)]
pub(crate) struct Refs {
    pub syms: Vec<(SymbolId, bool)>,
    pub props: Vec<(String, bool)>,
    pub props_bare: bool,
    pub calls: Vec<String>,
    pub has_jsx: bool,
    pub prevent_default: bool,
    /// Symbols passed to `refresh(…)`: a refresh re-runs their source (a
    /// write, for liveness).
    pub refreshed: Vec<SymbolId>,
}

struct Walker<'m, 'a> {
    m: &'m Model<'a>,
    props: Option<SymbolId>,
    out: Refs,
    cond: u32,
}

impl<'a> Visit<'a> for Walker<'_, 'a> {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if let Some(s) = self.m.symbol_of(id) {
            if Some(s) == self.props {
                self.out.props_bare = true;
            } else {
                self.out.syms.push((s, self.cond > 0));
            }
        }
    }
    fn visit_static_member_expression(&mut self, e: &StaticMemberExpression<'a>) {
        if e.property.name == "preventDefault" {
            self.out.prevent_default = true;
        }
        if let Expression::Identifier(id) = &e.object
            && self.props.is_some()
            && self.m.symbol_of(id) == self.props
        {
            self.out
                .props
                .push((e.property.name.to_string(), self.cond > 0));
            return;
        }
        walk::walk_static_member_expression(self, e);
    }
    fn visit_conditional_expression(&mut self, e: &ConditionalExpression<'a>) {
        self.visit_expression(&e.test);
        self.cond += 1;
        self.visit_expression(&e.consequent);
        self.visit_expression(&e.alternate);
        self.cond -= 1;
    }
    fn visit_logical_expression(&mut self, e: &LogicalExpression<'a>) {
        self.visit_expression(&e.left);
        self.cond += 1;
        self.visit_expression(&e.right);
        self.cond -= 1;
    }
    fn visit_if_statement(&mut self, s: &IfStatement<'a>) {
        self.visit_expression(&s.test);
        self.cond += 1;
        self.visit_statement(&s.consequent);
        if let Some(a) = &s.alternate {
            self.visit_statement(a);
        }
        self.cond -= 1;
    }
    fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
        self.cond += 1;
        walk::walk_function(self, f, flags);
        self.cond -= 1;
    }
    fn visit_arrow_function_expression(&mut self, a: &ArrowFunctionExpression<'a>) {
        self.cond += 1;
        walk::walk_arrow_function_expression(self, a);
        self.cond -= 1;
    }
    fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
        if let Some(n) = self.m.runtime_name(&c.callee) {
            if n == "refresh" {
                for a in &c.arguments {
                    if let Some(s) = a.as_expression().and_then(|e| self.m.symbol_of_expr(e)) {
                        self.out.refreshed.push(s);
                    }
                }
            }
            self.out.calls.push(n.to_string());
        }
        walk::walk_call_expression(self, c);
    }
    fn visit_jsx_element(&mut self, e: &JSXElement<'a>) {
        self.out.has_jsx = true;
        walk::walk_jsx_element(self, e);
    }
}

pub(crate) fn refs_expr<'a>(m: &Model<'a>, props: Option<SymbolId>, e: &Expression<'a>) -> Refs {
    let mut w = Walker {
        m,
        props,
        out: Refs::default(),
        cond: 0,
    };
    w.visit_expression(e);
    w.out
}

pub(crate) fn refs_fn<'a>(m: &Model<'a>, props: Option<SymbolId>, f: FnRef<'a>) -> Refs {
    let mut w = Walker {
        m,
        props,
        out: Refs::default(),
        cond: 0,
    };
    match f {
        FnRef::Func(func) => walk::walk_function(&mut w, func, ScopeFlags::Function),
        FnRef::Arrow(a) => walk::walk_arrow_function_expression(&mut w, a),
    }
    w.out
}

pub(crate) fn refs_stmt<'a>(m: &Model<'a>, s: &oxc_ast::ast::Statement<'a>) -> Refs {
    let mut w = Walker {
        m,
        props: None,
        out: Refs::default(),
        cond: 0,
    };
    w.visit_statement(s);
    w.out
}

fn refs_local<'a>(m: &Model<'a>, props: Option<SymbolId>, d: &LocalDecl<'a>) -> Refs {
    let mut w = Walker {
        m,
        props,
        out: Refs::default(),
        cond: 0,
    };
    match d {
        LocalDecl::Var(v) => {
            if let Some(i) = &v.init {
                w.visit_expression(i);
            }
        }
        LocalDecl::Func(f) => walk::walk_function(&mut w, f, ScopeFlags::Function),
    }
    w.out
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum SiteKind {
    /// A child expression hole.
    Text,
    /// A dynamic attribute (`class`, `style`, `href`, …).
    Attr(String),
    /// `on*` handler (event name).
    Handler(String),
    /// `<Show when>`.
    Show,
    /// `<For each>`.
    For,
    /// A setup effect (`$effect`) or settled body; item index.
    Effect(usize, bool),
}

// `expr` / `regions` complete the site record for consumers of the analysis.
#[allow(dead_code)]
pub(crate) struct Site<'a> {
    pub kind: SiteKind,
    pub span: Span,
    pub expr: Option<&'a Expression<'a>>,
    pub refs: Refs,
    /// The live-region sites (Show/For) of this component enclosing it.
    pub regions: Vec<usize>,
    /// `Show` / `For`: the render callback's parameter (`item => …`).
    pub param: Option<SymbolId>,
}

pub(crate) struct Call<'a> {
    pub tag: Tag,
    pub props: Vec<(String, Option<&'a Expression<'a>>)>,
    pub regions: Vec<usize>,
    pub span: Span,
}

#[derive(Default)]
pub(crate) struct CompFacts<'a> {
    pub sites: Vec<Site<'a>>,
    pub site_at: HashMap<u32, usize>,
    pub calls: Vec<Call<'a>>,
    pub providers: Vec<(SymbolId, Option<&'a Expression<'a>>)>,
    /// Boundaries (`Loading` / `Errored`) with their enclosing regions.
    pub boundaries: Vec<(String, Vec<usize>)>,
    pub issues: Vec<String>,
    /// Refs per setup item (init / body).
    pub item_refs: Vec<Refs>,
    /// `props.children` rendered as a child (a pass-through slot).
    pub slot: bool,
}

struct ViewWalk<'m, 'a> {
    m: &'m Model<'a>,
    props: Option<SymbolId>,
    f: CompFacts<'a>,
    regions: Vec<usize>,
}

impl<'a> ViewWalk<'_, 'a> {
    fn site(
        &mut self,
        kind: SiteKind,
        span: Span,
        expr: Option<&'a Expression<'a>>,
        refs: Refs,
    ) -> usize {
        let i = self.f.sites.len();
        self.f.site_at.insert(span.start, i);
        self.f.sites.push(Site {
            kind,
            span,
            expr,
            refs,
            regions: self.regions.clone(),
            param: None,
        });
        i
    }
    fn expr_hole(&mut self, e: &'a Expression<'a>) {
        // `props.children` as a child: pass-through slot.
        if let Expression::StaticMemberExpression(me) = e.without_parentheses()
            && me.property.name == "children"
            && let Expression::Identifier(id) = &me.object
            && self.props.is_some()
            && self.m.symbol_of(id) == self.props
        {
            self.f.slot = true;
            return;
        }
        let refs = refs_expr(self.m, self.props, e);
        let has_jsx = refs.has_jsx;
        // Component call forms (`User(props)`, `Loading({ … })`) render
        // components the partitioner cannot see as JSX: not compiled.
        for (s, _) in &refs.syms {
            let name = self.m.runtime.get(s).map(String::as_str);
            if (self.m.comp_of.contains_key(s) || name.is_some_and(|n| jsx::BUILTINS.contains(&n)))
                && text_calls(self.m.text(e.span()), self.m.sym_name(*s))
            {
                self.f.issues.push(format!(
                    "component call form `{}(…)` in a view (write it as JSX)",
                    self.m.sym_name(*s)
                ));
            }
        }
        self.site(SiteKind::Text, e.span(), Some(e), refs);
        if has_jsx {
            // Nested JSX inside an expression: its component calls and
            // providers are real edges; handlers there are not compiled.
            let before = self.f.sites.len();
            self.nested_jsx(e);
            if self.f.sites[before..]
                .iter()
                .any(|s| matches!(s.kind, SiteKind::Handler(_)))
            {
                self.f
                    .issues
                    .push("event handler inside JSX nested in an expression".into());
            }
        }
    }
    fn nested_jsx(&mut self, e: &'a Expression<'a>) {
        let mut roots = Vec::new();
        let mut complete = true;
        find_jsx(e, &mut roots, &mut complete);
        if !complete || roots.len() != count_jsx_roots(e) {
            self.f.issues.push(format!(
                "JSX in an expression form the island compiler does not follow: `{}`",
                super::model::short(self.m.text(e.span()))
            ));
        }
        for r in roots {
            match r {
                Root::Element(el) => self.element(el),
                Root::Fragment(f) => self.kids(&f.children),
            }
        }
    }
    fn kids(&mut self, kids: &'a [oxc_ast::ast::JSXChild<'a>]) {
        match jsx::children(kids) {
            Ok(list) => {
                for c in list {
                    self.child(c);
                }
            }
            Err(e) => self.f.issues.push(e),
        }
    }
    fn child(&mut self, c: Child<'a>) {
        match c {
            Child::Text(_) => {}
            Child::Expr(e) => {
                if jsx::static_child(e).is_none() {
                    self.expr_hole(e);
                }
            }
            Child::Element(el) => self.element(el),
            Child::Fragment(f) => self.kids(&f.children),
        }
    }
    fn root(&mut self, e: &'a Expression<'a>) {
        match jsx::root_of(e) {
            Some(Root::Element(el)) => self.element(el),
            Some(Root::Fragment(f)) => self.kids(&f.children),
            None => self.expr_hole(e),
        }
    }
    /// Function children (`{item => <x/>}`) or plain JSX children.
    fn render_children(&mut self, el: &'a JSXElement<'a>) {
        let list = match jsx::children(&el.children) {
            Ok(l) => l,
            Err(e) => {
                self.f.issues.push(e);
                return;
            }
        };
        for c in list {
            if let Child::Expr(e) = c
                && let Some(f) = FnRef::from_expr(e)
            {
                self.fn_body(f);
                continue;
            }
            self.child(c);
        }
    }
    fn fn_body(&mut self, f: FnRef<'a>) {
        if f.is_concise() {
            if let Some(s) = f.concise() {
                self.root(s);
            }
            return;
        }
        let stmts = f.statements();
        match stmts.last() {
            Some(oxc_ast::ast::Statement::ReturnStatement(r)) if stmts.len() == 1 => {
                if let Some(a) = &r.argument {
                    self.root(a);
                }
            }
            _ => {
                // Statements before the markup (an error fallback that logs,
                // a row that computes a local): the markup is every `return`'s
                // JSX; the statements run where the callback runs (the server
                // for inert content; client emission refuses live callbacks
                // with statements). Handlers inside are not compiled.
                let before = self.f.sites.len();
                let mut v = Returns { out: Vec::new() };
                for s in stmts {
                    v.visit_statement(s);
                }
                for e in v.out {
                    let e: &'a Expression<'a> = unsafe { &*(e as *const Expression<'a>) };
                    self.root(e);
                }
                if self.f.sites[before..]
                    .iter()
                    .any(|s| matches!(s.kind, SiteKind::Handler(_)))
                {
                    self.f
                        .issues
                        .push("event handler inside a render callback with statements".into());
                }
            }
        }
    }
    fn attr_jsx(&mut self, v: &AttrVal<'a>) {
        match v {
            AttrVal::Element(e) => self.element(e),
            AttrVal::Fragment(f) => self.kids(&f.children),
            AttrVal::Expr(e) => {
                if let Some(Root::Element(el)) = jsx::root_of(e) {
                    self.element(el);
                } else if let Some(Root::Fragment(f)) = jsx::root_of(e) {
                    self.kids(&f.children);
                } else if let Some(f) = FnRef::from_expr(e) {
                    self.fn_body(f);
                } else {
                    let r = refs_expr(self.m, self.props, e);
                    if r.has_jsx {
                        self.nested_jsx(e);
                    }
                }
            }
            _ => {}
        }
    }
    fn element(&mut self, el: &'a JSXElement<'a>) {
        let attrs = match jsx::attrs(el) {
            Ok(a) => a,
            Err(e) => {
                self.f.issues.push(e);
                return;
            }
        };
        match jsx::tag_of(self.m, &el.opening_element.name) {
            Tag::Intrinsic(_) => {
                for a in &attrs {
                    match &a.value {
                        AttrVal::Expr(e) if jsx::is_event_attr(&a.name) => {
                            let refs = refs_expr(self.m, self.props, e);
                            self.site(
                                SiteKind::Handler(jsx::event_name(&a.name)),
                                e.span(),
                                Some(e),
                                refs,
                            );
                        }
                        AttrVal::Expr(_) if a.name == "ref" => {
                            self.f.issues.push("`ref` attribute".into())
                        }
                        AttrVal::Expr(e) if jsx::static_child(e).is_none() => {
                            let refs = refs_expr(self.m, self.props, e);
                            self.site(SiteKind::Attr(a.name.clone()), e.span(), Some(e), refs);
                        }
                        AttrVal::Expr(_) => {}
                        AttrVal::Element(_) | AttrVal::Fragment(_) => self
                            .f
                            .issues
                            .push(format!("JSX as the value of attribute `{}`", a.name)),
                        _ => {}
                    }
                }
                self.kids(&el.children);
            }
            Tag::Builtin(name) => match name.as_str() {
                "Show" | "For" => {
                    let input = if name == "Show" { "when" } else { "each" };
                    let site = match jsx::attr(&attrs, input).map(|a| &a.value) {
                        Some(AttrVal::Expr(e)) => {
                            let refs = refs_expr(self.m, self.props, e);
                            let kind = if name == "Show" {
                                SiteKind::Show
                            } else {
                                SiteKind::For
                            };
                            Some(self.site(kind, e.span(), Some(e), refs))
                        }
                        _ => {
                            self.f
                                .issues
                                .push(format!("<{name}> without an expression `{input}`"));
                            None
                        }
                    };
                    for a in &attrs {
                        if a.name != input && a.name != "fallback" && a.name != "keyed" {
                            self.f.issues.push(format!("<{name} {}>", a.name));
                        }
                    }
                    if let Some(s) = site {
                        self.regions.push(s);
                        // The render callback's parameter carries the input.
                        if let Ok(kids) = jsx::children(&el.children)
                            && let [Child::Expr(e)] = kids.as_slice()
                            && let Some(f) = FnRef::from_expr(e)
                            && let Some(p) = f.params().items.first()
                            && let oxc_ast::ast::BindingPattern::BindingIdentifier(id) = &p.pattern
                        {
                            self.f.sites[s].param = id.symbol_id.get();
                        }
                    }
                    if let Some(fb) = jsx::attr(&attrs, "fallback") {
                        self.attr_jsx(&fb.value);
                    }
                    self.render_children(el);
                    if site.is_some() {
                        self.regions.pop();
                    }
                }
                "Loading" | "Errored" => {
                    self.f.boundaries.push((name.clone(), self.regions.clone()));
                    if let Some(fb) = jsx::attr(&attrs, "fallback") {
                        // A boundary's fallback is server HTML in islands
                        // mode (rendered in the shell, or streamed over the
                        // region on a failure): its holes and handlers are
                        // not island sites. Its components and providers
                        // still render.
                        let before = self.f.sites.len();
                        self.attr_jsx(&fb.value);
                        for s in self.f.sites.drain(before..) {
                            self.f.site_at.remove(&s.span.start);
                        }
                    }
                    self.kids(&el.children);
                }
                other => {
                    self.f
                        .issues
                        .push(format!("<{other}> (not compiled to islands yet)"));
                }
            },
            Tag::Provider(ctx) => {
                let value = match jsx::attr(&attrs, "value").map(|a| &a.value) {
                    Some(AttrVal::Expr(e)) => Some(*e),
                    _ => None,
                };
                self.f.providers.push((ctx, value));
                self.kids(&el.children);
            }
            tag @ (Tag::Comp(_) | Tag::Opaque(_)) => {
                let mut props = Vec::new();
                for a in &attrs {
                    match &a.value {
                        AttrVal::Expr(e) => props.push((a.name.clone(), Some(*e))),
                        AttrVal::Element(_) | AttrVal::Fragment(_) => {
                            props.push((a.name.clone(), None));
                            self.attr_jsx(&a.value);
                        }
                        _ => props.push((a.name.clone(), None)),
                    }
                }
                if let Tag::Opaque(n) = &tag
                    && n == "<member>"
                {
                    self.f.issues.push("member-expression JSX tag".into());
                }
                self.f.calls.push(Call {
                    tag,
                    props,
                    regions: self.regions.clone(),
                    span: el.span,
                });
                // Children are rendered in this component's scope.
                self.render_children(el);
            }
        }
    }
}

/// `return` arguments of a function body (not of nested functions).
struct Returns<'x> {
    out: Vec<&'x Expression<'x>>,
}

impl<'a> Visit<'a> for Returns<'a> {
    fn visit_return_statement(&mut self, r: &oxc_ast::ast::ReturnStatement<'a>) {
        if let Some(a) = &r.argument {
            let a: &'a Expression<'a> = unsafe { &*(a as *const Expression<'a>) };
            self.out.push(a);
        }
    }
    fn visit_function(&mut self, _: &Function<'a>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
}

pub(crate) struct Group {
    pub id: String,
    pub root: usize,
    /// Components with state or sites in the group (root first).
    pub members: Vec<usize>,
    pub keys: BTreeSet<Key>,
    /// (comp, site)
    pub sites: Vec<(usize, usize)>,
    pub tier: u8,
    pub own_tiers: Vec<(usize, u8)>,
    pub why: Vec<String>,
    pub unsupported: Vec<String>,
    pub events: Vec<String>,
    /// Window events whose listener a settled body registers (lazy stubs).
    pub window_events: Vec<String>,
    /// A load-time effect other than a listener stub: activate at load.
    pub hot: bool,
    pub prevent_default: bool,
}

#[derive(Default, Clone, PartialEq, Debug)]
pub(crate) struct Av {
    pub reads: BTreeSet<Key>,
    pub writes: BTreeSet<Key>,
}

impl Av {
    fn join(&mut self, o: &Av) -> bool {
        let before = self.reads.len() + self.writes.len();
        self.reads.extend(o.reads.iter().copied());
        self.writes.extend(o.writes.iter().copied());
        before != self.reads.len() + self.writes.len()
    }
}

pub(crate) struct Analysis<'a> {
    pub facts: Vec<CompFacts<'a>>,
    pub sym_av: HashMap<SymbolId, Av>,
    pub prop_av: HashMap<(usize, String), Av>,
    pub ctx_av: HashMap<SymbolId, Av>,
    pub written: BTreeSet<Key>,
    pub written_by_effect: BTreeSet<Key>,
    /// Cells whose setter escapes to code the compiler cannot see.
    pub escaped_writes: BTreeSet<Key>,
    pub live: BTreeSet<Key>,
    pub memo_deps: HashMap<Key, BTreeSet<Key>>,
    /// Live flags per component per site.
    pub site_live: Vec<Vec<bool>>,
    pub groups: Vec<Group>,
    /// (comp, site) → group index.
    pub group_of_site: HashMap<(usize, usize), usize>,
    pub group_of_key: HashMap<Key, usize>,
    /// Components rooting a group.
    pub root_of: HashMap<usize, Vec<usize>>,
    pub callers: Vec<BTreeSet<usize>>,
    pub issues: Vec<String>,
}

impl<'a> Analysis<'a> {
    pub(crate) fn av_of(&self, comp: usize, r: &Refs) -> Av {
        let mut av = Av::default();
        for (s, _) in &r.syms {
            if let Some(x) = self.sym_av.get(s) {
                av.join(x);
            }
        }
        for (p, _) in &r.props {
            if let Some(x) = self.prop_av.get(&(comp, p.clone())) {
                av.join(x);
            }
        }
        if r.props_bare {
            for ((c, _), x) in &self.prop_av {
                if *c == comp {
                    av.join(x);
                }
            }
        }
        av
    }
    /// Live keys a site's expression reads, and whether any is read
    /// conditionally.
    pub(crate) fn live_reads(&self, comp: usize, r: &Refs) -> (BTreeSet<Key>, bool) {
        let mut out = BTreeSet::new();
        let mut cond = false;
        for (s, c) in &r.syms {
            if let Some(x) = self.sym_av.get(s) {
                for k in &x.reads {
                    if self.live.contains(k) {
                        out.insert(*k);
                        cond |= *c;
                    }
                }
            }
        }
        for (p, c) in &r.props {
            if let Some(x) = self.prop_av.get(&(comp, p.clone())) {
                for k in &x.reads {
                    if self.live.contains(k) {
                        out.insert(*k);
                        cond |= *c;
                    }
                }
            }
        }
        if r.props_bare {
            let av = self.av_of(
                comp,
                &Refs {
                    props_bare: true,
                    ..Refs::default()
                },
            );
            out.extend(av.reads.into_iter().filter(|k| self.live.contains(k)));
        }
        (out, cond)
    }
    pub(crate) fn is_live_site(&self, comp: usize, span_start: u32) -> bool {
        self.facts[comp]
            .site_at
            .get(&span_start)
            .is_some_and(|i| self.site_live[comp][*i])
    }
}

/// Store keys among `reads`, through the memos that read them.
fn store_keys(m: &Model<'_>, a: &Analysis<'_>, reads: &BTreeSet<Key>) -> BTreeSet<Key> {
    let mut out = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut stack: Vec<Key> = reads.iter().copied().collect();
    while let Some(k) = stack.pop() {
        if !seen.insert(k) {
            continue;
        }
        match &m.comps[k.0].setup[k.1] {
            Item::Cell {
                host: CellHost::Store | CellHost::Optimistic,
                ..
            } => {
                out.insert(k);
            }
            Item::Memo { .. } => {
                let v = a.av_of(k.0, &a.facts[k.0].item_refs[k.1]);
                stack.extend(v.reads);
            }
            _ => {}
        }
    }
    out
}

fn key_is_memo(m: &Model<'_>, k: Key) -> bool {
    matches!(m.comps[k.0].setup[k.1], Item::Memo { .. })
}

pub(crate) fn analyze<'a>(m: &Model<'a>, id_prefix: &str) -> Analysis<'a> {
    let n = m.comps.len();
    let mut facts: Vec<CompFacts<'a>> = Vec::with_capacity(n);
    for c in &m.comps {
        let mut w = ViewWalk {
            m,
            props: c.props,
            f: CompFacts::default(),
            regions: vec![],
        };
        if let Some(v) = c.view {
            w.root(v);
        }
        for s in &c.view_stmts {
            let mut rw = Walker {
                m,
                props: c.props,
                out: Refs::default(),
                cond: 0,
            };
            rw.visit_statement(s);
            // A view statement's reads are reads of the whole view.
            let span = s.span();
            w.f.site_at.insert(span.start, w.f.sites.len());
            w.f.sites.push(Site {
                kind: SiteKind::Text,
                span,
                expr: None,
                refs: rw.out,
                regions: vec![],
                param: None,
            });
            w.f.issues
                .push("statements before the view's return".into());
        }
        let mut item_refs = Vec::new();
        for (ii, item) in c.setup.iter().enumerate() {
            let r = match item {
                Item::Cell { init, .. } => {
                    init.map(|e| refs_expr(m, c.props, e)).unwrap_or_default()
                }
                Item::Memo { body, .. } | Item::Event { body, .. } => refs_fn(m, c.props, *body),
                Item::Effect {
                    body,
                    settled,
                    span,
                } => {
                    let r = refs_fn(m, c.props, *body);
                    w.f.site_at.insert(span.start, w.f.sites.len());
                    w.f.sites.push(Site {
                        kind: SiteKind::Effect(ii, *settled),
                        span: *span,
                        expr: None,
                        refs: r.clone(),
                        regions: vec![],
                param: None,
                    });
                    r
                }
                Item::Context { .. } => Refs::default(),
                Item::Local { decl, .. } => refs_local(m, c.props, decl),
                Item::Cleanup { arg, .. } => refs_expr(m, c.props, arg),
                Item::Stmt { stmt, .. } => {
                    let mut w = Walker {
                        m,
                        props: c.props,
                        out: Refs::default(),
                        cond: 0,
                    };
                    w.visit_statement(stmt);
                    w.out
                }
            };
            item_refs.push(r);
        }
        w.f.item_refs = item_refs;
        let mut f = w.f;
        f.issues.extend(c.issues.iter().cloned());
        facts.push(f);
    }

    // --- flows: abstract values to a fixpoint ----------------------------------
    let mut sym_av: HashMap<SymbolId, Av> = HashMap::new();
    for (ci, c) in m.comps.iter().enumerate() {
        for (ii, item) in c.setup.iter().enumerate() {
            match item {
                Item::Cell { get, set, .. } => {
                    sym_av.entry(*get).or_default().reads.insert((ci, ii));
                    if let Some(s) = set {
                        sym_av.entry(*s).or_default().writes.insert((ci, ii));
                    }
                }
                Item::Memo { sym, .. } => {
                    sym_av.entry(*sym).or_default().reads.insert((ci, ii));
                }
                _ => {}
            }
        }
    }
    let mut a = Analysis {
        facts,
        sym_av,
        prop_av: HashMap::new(),
        ctx_av: HashMap::new(),
        written: BTreeSet::new(),
        written_by_effect: BTreeSet::new(),
        escaped_writes: BTreeSet::new(),
        live: BTreeSet::new(),
        memo_deps: HashMap::new(),
        site_live: vec![],
        groups: vec![],
        group_of_site: HashMap::new(),
        group_of_key: HashMap::new(),
        root_of: HashMap::new(),
        callers: vec![BTreeSet::new(); n],
        issues: m.issues.clone(),
    };
    loop {
        let mut changed = false;
        for (ci, c) in m.comps.iter().enumerate() {
            for (ii, item) in c.setup.iter().enumerate() {
                let targets: Vec<SymbolId> = match item {
                    Item::Local { symbols, .. } => symbols.clone(),
                    Item::Event { sym, .. } => vec![*sym],
                    Item::Context { symbols, ctx, .. } => {
                        let v = a.ctx_av.get(ctx).cloned().unwrap_or_default();
                        for s in symbols {
                            changed |= a.sym_av.entry(*s).or_default().join(&v);
                        }
                        continue;
                    }
                    _ => continue,
                };
                let v = a.av_of(ci, &a.facts[ci].item_refs[ii].clone());
                for s in targets {
                    changed |= a.sym_av.entry(s).or_default().join(&v);
                }
            }
            for call in 0..a.facts[ci].calls.len() {
                let Tag::Comp(child) = a.facts[ci].calls[call].tag else {
                    continue;
                };
                for pi in 0..a.facts[ci].calls[call].props.len() {
                    let (name, expr) = a.facts[ci].calls[call].props[pi].clone();
                    let v = match expr {
                        Some(e) => a.av_of(ci, &refs_expr(m, c.props, e)),
                        None => Av::default(),
                    };
                    changed |= a.prop_av.entry((child, name)).or_default().join(&v);
                }
            }
            // Render callback parameters: a keyed `Show`'s value is its
            // input; a `For` row over a store is the store's (a row reads
            // its item's fields through the proxy: live when the store is).
            // Rows over plain values (an immutable array in a signal) stay
            // plain: the item never changes for a keyed row.
            for si in 0..a.facts[ci].sites.len() {
                let site = &a.facts[ci].sites[si];
                let Some(p) = site.param else { continue };
                let v = a.av_of(ci, &site.refs.clone());
                let v = if site.kind == SiteKind::For {
                    Av {
                        reads: store_keys(m, &a, &v.reads),
                        writes: BTreeSet::new(),
                    }
                } else {
                    Av {
                        reads: v.reads,
                        writes: BTreeSet::new(),
                    }
                };
                changed |= a.sym_av.entry(p).or_default().join(&v);
            }
            for pi in 0..a.facts[ci].providers.len() {
                let (ctx, value) = a.facts[ci].providers[pi];
                let v = match value {
                    Some(e) => a.av_of(ci, &refs_expr(m, c.props, e)),
                    None => Av::default(),
                };
                changed |= a.ctx_av.entry(ctx).or_default().join(&v);
            }
        }
        if !changed {
            break;
        }
    }
    for (ci, f) in a.facts.iter().enumerate() {
        for call in &f.calls {
            if let Tag::Comp(child) = call.tag {
                a.callers[child].insert(ci);
            }
        }
    }

    // --- liveness -------------------------------------------------------------------
    for (ci, c) in m.comps.iter().enumerate() {
        for (ii, item) in c.setup.iter().enumerate() {
            match item {
                Item::Event { .. } => {
                    let v = a.av_of(ci, &a.facts[ci].item_refs[ii]);
                    a.written.extend(v.writes);
                }
                Item::Effect { .. } => {
                    let v = a.av_of(ci, &a.facts[ci].item_refs[ii]);
                    a.written_by_effect.extend(v.writes.iter().copied());
                    a.written.extend(v.writes);
                }
                // A setter reaching a setup statement, a cleanup, or a local
                // computed by a call may be stored anywhere (a module
                // variable, a registry): it escapes, and the cell counts as
                // written by code the compiler cannot see.
                Item::Stmt { .. } | Item::Cleanup { .. } => {
                    let v = a.av_of(ci, &a.facts[ci].item_refs[ii]);
                    a.escaped_writes.extend(v.writes.iter().copied());
                    a.written.extend(v.writes);
                }
                Item::Local {
                    decl: LocalDecl::Var(d),
                    ..
                } if d
                    .init
                    .as_ref()
                    .is_some_and(|i| FnRef::from_expr(i).is_none() && contains_call(i)) =>
                {
                    let v = a.av_of(ci, &a.facts[ci].item_refs[ii]);
                    a.escaped_writes.extend(v.writes.iter().copied());
                    a.written.extend(v.writes);
                }
                _ => {}
            }
        }
        for s in &a.facts[ci].sites {
            let v = a.av_of(ci, &s.refs);
            match s.kind {
                SiteKind::Handler(_) => a.written.extend(v.writes),
                // A view expression that references a setter (other than as
                // a prop of a module component, which flows) hands it out.
                SiteKind::Text | SiteKind::Attr(_) | SiteKind::Show | SiteKind::For => {
                    a.escaped_writes.extend(v.writes.iter().copied());
                    a.written.extend(v.writes);
                }
                SiteKind::Effect(..) => {}
            }
        }
        // Setters handed to components outside the module escape: whoever
        // receives one may write.
        for call in &a.facts[ci].calls {
            if matches!(call.tag, Tag::Opaque(_)) {
                for (_, e) in &call.props {
                    if let Some(e) = e {
                        let v = a.av_of(ci, &refs_expr(m, c.props, e));
                        if !v.writes.is_empty() || !v.reads.is_empty() {
                            a.issues.push(format!(
                                "`{}` passes reactive state to a component outside the module",
                                c.name
                            ));
                        }
                        a.written.extend(v.writes);
                    }
                }
            }
        }
    }
    // `refresh(x)` anywhere re-runs x's source: x is written.
    for (ci, _) in m.comps.iter().enumerate() {
        let refreshed: Vec<SymbolId> = a.facts[ci]
            .item_refs
            .iter()
            .chain(a.facts[ci].sites.iter().map(|s| &s.refs))
            .flat_map(|r| r.refreshed.iter().copied())
            .collect();
        for s in refreshed {
            if let Some(v) = a.sym_av.get(&s) {
                a.written.extend(v.reads.iter().copied());
            }
        }
    }
    a.live = a.written.clone();
    // Memos: live when they read a live key (fixpoint).
    for (ci, c) in m.comps.iter().enumerate() {
        for (ii, item) in c.setup.iter().enumerate() {
            if let Item::Memo { .. } = item {
                let v = a.av_of(ci, &a.facts[ci].item_refs[ii]);
                a.memo_deps.insert((ci, ii), v.reads);
            }
        }
    }
    loop {
        let mut changed = false;
        for (k, deps) in &a.memo_deps {
            if !a.live.contains(k) && deps.iter().any(|d| a.live.contains(d)) {
                a.live.insert(*k);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // --- sites and union-find ----------------------------------------------------------
    let mut index: HashMap<Key, usize> = HashMap::new();
    let mut elems: Vec<Elem> = Vec::new();
    #[derive(Clone, Copy, PartialEq)]
    enum Elem {
        Key(Key),
        Site(usize, usize),
    }
    for k in &a.live {
        index.insert(*k, elems.len());
        elems.push(Elem::Key(*k));
    }
    let mut site_index: HashMap<(usize, usize), usize> = HashMap::new();
    let mut parent: Vec<usize> = (0..elems.len()).collect();
    fn find(p: &mut [usize], x: usize) -> usize {
        let mut r = x;
        while p[r] != r {
            r = p[r];
        }
        let mut y = x;
        while p[y] != r {
            let nx = p[y];
            p[y] = r;
            y = nx;
        }
        r
    }
    fn union(p: &mut [usize], x: usize, y: usize) {
        let (a, b) = (find(p, x), find(p, y));
        if a != b {
            p[b] = a;
        }
    }
    a.site_live = a.facts.iter().map(|f| vec![false; f.sites.len()]).collect();
    for ci in 0..n {
        for si in 0..a.facts[ci].sites.len() {
            let s = &a.facts[ci].sites[si];
            let (reads, _) = a.live_reads(ci, &s.refs);
            let touches: BTreeSet<Key> = match s.kind {
                SiteKind::Handler(_) | SiteKind::Effect(..) => {
                    let v = a.av_of(ci, &s.refs);
                    v.reads
                        .union(&v.writes)
                        .filter(|k| a.live.contains(k))
                        .copied()
                        .collect()
                }
                _ => reads,
            };
            let always = matches!(s.kind, SiteKind::Handler(_) | SiteKind::Effect(..));
            if touches.is_empty() && !always {
                continue;
            }
            a.site_live[ci][si] = true;
            let e = elems.len();
            elems.push(Elem::Site(ci, si));
            parent.push(e);
            site_index.insert((ci, si), e);
            for k in touches {
                union(&mut parent, e, index[&k]);
            }
        }
    }
    for (k, deps) in a.memo_deps.clone() {
        if !a.live.contains(&k) {
            continue;
        }
        for d in deps {
            if a.live.contains(&d) {
                union(&mut parent, index[&k], index[&d]);
            }
        }
    }
    // A component whose setup has side-effect statements must run them
    // once: all of its live parts form one island.
    for (ci, c) in m.comps.iter().enumerate() {
        if !c.setup.iter().any(|it| matches!(it, Item::Stmt { .. })) {
            continue;
        }
        let mine: Vec<usize> = (0..elems.len())
            .filter(|e| match elems[*e] {
                Elem::Key(k) => k.0 == ci,
                Elem::Site(c2, _) => c2 == ci,
            })
            .collect();
        for w in mine.windows(2) {
            union(&mut parent, w[0], w[1]);
        }
    }

    // Dominance: `dominated[c]` = components rendered only under c.
    let exported: Vec<bool> = m.comps.iter().map(|c| c.exported).collect();
    let dominated = |c: usize, callers: &Vec<BTreeSet<usize>>| -> HashSet<usize> {
        let mut d: HashSet<usize> = HashSet::new();
        loop {
            let mut changed = false;
            for x in 0..n {
                if x == c || d.contains(&x) || exported[x] || callers[x].is_empty() {
                    continue;
                }
                if callers[x].iter().all(|p| *p == c || d.contains(p)) {
                    d.insert(x);
                    changed = true;
                }
            }
            if !changed {
                break d;
            }
        }
    };
    // Components reachable from a component's view (transitively).
    let reach = |c: usize, facts: &Vec<CompFacts<'a>>| -> HashSet<usize> {
        let mut seen = HashSet::new();
        let mut stack = vec![c];
        while let Some(x) = stack.pop() {
            for call in &facts[x].calls {
                if let Tag::Comp(y) = call.tag
                    && seen.insert(y)
                {
                    stack.push(y);
                }
            }
        }
        seen
    };

    // Merge loop: a component that is a member of one group and roots (or is
    // a member of) another joins them; so does a group rendered inside
    // another group's live region (its DOM is created by that group).
    let mut groups_raw: Vec<Vec<usize>>;
    loop {
        let mut by_root: HashMap<usize, Vec<usize>> = HashMap::new();
        for e in 0..elems.len() {
            let r = find(&mut parent, e);
            by_root.entry(r).or_default().push(e);
        }
        let mut roots: Vec<usize> = by_root.keys().copied().collect();
        roots.sort();
        groups_raw = roots.iter().map(|r| by_root[r].clone()).collect();
        let comp_sets: Vec<BTreeSet<usize>> = groups_raw
            .iter()
            .map(|g| {
                g.iter()
                    .map(|e| match elems[*e] {
                        Elem::Key(k) => k.0,
                        Elem::Site(c, _) => c,
                    })
                    .collect()
            })
            .collect();
        let mut merged = false;
        'outer: for (gi, g) in groups_raw.iter().enumerate() {
            for e in g {
                let Elem::Site(ci, si) = elems[*e] else {
                    continue;
                };
                if !matches!(a.facts[ci].sites[si].kind, SiteKind::Show | SiteKind::For) {
                    continue;
                }
                // Components rendered inside this live region.
                let mut inside: HashSet<usize> = HashSet::new();
                for call in &a.facts[ci].calls {
                    if call.regions.contains(&si)
                        && let Tag::Comp(y) = call.tag
                    {
                        inside.insert(y);
                        inside.extend(reach(y, &a.facts));
                    }
                }
                for (gj, cs) in comp_sets.iter().enumerate() {
                    if gj != gi && cs.iter().any(|c| inside.contains(c)) {
                        union(&mut parent, g[0], groups_raw[gj][0]);
                        merged = true;
                        break 'outer;
                    }
                }
            }
        }
        if !merged {
            break;
        }
    }

    for (gi, g) in groups_raw.iter().enumerate() {
        let mut keys = BTreeSet::new();
        let mut sites = Vec::new();
        let mut comps: BTreeSet<usize> = BTreeSet::new();
        for e in g {
            match elems[*e] {
                Elem::Key(k) => {
                    keys.insert(k);
                    comps.insert(k.0);
                }
                Elem::Site(c, s) => {
                    sites.push((c, s));
                    comps.insert(c);
                }
            }
        }
        sites.sort();
        let mut unsupported = Vec::new();
        // Root: the component that renders every member.
        let owners: BTreeSet<usize> = if keys.is_empty() {
            comps.clone()
        } else {
            keys.iter().map(|k| k.0).collect()
        };
        let mut root = None;
        for c in &owners {
            let d = dominated(*c, &a.callers);
            if comps.iter().all(|x| x == c || d.contains(x)) {
                root = Some(*c);
                break;
            }
        }
        let root = root.unwrap_or_else(|| {
            unsupported.push(format!(
                "no single component renders every member ({})",
                comps
                    .iter()
                    .map(|c| m.comps[*c].name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            *comps.iter().next().unwrap()
        });
        let mut members: Vec<usize> = vec![root];
        members.extend(comps.iter().copied().filter(|c| *c != root));
        for c in &members {
            if reach(*c, &a.facts).contains(c) {
                unsupported.push(format!(
                    "`{}` renders itself (recursion inside an island)",
                    m.comps[*c].name
                ));
            }
            for issue in &a.facts[*c].issues {
                unsupported.push(format!("`{}`: {issue}", m.comps[*c].name));
            }
        }

        // --- tier -------------------------------------------------------------------
        let mut t2: Vec<String> = Vec::new();
        let mut t1: Vec<String> = Vec::new();
        let mut own: HashMap<usize, u8> = members.iter().map(|c| (*c, 0u8)).collect();
        let bump = |own: &mut HashMap<usize, u8>, c: usize, t: u8| {
            let e = own.entry(c).or_insert(0);
            *e = (*e).max(t);
        };
        for k in &keys {
            match &m.comps[k.0].setup[k.1] {
                Item::Cell {
                    host: CellHost::Store,
                    name,
                    ..
                } => {
                    t2.push(format!("store `{name}` (the kernel has no stores)"));
                    bump(&mut own, k.0, 2);
                }
                Item::Cell {
                    host: CellHost::Optimistic,
                    name,
                    ..
                } => {
                    t2.push(format!("async / optimistic cell `{name}`"));
                    bump(&mut own, k.0, 2);
                }
                Item::Cell { name, .. } if a.written_by_effect.contains(k) => {
                    t1.push(format!("`{name}` is written by an effect"));
                    bump(&mut own, k.0, 1);
                }
                Item::Cell { name, .. } if a.escaped_writes.contains(k) => {
                    t1.push(format!(
                        "`{name}`'s setter escapes (written outside the island's handlers)"
                    ));
                    bump(&mut own, k.0, 1);
                }
                Item::Memo { name, is_async, .. } => {
                    if *is_async {
                        t2.push(format!("async memo `{name}`"));
                        bump(&mut own, k.0, 2);
                    } else {
                        t1.push(format!("memo `{name}`"));
                        bump(&mut own, k.0, 1);
                    }
                }
                _ => {}
            }
        }
        let mut events = BTreeSet::new();
        let mut window_events = BTreeSet::new();
        let mut hot = false;
        let mut prevent_default = false;
        for (c, s) in &sites {
            let site = &a.facts[*c].sites[*s];
            let calls: Vec<&String> = site.refs.calls.iter().collect();
            for name in &calls {
                if matches!(
                    name.as_str(),
                    "attempt" | "action" | "refresh" | "startTransition" | "createAsync"
                ) {
                    t2.push(format!("`{}` calls `{name}`", m.comps[*c].name));
                    bump(&mut own, *c, 2);
                }
            }
            match &site.kind {
                SiteKind::Handler(ev) => {
                    events.insert(ev.clone());
                    prevent_default |= site.refs.prevent_default
                        || handler_prevents(m, a.sym_av_event(*c, &site.refs));
                }
                SiteKind::Show | SiteKind::For => {
                    t1.push(format!(
                        "`{}`: <{}> over a live input (dynamic structure)",
                        m.comps[*c].name,
                        if site.kind == SiteKind::Show {
                            "Show"
                        } else {
                            "For"
                        }
                    ));
                    bump(&mut own, *c, 1);
                }
                SiteKind::Effect(ii, settled) => {
                    t1.push(format!(
                        "`{}`: {} (load-time)",
                        m.comps[*c].name,
                        if *settled { "settled body" } else { "effect" }
                    ));
                    bump(&mut own, *c, 1);
                    match settled_listener(m, *c, *ii) {
                        Some(evs) if *settled => window_events.extend(evs),
                        _ => hot = true,
                    }
                }
                SiteKind::Text | SiteKind::Attr(_) => {
                    let (_, cond) = a.live_reads(*c, &site.refs);
                    if cond {
                        t1.push(format!(
                            "`{}`: conditional read in `{}`",
                            m.comps[*c].name,
                            super::model::short(m.text(site.span))
                        ));
                        bump(&mut own, *c, 1);
                    }
                }
            }
        }
        // Core-only runtime (stores, actions, refresh, …) referenced by the
        // island's code: its sites, and its members' setup items the client
        // rebuilds (a server-authoritative async memo stays on the server).
        let mut core_refs: BTreeSet<String> = BTreeSet::new();
        for (c, s) in &sites {
            for (sym, _) in &a.facts[*c].sites[*s].refs.syms {
                if let Some(n) = m.runtime.get(sym) {
                    core_refs.insert(n.clone());
                }
            }
        }
        for c in &members {
            for (ii, item) in m.comps[*c].setup.iter().enumerate() {
                if matches!(item, Item::Memo { is_async: true, .. }) && !a.live.contains(&(*c, ii)) {
                    continue;
                }
                for (sym, _) in &a.facts[*c].item_refs[ii].syms {
                    if let Some(n) = m.runtime.get(sym) {
                        core_refs.insert(n.clone());
                    }
                }
            }
        }
        for n in &core_refs {
            if super::client::CORE_ONLY.contains(&n.as_str()) || n == "readStore" {
                t2.push(format!("`{n}` (the full core)"));
            }
        }
        for c in &members {
            for (b, regions) in &a.facts[*c].boundaries {
                if regions.iter().any(|r| a.site_live[*c][*r]) {
                    t2.push(format!(
                        "`{}`: <{b}> inside a live region",
                        m.comps[*c].name
                    ));
                    bump(&mut own, *c, 2);
                }
            }
            for item in &m.comps[*c].setup {
                if let Item::Cleanup { .. } = item {
                    t1.push(format!("`{}`: $cleanup", m.comps[*c].name));
                    bump(&mut own, *c, 1);
                }
            }
        }
        if members.len() > 1 {
            t1.push(format!(
                "state shared across components: {}",
                members
                    .iter()
                    .map(|c| m.comps[*c].name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        // Cells written by something other than the island's own handlers.
        let tier = if !t2.is_empty() {
            2
        } else if !t1.is_empty() {
            1
        } else {
            0
        };
        let why = match tier {
            2 => t2.clone(),
            1 => t1.clone(),
            _ => vec![format!(
                "cells [{}] written only by the island's own handlers; {} live hole(s), all read unconditionally; no memo, effect, cleanup, dynamic structure, async or sharing",
                keys.iter()
                    .filter_map(|k| match &m.comps[k.0].setup[k.1] {
                        Item::Cell { name, .. } => Some(name.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
                sites
                    .iter()
                    .filter(|(c, s)| matches!(
                        a.facts[*c].sites[*s].kind,
                        SiteKind::Text | SiteKind::Attr(_)
                    ))
                    .count()
            )],
        };
        let mut own_tiers: Vec<(usize, u8)> = members.iter().map(|c| (*c, own[c])).collect();
        own_tiers.sort();
        for (c, s) in &sites {
            a.group_of_site.insert((*c, *s), gi);
        }
        for k in &keys {
            a.group_of_key.insert(*k, gi);
        }
        a.root_of.entry(root).or_default().push(gi);
        let _ = key_is_memo;
        a.groups.push(Group {
            id: format!("{id_prefix}{}", base36(gi)),
            root,
            members,
            keys,
            sites,
            tier,
            own_tiers,
            why,
            unsupported,
            events: events.into_iter().collect(),
            window_events: window_events.into_iter().collect(),
            hot,
            prevent_default,
        });
    }
    a
}

impl Analysis<'_> {
    /// Event bodies a handler expression references (for `preventDefault`).
    fn sym_av_event(&self, _comp: usize, r: &Refs) -> Vec<SymbolId> {
        r.syms.iter().map(|(s, _)| *s).collect()
    }
}

fn handler_prevents(m: &Model<'_>, syms: Vec<SymbolId>) -> bool {
    for c in &m.comps {
        for item in &c.setup {
            if let Item::Event { sym, body, .. } = item
                && syms.contains(sym)
                && m.text(body.body_span()).contains("preventDefault")
            {
                return true;
            }
        }
    }
    false
}

/// A settled body that only registers `window` listeners for `$event`s and
/// removes them in `$cleanup` is a lazy stub: the loader listens instead
/// and activates the island on the first such event.
fn settled_listener(m: &Model<'_>, comp: usize, item: usize) -> Option<Vec<String>> {
    let Item::Effect { body, .. } = &m.comps[comp].setup[item] else {
        return None;
    };
    let mut events = Vec::new();
    for s in body.statements() {
        let text = m.text(s.span());
        let t = text.trim();
        if let Some(rest) = t.strip_prefix("window.addEventListener(") {
            let ev = rest.split(['"', '\'']).nth(1)?;
            events.push(ev.to_string());
            continue;
        }
        if t.starts_with("const ") && t.contains("$event(") {
            continue;
        }
        if t.starts_with("yield* $cleanup(") && t.contains("window.removeEventListener(") {
            continue;
        }
        return None;
    }
    if events.is_empty() {
        None
    } else {
        Some(events)
    }
}

/// JSX roots reachable through the expression forms a view uses to choose
/// or map markup: conditionals, logical operators, calls (e.g. `.map`),
/// callbacks, arrays, sequences. `complete` turns false on a statement body.
pub(crate) fn find_jsx<'a>(e: &'a Expression<'a>, out: &mut Vec<Root<'a>>, complete: &mut bool) {
    match e.without_parentheses() {
        Expression::JSXElement(el) => out.push(Root::Element(el)),
        Expression::JSXFragment(f) => out.push(Root::Fragment(f)),
        Expression::ConditionalExpression(c) => {
            find_jsx(&c.test, out, complete);
            find_jsx(&c.consequent, out, complete);
            find_jsx(&c.alternate, out, complete);
        }
        Expression::LogicalExpression(l) => {
            find_jsx(&l.left, out, complete);
            find_jsx(&l.right, out, complete);
        }
        Expression::CallExpression(c) => {
            find_jsx(&c.callee, out, complete);
            for a in &c.arguments {
                if let Some(x) = a.as_expression() {
                    find_jsx(x, out, complete);
                }
            }
        }
        Expression::StaticMemberExpression(s) => find_jsx(&s.object, out, complete),
        Expression::ArrayExpression(a) => {
            for el in &a.elements {
                if let Some(x) = el.as_expression() {
                    find_jsx(x, out, complete);
                }
            }
        }
        Expression::SequenceExpression(s) => {
            for x in &s.expressions {
                find_jsx(x, out, complete);
            }
        }
        Expression::ArrowFunctionExpression(a) => {
            if let Some(x) = a.body.as_expression() {
                find_jsx(x, out, complete);
            } else if let Some(b) = a.body.as_function_body() {
                for s in &b.statements {
                    match s {
                        oxc_ast::ast::Statement::ReturnStatement(r) => {
                            if let Some(x) = &r.argument {
                                find_jsx(x, out, complete);
                            }
                        }
                        _ => *complete = false,
                    }
                }
            }
        }
        Expression::TSAsExpression(t) => find_jsx(&t.expression, out, complete),
        Expression::TSNonNullExpression(t) => find_jsx(&t.expression, out, complete),
        _ => {}
    }
}

/// Outermost JSX nodes anywhere inside an expression.
fn count_jsx_roots(e: &Expression<'_>) -> usize {
    struct C {
        depth: u32,
        n: usize,
    }
    impl<'a> Visit<'a> for C {
        fn visit_jsx_element(&mut self, e: &JSXElement<'a>) {
            if self.depth == 0 {
                self.n += 1;
            }
            self.depth += 1;
            walk::walk_jsx_element(self, e);
            self.depth -= 1;
        }
        fn visit_jsx_fragment(&mut self, f: &oxc_ast::ast::JSXFragment<'a>) {
            if self.depth == 0 {
                self.n += 1;
            }
            self.depth += 1;
            walk::walk_jsx_fragment(self, f);
            self.depth -= 1;
        }
    }
    let mut c = C { depth: 0, n: 0 };
    c.visit_expression(e);
    c.n
}

/// `name(` appears as a call in `text` (a word boundary before the name).
fn text_calls(text: &str, name: &str) -> bool {
    let pat = format!("{name}(");
    text.match_indices(&pat).any(|(i, _)| {
        i == 0
            || !text[..i]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.')
    })
}

/// Does the expression call anything (outside nested functions)?
pub(crate) fn contains_call(e: &Expression<'_>) -> bool {
    struct C {
        found: bool,
        depth: u32,
    }
    impl<'a> Visit<'a> for C {
        fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
            if self.depth == 0 {
                self.found = true;
            }
            walk::walk_call_expression(self, c);
        }
        fn visit_new_expression(&mut self, n: &oxc_ast::ast::NewExpression<'a>) {
            if self.depth == 0 {
                self.found = true;
            }
            walk::walk_new_expression(self, n);
        }
        fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
            self.depth += 1;
            walk::walk_function(self, f, flags);
            self.depth -= 1;
        }
        fn visit_arrow_function_expression(&mut self, a: &ArrowFunctionExpression<'a>) {
            self.depth += 1;
            walk::walk_arrow_function_expression(self, a);
            self.depth -= 1;
        }
    }
    let mut c = C {
        found: false,
        depth: 0,
    };
    c.visit_expression(e);
    c.found
}

pub(crate) fn base36(mut n: usize) -> String {
    const D: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut s = Vec::new();
    loop {
        s.push(D[n % 36]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}
