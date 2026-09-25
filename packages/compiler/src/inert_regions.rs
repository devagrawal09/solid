//! Track D slice 6 — inert-region hydration elimination (smallest safe form).
//!
//! A hydrating client re-runs every component: it calls the function, claims
//! each template root from the hydration-key registry (`getNextElement`),
//! walks the claimed DOM, and (in dev/observe builds) creates a component
//! owner — even for markup that can never change or react. This pass proves
//! such regions inert and lets the client skip them entirely while hydrating.
//!
//! ## Proof (conservative; anything unproven keeps ordinary hydration)
//!
//! A same-module component is **inert** iff:
//! - it takes no props (no parameter, or one never referenced) — so no
//!   caller input, and in particular no `children`;
//! - its body is exactly `return <jsx/>` (or an arrow's JSX expression body):
//!   no statements, calls, reads, writes, cleanup, context, or client-only
//!   logic can run;
//! - the JSX is intrinsic elements (not custom elements, which may upgrade),
//!   fragments, text, and literal expression containers;
//! - every attribute is a plain name (no `on*` events, `ref`, or namespaced
//!   `use:`/`prop:`/`attr:`/`on:` directives) with a literal value, and there
//!   are no spreads;
//! - every component inside it is itself inert (same module), or an import the
//!   cross-module summary declares `inert-component` — never a runtime
//!   component (`Show`, `For`, `Loading`, `Errored`, context providers, …),
//!   so no boundaries and no interactive descendants.
//!
//! ## Rewrite (identical on both generates, before JSX lowering)
//!
//! A use site `<Inert />` (no attributes, no children) that sits
//! unconditionally inside intrinsic elements of a function's returned JSX root
//! becomes a hole holding a hoisted constant:
//!
//! ```js
//! const _$inert0 = _$inert(() => <Inert />);   // top of the enclosing function
//! … <div>{_$inert0}</div> …
//! ```
//!
//! - Server `inert(render)`: renders under a transparent owner with the
//!   no-hydration context — no `_hk` keys, no ids allocated.
//! - Client `inert(render)`: while hydrating it returns a sentinel that
//!   `insert()` adopts in place (the server's nodes stay; nothing is called,
//!   claimed, or owned); otherwise it renders normally.
//!
//! Neither side allocates ids for the region, so parity holds. The component's
//! code is still shipped: omitting it would need a whole-graph proof that the
//! use site never renders outside hydration (a Track C linker fact).
use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    ArrowFunctionExpression, Expression, Function, ImportDeclarationSpecifier, ImportOrExportKind,
    JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXChild, JSXElement, JSXElementName,
    JSXExpression, Program, Statement, VariableDeclarationKind,
};
use oxc_ast_visit::{VisitMut, walk_mut};
use oxc_semantic::{AstNodes, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use crate::server_authority::{AuthorityKind, AuthoritySummary};
use crate::shared::ast_builder::AstBuilder;

const INERT_LOCAL: &str = "_$inert";

/// One component decision (exposed for tests and the report channel).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InertDecision {
    pub name: String,
    pub inert: bool,
    pub reason: Option<String>,
}

/// Prove inert components and rewrite their eligible use sites.
pub(crate) fn mark_inert_regions<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    module_name: &str,
    summary: &AuthoritySummary,
) -> (Vec<InertDecision>, usize) {
    let (decisions, plan) = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let analysis = Analysis::new(semantic.scoping(), semantic.nodes(), program, summary);
        analysis.run()
    };
    let sites = plan.values().map(Vec::len).sum();
    if sites > 0 {
        let mut rewriter = Rewriter {
            allocator,
            plan,
            frames: Vec::new(),
            counter: 0,
        };
        rewriter.visit_program(program);
        program.body.insert(
            0,
            crate::shared::ast::import_named(allocator, module_name, "inert", INERT_LOCAL),
        );
    }
    (decisions, sites)
}

struct Analysis<'s, 'a> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'a>,
    summary: &'s AuthoritySummary,
    imports: HashMap<SymbolId, (String, String)>,
    /// Same-module components by symbol: their function node span.
    components: HashMap<SymbolId, (String, Span)>,
}

impl<'s, 'a> Analysis<'s, 'a> {
    fn new(
        scoping: &'s Scoping,
        nodes: &'s AstNodes<'a>,
        program: &'s Program<'a>,
        summary: &'s AuthoritySummary,
    ) -> Self {
        let mut imports = HashMap::new();
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if import.import_kind == ImportOrExportKind::Type {
                continue;
            }
            for specifier in import.specifiers.iter().flatten() {
                if let ImportDeclarationSpecifier::ImportSpecifier(s) = specifier
                    && let Some(symbol) = s.local.symbol_id.get()
                {
                    imports.insert(
                        symbol,
                        (
                            import.source.value.to_string(),
                            s.imported.name().to_string(),
                        ),
                    );
                }
            }
        }
        let mut components = HashMap::new();
        for node in nodes.iter() {
            match node.kind() {
                AstKind::Function(function)
                    if function.id.as_ref().is_some_and(|id| capitalized(&id.name)) =>
                {
                    if let Some(symbol) = function.id.as_ref().and_then(|id| id.symbol_id.get()) {
                        components.insert(
                            symbol,
                            (
                                function.id.as_ref().unwrap().name.to_string(),
                                function.span,
                            ),
                        );
                    }
                }
                AstKind::VariableDeclarator(declarator) => {
                    let Some(name) = declarator.id.get_identifier_name() else {
                        continue;
                    };
                    if !capitalized(&name) {
                        continue;
                    }
                    let span = match declarator.init.as_ref() {
                        Some(Expression::ArrowFunctionExpression(arrow)) => arrow.span,
                        Some(Expression::FunctionExpression(function)) => function.span,
                        _ => continue,
                    };
                    if let Some(symbol) = declarator
                        .id
                        .get_binding_identifier()
                        .and_then(|b| b.symbol_id.get())
                    {
                        components.insert(symbol, (name.to_string(), span));
                    }
                }
                _ => {}
            }
        }
        Self {
            scoping,
            nodes,
            summary,
            imports,
            components,
        }
    }

    fn run(&self) -> (Vec<InertDecision>, HashMap<Span, Vec<Span>>) {
        let mut memo: HashMap<SymbolId, Result<(), String>> = HashMap::new();
        let mut decisions = Vec::new();
        let mut symbols: Vec<_> = self.components.keys().copied().collect();
        symbols.sort_by_key(|s| self.components[s].1.start);
        for symbol in &symbols {
            let result = self.inert(*symbol, &mut memo, &mut HashSet::new());
            decisions.push(InertDecision {
                name: self.components[symbol].0.clone(),
                inert: result.is_ok(),
                reason: result.err(),
            });
        }
        let inert_bodies: HashSet<Span> = symbols
            .iter()
            .filter(|s| matches!(memo.get(s), Some(Ok(()))))
            .map(|s| self.components[s].1)
            .collect();
        // Use sites: in every function's unconditional returned JSX root.
        let mut plan: HashMap<Span, Vec<Span>> = HashMap::new();
        for node in self.nodes.iter() {
            let (span, root) = match node.kind() {
                AstKind::ArrowFunctionExpression(arrow) => (arrow.span, returned_jsx_arrow(arrow)),
                AstKind::Function(function) => (
                    function.span,
                    function
                        .body
                        .as_ref()
                        .and_then(|b| returned_jsx(&b.statements)),
                ),
                _ => continue,
            };
            if inert_bodies.contains(&span) {
                continue;
            }
            let Some(root) = root else { continue };
            let mut sites = Vec::new();
            match root {
                Expression::JSXElement(element) => {
                    if is_intrinsic(element) {
                        self.scan(&element.children, &mut memo, &mut sites);
                    }
                }
                Expression::JSXFragment(fragment) => {
                    self.scan(&fragment.children, &mut memo, &mut sites)
                }
                _ => {}
            }
            if !sites.is_empty() {
                plan.insert(span, sites);
            }
        }
        (decisions, plan)
    }

    /// Children of an intrinsic element / fragment: inert use sites, and
    /// descent through further intrinsic elements and fragments only.
    fn scan(
        &self,
        children: &[JSXChild<'_>],
        memo: &mut HashMap<SymbolId, Result<(), String>>,
        out: &mut Vec<Span>,
    ) {
        for child in children {
            match child {
                JSXChild::Element(element) => {
                    if is_intrinsic(element) {
                        self.scan(&element.children, memo, out);
                    } else if element.opening_element.attributes.is_empty()
                        && element.children.is_empty()
                        && self.tag_is_inert(element, memo)
                    {
                        out.push(element.span);
                    }
                }
                JSXChild::Fragment(fragment) => self.scan(&fragment.children, memo, out),
                _ => {}
            }
        }
    }

    fn tag_is_inert(
        &self,
        element: &JSXElement<'_>,
        memo: &mut HashMap<SymbolId, Result<(), String>>,
    ) -> bool {
        let JSXElementName::IdentifierReference(tag) = &element.opening_element.name else {
            return false;
        };
        let Some(symbol) = tag
            .reference_id
            .get()
            .and_then(|r| self.scoping.get_reference(r).symbol_id())
        else {
            return false;
        };
        self.inert(symbol, memo, &mut HashSet::new()).is_ok()
    }

    fn inert(
        &self,
        symbol: SymbolId,
        memo: &mut HashMap<SymbolId, Result<(), String>>,
        visiting: &mut HashSet<SymbolId>,
    ) -> Result<(), String> {
        if let Some(result) = memo.get(&symbol) {
            return result.clone();
        }
        if let Some((module, export)) = self.imports.get(&symbol) {
            return if self.summary_kind(module, export) == Some(AuthorityKind::InertComponent) {
                Ok(())
            } else {
                Err(format!("import `{export}` has no inert-component summary"))
            };
        }
        if !visiting.insert(symbol) {
            return Err("recursive component".into());
        }
        let result = self.check_component(symbol, memo, visiting);
        memo.insert(symbol, result.clone());
        result
    }

    fn summary_kind(&self, module: &str, export: &str) -> Option<AuthorityKind> {
        self.summary
            .entries
            .iter()
            .find(|(m, e, _)| m == module && e == export)
            .map(|(_, _, kind)| *kind)
    }

    fn check_component(
        &self,
        symbol: SymbolId,
        memo: &mut HashMap<SymbolId, Result<(), String>>,
        visiting: &mut HashSet<SymbolId>,
    ) -> Result<(), String> {
        let Some((_, span)) = self.components.get(&symbol) else {
            return Err("not a same-module component".into());
        };
        let node = self
            .nodes
            .iter()
            .find(|n| {
                n.kind().span() == *span
                    && matches!(
                        n.kind(),
                        AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)
                    )
            })
            .ok_or("component function not found")?;
        let (params, root) = match node.kind() {
            AstKind::ArrowFunctionExpression(arrow) => {
                if arrow.r#async {
                    return Err("async component".into());
                }
                (&arrow.params, returned_jsx_arrow(arrow))
            }
            AstKind::Function(function) => {
                if function.r#async || function.generator {
                    return Err("async / generator component".into());
                }
                (
                    &function.params,
                    function
                        .body
                        .as_ref()
                        .and_then(|b| only_return_jsx(&b.statements)),
                )
            }
            _ => return Err("not a function".into()),
        };
        if let AstKind::ArrowFunctionExpression(arrow) = node.kind()
            && let oxc_ast::ast::ArrowFunctionBody::FunctionBody(body) = &arrow.body
            && only_return_jsx(&body.statements).is_none()
        {
            return Err("body has statements besides `return <jsx/>`".into());
        }
        if params.items.len() > 1 || params.rest.is_some() {
            return Err("takes more than a props parameter".into());
        }
        if let Some(param) = params.items.first() {
            let oxc_ast::ast::BindingPattern::BindingIdentifier(identifier) = &param.pattern else {
                return Err("destructures props (reads caller input)".into());
            };
            let used = identifier
                .symbol_id
                .get()
                .is_some_and(|s| !self.scoping.get_resolved_reference_ids(s).is_empty());
            if used {
                return Err("reads props (caller input, possibly live or children)".into());
            }
        }
        let root = root.ok_or("body is not exactly `return <jsx/>`")?;
        match root {
            Expression::JSXElement(element) => self.check_element(element, memo, visiting),
            Expression::JSXFragment(fragment) => {
                self.check_children(&fragment.children, memo, visiting)
            }
            _ => Err("returns something other than JSX".into()),
        }
    }

    fn check_element(
        &self,
        element: &JSXElement<'_>,
        memo: &mut HashMap<SymbolId, Result<(), String>>,
        visiting: &mut HashSet<SymbolId>,
    ) -> Result<(), String> {
        match &element.opening_element.name {
            JSXElementName::Identifier(tag) => {
                if tag.name.contains('-') {
                    return Err(format!("custom element `<{}>` may upgrade", tag.name));
                }
                for item in &element.opening_element.attributes {
                    let JSXAttributeItem::Attribute(attribute) = item else {
                        return Err("spread attributes".into());
                    };
                    let JSXAttributeName::Identifier(name) = &attribute.name else {
                        return Err("namespaced attribute / directive".into());
                    };
                    let name = name.name.as_str();
                    if name.starts_with("on") {
                        return Err(format!("event handler `{name}`"));
                    }
                    if name == "ref" {
                        return Err("ref".into());
                    }
                    match &attribute.value {
                        None | Some(JSXAttributeValue::StringLiteral(_)) => {}
                        Some(JSXAttributeValue::ExpressionContainer(container))
                            if container.expression.as_expression().is_some_and(is_literal) => {}
                        _ => return Err(format!("non-literal attribute `{name}`")),
                    }
                }
                self.check_children(&element.children, memo, visiting)
            }
            JSXElementName::IdentifierReference(tag) => {
                if !element.opening_element.attributes.is_empty() || !element.children.is_empty() {
                    return Err(format!("passes props/children to `<{}>`", tag.name));
                }
                let symbol = tag
                    .reference_id
                    .get()
                    .and_then(|r| self.scoping.get_reference(r).symbol_id())
                    .ok_or_else(|| format!("unknown component `<{}>`", tag.name))?;
                self.inert(symbol, memo, visiting)
                    .map_err(|reason| format!("child `<{}>` is not inert: {reason}", tag.name))
            }
            _ => Err("member-expression component".into()),
        }
    }

    fn check_children(
        &self,
        children: &[JSXChild<'_>],
        memo: &mut HashMap<SymbolId, Result<(), String>>,
        visiting: &mut HashSet<SymbolId>,
    ) -> Result<(), String> {
        for child in children {
            match child {
                JSXChild::Text(_) => {}
                JSXChild::Element(element) => self.check_element(element, memo, visiting)?,
                JSXChild::Fragment(fragment) => {
                    self.check_children(&fragment.children, memo, visiting)?
                }
                JSXChild::ExpressionContainer(container) => match &container.expression {
                    JSXExpression::EmptyExpression(_) => {}
                    expression => {
                        if !expression.as_expression().is_some_and(is_literal) {
                            return Err("dynamic child expression".into());
                        }
                    }
                },
                JSXChild::Spread(_) => return Err("spread child".into()),
            }
        }
        Ok(())
    }
}

fn capitalized(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

fn is_intrinsic(element: &JSXElement<'_>) -> bool {
    matches!(element.opening_element.name, JSXElementName::Identifier(_))
}

fn is_literal(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_) => true,
        Expression::TemplateLiteral(template) => template.expressions.is_empty(),
        _ => false,
    }
}

fn is_jsx_root(expression: &Expression<'_>) -> bool {
    matches!(
        expression,
        Expression::JSXElement(_) | Expression::JSXFragment(_)
    )
}

fn unparen<'b, 'a>(expression: &'b Expression<'a>) -> &'b Expression<'a> {
    match expression {
        Expression::ParenthesizedExpression(p) => unparen(&p.expression),
        other => other,
    }
}

/// An arrow's unconditionally returned JSX root.
fn returned_jsx_arrow<'b, 'a>(
    arrow: &'b ArrowFunctionExpression<'a>,
) -> Option<&'b Expression<'a>> {
    match &arrow.body {
        oxc_ast::ast::ArrowFunctionBody::FunctionBody(body) => returned_jsx(&body.statements),
        body => {
            let expression = unparen(body.as_expression()?);
            is_jsx_root(expression).then_some(expression)
        }
    }
}

/// Straight-line statements ending in `return <jsx/>`.
fn returned_jsx<'b, 'a>(statements: &'b [Statement<'a>]) -> Option<&'b Expression<'a>> {
    let (last, rest) = statements.split_last()?;
    if !rest.iter().all(|s| {
        matches!(
            s,
            Statement::VariableDeclaration(_) | Statement::ExpressionStatement(_)
        )
    }) {
        return None;
    }
    let Statement::ReturnStatement(ret) = last else {
        return None;
    };
    let expression = unparen(ret.argument.as_ref()?);
    is_jsx_root(expression).then_some(expression)
}

/// Exactly one statement: `return <jsx/>`.
fn only_return_jsx<'b, 'a>(statements: &'b [Statement<'a>]) -> Option<&'b Expression<'a>> {
    if statements.len() != 1 {
        return None;
    }
    returned_jsx(statements)
}

struct Rewriter<'a> {
    allocator: &'a Allocator,
    /// Enclosing function span → use-site element spans to rewrite.
    plan: HashMap<Span, Vec<Span>>,
    frames: Vec<(Vec<Span>, Vec<(String, Expression<'a>)>)>,
    counter: usize,
}

impl<'a> Rewriter<'a> {
    fn open(&mut self, span: Span) -> bool {
        match self.plan.remove(&span) {
            Some(sites) => {
                self.frames.push((sites, Vec::new()));
                true
            }
            None => false,
        }
    }

    fn declarations(&mut self, span: Span) -> Vec<Statement<'a>> {
        let (_, decls) = self.frames.pop().expect("opened frame");
        let ast = AstBuilder::new(self.allocator);
        decls
            .into_iter()
            .map(|(name, element)| {
                let thunk = crate::shared::ast::concise_arrow_thunk(self.allocator, span, element);
                let call = ast.expression_call(
                    span,
                    ast.expression_identifier(span, ast.ident(INERT_LOCAL)),
                    None,
                    ast.vec1(crate::shared::ast::expression_to_argument(thunk)),
                    false,
                );
                crate::shared::ast::variable_statement(
                    self.allocator,
                    span,
                    VariableDeclarationKind::Const,
                    &name,
                    call,
                )
            })
            .collect()
    }
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        let opened = self.open(arrow.span);
        walk_mut::walk_arrow_function_expression(self, arrow);
        if !opened {
            return;
        }
        let span = arrow.span;
        let mut statements = self.declarations(span);
        if statements.is_empty() {
            return;
        }
        let ast = AstBuilder::new(self.allocator);
        let placeholder = oxc_ast::ast::ArrowFunctionBody::from(ast.expression_null_literal(span));
        let body = std::mem::replace(&mut arrow.body, placeholder);
        statements.extend(crate::shared::ast::arrow_body_statements(
            self.allocator,
            span,
            body,
        ));
        let body = ast.function_body(span, ast.vec(), ast.vec_from_iter(statements));
        arrow.body = oxc_ast::ast::ArrowFunctionBody::FunctionBody(ast.alloc(body));
    }

    fn visit_function(
        &mut self,
        function: &mut Function<'a>,
        flags: oxc_syntax::scope::ScopeFlags,
    ) {
        let opened = self.open(function.span);
        walk_mut::walk_function(self, function, flags);
        if !opened {
            return;
        }
        let statements = self.declarations(function.span);
        if let Some(body) = function.body.as_mut() {
            for (index, statement) in statements.into_iter().enumerate() {
                body.statements.insert(index, statement);
            }
        }
    }

    fn visit_jsx_children(&mut self, children: &mut oxc_allocator::Vec<'a, JSXChild<'a>>) {
        if let Some((sites, decls)) = self.frames.last_mut() {
            for child in children.iter_mut() {
                let JSXChild::Element(element) = child else {
                    continue;
                };
                if !sites.contains(&element.span) {
                    continue;
                }
                let span = element.span;
                let name = format!("{INERT_LOCAL}{}", self.counter);
                self.counter += 1;
                let ast = AstBuilder::new(self.allocator);
                let replacement = ast.jsx_child_expression_container(
                    span,
                    JSXExpression::from(ast.expression_identifier(span, ast.ident(&name))),
                );
                let JSXChild::Element(taken) = std::mem::replace(child, replacement) else {
                    unreachable!()
                };
                decls.push((name, Expression::JSXElement(taken)));
            }
        }
        walk_mut::walk_jsx_children(self, children);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    fn run(
        source: &str,
        summary: &AuthoritySummary,
    ) -> (HashMap<String, Result<(), String>>, String) {
        let allocator = Allocator::default();
        let mut program = Parser::new(&allocator, source, SourceType::tsx())
            .parse()
            .program;
        let (decisions, _) = mark_inert_regions(&allocator, &mut program, "@solidjs/web", summary);
        let out = oxc_codegen::Codegen::new().build(&program).code;
        let map = decisions
            .into_iter()
            .map(|d| {
                (
                    d.name,
                    if d.inert {
                        Ok(())
                    } else {
                        Err(d.reason.unwrap_or_default())
                    },
                )
            })
            .collect();
        (map, out)
    }

    fn rejected(v: &HashMap<String, Result<(), String>>, name: &str, needle: &str) {
        match v.get(name) {
            Some(Err(reason)) => assert!(
                reason.contains(needle),
                "{name}: `{reason}` lacks `{needle}`"
            ),
            other => panic!("{name}: expected rejection `{needle}`, got {other:?}"),
        }
    }

    #[test]
    fn proves_and_rewrites_static_regions() {
        let (v, out) = run(
            r#"import { createSignal } from "solid-js";
function Icon() { return <svg viewBox="0 0 8 8"><path d="M0 0" /></svg>; }
const Legal = () => (<footer class="legal"><Icon /><p>(c) 2026 {"ACME"}</p></footer>);
function Page() {
  const [n, setN] = createSignal(0);
  return <main><section><Legal /></section><button onClick={() => setN(n() + 1)}>{n()}</button></main>;
}"#,
            &AuthoritySummary::default(),
        );
        assert_eq!(v.get("Icon"), Some(&Ok(())));
        assert_eq!(v.get("Legal"), Some(&Ok(())));
        rejected(&v, "Page", "`return <jsx/>`");
        assert!(
            out.contains("import { inert as _$inert } from \"@solidjs/web\";"),
            "{out}"
        );
        assert!(
            out.contains("const _$inert0 = _$inert(() => <Legal />);"),
            "{out}"
        );
        assert!(out.contains("<section>{_$inert0}</section>"), "{out}");
        // Inside an inert component nothing is rewritten.
        assert!(out.contains("<Icon />"), "{out}");
    }

    #[test]
    fn refuses_anything_client_live() {
        let (v, _) = run(
            r#"import { createSignal, useContext, onCleanup, Show } from "solid-js";
import { isServer } from "@solidjs/web";
import { Remote } from "./remote";
const [sig] = createSignal(1);
function Read() { return <p>{sig()}</p>; }
function Event() { return <button onClick={() => {}}>x</button>; }
function Ref() { let el; return <div ref={el} />; }
function RefAttr() { return <div ref={() => {}} />; }
function Directive() { return <div use:tooltip="x" />; }
function Ctx() { const v = useContext(C); return <p>{v}</p>; }
function Cleanup() { onCleanup(() => {}); return <p />; }
function Boundary() { return <Show when={true}><p /></Show>; }
function ClientOnly() { return <p>{isServer ? "s" : "c"}</p>; }
function Children(props) { return <div>{props.children}</div>; }
function Spread() { const a = {}; return <div {...a} />; }
function Custom() { return <my-widget />; }
function Nested() { return <div><Event /></div>; }
function Imported() { return <div><Remote /></div>; }
function Dynamic() { return <div class={`x${1}`} title={String(1)} />; }"#,
            &AuthoritySummary::default(),
        );
        rejected(&v, "Read", "dynamic child");
        rejected(&v, "Event", "event handler");
        rejected(&v, "Ref", "`return <jsx/>`");
        rejected(&v, "RefAttr", "ref");
        rejected(&v, "Directive", "namespaced");
        rejected(&v, "Ctx", "`return <jsx/>`");
        rejected(&v, "Cleanup", "`return <jsx/>`");
        rejected(&v, "Boundary", "passes props/children to `<Show>`");
        rejected(&v, "ClientOnly", "dynamic child");
        rejected(&v, "Children", "reads props");
        rejected(&v, "Spread", "`return <jsx/>`");
        rejected(&v, "Custom", "custom element");
        rejected(&v, "Nested", "child `<Event>` is not inert");
        rejected(&v, "Imported", "no inert-component summary");
        rejected(&v, "Dynamic", "non-literal attribute");
    }

    #[test]
    fn keeps_hydration_for_unproven_use_sites() {
        let (_, out) = run(
            r#"import { Show } from "solid-js";
function Badge() { return <b>new</b>; }
function Page(props) {
  return <div>
    {props.flag ? <Badge /> : null}
    <Show when={props.flag}><Badge /></Show>
    <Badge title="x" />
  </div>;
}
function Root() { return <Badge />; }"#,
            &AuthoritySummary::default(),
        );
        assert!(!out.contains("_$inert"), "{out}");
    }

    #[test]
    fn follows_summarized_imports() {
        let summary = AuthoritySummary {
            entries: vec![("./ui".into(), "Logo".into(), AuthorityKind::InertComponent)],
        };
        let (_, out) = run(
            r#"import { Logo } from "./ui";
function Header() { return <header><Logo /><nav /></header>; }
function Page() { const x = 1; return <div><Header /></div>; }"#,
            &summary,
        );
        // Header is inert through the summarized import; Page's use site is rewritten.
        assert!(out.contains("_$inert(() => <Header />)"), "{out}");
    }
}
