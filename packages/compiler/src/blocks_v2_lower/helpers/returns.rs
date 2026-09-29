//! Helper return facts (section 12 of
//! `documentation/plans/blocks-v2-performance.md`).
//!
//! What a lowered helper returns, when the compiler can prove it from the
//! helper's body alone, so reads of the result lower like reads of a local
//! creation:
//!
//! | the helper returns (on every path) | shape | a caller's read |
//! | --- | --- | --- |
//! | `yield* $memo(…)`, a `$signal` / `$memo` / `createSignal` / `createMemo` accessor binding, another helper's accessor | accessor | `const d = h()`: `_$perform(d)` → `d()` / `_$readAccessor(d)` |
//! | a `$store` / `createStore` store binding | store | (the fusion's store rules) |
//! | a fresh object literal `{ d, inc }` | object: each property an accessor, store, function (an arrow or a setter) or other | `const { d } = h()`: as above; `const k = h()`: `_$readPath1(k, "d")` → `k.d()` / `_$readAccessor(k.d)` |
//! | a fresh array literal `[a, setA]` | tuple | `const [a] = h()`: as above |
//!
//! Soundness:
//! - every `return` at the helper's own depth returns the same shape, and the
//!   body's last statement is a `return` (no path falls off the end with
//!   `undefined`); property kinds that differ between returns are "other";
//! - an object or array is a literal, created by the `return` itself: nothing
//!   else holds it. Properties are plain data (no getter, setter, method,
//!   spread, computed key or `__proto__`), so reading `k.d` runs no code;
//! - a caller's binding is `const`; for property reads, every reference to
//!   it is a lowered path read's root or the object of a member access that
//!   is not written (`k.d = …`, `k.d++`, `delete k.d`, a destructuring or
//!   `for` target) and is called only when the property is an accessor or a
//!   function (a call passes `k` as `this`: an arrow ignores it, and so do
//!   accessors and setters). `k` itself never escapes, so no code the
//!   compiler cannot see can change `k.d`;
//! - the helper's binding is a function declaration no code reassigns, or an
//!   import (immutable).
//!
//! The facts travel with the lowering: local helpers by (lowered name,
//! declaration span), imported twins by (import source, twin name), from the
//! exporting module's helper summary (`returns`).
use std::collections::HashMap;

use oxc_ast::AstKind;
use oxc_ast::ast::{
    ArrayExpressionElement, BindingPattern, CallExpression, Expression, Function,
    ObjectPropertyKind, PropertyKey, PropertyKind, Statement, UnaryOperator,
    VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{AstNodes, Scoping, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use super::Analysis;
use crate::generators::Origin;

/// What a property or tuple element of a returned literal holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Member {
    Accessor,
    Store,
    /// Callable with any `this`: an arrow function or a setter.
    Function,
    Other,
}

/// What a lowered helper returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Shape {
    Accessor,
    Store,
    /// A fresh object literal: its properties, in source order.
    Object(Vec<(String, Member)>),
    /// A fresh array literal.
    Tuple(Vec<Member>),
}

impl Member {
    fn name(self) -> &'static str {
        match self {
            Member::Accessor => "accessor",
            Member::Store => "store",
            Member::Function => "function",
            Member::Other => "other",
        }
    }

    fn parse(text: &str) -> Member {
        match text {
            "accessor" => Member::Accessor,
            "store" => Member::Store,
            "function" => Member::Function,
            _ => Member::Other,
        }
    }

    /// The origin a binding of this member has.
    pub(crate) fn origin(self) -> Origin {
        match self {
            Member::Accessor => Origin::Accessor,
            Member::Store => Origin::Store,
            _ => Origin::Other,
        }
    }

    fn merge(self, other: Member) -> Member {
        if self == other { self } else { Member::Other }
    }
}

impl Shape {
    /// The member a binding of the whole value has.
    fn as_member(&self) -> Member {
        match self {
            Shape::Accessor => Member::Accessor,
            Shape::Store => Member::Store,
            _ => Member::Other,
        }
    }

    /// Two returns' shapes: the shape both have, if any.
    fn merge(&self, other: &Shape) -> Option<Shape> {
        match (self, other) {
            (Shape::Accessor, Shape::Accessor) => Some(Shape::Accessor),
            (Shape::Store, Shape::Store) => Some(Shape::Store),
            (Shape::Object(a), Shape::Object(b))
                if a.len() == b.len() && a.iter().all(|(k, _)| b.iter().any(|(j, _)| j == k)) =>
            {
                Some(Shape::Object(
                    a.iter()
                        .map(|(k, m)| {
                            let other = b.iter().find(|(j, _)| j == k).expect("same keys").1;
                            (k.clone(), m.merge(other))
                        })
                        .collect(),
                ))
            }
            (Shape::Tuple(a), Shape::Tuple(b)) if a.len() == b.len() => Some(Shape::Tuple(
                a.iter().zip(b).map(|(x, y)| x.merge(*y)).collect(),
            )),
            _ => None,
        }
    }

    /// The flattened form the native options carry: `accessor`, `store`,
    /// `object:d=accessor;inc=function`, `tuple:accessor;function` (the
    /// compiler's JS entry writes it from the summary JSON).
    #[cfg(test)]
    pub(crate) fn encode(&self) -> String {
        match self {
            Shape::Accessor => "accessor".into(),
            Shape::Store => "store".into(),
            Shape::Object(members) => format!(
                "object:{}",
                members
                    .iter()
                    .map(|(k, m)| format!("{k}={}", m.name()))
                    .collect::<Vec<_>>()
                    .join(";")
            ),
            Shape::Tuple(members) => format!(
                "tuple:{}",
                members
                    .iter()
                    .map(|m| m.name())
                    .collect::<Vec<_>>()
                    .join(";")
            ),
        }
    }

    /// Parse `encode`'s form (`None`: empty or unknown).
    pub(crate) fn decode(text: &str) -> Option<Shape> {
        match text {
            "accessor" => return Some(Shape::Accessor),
            "store" => return Some(Shape::Store),
            _ => {}
        }
        let split = |rest: &str| -> Vec<String> {
            if rest.is_empty() {
                Vec::new()
            } else {
                rest.split(';').map(str::to_string).collect()
            }
        };
        if let Some(rest) = text.strip_prefix("object:") {
            let mut members = Vec::new();
            for entry in split(rest) {
                let (key, member) = entry.split_once('=')?;
                if !is_identifier_name(key) || members.iter().any(|(k, _)| k == key) {
                    return None;
                }
                members.push((key.to_string(), Member::parse(member)));
            }
            return Some(Shape::Object(members));
        }
        if let Some(rest) = text.strip_prefix("tuple:") {
            return Some(Shape::Tuple(
                split(rest).iter().map(|m| Member::parse(m)).collect(),
            ));
        }
        None
    }

    /// The summary JSON value: `"accessor"`, `"store"`,
    /// `{"object":{"d":"accessor"}}`, `{"tuple":["accessor","function"]}`.
    pub(crate) fn json(&self) -> String {
        match self {
            Shape::Accessor => "\"accessor\"".into(),
            Shape::Store => "\"store\"".into(),
            Shape::Object(members) => format!(
                "{{\"object\":{{{}}}}}",
                members
                    .iter()
                    .map(|(k, m)| format!("\"{k}\":\"{}\"", m.name()))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Shape::Tuple(members) => format!(
                "{{\"tuple\":[{}]}}",
                members
                    .iter()
                    .map(|m| format!("\"{}\"", m.name()))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        }
    }
}

fn is_identifier_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c == '_' || c == '$' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c == '$' || c.is_ascii_alphanumeric())
}

/// The return facts of a module's lowered helpers, for the passes after the
/// helper lowering (`FusionContext::returns`).
#[derive(Default, Debug)]
pub(crate) struct HelperReturns {
    /// Lowered local helpers (in place or twins): (function name, span).
    pub(super) local: HashMap<(String, Span), Shape>,
    /// Imported twins: (import source as written, imported name).
    pub(super) imported: HashMap<(String, String), Shape>,
}

impl HelperReturns {
    /// The shape a call of `callee` returns: a lowered helper declaration no
    /// code reassigns, or an imported twin.
    pub(crate) fn shape_of(
        &self,
        scoping: &Scoping,
        nodes: &AstNodes<'_>,
        callee: SymbolId,
    ) -> Option<&Shape> {
        let declaration = scoping.symbol_declaration(callee);
        match nodes.get_node(declaration).kind() {
            AstKind::Function(function) if !function.generator && !function.r#async => {
                if scoping
                    .get_resolved_references(callee)
                    .any(|reference| reference.is_write())
                {
                    return None;
                }
                let name = function.id.as_ref()?.name.to_string();
                self.local.get(&(name, function.span))
            }
            AstKind::ImportSpecifier(specifier) => {
                let mut node = declaration;
                let source = loop {
                    let parent = nodes.parent_id(node);
                    if parent == node {
                        return None;
                    }
                    node = parent;
                    if let AstKind::ImportDeclaration(import) = nodes.get_node(node).kind() {
                        break import.source.value.to_string();
                    }
                };
                self.imported
                    .get(&(source, specifier.imported.name().to_string()))
            }
            _ => None,
        }
    }
}

/// Where a symbol sits in a `const` declarator's pattern.
pub(crate) enum Position {
    Whole,
    Index(usize),
    Key(String),
}

/// The position of `symbol` in `pattern` (one level deep, no defaults).
pub(crate) fn position(pattern: &BindingPattern<'_>, symbol: SymbolId) -> Option<Position> {
    let is = |p: &BindingPattern<'_>| matches!(p, BindingPattern::BindingIdentifier(id) if id.symbol_id.get() == Some(symbol));
    match pattern {
        p if is(p) => Some(Position::Whole),
        BindingPattern::ArrayPattern(array) => array
            .elements
            .iter()
            .position(|e| e.as_ref().is_some_and(is))
            .map(Position::Index),
        BindingPattern::ObjectPattern(object) => object.properties.iter().find_map(|property| {
            if property.computed || !is(&property.value) {
                return None;
            }
            static_key(&property.key).map(Position::Key)
        }),
        _ => None,
    }
}

fn static_key(key: &PropertyKey<'_>) -> Option<String> {
    let name = match key {
        PropertyKey::StaticIdentifier(id) => id.name.to_string(),
        PropertyKey::StringLiteral(s) => s.value.to_string(),
        _ => return None,
    };
    (is_identifier_name(&name) && name != "__proto__").then_some(name)
}

impl Shape {
    /// The member a binding at `position` of this value holds.
    pub(crate) fn at(&self, position: &Position) -> Member {
        match (self, position) {
            (shape, Position::Whole) => shape.as_member(),
            (Shape::Tuple(members), Position::Index(i)) => {
                members.get(*i).copied().unwrap_or(Member::Other)
            }
            (Shape::Object(members), Position::Key(key)) => members
                .iter()
                .find(|(k, _)| k == key)
                .map_or(Member::Other, |(_, m)| *m),
            _ => Member::Other,
        }
    }
}

/// The `const` declarator binding `symbol`, and its pattern position.
pub(crate) fn const_declarator<'s, 'a>(
    scoping: &Scoping,
    nodes: &'s AstNodes<'a>,
    symbol: SymbolId,
) -> Option<(&'s oxc_ast::ast::VariableDeclarator<'a>, Position)> {
    let mut node = scoping.symbol_declaration(symbol);
    let declarator = loop {
        match nodes.get_node(node).kind() {
            AstKind::VariableDeclarator(declarator) => break declarator,
            AstKind::BindingIdentifier(_)
            | AstKind::ArrayPattern(_)
            | AstKind::ObjectPattern(_)
            | AstKind::BindingProperty(_) => {
                let parent = nodes.parent_id(node);
                if parent == node {
                    return None;
                }
                node = parent;
            }
            _ => return None,
        }
    };
    let parent = nodes.parent_id(node);
    if parent == node
        || !matches!(nodes.get_node(parent).kind(),
            AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const)
    {
        return None;
    }
    let position = position(&declarator.id, symbol)?;
    Some((declarator, position))
}

/// Is every reference to the object bound to `symbol` a read the fusion can
/// see (see the module doc)? `readers`: the lowered path readers' symbols.
pub(crate) fn object_stays_local(
    scoping: &Scoping,
    nodes: &AstNodes<'_>,
    symbol: SymbolId,
    members: &[(String, Member)],
    readers: &[SymbolId],
) -> bool {
    let callable = |key: Option<&str>| {
        key.and_then(|key| members.iter().find(|(k, _)| k == key))
            .is_some_and(|(_, m)| matches!(m, Member::Accessor | Member::Function))
    };
    scoping.get_resolved_references(symbol).all(|reference| {
        if reference.is_write() {
            return false;
        }
        let node = reference.node_id();
        let span = nodes.get_node(node).kind().span();
        let parent = nodes.parent_id(node);
        let (member_span, key) = match nodes.get_node(parent).kind() {
            AstKind::StaticMemberExpression(m) if m.object.span() == span => {
                (m.span, Some(m.property.name.as_str()))
            }
            AstKind::ComputedMemberExpression(m) if m.object.span() == span => (m.span, None),
            AstKind::CallExpression(call) => {
                return call.callee.span() != span
                    && call.arguments.first().is_some_and(|a| a.span() == span)
                    && super::super::callee_symbol(scoping, call)
                        .is_some_and(|callee| readers.contains(&callee));
            }
            _ => return false,
        };
        let outer = nodes.parent_id(parent);
        match nodes.get_node(outer).kind() {
            AstKind::AssignmentExpression(it) => it.left.span() != member_span,
            AstKind::UpdateExpression(_)
            | AstKind::ArrayAssignmentTarget(_)
            | AstKind::ObjectAssignmentTarget(_)
            | AstKind::AssignmentTargetWithDefault(_)
            | AstKind::AssignmentTargetPropertyProperty(_)
            | AstKind::AssignmentTargetRest(_)
            | AstKind::ParenthesizedExpression(_) => false,
            AstKind::UnaryExpression(it) => it.operator != UnaryOperator::Delete,
            AstKind::ForInStatement(it) => it.left.span() != member_span,
            AstKind::ForOfStatement(it) => it.left.span() != member_span,
            AstKind::CallExpression(call) if call.callee.span() == member_span => callable(key),
            AstKind::TaggedTemplateExpression(it) if it.tag.span() == member_span => callable(key),
            _ => true,
        }
    })
}

// --- analysis (in the helper lowering, on the generator form) -------------------------

/// The return shapes of the candidates (`None`: unknown), to a fixpoint:
/// a helper returning another's result depends on the callee's shape.
pub(super) fn return_shapes(
    analysis: &Analysis<'_>,
    functions: &[&Function<'_>],
    lowerable: &[bool],
) -> Vec<Option<Shape>> {
    let n = functions.len();
    let mut shapes: Vec<Option<Shape>> = vec![None; n];
    for _ in 0..=n {
        let mut changed = false;
        for i in 0..n {
            if !lowerable[i] {
                continue;
            }
            let shape = Shapes {
                analysis,
                shapes: &shapes,
            }
            .function(functions[i]);
            if shape != shapes[i] {
                shapes[i] = shape;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    shapes
}

struct Shapes<'x, 's> {
    analysis: &'x Analysis<'s>,
    shapes: &'x [Option<Shape>],
}

impl Shapes<'_, '_> {
    fn function(&self, function: &Function<'_>) -> Option<Shape> {
        let body = function.body.as_ref()?;
        if !matches!(body.statements.last(), Some(Statement::ReturnStatement(_))) {
            return None;
        }
        let mut returns = Returns {
            arguments: Vec::new(),
            ok: true,
        };
        returns.visit_function_body(body);
        if !returns.ok {
            return None;
        }
        let mut shape: Option<Shape> = None;
        for span in returns.arguments {
            let argument = self.expression_at(body, span)?;
            let next = self.expression(argument)?;
            shape = Some(match shape {
                None => next,
                Some(prev) => prev.merge(&next)?,
            });
        }
        shape
    }

    /// The return argument with `span` (found again by span: the visitor
    /// cannot hand out references with the body's lifetime).
    fn expression_at<'b, 'a>(
        &self,
        body: &'b oxc_ast::ast::FunctionBody<'a>,
        span: Span,
    ) -> Option<&'b Expression<'a>> {
        struct Find<'b, 'a> {
            span: Span,
            found: Option<&'b Expression<'a>>,
        }
        impl<'b, 'a> Find<'b, 'a> {
            fn statements(&mut self, statements: &'b [Statement<'a>]) {
                for statement in statements {
                    self.statement(statement);
                }
            }
            fn statement(&mut self, statement: &'b Statement<'a>) {
                if self.found.is_some() {
                    return;
                }
                match statement {
                    Statement::ReturnStatement(it) => {
                        if let Some(argument) = it.argument.as_ref()
                            && argument.span() == self.span
                        {
                            self.found = Some(argument);
                        }
                    }
                    Statement::BlockStatement(it) => self.statements(&it.body),
                    Statement::IfStatement(it) => {
                        self.statement(&it.consequent);
                        if let Some(alternate) = it.alternate.as_ref() {
                            self.statement(alternate);
                        }
                    }
                    Statement::TryStatement(it) => {
                        self.statements(&it.block.body);
                        if let Some(handler) = it.handler.as_ref() {
                            self.statements(&handler.body.body);
                        }
                        if let Some(finalizer) = it.finalizer.as_ref() {
                            self.statements(&finalizer.body);
                        }
                    }
                    Statement::ForStatement(it) => self.statement(&it.body),
                    Statement::ForInStatement(it) => self.statement(&it.body),
                    Statement::ForOfStatement(it) => self.statement(&it.body),
                    Statement::WhileStatement(it) => self.statement(&it.body),
                    Statement::DoWhileStatement(it) => self.statement(&it.body),
                    Statement::LabeledStatement(it) => self.statement(&it.body),
                    Statement::SwitchStatement(it) => {
                        for case in &it.cases {
                            self.statements(&case.consequent);
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut find = Find { span, found: None };
        find.statements(&body.statements);
        find.found
    }

    /// The shape of a returned expression.
    fn expression(&self, expression: &Expression<'_>) -> Option<Shape> {
        match expression {
            Expression::ParenthesizedExpression(it) => self.expression(&it.expression),
            Expression::YieldExpression(_) => match self.yielded(expression)? {
                YieldShape::Shape(shape) => Some(shape),
                YieldShape::Pair(first, second) => Some(Shape::Tuple(vec![first, second])),
            },
            Expression::Identifier(reference) => {
                let symbol = super::reference_symbol(self.analysis.scoping, reference)?;
                match self.binding(symbol) {
                    Member::Accessor => Some(Shape::Accessor),
                    Member::Store => Some(Shape::Store),
                    _ => None,
                }
            }
            Expression::CallExpression(call) => match self.runtime_factory(call)? {
                Member::Accessor => Some(Shape::Accessor),
                _ => None,
            },
            Expression::ObjectExpression(object) => {
                let mut members: Vec<(String, Member)> = Vec::new();
                for property in &object.properties {
                    let ObjectPropertyKind::ObjectProperty(property) = property else {
                        return None;
                    };
                    if property.kind != PropertyKind::Init || property.method || property.computed {
                        return None;
                    }
                    let key = static_key(&property.key)?;
                    if members.iter().any(|(k, _)| *k == key) {
                        return None;
                    }
                    members.push((key, self.member(&property.value)));
                }
                Some(Shape::Object(members))
            }
            Expression::ArrayExpression(array) => {
                let mut members = Vec::new();
                for element in &array.elements {
                    match element {
                        ArrayExpressionElement::SpreadElement(_)
                        | ArrayExpressionElement::Elision(_) => return None,
                        element => members.push(self.member(element.to_expression())),
                    }
                }
                Some(Shape::Tuple(members))
            }
            _ => None,
        }
    }

    /// A property value or tuple element.
    fn member(&self, expression: &Expression<'_>) -> Member {
        match expression {
            Expression::ParenthesizedExpression(it) => self.member(&it.expression),
            Expression::ArrowFunctionExpression(_) => Member::Function,
            Expression::Identifier(reference) => {
                super::reference_symbol(self.analysis.scoping, reference)
                    .map_or(Member::Other, |symbol| self.binding(symbol))
            }
            Expression::YieldExpression(_) => match self.yielded(expression) {
                Some(YieldShape::Shape(shape)) => shape.as_member(),
                _ => Member::Other,
            },
            Expression::CallExpression(call) => self.runtime_factory(call).unwrap_or(Member::Other),
            _ => Member::Other,
        }
    }

    /// `createMemo(…)` from a runtime module: an accessor.
    fn runtime_factory(&self, call: &CallExpression<'_>) -> Option<Member> {
        match self.analysis.names.of(self.analysis.scoping, call)? {
            ("createMemo", _) => Some(Member::Accessor),
            _ => None,
        }
    }

    /// What `yield* X` evaluates to, as a shape.
    fn yielded(&self, expression: &Expression<'_>) -> Option<YieldShape> {
        let Expression::YieldExpression(it) = expression else {
            return None;
        };
        let (true, Some(Expression::CallExpression(call))) = (it.delegate, it.argument.as_ref())
        else {
            return None;
        };
        let analysis = self.analysis;
        match analysis.names.of(analysis.scoping, call) {
            Some(("$memo", _)) => Some(YieldShape::Shape(Shape::Accessor)),
            Some(("$signal", _)) => Some(YieldShape::Pair(Member::Accessor, Member::Function)),
            Some(("$store", _)) => Some(YieldShape::Pair(Member::Store, Member::Function)),
            Some(_) => None,
            None => {
                let callee = super::callee_symbol(analysis.scoping, call)?;
                if let Some(&index) = analysis.candidates.get(&callee) {
                    return self.shapes[index].clone().map(YieldShape::Shape);
                }
                let (fact, _) = analysis.imported.get(&callee)?;
                fact.returns.clone().map(YieldShape::Shape)
            }
        }
    }

    /// What a binding in the helper holds: a `const` bound by a creation, a
    /// helper result or an arrow, or a binding the fusion proves.
    fn binding(&self, symbol: SymbolId) -> Member {
        let analysis = self.analysis;
        let fallback = || match analysis.context.binding_origin(symbol) {
            Origin::Accessor => Member::Accessor,
            Origin::Store => Member::Store,
            Origin::Other => Member::Other,
        };
        let Some((declarator, position)) =
            const_declarator(analysis.scoping, analysis.nodes, symbol)
        else {
            return fallback();
        };
        let Some(init) = declarator.init.as_ref() else {
            return Member::Other;
        };
        match (init, &position) {
            (Expression::ArrowFunctionExpression(_), Position::Whole) => Member::Function,
            (Expression::YieldExpression(_), _) => match self.yielded(init) {
                Some(YieldShape::Shape(shape)) => shape.at(&position),
                Some(YieldShape::Pair(first, second)) => match position {
                    Position::Index(0) => first,
                    Position::Index(1) => second,
                    _ => Member::Other,
                },
                None => Member::Other,
            },
            _ => fallback(),
        }
    }
}

enum YieldShape {
    Shape(Shape),
    /// A `$signal` / `$store` tuple (element 0, element 1).
    Pair(Member, Member),
}

/// The arguments of the `return`s at a function's own depth (`ok`: every
/// one has an argument).
struct Returns {
    arguments: Vec<Span>,
    ok: bool,
}

impl<'b> Visit<'b> for Returns {
    fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &oxc_ast::ast::ArrowFunctionExpression<'b>) {}
    fn visit_class(&mut self, _: &oxc_ast::ast::Class<'b>) {}

    fn visit_return_statement(&mut self, it: &oxc_ast::ast::ReturnStatement<'b>) {
        match it.argument.as_ref() {
            Some(argument) => self.arguments.push(argument.span()),
            None => self.ok = false,
        }
        walk::walk_return_statement(self, it);
    }
}
