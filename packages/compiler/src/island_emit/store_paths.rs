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
