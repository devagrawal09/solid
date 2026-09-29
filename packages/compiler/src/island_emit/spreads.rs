//! Spread attributes on intrinsic elements → explicit attributes, a source
//! pre-pass.
//!
//! The island compiler addresses every attribute, handler and ref by its
//! source position, so a spread is rewritten to the attributes it stands for
//! before the module is analysed, when they are known statically:
//!
//! - **an object literal** with static keys (`{...{ a: x, "b-c": y }}`):
//!   one attribute per property, in order;
//! - **the component's own `props`** (`<button {...props}>`), when every
//!   caller is in the module (the component is not exported and is only
//!   rendered as JSX there, never with a spread): one `key={props.key}` per
//!   attribute any caller passes, in first-seen order — an attribute a caller
//!   leaves out reads `undefined` and renders nothing, as the runtime spread
//!   does. Children callers pass become the element's `{props.children}` when
//!   it has none of its own (the runtime spread inserts them).
//!
//! A spread whose keys cannot be listed this way (an exported component's
//! props, a caller passing `ref` or a spread, another expression) or whose
//! keys collide with the element's explicit attributes is left as written,
//! and the analysis refuses it as before.
use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Expression, JSXAttributeItem, JSXAttributeName, JSXChild, JSXElement, JSXElementName,
    ObjectPropertyKind, PropertyKey, PropertyKind,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use super::model::{self, Model};
use crate::compiler::{parse_program, source_type_for_filename};
use crate::store_scalars::splice;

/// The rewritten source, or `None` when nothing was rewritten.
pub(crate) fn rewrite(source: &str, filename: Option<&str>) -> Option<String> {
    if !source.contains("{...") {
        return None;
    }
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename).ok()?;
    let program = parse_program(&allocator, source, source_type).ok()?;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let scoping = semantic.scoping();
    let m = model::build_model(source, &program, scoping, Vec::new());
    let mut v = Collect {
        m: &m,
        elements: Vec::new(),
        calls: HashMap::new(),
        names: HashMap::new(),
    };
    v.visit_program(&program);
    let mut edits: Vec<(Span, String)> = Vec::new();
    for el in &v.elements {
        let el: &JSXElement<'_> = el;
        if let Some(mut e) = rewrite_element(&m, &v, el) {
            edits.append(&mut e);
        }
    }
    if edits.is_empty() {
        return None;
    }
    Some(splice(source, Span::new(0, source.len() as u32), edits))
}

struct Collect<'m, 'a> {
    m: &'m Model<'a>,
    /// Intrinsic elements with a spread attribute.
    elements: Vec<&'a JSXElement<'a>>,
    /// Component index → its JSX call sites.
    calls: HashMap<usize, Vec<&'a JSXElement<'a>>>,
    /// Component symbol → references as a JSX element name (opening and
    /// closing tags).
    names: HashMap<SymbolId, usize>,
}

impl<'a> Visit<'a> for Collect<'_, 'a> {
    fn visit_jsx_element(&mut self, e: &JSXElement<'a>) {
        // Every node visited belongs to the program arena ('a); see tx.rs.
        let e: &'a JSXElement<'a> = unsafe { &*(e as *const JSXElement<'a>) };
        match &e.opening_element.name {
            JSXElementName::Identifier(_) => {
                if e
                    .opening_element
                    .attributes
                    .iter()
                    .any(|a| matches!(a, JSXAttributeItem::SpreadAttribute(_)))
                {
                    self.elements.push(e);
                }
            }
            JSXElementName::IdentifierReference(id) => {
                if let Some(s) = self.m.symbol_of(id) {
                    // A closing tag's name may resolve as a reference too.
                    let closing = e.closing_element.as_ref().is_some_and(|c| {
                        matches!(&c.name, JSXElementName::IdentifierReference(cid) if self.m.symbol_of(cid) == Some(s))
                    });
                    *self.names.entry(s).or_default() += 1 + usize::from(closing);
                    if let Some(c) = self.m.comp_of.get(&s) {
                        self.calls.entry(*c).or_default().push(e);
                    }
                }
            }
            _ => {}
        }
        walk::walk_jsx_element(self, e);
    }
}

fn attr_name(n: &JSXAttributeName<'_>) -> String {
    match n {
        JSXAttributeName::Identifier(id) => id.name.to_string(),
        JSXAttributeName::NamespacedName(n) => format!("{}:{}", n.namespace.name, n.name.name),
    }
}

fn is_ident(s: &str) -> bool {
    let mut c = s.chars();
    c.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && c.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// A valid JSX attribute name (identifier with dashes, or `ns:name`).
fn jsx_name(s: &str) -> bool {
    let part = |p: &str| {
        p.chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '-')
    };
    match s.split_once(':') {
        Some((a, b)) => part(a) && part(b),
        None => part(s),
    }
}

/// Meaningful JSX children (whitespace-only text dropped).
fn has_children(kids: &[JSXChild<'_>]) -> bool {
    kids.iter().any(|k| match k {
        JSXChild::Text(t) => !crate::shared::utils::trim_jsx_text(t.value.as_str()).is_empty(),
        JSXChild::ExpressionContainer(c) => c.expression.as_expression().is_some(),
        _ => true,
    })
}

fn rewrite_element<'a>(
    m: &Model<'a>,
    v: &Collect<'_, 'a>,
    el: &'a JSXElement<'a>,
) -> Option<Vec<(Span, String)>> {
    let JSXElementName::Identifier(tag) = &el.opening_element.name else {
        return None;
    };
    let explicit: Vec<String> = el
        .opening_element
        .attributes
        .iter()
        .filter_map(|a| match a {
            JSXAttributeItem::Attribute(a) => Some(attr_name(&a.name)),
            JSXAttributeItem::SpreadAttribute(_) => None,
        })
        .collect();
    let mut edits = Vec::new();
    let mut spread_keys: Vec<String> = Vec::new();
    let mut children: Option<String> = None;
    for a in &el.opening_element.attributes {
        let JSXAttributeItem::SpreadAttribute(sp) = a else {
            continue;
        };
        let arg = sp.argument.without_parentheses();
        let mut attrs = String::new();
        match arg {
            Expression::ObjectExpression(o) => {
                for p in &o.properties {
                    let ObjectPropertyKind::ObjectProperty(p) = p else {
                        return None;
                    };
                    if p.kind != PropertyKind::Init || p.method || p.computed {
                        return None;
                    }
                    let key = match &p.key {
                        PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                        PropertyKey::StringLiteral(s) if jsx_name(&s.value) => s.value.to_string(),
                        _ => return None,
                    };
                    if key == "children" || key == "ref" {
                        return None;
                    }
                    spread_keys.push(key.clone());
                    attrs.push_str(&format!(" {key}={{{}}}", m.text(p.value.span())));
                }
            }
            Expression::Identifier(id) => {
                let s = m.symbol_of(id)?;
                // The props of the component this element belongs to.
                let ci = m.comps.iter().position(|c| {
                    c.props == Some(s)
                        && c.replace.start <= el.span.start
                        && el.span.end <= c.replace.end
                })?;
                let c = &m.comps[ci];
                let sym = c.sym?;
                if c.exported {
                    return None;
                }
                let calls = v.calls.get(&ci).map_or(&[][..], |x| &x[..]);
                // Only rendered as JSX in this module (no other reference).
                let refs = m.scoping.get_resolved_reference_ids(sym).len();
                if calls.is_empty() || v.names.get(&sym).copied().unwrap_or(0) != refs {
                    return None;
                }
                let mut keys: Vec<String> = Vec::new();
                let mut kids = false;
                for call in calls {
                    for ca in &call.opening_element.attributes {
                        let JSXAttributeItem::Attribute(ca) = ca else {
                            return None;
                        };
                        let k = attr_name(&ca.name);
                        if k == "ref" {
                            return None;
                        }
                        if k == "children" {
                            kids = true;
                            continue;
                        }
                        if !keys.contains(&k) {
                            keys.push(k);
                        }
                    }
                    kids |= has_children(&call.children);
                }
                let p = &id.name;
                for k in keys {
                    let read = if is_ident(&k) {
                        format!("{p}.{k}")
                    } else {
                        format!("{p}[{}]", super::client_js_str(&k))
                    };
                    attrs.push_str(&format!(" {k}={{{read}}}"));
                    spread_keys.push(k);
                }
                if kids && !has_children(&el.children) && !crate::shared::utils::is_void_element(&tag.name) {
                    children = Some(format!("{{{p}.children}}"));
                }
            }
            _ => return None,
        }
        edits.push((sp.span, attrs.trim_start().to_string()));
    }
    // Precedence between a spread and an explicit attribute of the same name
    // depends on the runtime value: not rewritten.
    if spread_keys.iter().any(|k| explicit.contains(k))
        || (1..spread_keys.len()).any(|i| spread_keys[..i].contains(&spread_keys[i]))
    {
        return None;
    }
    if let Some(ch) = children {
        match &el.closing_element {
            Some(close) => edits.push((Span::new(close.span.start, close.span.start), ch)),
            None => {
                // `<tag … />` → `<tag …>{props.children}</tag>`.
                let end = el.opening_element.span.end;
                if !m.text(el.opening_element.span).ends_with("/>") {
                    return None;
                }
                edits.push((Span::new(end - 2, end), format!(">{ch}</{}>", tag.name)));
            }
        }
    }
    Some(edits)
}
