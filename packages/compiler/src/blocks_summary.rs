//! Analysis-only: the per-module summary the blocks type linker reads
//! (`@solidjs/blocks-linker`, documentation/plans/blocks-library.md,
//! "The type linker"). It never rewrites code.
//!
//! One module in, one JSON document out, versioned
//! (`{"schema":"solid-blocks-summary","version":1,…}`):
//!
//! - `imports` / `exports` / `reexports` — the module's edges and names;
//! - `statics` — module-level `const`s bound to literals;
//! - `classes` — module-level classes (a raised error type the linker can
//!   name when exported);
//! - `components` — every `$component` bound at module level: its local
//!   name, its linker key (`TypedProps<P, "Key">`), its props parameter,
//!   and the facts of its setup's bindings;
//! - `renders` — every render site of a capitalized component: tag form
//!   (`<X a={…} />`), call form (`X({ a: … })`), the component it sits in,
//!   whether a `Loading` / `Errored` encloses it there, and a *value fact*
//!   for each prop;
//! - `escapes` — component names used as values (passed to `<Dynamic>`,
//!   stored, handed to a function): their callers are unknown.
//!
//! Value facts are "may" facts, joined by the linker over every known
//! render site: `static` (a literal or a module constant), `value` (read by
//! the caller, `yield*` — settled for the callee), `live` (a signal, a store
//! path, a row item), `memo` (may be pending when its body calls `attempt`;
//! may fail with what it `raise`s or declares to `attempt`; plus what it
//! reads), `prop` (the caller's own prop, passed through: its callers'
//! facts), and `unknown` (anything the syntax does not show: the declared
//! type, widest). The same facts serve the types (may be pending → needs a
//! `Loading`) and a future compiler (may not be live → static / inert).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_syntax::scope::ScopeFlags;

use crate::error::CompileError;

pub const SUMMARY_SCHEMA: &str = "solid-blocks-summary";
pub const SUMMARY_VERSION: u32 = 1;

#[derive(Clone, Debug)]
enum Fact {
    Static,
    Value,
    Live,
    Memo {
        pending: bool,
        fails: Vec<String>,
        reads: Vec<Fact>,
    },
    Prop(String),
    Unknown,
}

struct Component {
    local: String,
    key: Option<String>,
    props_param: Option<String>,
    bindings: HashMap<String, Fact>,
    binding_order: Vec<String>,
    start: u32,
    end: u32,
}

struct Render {
    component: String,
    form: &'static str,
    owner: Option<String>,
    in_loading: bool,
    in_errored: bool,
    props: Vec<(String, Fact)>,
    spread: bool,
    start: u32,
    end: u32,
}

#[derive(Default)]
struct Summary {
    imports: Vec<(String, String, String)>,
    exports: Vec<(String, String)>,
    reexports: Vec<(String, String, String)>,
    statics: HashSet<String>,
    classes: Vec<String>,
    components: Vec<Component>,
    renders: Vec<Render>,
    escapes: Vec<(String, u32)>,
}

// --- small helpers -------------------------------------------------------------------------

fn callee_name<'b>(call: &'b CallExpression<'_>) -> Option<&'b str> {
    match &call.callee {
        Expression::Identifier(id) => Some(id.name.as_str()),
        Expression::StaticMemberExpression(m) => Some(m.property.name.as_str()),
        _ => None,
    }
}

fn is_capitalized(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

fn is_literal(expr: &Expression<'_>) -> bool {
    match expr {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_) => true,
        Expression::TemplateLiteral(t) => t.expressions.is_empty(),
        Expression::UnaryExpression(u) => is_literal(&u.argument),
        Expression::TSAsExpression(e) => is_literal(&e.expression),
        Expression::TSSatisfiesExpression(e) => is_literal(&e.expression),
        Expression::ArrayExpression(a) => a
            .elements
            .iter()
            .all(|e| e.as_expression().is_some_and(is_literal)),
        Expression::ObjectExpression(o) => o.properties.iter().all(|p| match p {
            ObjectPropertyKind::ObjectProperty(p) => !p.computed && is_literal(&p.value),
            ObjectPropertyKind::SpreadProperty(_) => false,
        }),
        _ => false,
    }
}

/// The root identifier of `a.b.c` (and of `a`), with the first key after it.
fn member_root<'b>(expr: &'b Expression<'_>) -> Option<(&'b str, Option<String>)> {
    let mut e = expr;
    let mut first: Option<String> = None;
    loop {
        match e {
            Expression::Identifier(id) => return Some((id.name.as_str(), first)),
            Expression::StaticMemberExpression(m) => {
                first = Some(m.property.name.to_string());
                e = &m.object;
            }
            Expression::ComputedMemberExpression(m) => {
                first = match &m.expression {
                    Expression::StringLiteral(s) => Some(s.value.to_string()),
                    _ => None,
                };
                e = &m.object;
            }
            Expression::ChainExpression(_) => return None,
            _ => return None,
        }
    }
}

/// `TypedProps<P, "Key">` on a parameter: the key.
fn typed_props_key(param: &FormalParameter<'_>) -> Option<String> {
    let annotation = param.type_annotation.as_ref()?;
    let TSType::TSTypeReference(reference) = &annotation.type_annotation else {
        return None;
    };
    let TSTypeName::IdentifierReference(name) = &reference.type_name else {
        return None;
    };
    if name.name.as_str() != "TypedProps" {
        return None;
    }
    let args = reference.type_arguments.as_ref()?;
    match args.params.get(1)? {
        TSType::TSLiteralType(lit) => match &lit.literal {
            TSLiteral::StringLiteral(s) => Some(s.value.to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn binding_name(pattern: &BindingPattern<'_>) -> Option<String> {
    match pattern {
        BindingPattern::BindingIdentifier(id) => Some(id.name.to_string()),
        _ => None,
    }
}

fn delegated_call<'b, 'a>(expr: &'b Expression<'a>) -> Option<&'b CallExpression<'a>> {
    let Expression::YieldExpression(y) = expr else {
        return None;
    };
    if !y.delegate {
        return None;
    }
    match y.argument.as_ref()? {
        Expression::CallExpression(call) => Some(call),
        _ => None,
    }
}

// --- memo bodies ----------------------------------------------------------------------------

/// What a `$memo` (or `$` block) body does: whether it may suspend, what it
/// raises, and what it reads.
struct BodyFacts<'s> {
    scope: &'s dyn Fn(&str, Option<String>) -> Fact,
    pending: bool,
    fails: Vec<String>,
    reads: Vec<Fact>,
    depth: u32,
}

impl<'a> Visit<'a> for BodyFacts<'_> {
    fn visit_function(&mut self, it: &Function<'a>, flags: ScopeFlags) {
        // A nested generator is its own block; a nested plain function is a
        // callback (its yields are not the memo's).
        self.depth += 1;
        walk::walk_function(self, it, flags);
        self.depth -= 1;
    }
    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        self.depth += 1;
        walk::walk_arrow_function_expression(self, it);
        self.depth -= 1;
    }
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        match callee_name(it) {
            Some("attempt") => {
                // An attempt may suspend (it may return a promise) and fails
                // with the classes it declares.
                self.pending = true;
                for arg in it.arguments.iter().skip(1) {
                    if let Some(Expression::Identifier(id)) = arg.as_expression() {
                        push(&mut self.fails, id.name.to_string());
                    } else {
                        push(&mut self.fails, "*".into());
                    }
                }
            }
            Some("raise") => {
                let class = match it.arguments.first().and_then(|a| a.as_expression()) {
                    Some(Expression::NewExpression(n)) => match &n.callee {
                        Expression::Identifier(id) => id.name.to_string(),
                        _ => "*".into(),
                    },
                    _ => "*".into(),
                };
                push(&mut self.fails, class);
            }
            _ => {}
        }
        walk::walk_call_expression(self, it);
    }
    fn visit_return_statement(&mut self, it: &ReturnStatement<'a>) {
        // A memo that returns what a plain function call gives it may return
        // a promise or an async iterable (`return runEffect(…)`): it may be
        // pending and fail with anything. (A method call — `list.filter(…)`
        // — is taken as synchronous.)
        if self.depth == 0
            && let Some(Expression::CallExpression(call)) = &it.argument
            && matches!(call.callee, Expression::Identifier(_))
            && !matches!(callee_name(call), Some("attempt" | "raise"))
        {
            self.pending = true;
            push(&mut self.fails, "*".into());
        }
        walk::walk_return_statement(self, it);
    }
    fn visit_yield_expression(&mut self, it: &YieldExpression<'a>) {
        if it.delegate
            && self.depth == 0
            && let Some(arg) = &it.argument
            && !matches!(arg, Expression::CallExpression(c) if matches!(callee_name(c), Some("attempt" | "raise")))
        {
            let fact = match member_root(arg) {
                Some((root, first)) => (self.scope)(root, first),
                None => Fact::Unknown,
            };
            self.reads.push(fact);
        }
        walk::walk_yield_expression(self, it);
    }
}

fn push(v: &mut Vec<String>, s: String) {
    if !v.contains(&s) {
        v.push(s);
    }
}

// --- the module walk -------------------------------------------------------------------------

struct Walker<'s> {
    summary: &'s mut Summary,
    component_names: HashSet<String>,
    /// Stack of the component each nested scope belongs to.
    owner: Vec<usize>,
    /// Row-block / render-callback parameters in scope (row items: live).
    row_items: Vec<Vec<String>>,
    loading: u32,
    errored: u32,
}

impl Walker<'_> {
    fn current(&self) -> Option<usize> {
        self.owner.last().copied()
    }

    fn resolve(&self, root: &str, first: Option<String>) -> Fact {
        if self
            .row_items
            .iter()
            .any(|scope| scope.iter().any(|n| n == root))
        {
            return Fact::Live;
        }
        if let Some(i) = self.current() {
            let c = &self.summary.components[i];
            if c.props_param.as_deref() == Some(root) {
                return first.map_or(Fact::Unknown, Fact::Prop);
            }
            if let Some(f) = c.bindings.get(root) {
                return f.clone();
            }
        }
        if self.summary.statics.contains(root) {
            return Fact::Static;
        }
        Fact::Unknown
    }

    fn value_fact(&self, expr: &Expression<'_>) -> Fact {
        if is_literal(expr) {
            return Fact::Static;
        }
        match expr {
            Expression::YieldExpression(y) if y.delegate => Fact::Value,
            Expression::ParenthesizedExpression(p) => self.value_fact(&p.expression),
            Expression::TSAsExpression(e) => self.value_fact(&e.expression),
            Expression::TSNonNullExpression(e) => self.value_fact(&e.expression),
            _ => match member_root(expr) {
                Some((root, first)) => self.resolve(root, first),
                None => Fact::Unknown,
            },
        }
    }

    fn record_setup_binding(&mut self, decl: &VariableDeclarator<'_>) {
        let Some(i) = self.current() else { return };
        let Some(init) = &decl.init else { return };
        // `yield* $signal(…)` / `$store` / `$memo`, or a hole block `$(function* …)`
        let call = match init {
            Expression::CallExpression(call) if callee_name(call) == Some("$") => call,
            _ => match delegated_call(init) {
                Some(call) => call,
                None => return,
            },
        };
        let names: Vec<(usize, String)> = match &decl.id {
            BindingPattern::BindingIdentifier(id) => vec![(0, id.name.to_string())],
            BindingPattern::ArrayPattern(a) => a
                .elements
                .iter()
                .enumerate()
                .filter_map(|(n, e)| e.as_ref().and_then(binding_name).map(|s| (n, s)))
                .collect(),
            _ => Vec::new(),
        };
        let fact = match callee_name(call) {
            Some("$signal" | "$store") => Fact::Live,
            Some("$memo" | "$") => {
                let body = call.arguments.first().and_then(|a| a.as_expression());
                match body {
                    Some(Expression::FunctionExpression(f)) => {
                        let resolve = |root: &str, first: Option<String>| self.resolve(root, first);
                        let mut facts = BodyFacts {
                            scope: &resolve,
                            pending: false,
                            fails: Vec::new(),
                            reads: Vec::new(),
                            depth: 0,
                        };
                        if let Some(body) = &f.body {
                            for statement in &body.statements {
                                facts.visit_statement(statement);
                            }
                        }
                        Fact::Memo {
                            pending: facts.pending,
                            fails: facts.fails,
                            reads: facts.reads,
                        }
                    }
                    _ => Fact::Unknown,
                }
            }
            _ => return,
        };
        let component = &mut self.summary.components[i];
        for (n, name) in names {
            // `[get, set]`: only the getter is a source.
            if n == 0 {
                component.binding_order.push(name.clone());
                component.bindings.insert(name, fact.clone());
            }
        }
    }

    fn render_props(&self, attributes: &[JSXAttributeItem<'_>]) -> (Vec<(String, Fact)>, bool) {
        let mut props = Vec::new();
        let mut spread = false;
        for item in attributes {
            match item {
                JSXAttributeItem::SpreadAttribute(_) => spread = true,
                JSXAttributeItem::Attribute(attr) => {
                    let name = match &attr.name {
                        JSXAttributeName::Identifier(id) => id.name.to_string(),
                        JSXAttributeName::NamespacedName(ns) => {
                            format!("{}:{}", ns.namespace.name, ns.name.name)
                        }
                    };
                    let fact = match &attr.value {
                        None | Some(JSXAttributeValue::StringLiteral(_)) => Fact::Static,
                        Some(JSXAttributeValue::ExpressionContainer(c)) => {
                            match c.expression.as_expression() {
                                Some(e) => self.value_fact(e),
                                None => Fact::Static,
                            }
                        }
                        Some(_) => Fact::Unknown,
                    };
                    props.push((name, fact));
                }
            }
        }
        (props, spread)
    }
}

impl<'a> Visit<'a> for Walker<'_> {
    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        self.record_setup_binding(it);
        walk::walk_variable_declarator(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        let name = callee_name(it);
        // entering a component's setup
        if name == Some("$component") {
            let index = self
                .summary
                .components
                .iter()
                .position(|c| c.start == it.span.start && c.end == it.span.end);
            if let Some(i) = index {
                self.owner.push(i);
                for arg in &it.arguments {
                    self.visit_argument(arg);
                }
                self.owner.pop();
                return;
            }
        }
        let boundary = matches!(name, Some("Loading" | "Errored"));
        if let Expression::Identifier(id) = &it.callee
            && is_capitalized(id.name.as_str())
            && !boundary
        {
            // call form: `X({ … })`
            let (props, spread) = match it.arguments.first().and_then(|a| a.as_expression()) {
                None => (Vec::new(), false),
                Some(Expression::ObjectExpression(o)) => {
                    let mut props = Vec::new();
                    let mut spread = false;
                    for p in &o.properties {
                        match p {
                            ObjectPropertyKind::SpreadProperty(_) => spread = true,
                            ObjectPropertyKind::ObjectProperty(p) => {
                                let key = match &p.key {
                                    PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                                    PropertyKey::StringLiteral(s) => s.value.to_string(),
                                    _ => {
                                        spread = true;
                                        continue;
                                    }
                                };
                                let fact = if p.kind == PropertyKind::Init {
                                    self.value_fact(&p.value)
                                } else {
                                    Fact::Unknown
                                };
                                props.push((key, fact));
                            }
                        }
                    }
                    (props, spread)
                }
                Some(_) => (Vec::new(), true),
            };
            self.summary.renders.push(Render {
                component: id.name.to_string(),
                form: "call",
                owner: self
                    .current()
                    .map(|i| self.summary.components[i].local.clone()),
                in_loading: self.loading > 0,
                in_errored: self.errored > 0,
                props,
                spread,
                start: it.span.start,
                end: it.span.end,
            });
            for arg in &it.arguments {
                self.visit_argument(arg);
            }
            return;
        }
        if boundary {
            let loading = name == Some("Loading");
            if loading {
                self.loading += 1;
            } else {
                self.errored += 1;
            }
            walk::walk_call_expression(self, it);
            if loading {
                self.loading -= 1;
            } else {
                self.errored -= 1;
            }
            return;
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        let opening = &it.opening_element;
        let tag = match &opening.name {
            JSXElementName::IdentifierReference(id) => Some(id.name.to_string()),
            JSXElementName::Identifier(id) if is_capitalized(id.name.as_str()) => {
                Some(id.name.to_string())
            }
            _ => None,
        };
        let boundary = matches!(tag.as_deref(), Some("Loading" | "Errored"));
        let flow = matches!(
            tag.as_deref(),
            Some("For" | "Show" | "Match" | "Repeat" | "Index")
        );
        if let Some(tag) = &tag
            && !boundary
            && !flow
        {
            let (props, spread) = self.render_props(&opening.attributes);
            self.summary.renders.push(Render {
                component: tag.clone(),
                form: "tag",
                owner: self
                    .current()
                    .map(|i| self.summary.components[i].local.clone()),
                in_loading: self.loading > 0,
                in_errored: self.errored > 0,
                props,
                spread,
                start: it.span.start,
                end: it.span.end,
            });
        }
        // attributes (values may hold JSX / renders); the tag name is not a use
        for item in &opening.attributes {
            self.visit_jsx_attribute_item(item);
        }
        let (l, e) = (
            tag.as_deref() == Some("Loading"),
            tag.as_deref() == Some("Errored"),
        );
        if l {
            self.loading += 1;
        }
        if e {
            self.errored += 1;
        }
        for child in &it.children {
            // a render callback of a flow control: its parameters are row items
            if flow
                && let JSXChild::ExpressionContainer(c) = child
                && let Some(expr) = c.expression.as_expression()
            {
                let params: Vec<String> = match expr {
                    Expression::ArrowFunctionExpression(f) => f
                        .params
                        .items
                        .iter()
                        .filter_map(|p| binding_name(&p.pattern))
                        .collect(),
                    Expression::FunctionExpression(f) => f
                        .params
                        .items
                        .iter()
                        .filter_map(|p| binding_name(&p.pattern))
                        .collect(),
                    _ => Vec::new(),
                };
                self.row_items.push(params);
                self.visit_jsx_child(child);
                self.row_items.pop();
                continue;
            }
            self.visit_jsx_child(child);
        }
        if l {
            self.loading -= 1;
        }
        if e {
            self.errored -= 1;
        }
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        let name = it.name.as_str();
        if self.component_names.contains(name) {
            self.summary.escapes.push((name.to_string(), it.span.start));
        }
    }
}

// --- JSON ------------------------------------------------------------------------------------

fn json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_fact(out: &mut String, fact: &Fact) {
    match fact {
        Fact::Static => out.push_str("{\"k\":\"static\"}"),
        Fact::Value => out.push_str("{\"k\":\"value\"}"),
        Fact::Live => out.push_str("{\"k\":\"live\"}"),
        Fact::Unknown => out.push_str("{\"k\":\"unknown\"}"),
        Fact::Prop(name) => {
            out.push_str("{\"k\":\"prop\",\"name\":");
            json_string(out, name);
            out.push('}');
        }
        Fact::Memo {
            pending,
            fails,
            reads,
        } => {
            let _ = write!(out, "{{\"k\":\"memo\",\"pending\":{pending},\"fails\":[");
            for (i, f) in fails.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_string(out, f);
            }
            out.push_str("],\"reads\":[");
            for (i, r) in reads.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                json_fact(out, r);
            }
            out.push_str("]}");
        }
    }
}

fn json_pairs(out: &mut String, key: &str, items: &[(String, String)], a: &str, b: &str) {
    json_string(out, key);
    out.push_str(":[");
    for (i, (x, y)) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('{');
        json_string(out, a);
        out.push(':');
        json_string(out, x);
        out.push(',');
        json_string(out, b);
        out.push(':');
        json_string(out, y);
        out.push('}');
    }
    out.push(']');
}

fn to_json(s: &Summary) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        "{{\"schema\":\"{SUMMARY_SCHEMA}\",\"version\":{SUMMARY_VERSION},\"imports\":["
    );
    for (i, (local, source, imported)) in s.imports.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"local\":");
        json_string(&mut out, local);
        out.push_str(",\"source\":");
        json_string(&mut out, source);
        out.push_str(",\"imported\":");
        json_string(&mut out, imported);
        out.push('}');
    }
    out.push_str("],");
    json_pairs(&mut out, "exports", &s.exports, "exported", "local");
    out.push_str(",\"reexports\":[");
    for (i, (exported, source, imported)) in s.reexports.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"exported\":");
        json_string(&mut out, exported);
        out.push_str(",\"source\":");
        json_string(&mut out, source);
        out.push_str(",\"imported\":");
        json_string(&mut out, imported);
        out.push('}');
    }
    out.push_str("],\"statics\":[");
    let mut statics: Vec<&String> = s.statics.iter().collect();
    statics.sort();
    for (i, n) in statics.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_string(&mut out, n);
    }
    out.push_str("],\"classes\":[");
    for (i, n) in s.classes.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_string(&mut out, n);
    }
    out.push_str("],\"components\":[");
    for (i, c) in s.components.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"local\":");
        json_string(&mut out, &c.local);
        out.push_str(",\"key\":");
        match &c.key {
            Some(k) => json_string(&mut out, k),
            None => out.push_str("null"),
        }
        out.push_str(",\"propsParam\":");
        match &c.props_param {
            Some(k) => json_string(&mut out, k),
            None => out.push_str("null"),
        }
        out.push_str(",\"bindings\":{");
        for (j, name) in c.binding_order.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            json_string(&mut out, name);
            out.push(':');
            json_fact(&mut out, &c.bindings[name]);
        }
        let _ = write!(out, "}},\"span\":[{},{}]}}", c.start, c.end);
    }
    out.push_str("],\"renders\":[");
    for (i, r) in s.renders.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"component\":");
        json_string(&mut out, &r.component);
        let _ = write!(out, ",\"form\":\"{}\",\"owner\":", r.form);
        match &r.owner {
            Some(o) => json_string(&mut out, o),
            None => out.push_str("null"),
        }
        let _ = write!(
            out,
            ",\"inLoading\":{},\"inErrored\":{},\"spread\":{},\"props\":{{",
            r.in_loading, r.in_errored, r.spread
        );
        for (j, (name, fact)) in r.props.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            json_string(&mut out, name);
            out.push(':');
            json_fact(&mut out, fact);
        }
        let _ = write!(out, "}},\"span\":[{},{}]}}", r.start, r.end);
    }
    out.push_str("],\"escapes\":[");
    for (i, (name, at)) in s.escapes.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"name\":");
        json_string(&mut out, name);
        let _ = write!(out, ",\"at\":{at}}}");
    }
    out.push_str("]}");
    out
}

// --- entry -------------------------------------------------------------------------------------

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(n) => n.name.to_string(),
        ModuleExportName::IdentifierReference(n) => n.name.to_string(),
        ModuleExportName::StringLiteral(s) => s.value.to_string(),
    }
}

fn collect_declaration(summary: &mut Summary, decl: &VariableDeclaration<'_>, exported: bool) {
    for d in &decl.declarations {
        let Some(name) = binding_name(&d.id) else {
            continue;
        };
        let Some(init) = &d.init else { continue };
        if exported {
            summary.exports.push((name.clone(), name.clone()));
        }
        if decl.kind == VariableDeclarationKind::Const && is_literal(init) {
            summary.statics.insert(name.clone());
        }
        if let Expression::CallExpression(call) = init
            && callee_name(call) == Some("$component")
        {
            let param = match call.arguments.first().and_then(|a| a.as_expression()) {
                Some(Expression::FunctionExpression(f)) => f.params.items.first(),
                _ => None,
            };
            summary.components.push(Component {
                local: name,
                key: param.and_then(typed_props_key),
                props_param: param.and_then(|p| binding_name(&p.pattern)),
                bindings: HashMap::new(),
                binding_order: Vec::new(),
                start: call.span.start,
                end: call.span.end,
            });
        }
    }
}

/// Summarize one module for the blocks type linker. Returns the versioned
/// JSON summary described in the module docs.
pub fn summarize_blocks(source: &str, filename: Option<&str>) -> Result<String, CompileError> {
    let allocator = Allocator::default();
    let source_type = crate::compiler::source_type_for_filename(filename)?;
    let program = crate::compiler::parse_program(&allocator, source, source_type)?;
    let mut summary = Summary::default();

    for statement in &program.body {
        match statement {
            Statement::ImportDeclaration(import) => {
                if import.import_kind.is_type() {
                    continue;
                }
                let source = import.source.value.to_string();
                for spec in import.specifiers.iter().flatten() {
                    match spec {
                        ImportDeclarationSpecifier::ImportSpecifier(s) => summary.imports.push((
                            s.local.name.to_string(),
                            source.clone(),
                            module_export_name(&s.imported),
                        )),
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => summary
                            .imports
                            .push((s.local.name.to_string(), source.clone(), "default".into())),
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => summary
                            .imports
                            .push((s.local.name.to_string(), source.clone(), "*".into())),
                    }
                }
            }
            Statement::VariableDeclaration(decl) => collect_declaration(&mut summary, decl, false),
            Statement::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    summary.classes.push(id.name.to_string());
                }
            }
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::VariableDeclaration(decl) => {
                    collect_declaration(&mut summary, decl, true)
                }
                Declaration::ClassDeclaration(class) => {
                    if let Some(id) = &class.id {
                        summary.classes.push(id.name.to_string());
                        summary
                            .exports
                            .push((id.name.to_string(), id.name.to_string()));
                    }
                }
                Declaration::FunctionDeclaration(f) => {
                    if let Some(id) = &f.id {
                        summary
                            .exports
                            .push((id.name.to_string(), id.name.to_string()));
                    }
                }
                _ => {}
            },
            Statement::ExportNamedDeclaration(export) => {
                for spec in &export.specifiers {
                    summary.exports.push((
                        module_export_name(&spec.exported),
                        module_export_name(&spec.local),
                    ));
                }
            }
            Statement::ExportFromDeclaration(export) => {
                for spec in &export.specifiers {
                    summary.reexports.push((
                        module_export_name(&spec.exported),
                        export.source.value.to_string(),
                        module_export_name(&spec.local),
                    ));
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                if let ExportDefaultDeclarationKind::Identifier(id) = &export.declaration {
                    summary
                        .exports
                        .push(("default".into(), id.name.to_string()));
                }
            }
            Statement::ExportAllDeclaration(export) => {
                summary
                    .reexports
                    .push(("*".into(), export.source.value.to_string(), "*".into()));
            }
            _ => {}
        }
    }

    let component_names = summary.components.iter().map(|c| c.local.clone()).collect();
    let mut walker = Walker {
        summary: &mut summary,
        component_names,
        owner: Vec::new(),
        row_items: Vec::new(),
        loading: 0,
        errored: 0,
    };
    for statement in &program.body {
        match statement {
            // exporting a component is not a use; everything else is walked
            Statement::ExportNamedDeclaration(_) | Statement::ExportFromDeclaration(_) => {}
            Statement::ExportDefaultDeclaration(e)
                if matches!(e.declaration, ExportDefaultDeclarationKind::Identifier(_)) => {}
            _ => walker.visit_statement(statement),
        }
    }
    Ok(to_json(&summary))
}

#[cfg(test)]
mod tests {
    use super::summarize_blocks;

    fn summary(src: &str) -> String {
        summarize_blocks(src, Some("m.tsx")).unwrap()
    }

    #[test]
    fn components_keys_and_memo_facts() {
        let s = summary(
            r#"
            import { $component, $memo, attempt, raise, type TypedProps } from "@solidjs/blocks";
            import { NotFound } from "./errors";
            export const UserCard = $component(function* (props: TypedProps<{ user: { name: string } }, "UserCard">) {
              return function* () { return <p>{(yield* props.user).name}</p>; };
            });
            export const Parent = $component(function* () {
              const user = yield* $memo(function* () {
                const u = yield* attempt(() => fetchUser(), NotFound);
                if (!u) yield* raise(new TypeError("x"));
                return u;
              });
              return function* () { return <UserCard user={user} />; };
            });
            "#,
        );
        assert!(
            s.starts_with(r#"{"schema":"solid-blocks-summary","version":1"#),
            "{s}"
        );
        assert!(
            s.contains(r#""local":"UserCard","key":"UserCard","propsParam":"props""#),
            "{s}"
        );
        assert!(
            s.contains(
                r#""user":{"k":"memo","pending":true,"fails":["NotFound","TypeError"],"reads":[]}"#
            ),
            "{s}"
        );
        assert!(
            s.contains(r#""component":"UserCard","form":"tag","owner":"Parent""#),
            "{s}"
        );
    }

    #[test]
    fn pass_through_call_form_statics_and_escapes() {
        let s = summary(
            r#"
            const LABEL = "hi";
            export const Middle = $component(function* (props: TypedProps<{ user: User }, "Middle">) {
              return function* () { return <section>{yield* Card({ user: props.user, label: LABEL, n: 1 })}</section>; };
            });
            const Card = $component(function* (props: TypedProps<{ user: User; label: string; n: number }, "Card">) {
              return function* () { return <p />; };
            });
            const view = <Dynamic component={Card} />;
            "#,
        );
        assert!(s.contains(r#""form":"call","owner":"Middle""#), "{s}");
        assert!(s.contains(r#""user":{"k":"prop","name":"user"}"#), "{s}");
        assert!(s.contains(r#""label":{"k":"static"}"#), "{s}");
        assert!(s.contains(r#""escapes":[{"name":"Card""#), "{s}");
    }

    #[test]
    fn row_items_are_live_and_boundaries_are_seen() {
        let s = summary(
            r#"
            const List = $component(function* () {
              const [items] = yield* $signal([]);
              return function* () {
                return <Loading><For each={yield* items}>{item => <Row item={item} />}</For></Loading>;
              };
            });
            "#,
        );
        assert!(
            s.contains(r#""component":"Row","form":"tag","owner":"List","inLoading":true"#),
            "{s}"
        );
        assert!(s.contains(r#""item":{"k":"live"}"#), "{s}");
    }
}
