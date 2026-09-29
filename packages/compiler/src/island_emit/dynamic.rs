//! `<Dynamic component={…}>` with a statically known component → the element
//! it stands for, a source pre-pass.
//!
//! The island compiler addresses elements and components by their source
//! position, so a `Dynamic` whose `component` is known when the module is
//! compiled is rewritten before the analysis:
//!
//! - **a string** (`component="h2"`): the intrinsic element `<h2 …>`;
//! - **a component bound at the module's top level** and never reassigned
//!   (a `$component`, a function, an import; its name capitalized, as a JSX
//!   tag must be): `<Card …>`.
//!
//! Its other attributes and its children carry over unchanged (`Dynamic`
//! passes them as the component's props). Any other `component` (a prop, a
//! local, reactive state) is left as written and the analysis refuses it.
use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Expression, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXElement, JSXElementName,
    JSXExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};

use super::model::{self, Model};
use crate::compiler::{parse_program, source_type_for_filename};
use crate::store_scalars::splice;

/// The rewritten source, or `None` when nothing was rewritten.
pub(crate) fn rewrite(source: &str, filename: Option<&str>) -> Option<String> {
    if !source.contains("Dynamic") {
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
        edits: Vec::new(),
    };
    v.visit_program(&program);
    if v.edits.is_empty() {
        return None;
    }
    Some(splice(source, Span::new(0, source.len() as u32), v.edits))
}

struct Collect<'m, 'a> {
    m: &'m Model<'a>,
    edits: Vec<(Span, String)>,
}

impl<'a> Visit<'a> for Collect<'_, 'a> {
    fn visit_jsx_element(&mut self, e: &JSXElement<'a>) {
        if let Some(mut edits) = rewrite_element(self.m, e) {
            self.edits.append(&mut edits);
        }
        walk::walk_jsx_element(self, e);
    }
}

/// A valid intrinsic tag name (letters, digits, `-`; starting lowercase).
fn tag_name(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_lowercase())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn rewrite_element(m: &Model<'_>, e: &JSXElement<'_>) -> Option<Vec<(Span, String)>> {
    let JSXElementName::IdentifierReference(id) = &e.opening_element.name else {
        return None;
    };
    let sym = m.symbol_of(id)?;
    if m.runtime.get(&sym).map(String::as_str) != Some("Dynamic") {
        return None;
    }
    // The `component` attribute (exactly one, no spread before it that could
    // override it).
    let mut comp_attr = None;
    for item in &e.opening_element.attributes {
        match item {
            JSXAttributeItem::SpreadAttribute(_) => return None,
            JSXAttributeItem::Attribute(a) => {
                if matches!(&a.name, JSXAttributeName::Identifier(n) if n.name == "component") {
                    if comp_attr.is_some() {
                        return None;
                    }
                    comp_attr = Some(a);
                }
            }
        }
    }
    let a = comp_attr?;
    let name = match a.value.as_ref()? {
        JSXAttributeValue::StringLiteral(s) if tag_name(&s.value) => s.value.to_string(),
        JSXAttributeValue::ExpressionContainer(c) => match &c.expression {
            JSXExpression::StringLiteral(s) if tag_name(&s.value) => s.value.to_string(),
            other => {
                let Some(Expression::Identifier(r)) =
                    other.as_expression().map(|x| x.without_parentheses())
                else {
                    return None;
                };
                let s = m.symbol_of(r)?;
                // Bound at the top level (a component, function, class or
                // import), never reassigned, and a JSX component name.
                let top = &m.top[*m.top_of.get(&s)?];
                if top.runtime_import
                    || m.scoping.symbol_is_mutated(s)
                    || !r.name.starts_with(|c: char| c.is_ascii_uppercase())
                {
                    return None;
                }
                r.name.to_string()
            }
        },
        _ => return None,
    };
    let mut edits = vec![(id.span, name.clone())];
    // Drop ` component={…}` (from the end of what precedes it).
    let before = e
        .opening_element
        .attributes
        .iter()
        .take_while(|x| x.span() != a.span)
        .last()
        .map_or(id.span.end, |x| x.span().end);
    edits.push((Span::new(before, a.span.end), String::new()));
    if let Some(c) = &e.closing_element {
        edits.push((c.name.span(), name));
    }
    Some(edits)
}
