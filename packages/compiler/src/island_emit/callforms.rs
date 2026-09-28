//! Component call forms → JSX, a source pre-pass.
//!
//! Views may render components and boundaries in call form — `User({ id })`,
//! `Loading({ fallback, children })`, `Errored({ fallback: err => …, children:
//! … })` — which is what a blocks view writes where JSX cannot express the
//! types. The island compiler reads markup as JSX, so a call whose callee is a
//! component of the module or one of the runtime's boundary / control-flow
//! builtins, with one object-literal argument (or none), is rewritten to the
//! equivalent element before the module is analysed: each property becomes an
//! attribute, `children` becomes the element's children. Nested call forms
//! are rewritten inside out. Anything else (a spread, a getter or method, a
//! computed key, a non-literal argument, `yield* Child(props)`) is left as
//! written, and the analysis refuses it as before.
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    CallExpression, Expression, JSXExpressionContainer, ObjectPropertyKind, PropertyKey, PropertyKind, YieldExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};

use super::model::{self, Model};
use crate::compiler::{parse_program, source_type_for_filename};
use crate::store_scalars::splice;

/// Builtins that have a JSX element form the island compiler reads.
const ELEMENT_BUILTINS: &[&str] = &["Loading", "Errored", "Show", "For"];

/// The rewritten source, or `None` when the module has no call forms.
pub(crate) fn rewrite(source: &str, filename: Option<&str>) -> Option<String> {
    // Cheap pre-check: every candidate is `Name(` with a capitalized name.
    if !has_capitalized_call(source) {
        return None;
    }
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename).ok()?;
    let program = parse_program(&allocator, source, source_type).ok()?;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let m = model::build_model(source, &program, semantic.scoping(), Vec::new());
    let r = Rewriter { m: &m };
    let span = Span::new(0, source.len() as u32);
    let mut edits = Vec::new();
    r.collect(&program, &mut edits);
    if edits.is_empty() {
        return None;
    }
    Some(splice(source, span, edits))
}

fn has_capitalized_call(s: &str) -> bool {
    let b = s.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$';
    let mut i = 0;
    while i < b.len() {
        if ident(b[i]) && (i == 0 || !ident(b[i - 1]) && b[i - 1] != b'.') {
            let start = i;
            while i < b.len() && ident(b[i]) {
                i += 1;
            }
            if b[start].is_ascii_uppercase() && i < b.len() && b[i] == b'(' {
                return true;
            }
            continue;
        }
        i += 1;
    }
    false
}

struct Rewriter<'m, 'a> {
    m: &'m Model<'a>,
}

impl<'a> Rewriter<'_, 'a> {
    fn is_candidate(&self, c: &CallExpression<'a>) -> bool {
        let Some(s) = self.m.symbol_of_expr(&c.callee) else {
            return false;
        };
        let target = self.m.comp_of.contains_key(&s)
            || self
                .m
                .runtime
                .get(&s)
                .is_some_and(|n| ELEMENT_BUILTINS.contains(&n.as_str()));
        target
            && c.type_arguments.is_none()
            && !c.optional
            && match c.arguments.len() {
                0 => true,
                1 => matches!(
                    c.arguments[0].as_expression().map(|e| e.without_parentheses()),
                    Some(Expression::ObjectExpression(_))
                ),
                _ => false,
            }
    }

    /// Outermost rewritable calls inside `node`, as splice edits.
    fn collect<N: Walkable<'a>>(&self, node: &N, edits: &mut Vec<(Span, String)>) {
        let mut f = Finder {
            r: self,
            found: Vec::new(),
        };
        node.walk_with(&mut f);
        for (span, c) in f.found {
            if let Some(text) = self.element(c) {
                edits.push((span, text));
            }
        }
    }

    /// An expression's text with its nested call forms rewritten.
    fn text(&self, e: &'a Expression<'a>) -> String {
        let mut edits = Vec::new();
        self.collect(e, &mut edits);
        splice(self.m.src, e.span(), edits)
    }

    fn element(&self, c: &'a CallExpression<'a>) -> Option<String> {
        let tag = self.m.text(c.callee.span());
        let mut attrs = String::new();
        let mut children: Option<String> = None;
        if let Some(arg) = c.arguments.first() {
            let Expression::ObjectExpression(o) = arg.as_expression()?.without_parentheses() else {
                return None;
            };
            for p in &o.properties {
                let ObjectPropertyKind::ObjectProperty(p) = p else {
                    return None;
                };
                if p.kind != PropertyKind::Init || p.method || p.computed {
                    return None;
                }
                let key = match &p.key {
                    PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                    PropertyKey::StringLiteral(s)
                        if s.value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ':') =>
                    {
                        s.value.to_string()
                    }
                    _ => return None,
                };
                let value = self.text(&p.value);
                if key == "children" {
                    let jsx = model::is_jsx(&p.value)
                        || matches!(p.value.without_parentheses(), Expression::CallExpression(inner) if self.is_candidate(inner));
                    children = Some(if jsx { value } else { format!("{{{value}}}") });
                } else {
                    attrs.push_str(&format!(" {key}={{{value}}}"));
                }
            }
        }
        Some(match children {
            Some(ch) => format!("<{tag}{attrs}>{ch}</{tag}>"),
            None => format!("<{tag}{attrs} />"),
        })
    }
}

struct Finder<'r, 'm, 'a> {
    r: &'r Rewriter<'m, 'a>,
    /// (span replaced, call): a call form that is a whole JSX child
    /// container (`{User({ … })}`) replaces the container.
    found: Vec<(Span, &'a CallExpression<'a>)>,
}

impl<'a> Visit<'a> for Finder<'_, '_, 'a> {
    fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
        // Every node visited belongs to the program arena ('a); see tx.rs.
        let c: &'a CallExpression<'a> = unsafe { &*(c as *const CallExpression<'a>) };
        if self.r.is_candidate(c) {
            self.found.push((c.span, c));
            return;
        }
        walk::walk_call_expression(self, c);
    }
    fn visit_jsx_expression_container(&mut self, j: &JSXExpressionContainer<'a>) {
        if let Some(Expression::CallExpression(c)) = j.expression.as_expression().map(|e| e.without_parentheses())
            && self.r.is_candidate(c)
            && self.r.element(c).is_some()
        {
            let c: &'a CallExpression<'a> = unsafe { &*(&**c as *const CallExpression<'a>) };
            self.found.push((j.span, c));
            return;
        }
        walk::walk_jsx_expression_container(self, j);
    }
    fn visit_yield_expression(&mut self, y: &YieldExpression<'a>) {
        // `yield* Child(props)`: a component read, not a call form.
        if y.delegate
            && let Some(Expression::CallExpression(c)) = y.argument.as_ref().map(|a| a.without_parentheses())
        {
            walk::walk_arguments(self, &c.arguments);
            return;
        }
        walk::walk_yield_expression(self, y);
    }
}

trait Walkable<'a> {
    fn walk_with(&self, v: &mut Finder<'_, '_, 'a>);
}

impl<'a> Walkable<'a> for oxc_ast::ast::Program<'a> {
    fn walk_with(&self, v: &mut Finder<'_, '_, 'a>) {
        v.visit_program(self);
    }
}

impl<'a> Walkable<'a> for Expression<'a> {
    fn walk_with(&self, v: &mut Finder<'_, '_, 'a>) {
        v.visit_expression(self);
    }
}
