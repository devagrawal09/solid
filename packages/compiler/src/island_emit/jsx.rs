//! JSX shape helpers shared by the analysis and both emitters.
use oxc_ast::ast::{
    Expression, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild, JSXElement, JSXElementName,
    JSXExpression, JSXFragment,
};
use oxc_semantic::SymbolId;
use oxc_span::{GetSpan, Span};

use super::model::Model;
use crate::shared::utils::{decode_html_entities, trim_jsx_text};

pub(crate) const BUILTINS: &[&str] = &["Show", "For", "Loading", "Errored", "Index", "Switch", "Match", "Dynamic", "Portal", "Repeat", "Reveal"];

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Tag {
    Intrinsic(String),
    /// A component defined in this module.
    Comp(usize),
    Builtin(String),
    /// `<Ctx value={…}>` for a context declared in this module.
    Provider(SymbolId),
    /// Any other component (imported or unknown).
    Opaque(String),
}

pub(crate) fn tag_of(m: &Model<'_>, name: &JSXElementName<'_>) -> Tag {
    match name {
        JSXElementName::Identifier(id) => Tag::Intrinsic(id.name.to_string()),
        JSXElementName::NamespacedName(n) => Tag::Intrinsic(format!("{}:{}", n.namespace.name, n.name.name)),
        JSXElementName::IdentifierReference(id) => {
            let sym = m.symbol_of(id);
            if let Some(s) = sym {
                if let Some(c) = m.comp_of.get(&s) {
                    return Tag::Comp(*c);
                }
                if m.contexts.contains_key(&s) {
                    return Tag::Provider(s);
                }
                if let Some(n) = m.runtime.get(&s)
                    && BUILTINS.contains(&n.as_str())
                {
                    return Tag::Builtin(n.clone());
                }
            }
            Tag::Opaque(id.name.to_string())
        }
        JSXElementName::MemberExpression(_) | JSXElementName::ThisExpression(_) => Tag::Opaque("<member>".into()),
    }
}

pub(crate) enum AttrVal<'a> {
    /// `<x flag />`
    True,
    Str(String),
    Expr(&'a Expression<'a>),
    Element(&'a JSXElement<'a>),
    Fragment(&'a JSXFragment<'a>),
}

pub(crate) struct Attr<'a> {
    pub name: String,
    pub value: AttrVal<'a>,
    pub span: Span,
}

/// Attributes of an opening element; `Err` on a spread.
pub(crate) fn attrs<'a>(el: &'a JSXElement<'a>) -> Result<Vec<Attr<'a>>, String> {
    let mut out = Vec::new();
    for item in &el.opening_element.attributes {
        match item {
            JSXAttributeItem::SpreadAttribute(_) => return Err("JSX spread attribute".into()),
            JSXAttributeItem::Attribute(a) => {
                let name = match &a.name {
                    JSXAttributeName::Identifier(id) => id.name.to_string(),
                    JSXAttributeName::NamespacedName(n) => format!("{}:{}", n.namespace.name, n.name.name),
                };
                let value = match &a.value {
                    None => AttrVal::True,
                    Some(JSXAttributeValue::StringLiteral(s)) => AttrVal::Str(s.value.to_string()),
                    Some(JSXAttributeValue::ExpressionContainer(c)) => match &c.expression {
                        JSXExpression::EmptyExpression(_) => continue,
                        e => match e.as_expression() {
                            Some(Expression::StringLiteral(s)) => AttrVal::Str(s.value.to_string()),
                            Some(expr) => AttrVal::Expr(expr),
                            None => continue,
                        },
                    },
                    Some(JSXAttributeValue::Element(e)) => AttrVal::Element(e),
                    Some(JSXAttributeValue::Fragment(f)) => AttrVal::Fragment(f),
                };
                out.push(Attr { name, value, span: a.span });
            }
        }
    }
    Ok(out)
}

pub(crate) fn attr<'b, 'a>(attrs: &'b [Attr<'a>], name: &str) -> Option<&'b Attr<'a>> {
    attrs.iter().find(|a| a.name == name)
}

pub(crate) fn is_event_attr(name: &str) -> bool {
    (name.starts_with("on") && name.len() > 2 && name.as_bytes()[2].is_ascii_uppercase()) || name.starts_with("on:")
}

/// `onClick` → `click`, `on:custom` → `custom`.
pub(crate) fn event_name(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("on:") {
        return rest.to_string();
    }
    name[2..].to_ascii_lowercase()
}

#[derive(Clone, Copy)]
pub(crate) enum Child<'a> {
    Text(Span),
    Expr(&'a Expression<'a>),
    Element(&'a JSXElement<'a>),
    Fragment(&'a JSXFragment<'a>),
}

impl<'a> Child<'a> {
    pub(crate) fn span(&self) -> Span {
        match self {
            Child::Text(s) => *s,
            Child::Expr(e) => e.span(),
            Child::Element(e) => e.span,
            Child::Fragment(f) => f.span,
        }
    }
}

/// Meaningful children (whitespace-only text and empty containers dropped).
pub(crate) fn children<'a>(kids: &'a [JSXChild<'a>]) -> Result<Vec<Child<'a>>, String> {
    let mut out = Vec::new();
    for k in kids {
        match k {
            JSXChild::Text(t) => {
                if !trim_jsx_text(t.value.as_str()).is_empty() {
                    out.push(Child::Text(t.span));
                }
            }
            JSXChild::Element(e) => out.push(Child::Element(e)),
            JSXChild::Fragment(f) => out.push(Child::Fragment(f)),
            JSXChild::ExpressionContainer(c) => {
                if let Some(e) = c.expression.as_expression() {
                    out.push(Child::Expr(e));
                }
            }
            JSXChild::Spread(_) => return Err("JSX spread child".into()),
        }
    }
    Ok(out)
}

/// The rendered text of a JSX text node (trimmed, entities decoded).
pub(crate) fn jsx_text(m: &Model<'_>, span: Span) -> String {
    decode_html_entities(&trim_jsx_text(m.text(span)))
}

pub(crate) fn esc_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;")
}

pub(crate) fn esc_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

/// Expression as a view child: a literal string/number renders statically.
pub(crate) fn static_child(e: &Expression<'_>) -> Option<String> {
    match e.without_parentheses() {
        Expression::StringLiteral(s) => Some(s.value.to_string()),
        Expression::NumericLiteral(n) => Some(crate::shared::utils::format_number(n.value)),
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => {
            t.quasis.first().map(|q| q.value.cooked.as_ref().map_or_else(|| q.value.raw.to_string(), |c| c.to_string()))
        }
        _ => None,
    }
}

pub(crate) fn is_void(tag: &str) -> bool {
    crate::shared::utils::is_void_element(tag)
}

/// A JSX expression root (element or fragment) under parentheses.
pub(crate) enum Root<'a> {
    Element(&'a JSXElement<'a>),
    Fragment(&'a JSXFragment<'a>),
}

pub(crate) fn root_of<'a>(e: &'a Expression<'a>) -> Option<Root<'a>> {
    match e.without_parentheses() {
        Expression::JSXElement(el) => Some(Root::Element(el)),
        Expression::JSXFragment(f) => Some(Root::Fragment(f)),
        _ => None,
    }
}
