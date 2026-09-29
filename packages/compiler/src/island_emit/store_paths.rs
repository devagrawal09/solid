//! Store serialization granularity (ssr-hydration-redesign.md §3.3): a store
//! an island rebuilds from server data serializes only the top-level keys its
//! component's code reads or writes, when every use is a static key access:
//!
//! - `S.key…` (`yield* S.key.rest`, a member chain in any expression);
//! - `readStore(S, s => …)` whose selector uses its parameter only as `s.key…`;
//! - `setS(s => …)` / `setS(function (s) { … })` whose draft is used only as
//!   `s.key…`, and `setS("key", …)`.
//!
//! Any other use (the store as a value, a computed key, a prop, a spread)
//! serializes the whole store.
use std::collections::BTreeSet;

use oxc_ast::ast::{
    Argument, CallExpression, ComputedMemberExpression, Expression, IdentifierReference,
    StaticMemberExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{ScopeFlags, SymbolId};

use oxc_span::GetSpan;

use super::model::{Comp, FnRef, Item, LocalDecl, Model};

/// The keys to serialize, or `None` for the whole store.
pub(crate) fn store_keys(
    m: &Model<'_>,
    comp: &Comp<'_>,
    get: SymbolId,
    set: Option<SymbolId>,
) -> Option<Vec<String>> {
    let mut v = Uses {
        m,
        targets: vec![get],
        setter: set,
        keys: BTreeSet::new(),
        whole: false,
    };
    for item in &comp.setup {
        match item {
            Item::Cell { init, .. } => {
                if let Some(e) = init {
                    v.visit_expression(e);
                }
            }
            Item::Memo { body, .. } | Item::Event { body, .. } | Item::Effect { body, .. } => {
                v.visit_fn(*body)
            }
            Item::Context { .. } => {}
            Item::Local { decl, .. } => match decl {
                LocalDecl::Var(d) => {
                    if let Some(e) = &d.init {
                        v.visit_expression(e);
                    }
                }
                LocalDecl::Func(f) => walk::walk_function(&mut v, f, ScopeFlags::Function),
            },
            Item::Cleanup { arg, .. } => v.visit_expression(arg),
            Item::Stmt { stmt, .. } => v.visit_statement(stmt),
        }
    }
    for st in &comp.view_stmts {
        v.visit_statement(st);
    }
    if let Some(e) = comp.view {
        v.visit_expression(e);
    }
    if v.whole {
        None
    } else {
        Some(v.keys.into_iter().collect())
    }
}

struct Uses<'m, 'a> {
    m: &'m Model<'a>,
    /// The store getter and draft / selector parameters standing for it.
    targets: Vec<SymbolId>,
    setter: Option<SymbolId>,
    keys: BTreeSet<String>,
    whole: bool,
}

impl<'a> Uses<'_, 'a> {
    fn is_target(&self, e: &Expression<'a>) -> bool {
        self.m
            .symbol_of_expr(e)
            .is_some_and(|s| self.targets.contains(&s))
    }
    /// A callback whose first parameter stands for the store.
    fn callback(&mut self, e: &Expression<'a>) -> bool {
        // Every node visited belongs to the program arena ('a); see tx.rs.
        let e: &'a Expression<'a> = unsafe { &*(e as *const Expression<'a>) };
        let Some(f) = FnRef::from_expr(e) else {
            return false;
        };
        let Some(p) = f.params().items.first() else {
            return true; // no parameter: nothing read through it
        };
        let oxc_ast::ast::BindingPattern::BindingIdentifier(id) = &p.pattern else {
            self.whole = true;
            return true;
        };
        if let Some(s) = id.symbol_id.get() {
            self.targets.push(s);
        }
        self.visit_fn(f);
        true
    }
    fn visit_fn(&mut self, f: FnRef<'a>) {
        match f {
            FnRef::Func(func) => walk::walk_function(self, func, ScopeFlags::Function),
            FnRef::Arrow(a) => walk::walk_arrow_function_expression(self, a),
        }
    }
}

impl<'a> Visit<'a> for Uses<'_, 'a> {
    fn visit_static_member_expression(&mut self, e: &StaticMemberExpression<'a>) {
        if self.is_target(&e.object) {
            self.keys.insert(e.property.name.to_string());
            return;
        }
        walk::walk_static_member_expression(self, e);
    }
    fn visit_computed_member_expression(&mut self, e: &ComputedMemberExpression<'a>) {
        if self.is_target(&e.object)
            && let Expression::StringLiteral(k) = &e.expression
        {
            self.keys.insert(k.value.to_string());
            return;
        }
        walk::walk_computed_member_expression(self, e);
    }
    fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
        let arg = |i: usize| c.arguments.get(i).and_then(Argument::as_expression);
        if self.m.runtime_name(&c.callee) == Some("readStore")
            && arg(0).is_some_and(|e| self.is_target(e))
            && let Some(sel) = arg(1)
            && self.callback(sel)
        {
            return;
        }
        if self.setter.is_some() && self.m.symbol_of_expr(&c.callee) == self.setter {
            match arg(0).map(|e| e.without_parentheses()) {
                Some(Expression::StringLiteral(k)) => {
                    self.keys.insert(k.value.to_string());
                    for a in c.arguments.iter().skip(1) {
                        if let Some(e) = a.as_expression() {
                            self.visit_expression(e);
                        }
                    }
                    return;
                }
                Some(e) if FnRef::from_expr(e).is_some() => {
                    if self.callback(e) {
                        return;
                    }
                }
                // A replacement value: every key it drops is a write.
                _ => {
                    self.whole = true;
                }
            }
        }
        walk::walk_call_expression(self, c);
    }
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if self
            .m
            .symbol_of(id)
            .is_some_and(|s| self.targets.contains(&s))
        {
            self.whole = true;
        }
    }
}

// --- keys owned by rows ------------------------------------------------------------

/// How a row scope uses a store map it receives as a prop, when the map is
/// split by key (`scopes.rs`, keyed stores): every read is `yield*
/// P.S[P.row.k]` and every write `P.setS(d => { … d[P.row.k] … })` in one of
/// the row's handlers, with the same key — the row's own parameter path.
#[derive(Debug, Default)]
pub(crate) struct RowKeyed {
    /// The key's path below the row prop (`.id`), the same for every use.
    pub suffix: String,
    /// The `yield*` operands `P.S[key]` (their spans).
    pub reads: Vec<oxc_span::Span>,
    /// The setter calls: (call span, callback span, draft accesses `d[key]`).
    pub writes: Vec<(oxc_span::Span, oxc_span::Span, Vec<oxc_span::Span>)>,
    /// `P.S` / `P.setS` passed on as attribute values (a recursive row).
    pub forwarded: Vec<oxc_span::Span>,
}

/// `P.<row>.a.b…` → `.a.b…` (a static chain below the row prop).
fn row_suffix<'a>(m: &Model<'a>, props: SymbolId, row: &str, e: &Expression<'a>) -> Option<String> {
    let mut names = Vec::new();
    let mut cur = e.without_parentheses();
    loop {
        match cur {
            Expression::StaticMemberExpression(s) => {
                names.push(s.property.name.to_string());
                cur = &s.object;
            }
            Expression::Identifier(_) if m.symbol_of_expr(cur) == Some(props) => break,
            _ => return None,
        }
    }
    names.reverse();
    // `P.row.k…`: the first name is the row prop, then at least one key.
    if names.len() < 2 || names[0] != row {
        return None;
    }
    Some(names[1..].iter().map(|n| format!(".{n}")).collect())
}

/// The row's keyed uses of the store prop `store` (and its setter prop
/// `setter`), keyed below the row prop `row`; `None` when any use is not
/// keyed by the row's own path (a read of the whole map, another key, a
/// write outside a handler).
pub(crate) fn row_keyed_uses<'a>(
    m: &Model<'a>,
    comp: &Comp<'a>,
    store: &str,
    setter: Option<&str>,
    row: &str,
) -> Option<RowKeyed> {
    let props = comp.props?;
    let body = comp.body_fn?;
    struct K<'m, 'a> {
        m: &'m Model<'a>,
        props: SymbolId,
        store: &'m str,
        setter: Option<&'m str>,
        row: &'m str,
        out: RowKeyed,
        bad: bool,
        /// Inside an `$event` body.
        event: u32,
        /// Spans of `P.S` / `P.setS` members already accounted for.
        seen: Vec<oxc_span::Span>,
    }
    impl<'a> K<'_, 'a> {
        fn is_member(&self, e: &Expression<'a>, name: &str) -> bool {
            matches!(e.without_parentheses(), Expression::StaticMemberExpression(s)
                if s.property.name == name && self.m.symbol_of_expr(&s.object) == Some(self.props))
        }
        fn key(&mut self, e: &Expression<'a>) -> bool {
            match row_suffix(self.m, self.props, self.row, e) {
                Some(s) if self.out.suffix.is_empty() || self.out.suffix == s => {
                    self.out.suffix = s;
                    true
                }
                _ => false,
            }
        }
    }
    impl<'a> Visit<'a> for K<'_, 'a> {
        fn visit_yield_expression(&mut self, y: &oxc_ast::ast::YieldExpression<'a>) {
            if y.delegate
                && let Some(Expression::ComputedMemberExpression(c)) =
                    y.argument.as_ref().map(|a| a.without_parentheses())
                && self.is_member(&c.object, self.store)
            {
                if self.key(&c.expression) {
                    self.out.reads.push(c.span);
                    self.seen.push(c.object.span());
                } else {
                    self.bad = true;
                }
                return;
            }
            walk::walk_yield_expression(self, y);
        }
        fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
            // Every node visited belongs to the program arena ('a); see tx.rs.
            let c: &'a CallExpression<'a> = unsafe { &*(c as *const CallExpression<'a>) };
            if self.m.runtime_name(&c.callee) == Some("$event") {
                self.event += 1;
                walk::walk_call_expression(self, c);
                self.event -= 1;
                return;
            }
            if let Some(setter) = self.setter
                && self.is_member(&c.callee, setter)
            {
                self.seen.push(c.callee.span());
                let cb = c.arguments.first().and_then(Argument::as_expression);
                let Some(f) = cb.and_then(FnRef::from_expr) else {
                    self.bad = true;
                    return;
                };
                if self.event == 0 || c.arguments.len() != 1 || f.params().items.len() != 1 {
                    self.bad = true;
                    return;
                }
                let oxc_ast::ast::BindingPattern::BindingIdentifier(d) = &f.params().items[0].pattern
                else {
                    self.bad = true;
                    return;
                };
                let Some(draft) = d.symbol_id.get() else {
                    self.bad = true;
                    return;
                };
                // Every use of the draft is `d[key]` with the row's key.
                let mut hits = Vec::new();
                let mut total = 0usize;
                struct D<'k, 'm, 'a> {
                    k: &'k mut K<'m, 'a>,
                    draft: SymbolId,
                    hits: &'k mut Vec<oxc_span::Span>,
                    total: &'k mut usize,
                    ok: bool,
                }
                impl<'a> Visit<'a> for D<'_, '_, 'a> {
                    fn visit_computed_member_expression(&mut self, e: &ComputedMemberExpression<'a>) {
                        if self.k.m.symbol_of_expr(&e.object) == Some(self.draft) {
                            if self.k.key(&e.expression) {
                                self.hits.push(e.span);
                                *self.total += 1;
                            } else {
                                self.ok = false;
                            }
                            return;
                        }
                        walk::walk_computed_member_expression(self, e);
                    }
                    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
                        if self.k.m.symbol_of(id) == Some(self.draft) {
                            // Outside `d[key]`: the draft as a value.
                            self.ok = false;
                        }
                    }
                }
                let ok = {
                    let mut dv = D {
                        k: self,
                        draft,
                        hits: &mut hits,
                        total: &mut total,
                        ok: true,
                    };
                    match f {
                        FnRef::Func(func) => walk::walk_function(&mut dv, func, ScopeFlags::Function),
                        FnRef::Arrow(a) => walk::walk_arrow_function_expression(&mut dv, a),
                    }
                    dv.ok
                };
                if !ok || total == 0 {
                    self.bad = true;
                    return;
                }
                self.out.writes.push((c.span, cb.map(|e| e.span()).unwrap_or(c.span), hits));
                return;
            }
            walk::walk_call_expression(self, c);
        }
        fn visit_jsx_expression_container(&mut self, j: &oxc_ast::ast::JSXExpressionContainer<'a>) {
            // `S={P.S}` / `setS={P.setS}` on a nested row: forwarded.
            if let Some(e) = j.expression.as_expression()
                && (self.is_member(e, self.store)
                    || self.setter.is_some_and(|s| self.is_member(e, s)))
            {
                self.out.forwarded.push(e.span());
                self.seen.push(e.span());
                return;
            }
            walk::walk_jsx_expression_container(self, j);
        }
        fn visit_static_member_expression(&mut self, e: &StaticMemberExpression<'a>) {
            if (e.property.name == self.store || self.setter.is_some_and(|s| e.property.name == s))
                && self.m.symbol_of_expr(&e.object) == Some(self.props)
                && !self.seen.contains(&e.span)
            {
                // Any other use of the map or its setter.
                self.bad = true;
            }
            walk::walk_static_member_expression(self, e);
        }
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
            if self.m.symbol_of(id) == Some(self.props) {
                // `props` itself handed on: its map could be read whole.
                let _ = id;
            }
        }
    }
    let mut k = K {
        m,
        props,
        store,
        setter,
        row,
        out: RowKeyed::default(),
        bad: false,
        event: 0,
        seen: Vec::new(),
    };
    match body {
        FnRef::Func(f) => walk::walk_function(&mut k, f, ScopeFlags::Function),
        FnRef::Arrow(a) => walk::walk_arrow_function_expression(&mut k, a),
    }
    // A bare `props` (spread, handed on) could reach the map: refuse.
    let text = m.text(body.body_span());
    let pname = m.sym_name(props);
    let bare = text.match_indices(pname).any(|(i, _)| {
        let after = text[i + pname.len()..].chars().next();
        let before = text[..i].chars().next_back();
        after != Some('.')
            && !after.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
            && !before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$' || c == '.')
    });
    if k.bad || bare || k.out.suffix.is_empty() || (k.out.reads.is_empty() && k.out.writes.is_empty()) {
        return None;
    }
    Some(k.out)
}
