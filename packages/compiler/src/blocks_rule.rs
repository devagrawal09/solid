//! The one block rule of the JSX transform (generator blocks as a library,
//! `documentation/plans/blocks-library.md`).
//!
//! Inside a JSX expression or attribute value, `yield* e` becomes
//! `perform(e)` (imported from the blocks module, default
//! `@solidjs/blocks`), so the expression is a call and the transform treats
//! it as dynamic: the read happens in the hole's own computation, and the
//! view generator — which then has no `yield` left — runs once. Nothing else
//! is lowered, and the rule is purely syntactic.
//!
//! Positions the rule cannot turn into a hole are refused with a compile
//! error. The list is exactly [`REFUSALS`]; the ESLint plugin
//! (`@solidjs/eslint-plugin-blocks`, rule `yield-in-jsx-hole`) reports the
//! same list, and `tests/blocks-rule-fixtures.json` pins both.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{VisitMut, walk_mut};
use oxc_span::Span;
use oxc_syntax::scope::ScopeFlags;

use crate::shared::ast::{expression_to_argument, import_named};
use crate::shared::ast_builder::AstBuilder;

/// The default module `perform` is imported from.
pub(crate) const DEFAULT_BLOCKS_MODULE: &str = "@solidjs/blocks";
/// The local name of the imported `perform`.
const PERFORM_LOCAL: &str = "_$perform";

/// A position the rule refuses: its diagnostic code and message.
pub(crate) struct Refusal {
    pub code: &'static str,
    pub message: &'static str,
}

/// Every refusal of the rule, in one place.
pub(crate) const REFUSALS: &[Refusal] = &[
    Refusal {
        code: "BLOCKS_YIELD_IN_EVENT",
        message: "a `yield*` in an event handler prop would read once, at render: read inside the `$event` instead",
    },
    Refusal {
        code: "BLOCKS_YIELD_IN_REF",
        message: "a `yield*` in a `ref` has no hole to read in: a ref is set once",
    },
    Refusal {
        code: "BLOCKS_YIELD_IN_SPREAD",
        message: "a `yield*` in a spread cannot become a hole: spread an object of values, or pass each prop",
    },
    Refusal {
        code: "BLOCKS_YIELD_IN_SPREAD_CHILD",
        message: "a `yield*` in a spread child cannot become a hole",
    },
    Refusal {
        code: "BLOCKS_PLAIN_YIELD_IN_JSX",
        message: "a plain `yield` inside JSX is not a read: use `yield*`",
    },
];

fn refusal(code: &str) -> &'static Refusal {
    REFUSALS
        .iter()
        .find(|r| r.code == code)
        .expect("known refusal")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Hole {
    /// Not inside a JSX expression of the current function.
    None,
    /// A hole the rule rewrites into.
    Allowed,
    /// A position the rule refuses (index into REFUSALS by code).
    Refused(&'static str),
}

struct BlocksRule<'a, 's> {
    ast: AstBuilder<'a>,
    source: &'s str,
    hole: Hole,
    /// The attribute whose value is being visited, when any.
    attribute: Option<Hole>,
    used: bool,
    errors: Vec<String>,
}

impl<'a> BlocksRule<'a, '_> {
    fn locate(&self, span: Span) -> String {
        let start = (span.start as usize).min(self.source.len());
        let before = &self.source[..start];
        let line = before.matches('\n').count() + 1;
        let column = start - before.rfind('\n').map_or(0, |i| i + 1) + 1;
        format!("{line}:{column}")
    }

    fn refuse(&mut self, code: &'static str, span: Span) {
        let r = refusal(code);
        let at = self.locate(span);
        self.errors
            .push(format!("[{}] {} ({at})", r.code, r.message));
    }
}

fn attribute_hole(name: &JSXAttributeName<'_>) -> Hole {
    match name {
        JSXAttributeName::Identifier(id) => {
            let n = id.name.as_str();
            if n == "ref" {
                Hole::Refused("BLOCKS_YIELD_IN_REF")
            } else if n.len() > 2 && n.starts_with("on") && n.as_bytes()[2].is_ascii_uppercase() {
                Hole::Refused("BLOCKS_YIELD_IN_EVENT")
            } else {
                Hole::Allowed
            }
        }
        JSXAttributeName::NamespacedName(ns) => {
            let n = ns.namespace.name.as_str();
            if n == "on" || n == "oncapture" {
                Hole::Refused("BLOCKS_YIELD_IN_EVENT")
            } else {
                Hole::Allowed
            }
        }
    }
}

impl<'a> VisitMut<'a> for BlocksRule<'a, '_> {
    fn visit_function(&mut self, it: &mut Function<'a>, flags: ScopeFlags) {
        let (hole, attribute) = (self.hole, self.attribute.take());
        self.hole = Hole::None;
        walk_mut::walk_function(self, it, flags);
        self.hole = hole;
        self.attribute = attribute;
    }

    fn visit_arrow_function_expression(&mut self, it: &mut ArrowFunctionExpression<'a>) {
        let (hole, attribute) = (self.hole, self.attribute.take());
        self.hole = Hole::None;
        walk_mut::walk_arrow_function_expression(self, it);
        self.hole = hole;
        self.attribute = attribute;
    }

    fn visit_class(&mut self, it: &mut Class<'a>) {
        let (hole, attribute) = (self.hole, self.attribute.take());
        self.hole = Hole::None;
        walk_mut::walk_class(self, it);
        self.hole = hole;
        self.attribute = attribute;
    }

    fn visit_jsx_element(&mut self, it: &mut JSXElement<'a>) {
        let attribute = self.attribute.take();
        walk_mut::walk_jsx_element(self, it);
        self.attribute = attribute;
    }

    fn visit_jsx_fragment(&mut self, it: &mut JSXFragment<'a>) {
        let attribute = self.attribute.take();
        walk_mut::walk_jsx_fragment(self, it);
        self.attribute = attribute;
    }

    fn visit_jsx_attribute(&mut self, it: &mut JSXAttribute<'a>) {
        let attribute = self.attribute.replace(attribute_hole(&it.name));
        walk_mut::walk_jsx_attribute(self, it);
        self.attribute = attribute;
    }

    fn visit_jsx_spread_attribute(&mut self, it: &mut JSXSpreadAttribute<'a>) {
        let hole = self.hole;
        self.hole = Hole::Refused("BLOCKS_YIELD_IN_SPREAD");
        walk_mut::walk_jsx_spread_attribute(self, it);
        self.hole = hole;
    }

    fn visit_jsx_spread_child(&mut self, it: &mut JSXSpreadChild<'a>) {
        let hole = self.hole;
        self.hole = Hole::Refused("BLOCKS_YIELD_IN_SPREAD_CHILD");
        walk_mut::walk_jsx_spread_child(self, it);
        self.hole = hole;
    }

    fn visit_jsx_expression_container(&mut self, it: &mut JSXExpressionContainer<'a>) {
        let (hole, attribute) = (self.hole, self.attribute.take());
        self.hole = attribute.unwrap_or(Hole::Allowed);
        walk_mut::walk_jsx_expression_container(self, it);
        self.hole = hole;
        self.attribute = attribute;
    }

    fn visit_expression(&mut self, it: &mut Expression<'a>) {
        walk_mut::walk_expression(self, it);
        let Expression::YieldExpression(y) = it else {
            return;
        };
        match self.hole {
            Hole::None => {}
            Hole::Refused(code) if y.delegate => self.refuse(code, y.span),
            _ if !y.delegate => self.refuse("BLOCKS_PLAIN_YIELD_IN_JSX", y.span),
            Hole::Allowed => {
                let span = y.span;
                let Some(argument) = y.argument.take() else {
                    return;
                };
                let callee = self
                    .ast
                    .expression_identifier(span, self.ast.ident(PERFORM_LOCAL));
                let arguments = self.ast.vec1(expression_to_argument(argument));
                *it = self
                    .ast
                    .expression_call(span, callee, None, arguments, false);
                self.used = true;
            }
            Hole::Refused(_) => {}
        }
    }
}

/// Apply the rule to a parsed program. Returns the refusals as one error
/// message (each on its own line), or `Ok(())`.
pub(crate) fn apply<'a>(
    allocator: &'a Allocator,
    source: &str,
    program: &mut Program<'a>,
    blocks_module: &str,
) -> Result<(), String> {
    // Cheap pre-check: a program with no `yield` has nothing to rewrite.
    if !source.contains("yield") {
        return Ok(());
    }
    let mut rule = BlocksRule {
        ast: AstBuilder::new(allocator),
        source,
        hole: Hole::None,
        attribute: None,
        used: false,
        errors: Vec::new(),
    };
    rule.visit_program(program);
    if !rule.errors.is_empty() {
        return Err(rule.errors.join("\n"));
    }
    if rule.used {
        let import = import_named(allocator, blocks_module, "perform", PERFORM_LOCAL);
        program.body.insert(0, import);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{CompileOptions, Generate, compile};

    fn dom(source: &str) -> Result<String, String> {
        compile(
            source,
            &CompileOptions {
                filename: Some("view.tsx".into()),
                ..CompileOptions::default()
            },
        )
        .map(|o| o.code)
        .map_err(|e| e.to_string())
    }

    #[test]
    fn rewrites_children_and_attributes_into_holes() {
        let code = dom(
            "const V = function* () { return <p class={{ big: (yield* n) > 3 }}>Hello {(yield* user).name}</p>; };",
        )
        .unwrap();
        assert!(code.contains("import { perform as _$perform } from \"@solidjs/blocks\""));
        assert!(code.contains("_$perform(user).name"));
        assert!(code.contains("_$perform(n) > 3"));
        assert!(
            !code.contains("yield"),
            "no yield left in the view:\n{code}"
        );
    }

    #[test]
    fn leaves_yield_outside_jsx_and_in_nested_functions() {
        let code = dom("function* v() { const x = yield* a; return <p>{x}</p>; }").unwrap();
        assert!(code.contains("yield* a"));
        assert!(!code.contains("_$perform"));
        let code =
            dom("function* v() { return <For each={xs}>{function* (x) { const s = yield* $signal(1); return function* () { return <i>{yield* s}</i>; }; }}</For>; }")
                .unwrap();
        assert!(code.contains("yield* $signal(1)"));
        assert!(code.contains("_$perform(s)"));
    }

    #[test]
    fn refuses_every_listed_position() {
        for (source, code) in [
            (
                "function* v() { return <b onClick={yield* h} />; }",
                "BLOCKS_YIELD_IN_EVENT",
            ),
            (
                "function* v() { return <b on:click={yield* h} />; }",
                "BLOCKS_YIELD_IN_EVENT",
            ),
            (
                "function* v() { return <b ref={yield* r} />; }",
                "BLOCKS_YIELD_IN_REF",
            ),
            (
                "function* v() { return <b {...(yield* p)} />; }",
                "BLOCKS_YIELD_IN_SPREAD",
            ),
            (
                "function* v() { return <b>{...(yield* p)}</b>; }",
                "BLOCKS_YIELD_IN_SPREAD_CHILD",
            ),
            (
                "function* v() { return <b>{yield x}</b>; }",
                "BLOCKS_PLAIN_YIELD_IN_JSX",
            ),
        ] {
            let error = dom(source).expect_err(source);
            assert!(error.contains(code), "{source}: {error}");
        }
    }

    #[test]
    fn refusal_list_matches_the_shared_fixtures() {
        let fixtures = include_str!("../tests/blocks-rule-fixtures.json");
        for r in super::REFUSALS {
            let quoted = format!("\"{}\"", r.code);
            assert!(
                fixtures.contains(&quoted),
                "{} missing from fixtures",
                r.code
            );
        }
        let listed = fixtures
            .split("\"refusals\": [")
            .nth(1)
            .unwrap()
            .split(']')
            .next()
            .unwrap();
        assert_eq!(listed.matches("BLOCKS_").count(), super::REFUSALS.len());
    }

    #[test]
    fn ssr_output_reads_in_holes_too() {
        let code = compile(
            "function* v() { return <p title={yield* t}>{(yield* user).name}</p>; }",
            &CompileOptions {
                filename: Some("view.tsx".into()),
                generate: Generate::Ssr,
                hydratable: true,
                ..CompileOptions::default()
            },
        )
        .unwrap()
        .code;
        assert!(code.contains("_$perform(user).name"));
        assert!(!code.contains("yield"));
    }
}
