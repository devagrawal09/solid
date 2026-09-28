//! Source-to-source expression translation by span splicing: the emitters
//! decide what `yield*` reads, identifiers, `props.*` members, special calls
//! and JSX become; everything else is copied from the source verbatim,
//! except TypeScript syntax, which is erased (type annotations, `as` /
//! `satisfies` / `!`, type parameters and arguments, optional-parameter
//! marks), so island chunks are plain JavaScript.
use oxc_ast::ast::{
    CallExpression, Expression, FormalParameter, IdentifierReference, ObjectProperty, PropertyKey, Statement,
    StaticMemberExpression, TSTypeAnnotation, TSTypeParameterDeclaration, TSTypeParameterInstantiation,
};
use oxc_ast_visit::{Visit, walk};
use oxc_span::{GetSpan, Span};

use super::model::{FnRef, Model};
use crate::store_scalars::splice;

pub(crate) type R<T> = Result<T, String>;

/// What the emitters substitute. Every hook returns `None` to keep the node.
pub(crate) trait Env<'a> {
    /// `yield* arg`.
    fn read(&self, tx: &Tx<'_, 'a>, arg: &'a Expression<'a>) -> R<String>;
    /// A bare identifier reference.
    fn ident(&self, _tx: &Tx<'_, 'a>, _id: &IdentifierReference<'a>) -> Option<String> {
        None
    }
    /// `props.name` (not under `yield*`).
    fn props_member(&self, _tx: &Tx<'_, 'a>, _name: &str) -> R<Option<String>> {
        Ok(None)
    }
    /// Is `e` the `props` binding?
    fn is_props(&self, _tx: &Tx<'_, 'a>, _e: &Expression<'a>) -> bool {
        false
    }
    /// A call the emitter lowers (`$event(…)`, a tier-0 setter, …).
    fn call(&self, _tx: &Tx<'_, 'a>, _c: &'a CallExpression<'a>) -> R<Option<String>> {
        Ok(None)
    }
    /// A JSX element or fragment in expression position.
    fn jsx(&self, tx: &Tx<'_, 'a>, e: &'a Expression<'a>) -> R<String> {
        Err(format!("JSX in client code: `{}`", super::model::short(tx.m.text(e.span()))))
    }
}

pub(crate) struct Tx<'m, 'a> {
    pub m: &'m Model<'a>,
}

impl<'m, 'a> Tx<'m, 'a> {
    pub(crate) fn expr(&self, env: &dyn Env<'a>, e: &'a Expression<'a>) -> R<String> {
        if let Some(r) = self.special(env, e)? {
            return Ok(r);
        }
        self.span_with(env, e.span(), |c| walk::walk_expression(c, e))
    }

    pub(crate) fn stmt(&self, env: &dyn Env<'a>, s: &'a Statement<'a>) -> R<String> {
        self.span_with(env, s.span(), |c| c.visit_statement(s))
    }

    /// A function's body as text: `{ … }` or a concise expression.
    pub(crate) fn body(&self, env: &dyn Env<'a>, f: FnRef<'a>) -> R<String> {
        if f.is_concise() {
            if let Some(s) = f.concise()
            {
                return self.expr(env, s);
            }
        }
        let span = f.body_span();
        match f {
            FnRef::Func(func) => self.span_with(env, span, |c| {
                if let Some(b) = &func.body {
                    walk::walk_function_body(c, b)
                }
            }),
            FnRef::Arrow(a) => self.span_with(env, span, |c| {
                if let Some(b) = a.body.as_function_body() {
                    walk::walk_function_body(c, b)
                }
            }),
        }
    }

    /// Parameter list text (without parentheses).
    pub(crate) fn params(&self, env: &dyn Env<'a>, f: FnRef<'a>) -> R<String> {
        let p = f.params();
        let text = self.span_with(env, p.span, |c| walk::walk_formal_parameters(c, p))?;
        let t = text.trim();
        let t = t.strip_prefix('(').and_then(|x| x.strip_suffix(')')).unwrap_or(t);
        Ok(t.to_string())
    }

    /// A block function as a plain JS function expression (generators become
    /// ordinary functions; the body's `yield*` are lowered by `env`).
    pub(crate) fn func(&self, env: &dyn Env<'a>, f: FnRef<'a>, is_async: bool) -> R<String> {
        let params = self.params(env, f)?;
        let body = self.body(env, f)?;
        let body = if f.is_concise() { format!("({body})") } else { body };
        Ok(format!("{}({params}) => {body}", if is_async { "async " } else { "" }))
    }

    fn span_with(&self, env: &dyn Env<'a>, span: Span, run: impl FnOnce(&mut Collect<'_, 'm, 'a>)) -> R<String> {
        let mut c = Collect { tx: self, env, edits: Vec::new(), err: None };
        run(&mut c);
        if let Some(e) = c.err {
            return Err(e);
        }
        Ok(splice(self.m.src, span, c.edits))
    }

    fn special(&self, env: &dyn Env<'a>, e: &'a Expression<'a>) -> R<Option<String>> {
        match e {
            Expression::YieldExpression(y) if y.delegate => {
                let Some(arg) = &y.argument else { return Err("empty yield*".into()) };
                Ok(Some(env.read(self, arg)?))
            }
            Expression::YieldExpression(_) => Err("`yield` without `*` in a block".into()),
            Expression::JSXElement(_) | Expression::JSXFragment(_) => Ok(Some(env.jsx(self, e)?)),
            Expression::CallExpression(c) => env.call(self, c),
            Expression::StaticMemberExpression(s) if env.is_props(self, &s.object) => {
                env.props_member(self, s.property.name.as_str())
            }
            Expression::Identifier(id) => Ok(env.ident(self, id)),
            // TypeScript expression wrappers: keep the expression only.
            Expression::TSAsExpression(t) => Ok(Some(self.expr(env, &t.expression)?)),
            Expression::TSSatisfiesExpression(t) => Ok(Some(self.expr(env, &t.expression)?)),
            Expression::TSNonNullExpression(t) => Ok(Some(self.expr(env, &t.expression)?)),
            Expression::TSTypeAssertion(t) => Ok(Some(self.expr(env, &t.expression)?)),
            Expression::TSInstantiationExpression(t) => Ok(Some(self.expr(env, &t.expression)?)),
            _ => Ok(None),
        }
    }
}

struct Collect<'t, 'm, 'a> {
    tx: &'t Tx<'m, 'a>,
    env: &'t dyn Env<'a>,
    edits: Vec<(Span, String)>,
    err: Option<String>,
}

impl<'a> Visit<'a> for Collect<'_, '_, 'a> {
    fn visit_expression(&mut self, e: &Expression<'a>) {
        if self.err.is_some() {
            return;
        }
        // SAFETY of lifetimes: every node visited belongs to the program
        // arena ('a); the visitor API erases that to a local borrow, so the
        // emitters re-borrow through a raw pointer to recover it.
        let e: &'a Expression<'a> = unsafe { &*(e as *const Expression<'a>) };
        match self.tx.special(self.env, e) {
            Ok(Some(r)) => self.edits.push((e.span(), r)),
            Ok(None) => walk::walk_expression(self, e),
            Err(x) => self.err = Some(x),
        }
    }
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if let Some(r) = self.env.ident(self.tx, id) {
            self.edits.push((id.span, r));
        }
    }
    fn visit_static_member_expression(&mut self, s: &StaticMemberExpression<'a>) {
        if self.env.is_props(self.tx, &s.object) {
            match self.env.props_member(self.tx, s.property.name.as_str()) {
                Ok(Some(r)) => self.edits.push((s.span, r)),
                Ok(None) => {}
                Err(x) => self.err = Some(x),
            }
            return;
        }
        walk::walk_static_member_expression(self, s);
    }
    fn visit_ts_type_annotation(&mut self, t: &TSTypeAnnotation<'a>) {
        self.edits.push((t.span, String::new()));
    }
    fn visit_ts_type_parameter_declaration(&mut self, t: &TSTypeParameterDeclaration<'a>) {
        self.edits.push((t.span, String::new()));
    }
    fn visit_ts_type_parameter_instantiation(&mut self, t: &TSTypeParameterInstantiation<'a>) {
        self.edits.push((t.span, String::new()));
    }
    fn visit_formal_parameter(&mut self, p: &FormalParameter<'a>) {
        if p.optional {
            // `x?: T` → `x`: erase from the pattern's end to the annotation's end.
            let end = p.type_annotation.as_ref().map_or(p.pattern.span().end + 1, |t| t.span.end);
            walk::walk_binding_pattern(self, &p.pattern);
            self.edits.push((Span::new(p.pattern.span().end, end), String::new()));
            if let Some(i) = &p.initializer {
                self.visit_expression(i);
            }
            return;
        }
        walk::walk_formal_parameter(self, p);
    }
    fn visit_object_property(&mut self, p: &ObjectProperty<'a>) {
        if p.shorthand
            && let Expression::Identifier(id) = &p.value
            && let Some(r) = self.env.ident(self.tx, id)
        {
            let key = match &p.key {
                PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                _ => id.name.to_string(),
            };
            self.edits.push((p.span, format!("{key}: {r}")));
            return;
        }
        walk::walk_object_property(self, p);
    }
}
