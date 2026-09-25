//! Module behavioral summaries — the compiler half of the strict
//! multi-module pipeline (Track C).
//!
//! `summarize_module` records, for one authored module, every behavioral fact
//! the bundler/linker needs that is *visible in the implementation* and that
//! TypeScript alone cannot state:
//!
//! - the module graph edges (static / dynamic / type-only imports, exports,
//!   re-exports, `export *`);
//! - the module-level bindings, the module-level bindings each of them
//!   references (a per-module call/reference graph), and whether module
//!   evaluation has top-level effects;
//! - every `$` block: its operations (reads, path reads, structural store
//!   reads, tasks, raises, attempts, writes, delegations, unknown yields), its
//!   captures (every binding it closes over, with where that binding lives
//!   and whether the body assigns it), the ways the block *escapes* the
//!   compiler's view (`this`, `arguments`, `eval`, nested blocks, dynamic
//!   imports), how its event parameter is used (`preventDefault`,
//!   propagation control, `currentTarget`, `target`, other members, whether
//!   the event object itself escapes to a call), a synchronous *prelude*
//!   (leading guards / propagation calls a hot shell could replay), and every
//!   *site* the block value flows to (a DOM event attribute, a component
//!   prop, a reactive host, a component's return, an export, a delegation,
//!   an unknown call or an assignment);
//! - each component's prop usage (path reads, DOM event bindings, forwarding
//!   to children, spreads and escapes);
//! - every JSX `on*` attribute with a classification of its value (a local
//!   block, a forwarded prop member, an ordinary binding, unknown) and the
//!   `Errored` / `Loading` boundaries enclosing it in this module;
//! - constructs that make the module *unknown* to the linker: `eval`, `with`,
//!   a non-literal `import()`, `import.meta`, `require(...)`, top-level
//!   `await`, `export *`.
//!
//! The summary is a JSON document (schema `solid-behavior-summary`, version
//! 1). Emission is deterministic: arrays follow source order (or are sorted
//! by name where source order is meaningless), object keys are fixed, and
//! every position is given both as UTF-16 offsets (TypeScript's unit, so
//! `solid-tsc` can join it with type information) and as a 1-based
//! line/column pair. Nothing here proves runtime behavior: the summary
//! states what the source *says*, and anything it cannot see is recorded as
//! unknown rather than guessed.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, BindingPattern, CallExpression, Class, Declaration,
    ExportDefaultDeclarationKind, Expression, Function, IdentifierReference,
    ImportDeclarationSpecifier, ImportOrExportKind, JSXAttributeItem, JSXAttributeName,
    JSXAttributeValue, JSXElementName, JSXExpression, JSXOpeningElement, ModuleExportName, Program,
    Statement, YieldExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{AstNodes, NodeId, ScopeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::reference::ReferenceFlags;
use oxc_syntax::scope::ScopeFlags;
use oxc_syntax::symbol::SymbolFlags;

use crate::compiler::{parse_program, source_type_for_filename};
use crate::error::CompileError;
use crate::generators::{is_component_props, member_chain_keys, member_chain_root};
use crate::shared::constants::delegated_events;

/// Schema identifier written into every summary.
pub const SCHEMA: &str = "solid-behavior-summary";
/// Schema version; bump on any incompatible change (the linker refuses
/// mismatched summaries as `unknown`).
pub const VERSION: u32 = 1;

/// Modules whose named exports are the block runtime.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
/// Reactive hosts that consume a block as their compute function.
const REACTIVE_HOSTS: &[&str] = &[
    "createMemo",
    "createEffect",
    "createRenderEffect",
    "createSignal",
    "createStore",
    "createProjection",
    "createOptimisticStore",
    "createOptimistic",
    "createAsync",
];
/// JSX boundaries recorded around a DOM event site.
const BOUNDARIES: &[&str] = &["Errored", "Loading"];

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/// A tiny JSON tree with insertion-ordered objects; serialized compactly.
#[derive(Clone, Debug)]
pub enum Json {
    Null,
    Bool(bool),
    Num(i64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn obj() -> Json {
        Json::Obj(Vec::new())
    }

    fn set(&mut self, key: &str, value: Json) -> &mut Json {
        if let Json::Obj(entries) = self {
            entries.push((key.to_string(), value));
        }
        self
    }

    fn push(&mut self, value: Json) {
        if let Json::Arr(items) = self {
            items.push(value);
        }
    }

    fn str(value: impl Into<String>) -> Json {
        Json::Str(value.into())
    }

    fn opt_str(value: Option<impl Into<String>>) -> Json {
        value.map_or(Json::Null, |value| Json::Str(value.into()))
    }

    fn strings<'s>(values: impl IntoIterator<Item = &'s str>) -> Json {
        Json::Arr(values.into_iter().map(Json::str).collect())
    }

    pub fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Num(value) => {
                let _ = write!(out, "{value}");
            }
            Json::Str(value) => write_json_string(out, value),
            Json::Arr(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(entries) => {
                out.push('{');
                for (index, (key, value)) in entries.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    write_json_string(out, key);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_json_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
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

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/// Byte offset → UTF-16 offset and 1-based line/column conversion.
struct Positions<'s> {
    source: &'s str,
    /// Byte offset of each line start.
    line_starts: Vec<u32>,
    /// UTF-16 offset of each line start.
    line_utf16: Vec<u32>,
    ascii: bool,
}

impl<'s> Positions<'s> {
    fn new(source: &'s str) -> Self {
        let mut line_starts = vec![0u32];
        let mut line_utf16 = vec![0u32];
        let mut utf16 = 0u32;
        let ascii = source.is_ascii();
        for (offset, character) in source.char_indices() {
            utf16 += character.len_utf16() as u32;
            if character == '\n' {
                line_starts.push((offset + 1) as u32);
                line_utf16.push(utf16);
            }
        }
        Self {
            source,
            line_starts,
            line_utf16,
            ascii,
        }
    }

    /// (utf16 offset, line, column) — line and column are 1-based, column in
    /// UTF-16 units (what TypeScript reports).
    fn convert(&self, byte: u32) -> (u32, u32, u32) {
        let byte = byte.min(self.source.len() as u32);
        let line = match self.line_starts.binary_search(&byte) {
            Ok(index) => index,
            Err(index) => index - 1,
        };
        let line_start = self.line_starts[line];
        let column_units = if self.ascii {
            byte - line_start
        } else {
            self.source[line_start as usize..byte as usize]
                .chars()
                .map(|c| c.len_utf16() as u32)
                .sum()
        };
        (
            self.line_utf16[line] + column_units,
            line as u32 + 1,
            column_units + 1,
        )
    }

    fn span(&self, span: Span) -> Json {
        let (start, line, column) = self.convert(span.start);
        let (end, _, _) = self.convert(span.end);
        let mut json = Json::obj();
        json.set("start", Json::Num(i64::from(start)));
        json.set("end", Json::Num(i64::from(end)));
        json.set("line", Json::Num(i64::from(line)));
        json.set("column", Json::Num(i64::from(column)));
        json
    }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/// Summarize `source`. The result is the JSON text of the summary.
pub fn summarize_module(source: &str, filename: Option<&str>) -> Result<String, CompileError> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename)?;
    let program = parse_program(&allocator, source, source_type)?;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let context = Context {
        source,
        positions: Positions::new(source),
        scoping: semantic.scoping(),
        nodes: semantic.nodes(),
        runtime: RuntimeSymbols::collect(&program),
        root_statements: program
            .body
            .iter()
            .map(|statement| statement.span())
            .collect(),
    };
    let summary = Summarizer::new(&context, &program).run();
    let mut out = String::new();
    summary.write(&mut out);
    Ok(out)
}

/// Shared analysis state.
struct Context<'s> {
    source: &'s str,
    positions: Positions<'s>,
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'s>,
    runtime: RuntimeSymbols,
    /// Spans of the program's top-level statements, in order.
    root_statements: Vec<Span>,
}

/// Named imports from the runtime sources that the summary recognizes.
#[derive(Default)]
struct RuntimeSymbols {
    adapter: Vec<SymbolId>,
    /// `raise` / `attempt` / `write` / `call` / `readStore` / `wait`, by
    /// imported name.
    ops: Vec<(SymbolId, &'static str)>,
    hosts: Vec<(SymbolId, &'static str)>,
    /// `action` (registered transaction factory) and `lazy`.
    action: Vec<SymbolId>,
    lazy: Vec<SymbolId>,
}

impl RuntimeSymbols {
    fn collect(program: &Program<'_>) -> Self {
        let mut symbols = Self::default();
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if !RUNTIME_SOURCES.contains(&import.source.value.as_str())
                && import.source.value.as_str() != "@solidjs/web"
                || import.import_kind == ImportOrExportKind::Type
            {
                continue;
            }
            for specifier in import.specifiers.iter().flatten() {
                let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                    continue;
                };
                let Some(symbol) = specifier.local.symbol_id.get() else {
                    continue;
                };
                let name = specifier.imported.name();
                let name = name.as_str();
                match name {
                    "$" => symbols.adapter.push(symbol),
                    "raise" => symbols.ops.push((symbol, "raise")),
                    "attempt" => symbols.ops.push((symbol, "attempt")),
                    "write" => symbols.ops.push((symbol, "write")),
                    "call" => symbols.ops.push((symbol, "call")),
                    "readStore" => symbols.ops.push((symbol, "readStore")),
                    "wait" => symbols.ops.push((symbol, "wait")),
                    "action" => symbols.action.push(symbol),
                    "lazy" => symbols.lazy.push(symbol),
                    _ => {}
                }
                if let Some(host) = REACTIVE_HOSTS.iter().find(|host| **host == name) {
                    symbols.hosts.push((symbol, host));
                }
            }
        }
        symbols
    }

    fn op(&self, symbol: SymbolId) -> Option<&'static str> {
        self.ops
            .iter()
            .find(|(candidate, _)| *candidate == symbol)
            .map(|(_, name)| *name)
    }

    fn host(&self, symbol: SymbolId) -> Option<&'static str> {
        self.hosts
            .iter()
            .find(|(candidate, _)| *candidate == symbol)
            .map(|(_, name)| *name)
    }
}

impl<'s> Context<'s> {
    fn symbol_of(&self, reference: &IdentifierReference<'_>) -> Option<SymbolId> {
        reference
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
    }

    fn callee_symbol(&self, call: &CallExpression<'_>) -> Option<SymbolId> {
        match &call.callee {
            Expression::Identifier(callee) => self.symbol_of(callee),
            _ => None,
        }
    }

    /// A value (read or write) reference, not a type-position reference.
    fn is_value_reference(&self, reference: &IdentifierReference<'_>) -> bool {
        reference
            .reference_id
            .get()
            .is_none_or(|id| self.scoping.get_reference(id).is_value())
    }

    fn is_adapter_call(&self, call: &CallExpression<'_>) -> bool {
        self.callee_symbol(call)
            .is_some_and(|symbol| self.runtime.adapter.contains(&symbol))
    }

    fn is_root_symbol(&self, symbol: SymbolId) -> bool {
        self.scoping.symbol_scope_id(symbol) == self.scoping.root_scope_id()
    }

    fn text(&self, span: Span) -> &'s str {
        &self.source[span.start as usize..span.end as usize]
    }

    /// Index of the top-level statement containing `node`.
    fn root_statement_index(&self, node: NodeId) -> Option<usize> {
        let span = self.nodes.get_node(node).kind().span();
        self.root_statements
            .iter()
            .position(|statement| statement.start <= span.start && span.end <= statement.end)
    }

    /// Walk up from `node` to the top-level statement, reporting the
    /// outermost named declaration (function / class / variable declarator)
    /// on the way: the module-level binding that "owns" the node.
    fn owner_of(&self, node: NodeId) -> Option<(String, SymbolId)> {
        let mut current = node;
        let mut owner: Option<(String, SymbolId)> = None;
        loop {
            let parent = self.nodes.parent_id(current);
            if parent == current {
                return owner;
            }
            match self.nodes.get_node(current).kind() {
                AstKind::Function(function) => {
                    if let Some(id) = function.id.as_ref()
                        && let Some(symbol) = id.symbol_id.get()
                    {
                        owner = Some((id.name.to_string(), symbol));
                    }
                }
                AstKind::Class(class) => {
                    if let Some(id) = class.id.as_ref()
                        && let Some(symbol) = id.symbol_id.get()
                    {
                        owner = Some((id.name.to_string(), symbol));
                    }
                }
                AstKind::VariableDeclarator(declarator) => {
                    if let BindingPattern::BindingIdentifier(id) = &declarator.id
                        && let Some(symbol) = id.symbol_id.get()
                    {
                        owner = Some((id.name.to_string(), symbol));
                    }
                }
                AstKind::Program(_) => return owner,
                _ => {}
            }
            if matches!(self.nodes.get_node(parent).kind(), AstKind::Program(_)) {
                // `current` is the top-level statement; keep only an owner
                // that is a *module-level* binding.
                return owner.filter(|(_, symbol)| self.is_root_symbol(*symbol));
            }
            current = parent;
        }
    }

    /// Nearest enclosing `Errored` / `Loading` JSX elements, innermost first.
    fn boundaries_of(&self, node: NodeId) -> Vec<String> {
        let mut chain = Vec::new();
        let mut previous = node;
        for ancestor in self.nodes.ancestor_ids(node) {
            // Reached through the element's own attributes (a `fallback`),
            // not its children: the boundary does not enclose the site.
            let through_attributes = matches!(
                self.nodes.get_node(previous).kind(),
                AstKind::JSXOpeningElement(_)
            );
            if !through_attributes
                && let AstKind::JSXElement(element) = self.nodes.get_node(ancestor).kind()
                && let Some(name) = jsx_component_name(&element.opening_element)
                && BOUNDARIES.contains(&name.as_str())
            {
                chain.push(name);
            }
            previous = ancestor;
        }
        chain
    }

    /// Is `symbol` declared as a function parameter? Returns the index of
    /// the parameter and the node of the declaring function.
    fn parameter_of(&self, symbol: SymbolId) -> Option<(usize, NodeId)> {
        let declaration = self.scoping.symbol_declaration(symbol);
        let declaration_span = self.nodes.get_node(declaration).kind().span();
        let mut saw_parameter = false;
        let mut current = declaration;
        loop {
            match self.nodes.get_node(current).kind() {
                AstKind::FormalParameter(_) => saw_parameter = true,
                AstKind::FormalParameters(params) => {
                    if !saw_parameter {
                        return None;
                    }
                    let index = params
                        .items
                        .iter()
                        .position(|param| param.span().contains_inclusive(declaration_span))?;
                    let parent = self.nodes.parent_id(current);
                    return Some((index, parent));
                }
                AstKind::Function(_)
                | AstKind::ArrowFunctionExpression(_)
                | AstKind::Program(_) => {
                    return None;
                }
                _ => {}
            }
            let parent = self.nodes.parent_id(current);
            if parent == current {
                return None;
            }
            current = parent;
        }
    }
}

fn jsx_component_name(element: &JSXOpeningElement<'_>) -> Option<String> {
    match &element.name {
        JSXElementName::IdentifierReference(reference) => Some(reference.name.to_string()),
        JSXElementName::MemberExpression(member) => Some(jsx_member_name(member)),
        _ => None,
    }
}

fn jsx_member_name(member: &oxc_ast::ast::JSXMemberExpression<'_>) -> String {
    use oxc_ast::ast::JSXMemberExpressionObject;
    let object = match &member.object {
        JSXMemberExpressionObject::IdentifierReference(reference) => reference.name.to_string(),
        JSXMemberExpressionObject::MemberExpression(inner) => jsx_member_name(inner),
        JSXMemberExpressionObject::ThisExpression(_) => "this".to_string(),
    };
    format!("{object}.{}", member.property.name)
}

/// The element name of a JSX opening element and whether it is intrinsic
/// (a lowercase identifier: a DOM element).
fn jsx_element_name(element: &JSXOpeningElement<'_>) -> (String, bool) {
    match &element.name {
        JSXElementName::Identifier(identifier) => (identifier.name.to_string(), true),
        JSXElementName::NamespacedName(name) => {
            (format!("{}:{}", name.namespace.name, name.name.name), true)
        }
        JSXElementName::ThisExpression(_) => ("this".to_string(), false),
        _ => (jsx_component_name(element).unwrap_or_default(), false),
    }
}

/// `onClick` → `("click", false)`, `on:custom` → `("custom", false)`,
/// `oncapture:click` → `("click", true)`. `None` for a non-event attribute.
fn event_attribute(name: &JSXAttributeName<'_>) -> Option<(String, bool)> {
    match name {
        JSXAttributeName::Identifier(identifier) => {
            let name = identifier.name.as_str();
            let rest = name.strip_prefix("on")?;
            let first = rest.chars().next()?;
            if !first.is_ascii_uppercase() {
                return None;
            }
            Some((rest.to_ascii_lowercase(), false))
        }
        JSXAttributeName::NamespacedName(namespaced) => {
            let namespace = namespaced.namespace.name.as_str();
            match namespace {
                "on" => Some((namespaced.name.name.to_string(), false)),
                "oncapture" => Some((namespaced.name.name.to_string(), true)),
                _ => None,
            }
        }
    }
}

fn attribute_name(name: &JSXAttributeName<'_>) -> String {
    match name {
        JSXAttributeName::Identifier(identifier) => identifier.name.to_string(),
        JSXAttributeName::NamespacedName(namespaced) => {
            format!("{}:{}", namespaced.namespace.name, namespaced.name.name)
        }
    }
}

fn starts_uppercase(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

fn module_export_name(name: &ModuleExportName<'_>) -> String {
    match name {
        ModuleExportName::IdentifierName(name) => name.name.to_string(),
        ModuleExportName::IdentifierReference(reference) => reference.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Summarizer
// ---------------------------------------------------------------------------

struct Component {
    name: String,
    symbol: SymbolId,
    /// The props parameter's symbol when it is a plain identifier.
    props: Option<SymbolId>,
    /// `"identifier"`, `"destructured"`, `"none"`.
    props_shape: &'static str,
    span: Span,
}

struct Summarizer<'s, 'p> {
    context: &'s Context<'s>,
    program: &'p Program<'p>,
    components: Vec<Component>,
    /// `$` blocks in source order, keyed by the `$` call span.
    blocks: Vec<BlockInfo>,
    /// Binding symbol → block index (for `const save = $(...)`).
    block_bindings: BTreeMap<SymbolId, usize>,
    exports: Vec<Json>,
    exported_locals: Vec<SymbolId>,
    unknowns: Vec<Json>,
}

struct BlockInfo {
    call_span: Span,
    node: NodeId,
    /// Function argument, if inline.
    body: Option<BodyRef>,
}

#[derive(Clone, Copy)]
enum BodyRef {
    Function(NodeId),
    Arrow(NodeId),
}

impl<'s, 'p> Summarizer<'s, 'p> {
    fn new(context: &'s Context<'s>, program: &'p Program<'p>) -> Self {
        Self {
            context,
            program,
            components: Vec::new(),
            blocks: Vec::new(),
            block_bindings: BTreeMap::new(),
            exports: Vec::new(),
            exported_locals: Vec::new(),
            unknowns: Vec::new(),
        }
    }

    fn run(mut self) -> Json {
        self.collect_components();
        self.collect_blocks();
        self.collect_exports();

        let mut summary = Json::obj();
        summary.set("schema", Json::str(SCHEMA));
        summary.set("version", Json::Num(i64::from(VERSION)));
        summary.set(
            "directives",
            Json::strings(
                self.program
                    .directives
                    .iter()
                    .map(|directive| directive.directive.as_str()),
            ),
        );
        summary.set(
            "serverFunctions",
            Json::Num(self.count_server_functions() as i64),
        );
        summary.set("imports", self.imports());
        summary.set("dynamicImports", self.dynamic_imports());
        summary.set("exports", Json::Arr(self.exports.clone()));
        let (bindings, top_level) = self.bindings();
        summary.set("bindings", bindings);
        summary.set("topLevel", top_level);
        summary.set("components", self.components_json());
        summary.set("eventBindings", self.event_bindings());
        summary.set("blocks", self.blocks_json());
        self.collect_module_unknowns();
        let mut unknowns = std::mem::take(&mut self.unknowns);
        unknowns.sort_by_key(span_start);
        summary.set("unknowns", Json::Arr(unknowns));
        summary
    }

    /// Constructs anywhere in the module that can reach module scope by name
    /// at run time or observe the module's identity: direct `eval`, `new
    /// Function`, `with`, `import.meta`, CommonJS `require`. Any of them
    /// makes the module's binding graph unknowable.
    fn collect_module_unknowns(&mut self) {
        struct Collector<'c, 's> {
            context: &'c Context<'s>,
            found: Vec<(&'static str, Span)>,
        }
        impl<'b> Visit<'b> for Collector<'_, '_> {
            fn visit_call_expression(&mut self, it: &CallExpression<'b>) {
                if let Expression::Identifier(callee) = &it.callee
                    && self.context.symbol_of(callee).is_none()
                {
                    match callee.name.as_str() {
                        "eval" => self.found.push(("eval", it.span)),
                        "require" => self.found.push(("require", it.span)),
                        _ => {}
                    }
                }
                walk::walk_call_expression(self, it);
            }
            fn visit_new_expression(&mut self, it: &oxc_ast::ast::NewExpression<'b>) {
                if let Expression::Identifier(callee) = &it.callee
                    && callee.name == "Function"
                    && self.context.symbol_of(callee).is_none()
                {
                    self.found.push(("newFunction", it.span));
                }
                walk::walk_new_expression(self, it);
            }
            fn visit_with_statement(&mut self, it: &oxc_ast::ast::WithStatement<'b>) {
                self.found.push(("with", it.span));
                walk::walk_with_statement(self, it);
            }
            fn visit_import_meta(&mut self, it: &oxc_ast::ast::ImportMeta) {
                self.found.push(("importMeta", it.span));
            }
        }
        let mut collector = Collector {
            context: self.context,
            found: Vec::new(),
        };
        collector.visit_program(self.program);
        for (kind, span) in collector.found {
            let mut unknown = Json::obj();
            unknown.set("kind", Json::str(kind));
            unknown.set("span", self.context.positions.span(span));
            self.unknowns.push(unknown);
        }
    }

    /// Functions carrying a `"use server"` directive (registered server
    /// functions: identity-bearing, never moved).
    fn count_server_functions(&self) -> usize {
        struct Counter(usize);
        impl<'b> Visit<'b> for Counter {
            fn visit_function_body(&mut self, it: &oxc_ast::ast::FunctionBody<'b>) {
                if it
                    .directives
                    .iter()
                    .any(|directive| directive.directive.as_str() == "use server")
                {
                    self.0 += 1;
                }
                walk::walk_function_body(self, it);
            }
        }
        let mut counter = Counter(0);
        counter.visit_program(self.program);
        counter.0
    }

    // -- components ---------------------------------------------------------

    fn collect_components(&mut self) {
        let context = self.context;
        for statement in &self.program.body {
            let declaration = match statement {
                Statement::FunctionDeclaration(function) => Some(Either::Function(function)),
                Statement::VariableDeclaration(declaration) => Some(Either::Variable(declaration)),
                Statement::ExportDeclaration(export) => match &export.declaration {
                    Declaration::FunctionDeclaration(function) => Some(Either::Function(function)),
                    Declaration::VariableDeclaration(declaration) => {
                        Some(Either::Variable(declaration))
                    }
                    _ => None,
                },
                Statement::ExportDefaultDeclaration(export) => match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                        Some(Either::Function(function))
                    }
                    _ => None,
                },
                _ => None,
            };
            match declaration {
                Some(Either::Function(function)) => {
                    if let Some(id) = function.id.as_ref()
                        && starts_uppercase(&id.name)
                        && let Some(symbol) = id.symbol_id.get()
                    {
                        let (props, shape) = props_of_params(&function.params);
                        self.components.push(Component {
                            name: id.name.to_string(),
                            symbol,
                            props,
                            props_shape: shape,
                            span: function.span,
                        });
                    }
                }
                Some(Either::Variable(declaration)) => {
                    for declarator in &declaration.declarations {
                        let BindingPattern::BindingIdentifier(id) = &declarator.id else {
                            continue;
                        };
                        if !starts_uppercase(&id.name) {
                            continue;
                        }
                        let Some(symbol) = id.symbol_id.get() else {
                            continue;
                        };
                        let params = match &declarator.init {
                            Some(Expression::ArrowFunctionExpression(arrow)) => Some(&arrow.params),
                            Some(Expression::FunctionExpression(function)) => {
                                Some(&function.params)
                            }
                            _ => None,
                        };
                        let Some(params) = params else {
                            continue;
                        };
                        let (props, shape) = props_of_params(params);
                        self.components.push(Component {
                            name: id.name.to_string(),
                            symbol,
                            props,
                            props_shape: shape,
                            span: declarator.span,
                        });
                    }
                }
                None => {}
            }
        }
        let _ = context;
    }

    fn component_of(&self, symbol: SymbolId) -> Option<&Component> {
        self.components
            .iter()
            .find(|component| component.symbol == symbol)
    }

    fn components_json(&mut self) -> Json {
        let context = self.context;
        let mut out = Json::Arr(Vec::new());
        for component in &self.components {
            let mut json = Json::obj();
            json.set("name", Json::str(&component.name));
            json.set("span", context.positions.span(component.span));
            json.set("props", Json::str(component.props_shape));
            let mut uses: BTreeMap<String, Vec<String>> = BTreeMap::new();
            let mut escapes: Vec<String> = Vec::new();
            if let Some(props) = component.props {
                for reference_id in context.scoping.get_resolved_reference_ids(props) {
                    let reference = context.scoping.get_reference(*reference_id);
                    let node = reference.node_id();
                    let parent = context.nodes.parent_id(node);
                    match context.nodes.get_node(parent).kind() {
                        AstKind::StaticMemberExpression(member) if matches!(&member.object, Expression::Identifier(id) if id.span == context.nodes.get_node(node).kind().span()) =>
                        {
                            let prop = member.property.name.to_string();
                            let use_kind = self.classify_member_use(parent);
                            let entry = uses.entry(prop).or_default();
                            if !entry.contains(&use_kind) {
                                entry.push(use_kind);
                            }
                        }
                        AstKind::ComputedMemberExpression(_) => {
                            escapes.push("computedAccess".to_string());
                        }
                        other => {
                            escapes.push(describe_escape(context, other, parent));
                        }
                    }
                }
            }
            let mut props_json = Json::Arr(Vec::new());
            for (name, mut kinds) in uses {
                kinds.sort();
                let mut prop = Json::obj();
                prop.set("name", Json::str(name));
                prop.set("uses", Json::strings(kinds.iter().map(String::as_str)));
                props_json.push(prop);
            }
            json.set("propUses", props_json);
            escapes.sort();
            escapes.dedup();
            json.set(
                "propsEscapes",
                Json::strings(escapes.iter().map(String::as_str)),
            );
            out.push(json);
        }
        out
    }

    /// How the value of a member chain rooted at a props parameter is used:
    /// the chain's outermost member expression is `node`.
    fn classify_member_use(&self, node: NodeId) -> String {
        let context = self.context;
        // Climb the member chain.
        let mut current = node;
        loop {
            let parent = context.nodes.parent_id(current);
            match context.nodes.get_node(parent).kind() {
                AstKind::StaticMemberExpression(_) | AstKind::ComputedMemberExpression(_) => {
                    current = parent;
                }
                AstKind::ChainExpression(_) => {
                    current = parent;
                }
                _ => break,
            }
        }
        let parent = context.nodes.parent_id(current);
        let member_span = context.nodes.get_node(current).kind().span();
        match context.nodes.get_node(parent).kind() {
            AstKind::YieldExpression(yield_expression) if yield_expression.delegate => {
                "pathRead".to_string()
            }
            AstKind::CallExpression(call) => {
                if call.callee.span() == member_span {
                    return "call".to_string();
                }
                if let Some(symbol) = context.callee_symbol(call) {
                    if context.runtime.op(symbol) == Some("call") {
                        return "delegated".to_string();
                    }
                    if context.runtime.op(symbol) == Some("write") {
                        return "written".to_string();
                    }
                    if let Some(host) = context.runtime.host(symbol) {
                        return format!("host:{host}");
                    }
                }
                format!("argument:{}", callee_text(context, call))
            }
            AstKind::JSXExpressionContainer(_) => {
                let attribute = context.nodes.parent_id(parent);
                match context.nodes.get_node(attribute).kind() {
                    AstKind::JSXAttribute(attribute_node) => {
                        let opening = context.nodes.parent_id(attribute);
                        let (element, intrinsic) = match context.nodes.get_node(opening).kind() {
                            AstKind::JSXOpeningElement(opening) => jsx_element_name(opening),
                            _ => (String::new(), false),
                        };
                        if let Some((event, _)) = event_attribute(&attribute_node.name) {
                            if intrinsic {
                                format!("domEvent:{event}")
                            } else {
                                format!(
                                    "componentProp:{element}.{}",
                                    attribute_name(&attribute_node.name)
                                )
                            }
                        } else if intrinsic {
                            format!("attribute:{}", attribute_name(&attribute_node.name))
                        } else {
                            format!(
                                "componentProp:{element}.{}",
                                attribute_name(&attribute_node.name)
                            )
                        }
                    }
                    _ => "jsxChild".to_string(),
                }
            }
            AstKind::VariableDeclarator(_) => "alias".to_string(),
            AstKind::ReturnStatement(_) => "returned".to_string(),
            AstKind::AssignmentExpression(assignment) if assignment.left.span() == member_span => {
                "assigned".to_string()
            }
            AstKind::ExpressionStatement(_) => "read".to_string(),
            _ => "read".to_string(),
        }
    }

    // -- blocks --------------------------------------------------------------

    fn collect_blocks(&mut self) {
        struct Collector<'c, 's> {
            context: &'c Context<'s>,
            blocks: Vec<BlockInfo>,
        }
        impl<'b> Visit<'b> for Collector<'_, '_> {
            fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
                if self.context.is_adapter_call(call) {
                    let body = match call.arguments.first() {
                        Some(Argument::FunctionExpression(function))
                            if call.arguments.len() == 1 =>
                        {
                            Some(BodyRef::Function(function.node_id.get()))
                        }
                        Some(Argument::ArrowFunctionExpression(arrow))
                            if call.arguments.len() == 1 =>
                        {
                            Some(BodyRef::Arrow(arrow.node_id.get()))
                        }
                        _ => None,
                    };
                    self.blocks.push(BlockInfo {
                        call_span: call.span,
                        node: call.node_id.get(),
                        body,
                    });
                }
                walk::walk_call_expression(self, call);
            }
        }
        let mut collector = Collector {
            context: self.context,
            blocks: Vec::new(),
        };
        collector.visit_program(self.program);
        collector.blocks.sort_by_key(|block| block.call_span.start);
        for (index, block) in collector.blocks.iter().enumerate() {
            let parent = self.context.nodes.parent_id(block.node);
            if let AstKind::VariableDeclarator(declarator) =
                self.context.nodes.get_node(parent).kind()
                && let BindingPattern::BindingIdentifier(id) = &declarator.id
                && let Some(symbol) = id.symbol_id.get()
            {
                self.block_bindings.insert(symbol, index);
            }
        }
        self.blocks = collector.blocks;
    }

    fn block_index_of_expression(&self, expression: &Expression<'_>) -> Option<usize> {
        match expression {
            Expression::CallExpression(call) => self
                .blocks
                .iter()
                .position(|block| block.call_span == call.span),
            Expression::Identifier(reference) => self
                .context
                .symbol_of(reference)
                .and_then(|symbol| self.block_bindings.get(&symbol).copied()),
            Expression::ParenthesizedExpression(inner) => {
                self.block_index_of_expression(&inner.expression)
            }
            _ => None,
        }
    }

    fn blocks_json(&mut self) -> Json {
        let mut out = Json::Arr(Vec::new());
        let blocks = std::mem::take(&mut self.blocks);
        for (index, block) in blocks.iter().enumerate() {
            out.push(self.block_json(index, block));
        }
        self.blocks = blocks;
        out
    }

    fn block_json(&mut self, index: usize, block: &BlockInfo) -> Json {
        let context = self.context;
        let mut json = Json::obj();
        json.set("id", Json::str(format!("b{index}")));
        json.set("span", context.positions.span(block.call_span));
        let parent = context.nodes.parent_id(block.node);
        let name = match context.nodes.get_node(parent).kind() {
            AstKind::VariableDeclarator(declarator) => match &declarator.id {
                BindingPattern::BindingIdentifier(id) => Some(id.name.to_string()),
                _ => None,
            },
            AstKind::ObjectProperty(property) => property.key.static_name().map(|n| n.to_string()),
            _ => None,
        };
        json.set("name", Json::opt_str(name));
        let owner = context.owner_of(block.node);
        json.set(
            "owner",
            Json::opt_str(owner.as_ref().map(|(name, _)| name.clone())),
        );
        json.set(
            "ownerIsComponent",
            Json::Bool(
                owner
                    .as_ref()
                    .is_some_and(|(_, symbol)| self.component_of(*symbol).is_some()),
            ),
        );
        // Nesting inside another block's body (a block created at run time).
        let nested_in = self
            .blocks
            .iter()
            .enumerate()
            .filter(|(other, candidate)| {
                *other != index
                    && candidate.call_span.start < block.call_span.start
                    && block.call_span.end <= candidate.call_span.end
            })
            .map(|(other, _)| format!("b{other}"))
            .collect::<Vec<_>>();
        json.set(
            "nestedIn",
            Json::strings(nested_in.iter().map(String::as_str)),
        );

        match block.body {
            None => {
                json.set("body", Json::Null);
                json.set("opaque", Json::Bool(true));
            }
            Some(body) => {
                json.set("opaque", Json::Bool(false));
                let analysis = self.analyze_body(block, body);
                json.set("body", analysis);
            }
        }
        json.set("sites", self.sites_of(block));
        json
    }

    /// Everything about the inline body of a block.
    fn analyze_body(&self, block: &BlockInfo, body: BodyRef) -> Json {
        let context = self.context;
        let (span, scope, generator, is_async, params, statements): (
            Span,
            Option<ScopeId>,
            bool,
            bool,
            &oxc_ast::ast::FormalParameters<'_>,
            Option<&oxc_ast::ast::FunctionBody<'_>>,
        ) = match body {
            BodyRef::Function(node) => match context.nodes.get_node(node).kind() {
                AstKind::Function(function) => (
                    function.span,
                    function.scope_id.get(),
                    function.generator,
                    function.r#async,
                    &function.params,
                    function.body.as_deref(),
                ),
                _ => unreachable!("body node is a function"),
            },
            BodyRef::Arrow(node) => match context.nodes.get_node(node).kind() {
                AstKind::ArrowFunctionExpression(arrow) => (
                    arrow.span,
                    arrow.scope_id.get(),
                    false,
                    arrow.r#async,
                    &arrow.params,
                    match &arrow.body {
                        oxc_ast::ast::ArrowFunctionBody::FunctionBody(body) => Some(body),
                        _ => None,
                    },
                ),
                _ => unreachable!("body node is an arrow"),
            },
        };
        let mut json = Json::obj();
        json.set("span", context.positions.span(span));
        json.set(
            "bodySpan",
            statements.map_or(Json::Null, |body| context.positions.span(body.span)),
        );
        json.set("paramsSpan", context.positions.span(params.span));
        json.set("generator", Json::Bool(generator));
        json.set("async", Json::Bool(is_async));
        json.set("arrow", Json::Bool(matches!(body, BodyRef::Arrow(_))));
        let (input_symbol, input_name) = match params.items.first().map(|param| &param.pattern) {
            Some(BindingPattern::BindingIdentifier(id)) => {
                (id.symbol_id.get(), Some(id.name.to_string()))
            }
            Some(_) => (None, Some("<pattern>".to_string())),
            None => (None, None),
        };
        json.set("paramCount", Json::Num(params.items.len() as i64));
        json.set("input", Json::opt_str(input_name));

        // Operations, captures, escapes: one walk over the body.
        let mut walker = BodyWalker {
            context,
            body_scope: scope,
            input: input_symbol,
            arrow: matches!(body, BodyRef::Arrow(_)),
            function_depth: 0,
            depth: 0,
            jsx_depth: 0,
            ops: Ops::default(),
            captures: BTreeMap::new(),
            globals: BTreeMap::new(),
            escapes: Escapes::default(),
            event: EventUsage::default(),
            nested_blocks: 0,
            dynamic_imports: Vec::new(),
        };
        match body {
            BodyRef::Function(node) => {
                if let AstKind::Function(function) = context.nodes.get_node(node).kind()
                    && let Some(body) = function.body.as_ref()
                {
                    walker.visit_function_body(body);
                }
            }
            BodyRef::Arrow(node) => {
                if let AstKind::ArrowFunctionExpression(arrow) = context.nodes.get_node(node).kind()
                {
                    walker.visit_arrow_function_body(&arrow.body);
                }
            }
        }

        json.set("ops", walker.ops.to_json(context));
        json.set("captures", self.captures_json(&walker, block));
        json.set("escapes", walker.escapes.to_json());
        json.set("nestedBlocks", Json::Num(walker.nested_blocks as i64));
        json.set(
            "dynamicImports",
            Json::Arr(
                walker
                    .dynamic_imports
                    .iter()
                    .map(|(source, span)| {
                        let mut entry = Json::obj();
                        entry.set("source", Json::opt_str(source.clone()));
                        entry.set("span", context.positions.span(*span));
                        entry
                    })
                    .collect(),
            ),
        );
        json.set(
            "event",
            match input_symbol {
                Some(_) => {
                    let mut event = walker.event.to_json();
                    let prelude = statements
                        .map(|statements| {
                            prelude_json(context, &statements.statements, input_symbol)
                        })
                        .unwrap_or_else(|| {
                            let mut prelude = Json::obj();
                            prelude.set("statements", Json::Arr(Vec::new()));
                            prelude.set("end", Json::Null);
                            prelude
                        });
                    event.set("prelude", prelude);
                    event
                }
                None => Json::Null,
            },
        );
        json
    }

    fn captures_json(&self, walker: &BodyWalker<'_, '_>, block: &BlockInfo) -> Json {
        let context = self.context;
        let mut out = Json::Arr(Vec::new());
        let mut captures: Vec<(&SymbolId, &CaptureUse)> = walker.captures.iter().collect();
        captures.sort_by_key(|(symbol, _)| context.scoping.symbol_span(**symbol).start);
        for (symbol, use_info) in captures {
            let symbol = *symbol;
            let mut json = Json::obj();
            json.set("name", Json::str(context.scoping.symbol_name(symbol)));
            let flags = context.scoping.symbol_flags(symbol);
            let root = context.is_root_symbol(symbol);
            let parameter = context.parameter_of(symbol);
            let scope = if flags.intersects(SymbolFlags::Import) {
                "import"
            } else if root {
                "module"
            } else if parameter.is_some() {
                "param"
            } else {
                "local"
            };
            json.set("scope", Json::str(scope));
            json.set("kind", Json::str(symbol_kind(flags)));
            json.set(
                "declaration",
                context.positions.span(context.scoping.symbol_span(symbol)),
            );
            // The module-level binding whose body declares a local capture.
            let owner = if root {
                None
            } else {
                context.owner_of(context.scoping.symbol_declaration(symbol))
            };
            json.set(
                "declaredIn",
                Json::opt_str(owner.as_ref().map(|(name, _)| name.clone())),
            );
            let props = match parameter {
                Some((0, function)) => owner
                    .as_ref()
                    .and_then(|(_, owner_symbol)| self.component_of(*owner_symbol))
                    .is_some_and(|component| {
                        component.props == Some(symbol)
                            && context.nodes.get_node(function).kind().span().start
                                <= block.call_span.start
                    }),
                _ => false,
            };
            json.set("props", Json::Bool(props));
            json.set("assigned", Json::Bool(use_info.assigned));
            json.set(
                "mutatedElsewhere",
                Json::Bool(context.scoping.symbol_is_mutated(symbol)),
            );
            json.set("uses", Json::Num(use_info.uses as i64));
            // A block held in a binding: the capture is another block.
            json.set(
                "block",
                Json::opt_str(
                    self.block_bindings
                        .get(&symbol)
                        .map(|index| format!("b{index}")),
                ),
            );
            out.push(json);
        }
        let mut globals: Vec<(&String, &CaptureUse)> = walker.globals.iter().collect();
        globals.sort_by_key(|(name, _)| (*name).clone());
        for (name, use_info) in globals {
            let mut json = Json::obj();
            json.set("name", Json::str(name.clone()));
            json.set("scope", Json::str("global"));
            json.set("kind", Json::str("global"));
            json.set("declaration", Json::Null);
            json.set("declaredIn", Json::Null);
            json.set("props", Json::Bool(false));
            json.set("assigned", Json::Bool(use_info.assigned));
            json.set("mutatedElsewhere", Json::Bool(false));
            json.set("uses", Json::Num(use_info.uses as i64));
            json.set("block", Json::Null);
            out.push(json);
        }
        out
    }

    /// Every place the block's value flows to.
    fn sites_of(&self, block: &BlockInfo) -> Json {
        let context = self.context;
        let mut sites = Vec::new();
        let parent = context.nodes.parent_id(block.node);
        match context.nodes.get_node(parent).kind() {
            AstKind::VariableDeclarator(declarator) => match &declarator.id {
                BindingPattern::BindingIdentifier(id) => {
                    if let Some(symbol) = id.symbol_id.get() {
                        if self.exported_locals.contains(&symbol) {
                            let mut site = Json::obj();
                            site.set("kind", Json::str("exported"));
                            site.set("name", Json::str(id.name.as_str()));
                            site.set("span", context.positions.span(declarator.span));
                            sites.push(site);
                        }
                        for reference_id in context.scoping.get_resolved_reference_ids(symbol) {
                            let reference = context.scoping.get_reference(*reference_id);
                            if reference.flags().intersects(ReferenceFlags::Write) {
                                let mut site = Json::obj();
                                site.set("kind", Json::str("reassigned"));
                                site.set(
                                    "span",
                                    context.positions.span(
                                        context.nodes.get_node(reference.node_id()).kind().span(),
                                    ),
                                );
                                sites.push(site);
                                continue;
                            }
                            sites.push(self.classify_value_use(reference.node_id()));
                        }
                    }
                }
                _ => {
                    let mut site = Json::obj();
                    site.set("kind", Json::str("escape"));
                    site.set("how", Json::str("destructuringTarget"));
                    site.set("span", context.positions.span(declarator.span));
                    sites.push(site);
                }
            },
            _ => sites.push(self.classify_value_use(block.node)),
        }
        Json::Arr(sites)
    }

    /// Classify one use of a block value at `node` (the expression node).
    fn classify_value_use(&self, node: NodeId) -> Json {
        let context = self.context;
        let node_span = context.nodes.get_node(node).kind().span();
        let mut current = node;
        // Skip transparent wrappers.
        loop {
            let parent = context.nodes.parent_id(current);
            match context.nodes.get_node(parent).kind() {
                AstKind::ParenthesizedExpression(_)
                | AstKind::TSAsExpression(_)
                | AstKind::TSSatisfiesExpression(_)
                | AstKind::TSNonNullExpression(_) => current = parent,
                _ => break,
            }
        }
        let parent = context.nodes.parent_id(current);
        let mut site = Json::obj();
        let set = |site: &mut Json, kind: &str| {
            site.set("kind", Json::str(kind));
        };
        match context.nodes.get_node(parent).kind() {
            AstKind::JSXExpressionContainer(_) => {
                let container_parent = context.nodes.parent_id(parent);
                match context.nodes.get_node(container_parent).kind() {
                    AstKind::JSXAttribute(attribute) => {
                        let opening = context.nodes.parent_id(container_parent);
                        let (element, intrinsic) = match context.nodes.get_node(opening).kind() {
                            AstKind::JSXOpeningElement(opening) => jsx_element_name(opening),
                            _ => (String::new(), false),
                        };
                        let event = event_attribute(&attribute.name);
                        if intrinsic {
                            if let Some((event, capture)) = event {
                                set(&mut site, "domEvent");
                                site.set("element", Json::str(element));
                                site.set("attribute", Json::str(attribute_name(&attribute.name)));
                                site.set("event", Json::str(&event));
                                site.set("capture", Json::Bool(capture));
                                site.set(
                                    "delegated",
                                    Json::Bool(!capture && delegated_events(&event)),
                                );
                                let boundaries = context.boundaries_of(container_parent);
                                site.set(
                                    "boundaries",
                                    Json::strings(boundaries.iter().map(String::as_str)),
                                );
                            } else {
                                set(&mut site, "attribute");
                                site.set("element", Json::str(element));
                                site.set("attribute", Json::str(attribute_name(&attribute.name)));
                            }
                        } else {
                            set(&mut site, "componentProp");
                            site.set("component", Json::str(element));
                            site.set("prop", Json::str(attribute_name(&attribute.name)));
                            site.set("event", Json::opt_str(event.map(|(event, _)| event)));
                            let boundaries = context.boundaries_of(container_parent);
                            site.set(
                                "boundaries",
                                Json::strings(boundaries.iter().map(String::as_str)),
                            );
                        }
                    }
                    _ => set(&mut site, "jsxChild"),
                }
            }
            AstKind::CallExpression(call) => {
                if call.callee.span() == node_span {
                    set(&mut site, "invoked");
                } else if let Some(symbol) = context.callee_symbol(call) {
                    if let Some(host) = context.runtime.host(symbol) {
                        set(&mut site, "host");
                        site.set("host", Json::str(host));
                    } else if context.runtime.op(symbol) == Some("call") {
                        set(&mut site, "delegated");
                    } else if context.runtime.adapter.contains(&symbol) {
                        set(&mut site, "wrapped");
                    } else {
                        set(&mut site, "argument");
                        site.set("callee", Json::str(callee_text(context, call)));
                        site.set(
                            "calleeScope",
                            Json::str(if context.is_root_symbol(symbol) {
                                if context
                                    .scoping
                                    .symbol_flags(symbol)
                                    .intersects(SymbolFlags::Import)
                                {
                                    "import"
                                } else {
                                    "module"
                                }
                            } else {
                                "local"
                            }),
                        );
                    }
                } else {
                    set(&mut site, "argument");
                    site.set("callee", Json::str(callee_text(context, call)));
                    site.set("calleeScope", Json::str("unknown"));
                }
            }
            AstKind::YieldExpression(yield_expression) if yield_expression.delegate => {
                set(&mut site, "delegated");
            }
            AstKind::ReturnStatement(_) => {
                set(&mut site, "returned");
                let owner = context.owner_of(parent);
                site.set(
                    "owner",
                    Json::opt_str(owner.as_ref().map(|(name, _)| name.clone())),
                );
                site.set(
                    "ownerIsComponent",
                    Json::Bool(
                        owner
                            .as_ref()
                            .is_some_and(|(_, symbol)| self.component_of(*symbol).is_some()),
                    ),
                );
            }
            AstKind::ArrowFunctionExpression(_) => {
                // `() => block` — an expression body returning the block.
                set(&mut site, "returned");
                let owner = context.owner_of(parent);
                site.set(
                    "owner",
                    Json::opt_str(owner.as_ref().map(|(name, _)| name.clone())),
                );
                site.set("ownerIsComponent", Json::Bool(false));
            }
            AstKind::VariableDeclarator(declarator) => {
                set(&mut site, "alias");
                site.set(
                    "name",
                    Json::opt_str(match &declarator.id {
                        BindingPattern::BindingIdentifier(id) => Some(id.name.to_string()),
                        _ => None,
                    }),
                );
            }
            AstKind::ExportDefaultDeclaration(_) => {
                set(&mut site, "exported");
                site.set("name", Json::str("default"));
            }
            AstKind::ExportSpecifier(_) => {
                set(&mut site, "exported");
            }
            AstKind::ObjectProperty(_) | AstKind::ArrayExpression(_) => {
                set(&mut site, "escape");
                site.set("how", Json::str("literal"));
            }
            AstKind::AssignmentExpression(_) => {
                set(&mut site, "escape");
                site.set("how", Json::str("assignment"));
            }
            AstKind::JSXSpreadAttribute(_) | AstKind::SpreadElement(_) => {
                set(&mut site, "escape");
                site.set("how", Json::str("spread"));
            }
            AstKind::ConditionalExpression(_) | AstKind::LogicalExpression(_) => {
                // `cond ? block : other` — follows the outer expression.
                return self.classify_value_use(parent);
            }
            AstKind::ExpressionStatement(_) => set(&mut site, "unused"),
            other => {
                set(&mut site, "escape");
                site.set("how", Json::str(other.debug_name()));
            }
        }
        site.set("span", context.positions.span(node_span));
        site
    }

    // -- imports / exports ----------------------------------------------------

    fn imports(&self) -> Json {
        let context = self.context;
        let mut out = Json::Arr(Vec::new());
        for statement in &self.program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            let mut json = Json::obj();
            json.set("source", Json::str(import.source.value.as_str()));
            json.set(
                "kind",
                Json::str(if import.import_kind == ImportOrExportKind::Type {
                    "type"
                } else {
                    "static"
                }),
            );
            let mut specifiers = Json::Arr(Vec::new());
            for specifier in import.specifiers.iter().flatten() {
                let mut entry = Json::obj();
                match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                        entry.set(
                            "imported",
                            Json::str(module_export_name(&specifier.imported)),
                        );
                        entry.set("local", Json::str(specifier.local.name.as_str()));
                        entry.set(
                            "type",
                            Json::Bool(specifier.import_kind == ImportOrExportKind::Type),
                        );
                        entry.set(
                            "used",
                            Json::Bool(
                                specifier.local.symbol_id.get().is_some_and(|symbol| {
                                    !context.scoping.symbol_is_unused(symbol)
                                }),
                            ),
                        );
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                        entry.set("imported", Json::str("default"));
                        entry.set("local", Json::str(specifier.local.name.as_str()));
                        entry.set("type", Json::Bool(false));
                        entry.set(
                            "used",
                            Json::Bool(
                                specifier.local.symbol_id.get().is_some_and(|symbol| {
                                    !context.scoping.symbol_is_unused(symbol)
                                }),
                            ),
                        );
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                        entry.set("imported", Json::str("*"));
                        entry.set("local", Json::str(specifier.local.name.as_str()));
                        entry.set("type", Json::Bool(false));
                        entry.set(
                            "used",
                            Json::Bool(
                                specifier.local.symbol_id.get().is_some_and(|symbol| {
                                    !context.scoping.symbol_is_unused(symbol)
                                }),
                            ),
                        );
                    }
                }
                entry.set("span", context.positions.span(specifier.span()));
                specifiers.push(entry);
            }
            json.set("specifiers", specifiers);
            json.set("span", context.positions.span(import.span));
            out.push(json);
        }
        out
    }

    fn dynamic_imports(&mut self) -> Json {
        struct Collector<'c, 's> {
            context: &'c Context<'s>,
            imports: Vec<Json>,
            unknowns: Vec<Json>,
            /// Inside a `lazy(() => import(...))` argument.
            lazy_depth: usize,
        }
        impl<'b> Visit<'b> for Collector<'_, '_> {
            fn visit_call_expression(&mut self, call: &CallExpression<'b>) {
                let lazy = self
                    .context
                    .callee_symbol(call)
                    .is_some_and(|symbol| self.context.runtime.lazy.contains(&symbol));
                if lazy {
                    self.lazy_depth += 1;
                }
                walk::walk_call_expression(self, call);
                if lazy {
                    self.lazy_depth -= 1;
                }
            }
            fn visit_import_expression(&mut self, it: &oxc_ast::ast::ImportExpression<'b>) {
                let mut json = Json::obj();
                let source = match &it.source {
                    Expression::StringLiteral(literal) => Some(literal.value.to_string()),
                    Expression::TemplateLiteral(template) if template.expressions.is_empty() => {
                        template
                            .quasis
                            .first()
                            .map(|quasi| quasi.value.raw.to_string())
                    }
                    _ => None,
                };
                if source.is_none() {
                    let mut unknown = Json::obj();
                    unknown.set("kind", Json::str("dynamicImportNonLiteral"));
                    unknown.set("span", self.context.positions.span(it.span));
                    self.unknowns.push(unknown);
                }
                json.set("source", Json::opt_str(source));
                json.set("lazy", Json::Bool(self.lazy_depth > 0));
                let owner = self.context.owner_of(it.node_id.get());
                json.set("owner", Json::opt_str(owner.map(|(name, _)| name)));
                json.set("span", self.context.positions.span(it.span));
                self.imports.push(json);
                walk::walk_import_expression(self, it);
            }
        }
        let mut collector = Collector {
            context: self.context,
            imports: Vec::new(),
            unknowns: Vec::new(),
            lazy_depth: 0,
        };
        collector.visit_program(self.program);
        self.unknowns.extend(collector.unknowns);
        Json::Arr(collector.imports)
    }

    fn collect_exports(&mut self) {
        let context = self.context;
        for statement in &self.program.body {
            match statement {
                Statement::ExportDeclaration(export) => {
                    let names: Vec<(String, Option<SymbolId>)> = match &export.declaration {
                        Declaration::VariableDeclaration(declaration) => declaration
                            .declarations
                            .iter()
                            .flat_map(|declarator| binding_names(&declarator.id))
                            .collect(),
                        Declaration::FunctionDeclaration(function) => function
                            .id
                            .iter()
                            .map(|id| (id.name.to_string(), id.symbol_id.get()))
                            .collect(),
                        Declaration::ClassDeclaration(class) => class
                            .id
                            .iter()
                            .map(|id| (id.name.to_string(), id.symbol_id.get()))
                            .collect(),
                        _ => {
                            // Type-only declarations.
                            continue;
                        }
                    };
                    for (name, symbol) in names {
                        let mut json = Json::obj();
                        json.set("exported", Json::str(&name));
                        json.set("kind", Json::str("local"));
                        json.set("local", Json::str(&name));
                        json.set("span", context.positions.span(export.span));
                        self.exports.push(json);
                        self.exported_locals.extend(symbol);
                    }
                }
                Statement::ExportNamedDeclaration(export) => {
                    if export.export_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        let mut json = Json::obj();
                        json.set(
                            "exported",
                            Json::str(module_export_name(&specifier.exported)),
                        );
                        json.set("kind", Json::str("local"));
                        json.set("local", Json::str(module_export_name(&specifier.local)));
                        json.set("span", context.positions.span(specifier.span));
                        self.exports.push(json);
                        if let ModuleExportName::IdentifierReference(reference) = &specifier.local
                            && let Some(symbol) = context.symbol_of(reference)
                        {
                            self.exported_locals.push(symbol);
                        }
                    }
                }
                Statement::ExportFromDeclaration(export) => {
                    if export.export_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    for specifier in &export.specifiers {
                        if specifier.export_kind == ImportOrExportKind::Type {
                            continue;
                        }
                        let mut json = Json::obj();
                        json.set(
                            "exported",
                            Json::str(module_export_name(&specifier.exported)),
                        );
                        json.set("kind", Json::str("reexport"));
                        json.set("source", Json::str(export.source.value.as_str()));
                        json.set("imported", Json::str(module_export_name(&specifier.local)));
                        json.set("span", context.positions.span(specifier.span));
                        self.exports.push(json);
                    }
                }
                Statement::ExportAllDeclaration(export) => {
                    if export.export_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    let mut json = Json::obj();
                    match &export.exported {
                        Some(name) => {
                            json.set("exported", Json::str(module_export_name(name)));
                            json.set("kind", Json::str("namespace"));
                        }
                        None => {
                            json.set("exported", Json::Null);
                            json.set("kind", Json::str("star"));
                            let mut unknown = Json::obj();
                            unknown.set("kind", Json::str("exportStar"));
                            unknown.set("source", Json::str(export.source.value.as_str()));
                            unknown.set("span", context.positions.span(export.span));
                            self.unknowns.push(unknown);
                        }
                    }
                    json.set("source", Json::str(export.source.value.as_str()));
                    json.set("span", context.positions.span(export.span));
                    self.exports.push(json);
                }
                Statement::ExportDefaultDeclaration(export) => {
                    let mut json = Json::obj();
                    json.set("exported", Json::str("default"));
                    json.set("kind", Json::str("local"));
                    let local = match &export.declaration {
                        ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                            if let Some(id) = function.id.as_ref() {
                                self.exported_locals.extend(id.symbol_id.get());
                                Some(id.name.to_string())
                            } else {
                                None
                            }
                        }
                        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                            if let Some(id) = class.id.as_ref() {
                                self.exported_locals.extend(id.symbol_id.get());
                                Some(id.name.to_string())
                            } else {
                                None
                            }
                        }
                        ExportDefaultDeclarationKind::Identifier(reference) => {
                            self.exported_locals.extend(context.symbol_of(reference));
                            Some(reference.name.to_string())
                        }
                        _ => None,
                    };
                    json.set("local", Json::opt_str(local));
                    json.set("span", context.positions.span(export.span));
                    self.exports.push(json);
                }
                _ => {}
            }
        }
    }

    // -- bindings and top-level evaluation --------------------------------------

    fn bindings(&mut self) -> (Json, Json) {
        let context = self.context;
        // Root-scope value symbols in declaration order.
        let mut symbols: Vec<SymbolId> = context
            .scoping
            .symbol_ids()
            .filter(|symbol| context.is_root_symbol(*symbol))
            .filter(|symbol| {
                let flags = context.scoping.symbol_flags(*symbol);
                !flags.intersects(
                    SymbolFlags::TypeAlias
                        | SymbolFlags::Interface
                        | SymbolFlags::TypeImport
                        | SymbolFlags::TypeParameter,
                ) || flags.intersects(SymbolFlags::Value | SymbolFlags::Import)
            })
            .collect();
        symbols.sort_by_key(|symbol| context.scoping.symbol_span(*symbol).start);

        // Per top-level statement: the root symbols it references and
        // whether it has evaluation effects.
        let mut statement_refs: Vec<Vec<SymbolId>> = Vec::new();
        let mut statement_effects: Vec<bool> = Vec::new();
        let mut statement_bindings: Vec<Vec<SymbolId>> = vec![Vec::new(); self.program.body.len()];
        let mut top_level_await = None;
        for statement in &self.program.body {
            let mut collector = RootRefCollector {
                context,
                refs: Vec::new(),
                top_level_await: None,
                depth: 0,
            };
            collector.visit_statement(statement);
            collector.refs.sort();
            statement_refs.push(collector.refs);
            statement_effects.push(statement_has_effects(statement));
            if top_level_await.is_none() {
                top_level_await = collector.top_level_await;
            }
        }
        for symbol in &symbols {
            let declaration = context.scoping.symbol_declaration(*symbol);
            if let Some(index) = context.root_statement_index(declaration) {
                statement_bindings[index].push(*symbol);
            }
        }
        if let Some(span) = top_level_await {
            let mut unknown = Json::obj();
            unknown.set("kind", Json::str("topLevelAwait"));
            unknown.set("span", context.positions.span(span));
            self.unknowns.push(unknown);
        }

        let mut out = Json::Arr(Vec::new());
        for symbol in &symbols {
            let symbol = *symbol;
            let flags = context.scoping.symbol_flags(symbol);
            let declaration = context.scoping.symbol_declaration(symbol);
            let index = context.root_statement_index(declaration);
            let mut json = Json::obj();
            json.set("name", Json::str(context.scoping.symbol_name(symbol)));
            json.set("kind", Json::str(symbol_kind(flags)));
            json.set(
                "span",
                context.positions.span(context.scoping.symbol_span(symbol)),
            );
            json.set(
                "statement",
                index.map_or(Json::Null, |index| Json::Num(index as i64)),
            );
            json.set(
                "statementSpan",
                index.map_or(Json::Null, |index| {
                    context.positions.span(context.root_statements[index])
                }),
            );
            json.set(
                "exported",
                Json::Bool(self.exported_locals.contains(&symbol)),
            );
            json.set(
                "mutated",
                Json::Bool(context.scoping.symbol_is_mutated(symbol)),
            );
            json.set(
                "refs",
                index.map_or(Json::Arr(Vec::new()), |index| {
                    ref_counts(context, &statement_refs[index], Some(symbol))
                }),
            );
            json.set(
                "effects",
                Json::Bool(index.is_some_and(|index| statement_effects[index])),
            );
            json.set("component", Json::Bool(self.component_of(symbol).is_some()));
            json.set(
                "block",
                Json::opt_str(
                    self.block_bindings
                        .get(&symbol)
                        .map(|index| format!("b{index}")),
                ),
            );
            json.set("action", Json::Bool(self.is_action_binding(symbol)));
            if flags.intersects(SymbolFlags::Import) {
                // Where an imported value flows (a DOM event, a component
                // prop, a host, …): what the linker needs to prove an
                // imported block event-only across modules.
                let mut sites = Json::Arr(Vec::new());
                for reference_id in context.scoping.get_resolved_reference_ids(symbol) {
                    let reference = context.scoping.get_reference(*reference_id);
                    if !reference.is_value() {
                        continue;
                    }
                    sites.push(self.classify_value_use(reference.node_id()));
                }
                json.set("sites", sites);
            }
            out.push(json);
        }

        // Top-level evaluation: statements that bind nothing.
        let mut effects = false;
        let mut refs: Vec<SymbolId> = Vec::new();
        for (index, statement) in self.program.body.iter().enumerate() {
            if statement_bindings[index].is_empty()
                && !matches!(
                    statement,
                    Statement::ImportDeclaration(_)
                        | Statement::ExportNamedDeclaration(_)
                        | Statement::ExportFromDeclaration(_)
                        | Statement::ExportAllDeclaration(_)
                )
                && !is_type_only_statement(statement)
            {
                effects = true;
                refs.extend(statement_refs[index].iter().copied());
            } else if statement_effects[index] {
                effects = true;
            }
        }
        refs.sort();
        let mut top_level = Json::obj();
        top_level.set("effects", Json::Bool(effects));
        top_level.set("refs", ref_counts(context, &refs, None));
        top_level.set(
            "sideEffectImports",
            Json::Arr(
                self.program
                    .body
                    .iter()
                    .filter_map(|statement| match statement {
                        Statement::ImportDeclaration(import) if import.specifiers.is_none() => {
                            Some(Json::str(import.source.value.as_str()))
                        }
                        _ => None,
                    })
                    .collect(),
            ),
        );
        (out, top_level)
    }

    /// `const save = action(function* …)` — a registered transaction.
    fn is_action_binding(&self, symbol: SymbolId) -> bool {
        let context = self.context;
        let declaration = context.scoping.symbol_declaration(symbol);
        let mut node = declaration;
        loop {
            match context.nodes.get_node(node).kind() {
                AstKind::VariableDeclarator(declarator) => {
                    return matches!(&declarator.init, Some(Expression::CallExpression(call))
                        if context.callee_symbol(call).is_some_and(|callee| context.runtime.action.contains(&callee)));
                }
                AstKind::BindingIdentifier(_) => {}
                _ => return false,
            }
            let parent = context.nodes.parent_id(node);
            if parent == node {
                return false;
            }
            node = parent;
        }
    }

    // -- JSX event bindings -----------------------------------------------------

    fn event_bindings(&mut self) -> Json {
        struct Collector<'c, 's, 'p> {
            summarizer: &'c Summarizer<'s, 'p>,
            out: Vec<Json>,
        }
        impl<'b> Visit<'b> for Collector<'_, '_, '_> {
            fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'b>) {
                let context = self.summarizer.context;
                let (element, intrinsic) = jsx_element_name(it);
                for attribute in &it.attributes {
                    match attribute {
                        JSXAttributeItem::Attribute(attribute) => {
                            let Some((event, capture)) = event_attribute(&attribute.name) else {
                                continue;
                            };
                            let mut json = Json::obj();
                            json.set("element", Json::str(&element));
                            json.set("intrinsic", Json::Bool(intrinsic));
                            json.set("attribute", Json::str(attribute_name(&attribute.name)));
                            json.set("event", Json::str(&event));
                            json.set("capture", Json::Bool(capture));
                            json.set(
                                "delegated",
                                Json::Bool(intrinsic && !capture && delegated_events(&event)),
                            );
                            let value = match &attribute.value {
                                Some(JSXAttributeValue::ExpressionContainer(container)) => {
                                    match &container.expression {
                                        JSXExpression::EmptyExpression(_) => Json::Null,
                                        other => self
                                            .summarizer
                                            .classify_handler_value(other.to_expression()),
                                    }
                                }
                                Some(_) => {
                                    let mut value = Json::obj();
                                    value.set("kind", Json::str("literal"));
                                    value
                                }
                                None => Json::Null,
                            };
                            json.set("value", value);
                            let owner = context.owner_of(it.node_id.get());
                            json.set(
                                "owner",
                                Json::opt_str(owner.as_ref().map(|(n, _)| n.clone())),
                            );
                            json.set(
                                "ownerIsComponent",
                                Json::Bool(owner.as_ref().is_some_and(|(_, symbol)| {
                                    self.summarizer.component_of(*symbol).is_some()
                                })),
                            );
                            let boundaries = context.boundaries_of(it.node_id.get());
                            json.set(
                                "boundaries",
                                Json::strings(boundaries.iter().map(String::as_str)),
                            );
                            json.set("span", context.positions.span(attribute.span));
                            self.out.push(json);
                        }
                        JSXAttributeItem::SpreadAttribute(spread) => {
                            let mut json = Json::obj();
                            json.set("element", Json::str(&element));
                            json.set("intrinsic", Json::Bool(intrinsic));
                            json.set("attribute", Json::str("...spread"));
                            json.set("event", Json::Null);
                            json.set("capture", Json::Bool(false));
                            json.set("delegated", Json::Bool(false));
                            let mut value = Json::obj();
                            value.set("kind", Json::str("spread"));
                            value.set("text", Json::str(context.text(spread.argument.span())));
                            json.set("value", value);
                            let owner = context.owner_of(it.node_id.get());
                            json.set(
                                "owner",
                                Json::opt_str(owner.as_ref().map(|(n, _)| n.clone())),
                            );
                            json.set(
                                "ownerIsComponent",
                                Json::Bool(owner.as_ref().is_some_and(|(_, symbol)| {
                                    self.summarizer.component_of(*symbol).is_some()
                                })),
                            );
                            json.set("boundaries", Json::Arr(Vec::new()));
                            json.set("span", context.positions.span(spread.span));
                            self.out.push(json);
                        }
                    }
                }
                walk::walk_jsx_opening_element(self, it);
            }
        }
        let mut collector = Collector {
            summarizer: self,
            out: Vec::new(),
        };
        collector.visit_program(self.program);
        Json::Arr(collector.out)
    }

    /// What an `on*` attribute's value is.
    fn classify_handler_value(&self, expression: &Expression<'_>) -> Json {
        let context = self.context;
        let mut json = Json::obj();
        if let Some(index) = self.block_index_of_expression(expression) {
            json.set("kind", Json::str("block"));
            json.set("block", Json::str(format!("b{index}")));
            return json;
        }
        match expression {
            Expression::Identifier(reference) => match context.symbol_of(reference) {
                Some(symbol) => {
                    let flags = context.scoping.symbol_flags(symbol);
                    json.set("kind", Json::str("binding"));
                    json.set("name", Json::str(reference.name.as_str()));
                    json.set(
                        "scope",
                        Json::str(if flags.intersects(SymbolFlags::Import) {
                            "import"
                        } else if context.is_root_symbol(symbol) {
                            "module"
                        } else if context.parameter_of(symbol).is_some() {
                            "param"
                        } else {
                            "local"
                        }),
                    );
                }
                None => {
                    json.set("kind", Json::str("global"));
                    json.set("name", Json::str(reference.name.as_str()));
                }
            },
            Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_) => {
                if let Some(root) = member_chain_root(expression)
                    && is_component_props(context.scoping, context.nodes, root)
                {
                    let keys = member_chain_keys(expression, context.source);
                    json.set("kind", Json::str("propMember"));
                    json.set("root", Json::str(root.name.as_str()));
                    json.set(
                        "path",
                        Json::strings(keys.iter().map(|key| key.trim_matches('"'))),
                    );
                    let owner = context.symbol_of(root).and_then(|symbol| {
                        context.owner_of(context.scoping.symbol_declaration(symbol))
                    });
                    json.set("component", Json::opt_str(owner.map(|(name, _)| name)));
                } else {
                    json.set("kind", Json::str("member"));
                    json.set("text", Json::str(context.text(expression.span())));
                }
            }
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                json.set("kind", Json::str("callback"));
            }
            Expression::ArrayExpression(array) => {
                json.set("kind", Json::str("tuple"));
                json.set(
                    "handler",
                    match array.elements.first() {
                        Some(first)
                            if !matches!(
                                first,
                                oxc_ast::ast::ArrayExpressionElement::SpreadElement(_)
                                    | oxc_ast::ast::ArrayExpressionElement::Elision(_)
                            ) =>
                        {
                            self.classify_handler_value(first.to_expression())
                        }
                        _ => Json::Null,
                    },
                );
            }
            _ => {
                json.set("kind", Json::str("unknown"));
                json.set("text", Json::str(context.text(expression.span())));
            }
        }
        json
    }
}

/// The `span.start` of a JSON entry (for sorting unknowns into source order).
fn span_start(json: &Json) -> i64 {
    if let Json::Obj(entries) = json
        && let Some((_, Json::Obj(span))) = entries.iter().find(|(key, _)| key == "span")
        && let Some((_, Json::Num(start))) = span.iter().find(|(key, _)| key == "start")
    {
        return *start;
    }
    0
}

enum Either<'a, 'p> {
    Function(&'a Function<'p>),
    Variable(&'a oxc_ast::ast::VariableDeclaration<'p>),
}

fn props_of_params(
    params: &oxc_ast::ast::FormalParameters<'_>,
) -> (Option<SymbolId>, &'static str) {
    match params.items.first().map(|param| &param.pattern) {
        Some(BindingPattern::BindingIdentifier(id)) => (id.symbol_id.get(), "identifier"),
        Some(_) => (None, "destructured"),
        None => (None, "none"),
    }
}

fn binding_names(pattern: &BindingPattern<'_>) -> Vec<(String, Option<SymbolId>)> {
    let mut names = Vec::new();
    collect_binding_names(pattern, &mut names);
    names
}

fn collect_binding_names(
    pattern: &BindingPattern<'_>,
    names: &mut Vec<(String, Option<SymbolId>)>,
) {
    match pattern {
        BindingPattern::BindingIdentifier(id) => {
            names.push((id.name.to_string(), id.symbol_id.get()));
        }
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                collect_binding_names(&property.value, names);
            }
            if let Some(rest) = &object.rest {
                collect_binding_names(&rest.argument, names);
            }
        }
        BindingPattern::ArrayPattern(array) => {
            for element in array.elements.iter().flatten() {
                collect_binding_names(element, names);
            }
            if let Some(rest) = &array.rest {
                collect_binding_names(&rest.argument, names);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => {
            collect_binding_names(&assignment.left, names);
        }
    }
}

/// `[{ name, count }]` for a sorted list of referenced symbols (duplicates =
/// multiple references), in first-reference order of the sorted ids,
/// excluding `skip` (a binding's own name in its declaration).
fn ref_counts(context: &Context<'_>, refs: &[SymbolId], skip: Option<SymbolId>) -> Json {
    let mut counts: Vec<(SymbolId, i64)> = Vec::new();
    for symbol in refs {
        if Some(*symbol) == skip {
            continue;
        }
        match counts.last_mut() {
            Some((last, count)) if last == symbol => *count += 1,
            _ => counts.push((*symbol, 1)),
        }
    }
    counts.sort_by_key(|(symbol, _)| context.scoping.symbol_span(*symbol).start);
    Json::Arr(
        counts
            .into_iter()
            .map(|(symbol, count)| {
                let mut json = Json::obj();
                json.set("name", Json::str(context.scoping.symbol_name(symbol)));
                json.set("count", Json::Num(count));
                json
            })
            .collect(),
    )
}

fn symbol_kind(flags: SymbolFlags) -> &'static str {
    if flags.intersects(SymbolFlags::Import) {
        "import"
    } else if flags.intersects(SymbolFlags::Function) {
        "function"
    } else if flags.intersects(SymbolFlags::Class) {
        "class"
    } else if flags.intersects(SymbolFlags::ConstVariable) {
        "const"
    } else if flags.intersects(SymbolFlags::BlockScopedVariable) {
        "let"
    } else if flags.intersects(SymbolFlags::FunctionScopedVariable) {
        "var"
    } else if flags.intersects(SymbolFlags::CatchVariable) {
        "catch"
    } else {
        "other"
    }
}

fn callee_text(context: &Context<'_>, call: &CallExpression<'_>) -> String {
    context.text(call.callee.span()).to_string()
}

fn describe_escape(context: &Context<'_>, kind: AstKind<'_>, node: NodeId) -> String {
    match kind {
        AstKind::CallExpression(call) => format!("argument:{}", callee_text(context, call)),
        AstKind::JSXSpreadAttribute(_) => "jsxSpread".to_string(),
        AstKind::SpreadElement(_) => "spread".to_string(),
        AstKind::VariableDeclarator(_) => "alias".to_string(),
        AstKind::ReturnStatement(_) => "returned".to_string(),
        AstKind::ObjectProperty(_) | AstKind::ArrayExpression(_) => "literal".to_string(),
        AstKind::AssignmentExpression(_) => "assignment".to_string(),
        other => {
            let _ = node;
            other.debug_name().to_string()
        }
    }
}

fn is_type_only_statement(statement: &Statement<'_>) -> bool {
    matches!(
        statement,
        Statement::TSTypeAliasDeclaration(_)
            | Statement::TSInterfaceDeclaration(_)
            | Statement::TSEnumDeclaration(_)
            | Statement::TSExternalModuleDeclaration(_)
            | Statement::TSNamespaceDeclaration(_)
            | Statement::TSGlobalDeclaration(_)
            | Statement::TSImportEqualsDeclaration(_)
            | Statement::TSExportAssignment(_)
            | Statement::TSNamespaceExportDeclaration(_)
            | Statement::EmptyStatement(_)
    ) || matches!(statement, Statement::ExportDeclaration(export)
        if !matches!(export.declaration, Declaration::VariableDeclaration(_) | Declaration::FunctionDeclaration(_) | Declaration::ClassDeclaration(_)))
}

/// Does evaluating this top-level statement do anything besides binding
/// names to values whose construction is inert (literals, functions,
/// classes without static blocks, object/array literals of such values)?
fn statement_has_effects(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::ImportDeclaration(_)
        | Statement::ExportNamedDeclaration(_)
        | Statement::ExportFromDeclaration(_)
        | Statement::ExportAllDeclaration(_)
        | Statement::FunctionDeclaration(_)
        | Statement::EmptyStatement(_) => false,
        Statement::ClassDeclaration(class) => class_has_effects(class),
        Statement::VariableDeclaration(declaration) => {
            declaration.declarations.iter().any(|declarator| {
                !declarator.id.is_binding_identifier()
                    || declarator
                        .init
                        .as_ref()
                        .is_some_and(|init| !expression_is_inert(init))
            })
        }
        Statement::ExportDeclaration(export) => match &export.declaration {
            Declaration::VariableDeclaration(declaration) => {
                declaration.declarations.iter().any(|declarator| {
                    !declarator.id.is_binding_identifier()
                        || declarator
                            .init
                            .as_ref()
                            .is_some_and(|init| !expression_is_inert(init))
                })
            }
            Declaration::FunctionDeclaration(_) => false,
            Declaration::ClassDeclaration(class) => class_has_effects(class),
            _ => false,
        },
        Statement::ExportDefaultDeclaration(export) => match &export.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(_) => false,
            ExportDefaultDeclarationKind::ClassDeclaration(class) => class_has_effects(class),
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => false,
            other => !expression_is_inert(other.to_expression()),
        },
        other => !is_type_only_statement(other),
    }
}

fn class_has_effects(class: &Class<'_>) -> bool {
    class.heritage.is_some()
        || class.body.body.iter().any(|element| {
            matches!(
                element,
                oxc_ast::ast::ClassElement::StaticBlock(_)
            ) || matches!(element, oxc_ast::ast::ClassElement::PropertyDefinition(property) if property.r#static)
        })
}

/// Conservative inertness: no call, no `new`, no member access (getters), no
/// assignment, no tagged template, no `await`/`yield`. A `$(…)` block
/// construction is a call and therefore *not* inert (it captures the owner).
fn expression_is_inert(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BigIntLiteral(_)
        | Expression::RegExpLiteral(_)
        | Expression::StringLiteral(_)
        | Expression::Identifier(_)
        | Expression::ArrowFunctionExpression(_)
        | Expression::FunctionExpression(_)
        | Expression::ThisExpression(_)
        | Expression::ImportMeta(_) => true,
        Expression::ClassExpression(class) => !class_has_effects(class),
        Expression::TemplateLiteral(template) => template
            .expressions
            .iter()
            .all(|expression| expression_is_inert(expression)),
        Expression::ArrayExpression(array) => array.elements.iter().all(|element| match element {
            oxc_ast::ast::ArrayExpressionElement::SpreadElement(_) => false,
            oxc_ast::ast::ArrayExpressionElement::Elision(_) => true,
            other => expression_is_inert(other.to_expression()),
        }),
        Expression::ObjectExpression(object) => {
            object.properties.iter().all(|property| match property {
                oxc_ast::ast::ObjectPropertyKind::ObjectProperty(property) => {
                    !property.computed && expression_is_inert(&property.value)
                }
                oxc_ast::ast::ObjectPropertyKind::SpreadProperty(_) => false,
            })
        }
        Expression::UnaryExpression(unary) => expression_is_inert(&unary.argument),
        Expression::BinaryExpression(binary) => {
            expression_is_inert(&binary.left) && expression_is_inert(&binary.right)
        }
        Expression::LogicalExpression(logical) => {
            expression_is_inert(&logical.left) && expression_is_inert(&logical.right)
        }
        Expression::ConditionalExpression(conditional) => {
            expression_is_inert(&conditional.test)
                && expression_is_inert(&conditional.consequent)
                && expression_is_inert(&conditional.alternate)
        }
        Expression::ParenthesizedExpression(inner) => expression_is_inert(&inner.expression),
        Expression::TSAsExpression(inner) => expression_is_inert(&inner.expression),
        Expression::TSSatisfiesExpression(inner) => expression_is_inert(&inner.expression),
        Expression::TSNonNullExpression(inner) => expression_is_inert(&inner.expression),
        Expression::TSTypeAssertion(inner) => expression_is_inert(&inner.expression),
        Expression::JSXElement(_) | Expression::JSXFragment(_) => false,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Statement-level reference collection
// ---------------------------------------------------------------------------

/// Collects the root-scope symbols referenced anywhere inside one top-level
/// statement, and a top-level `await` (depth 0 of functions).
struct RootRefCollector<'c, 's> {
    context: &'c Context<'s>,
    refs: Vec<SymbolId>,
    top_level_await: Option<Span>,
    depth: usize,
}

impl<'b> Visit<'b> for RootRefCollector<'_, '_> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'b>) {
        if !self.context.is_value_reference(it) {
            return;
        }
        if let Some(symbol) = self.context.symbol_of(it)
            && self.context.is_root_symbol(symbol)
        {
            self.refs.push(symbol);
        }
    }

    fn visit_function(&mut self, it: &Function<'b>, flags: ScopeFlags) {
        self.depth += 1;
        walk::walk_function(self, it, flags);
        self.depth -= 1;
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'b>) {
        self.depth += 1;
        walk::walk_arrow_function_expression(self, it);
        self.depth -= 1;
    }

    fn visit_await_expression(&mut self, it: &oxc_ast::ast::AwaitExpression<'b>) {
        if self.depth == 0 && self.top_level_await.is_none() {
            self.top_level_await = Some(it.span);
        }
        walk::walk_await_expression(self, it);
    }
}

// ---------------------------------------------------------------------------
// Block body walk
// ---------------------------------------------------------------------------

#[derive(Default)]
struct CaptureUse {
    uses: usize,
    assigned: bool,
}

#[derive(Default)]
struct Ops {
    /// `yield* identifier` — a signal accessor, a block, or an op held in a
    /// binding.
    values: Vec<(String, Span)>,
    /// `yield* root.a[0][k]` — `(root, keys, prop)`.
    paths: Vec<(String, Vec<String>, bool, Span)>,
    /// `yield* readStore(store, selector)` — the store text.
    store_reads: Vec<(String, Span)>,
    waits: Vec<Span>,
    raises: Vec<Span>,
    attempts: Vec<(String, Span)>,
    /// `yield* write(target, value)` — the target text.
    writes: Vec<(String, Span)>,
    /// `yield* call(block, input)` — the block text.
    calls: Vec<(String, Span)>,
    /// Anything else yielded with `yield*`: the text.
    unknown_yields: Vec<(String, Span)>,
    plain_yields: Vec<Span>,
    /// `perform(...)` calls (already-lowered input).
    performs: Vec<Span>,
    /// `await` inside the body (an async function body, or a nested async
    /// callback — recorded at any depth).
    awaits: Vec<Span>,
    throws: Vec<Span>,
}

impl Ops {
    fn to_json(&self, context: &Context<'_>) -> Json {
        fn texts(context: &Context<'_>, items: &[(String, Span)], key: &str) -> Json {
            Json::Arr(
                items
                    .iter()
                    .map(|(text, span)| {
                        let mut json = Json::obj();
                        json.set(key, Json::str(text.clone()));
                        json.set("span", context.positions.span(*span));
                        json
                    })
                    .collect(),
            )
        }
        fn spans(context: &Context<'_>, items: &[Span]) -> Json {
            Json::Arr(
                items
                    .iter()
                    .map(|span| context.positions.span(*span))
                    .collect(),
            )
        }
        let mut json = Json::obj();
        json.set("values", texts(context, &self.values, "name"));
        json.set(
            "paths",
            Json::Arr(
                self.paths
                    .iter()
                    .map(|(root, keys, prop, span)| {
                        let mut entry = Json::obj();
                        entry.set("root", Json::str(root.clone()));
                        entry.set("keys", Json::strings(keys.iter().map(String::as_str)));
                        entry.set("prop", Json::Bool(*prop));
                        entry.set("span", context.positions.span(*span));
                        entry
                    })
                    .collect(),
            ),
        );
        json.set("storeReads", texts(context, &self.store_reads, "store"));
        json.set("waits", spans(context, &self.waits));
        json.set("raises", spans(context, &self.raises));
        json.set("attempts", texts(context, &self.attempts, "run"));
        json.set("writes", texts(context, &self.writes, "target"));
        json.set("calls", texts(context, &self.calls, "block"));
        json.set(
            "unknownYields",
            texts(context, &self.unknown_yields, "text"),
        );
        json.set("plainYields", spans(context, &self.plain_yields));
        json.set("performs", spans(context, &self.performs));
        json.set("awaits", spans(context, &self.awaits));
        json.set("throws", spans(context, &self.throws));
        json
    }
}

#[derive(Default)]
struct Escapes {
    this: bool,
    arguments: bool,
    eval: bool,
    new_function: bool,
    with: bool,
    assigns_capture: bool,
    import_meta: bool,
}

impl Escapes {
    fn to_json(&self) -> Json {
        let mut json = Json::obj();
        json.set("this", Json::Bool(self.this));
        json.set("arguments", Json::Bool(self.arguments));
        json.set("eval", Json::Bool(self.eval));
        json.set("newFunction", Json::Bool(self.new_function));
        json.set("with", Json::Bool(self.with));
        json.set("assignsCapture", Json::Bool(self.assigns_capture));
        json.set("importMeta", Json::Bool(self.import_meta));
        json
    }
}

#[derive(Default)]
struct EventUsage {
    prevent_default: Vec<Span>,
    stop_propagation: Vec<Span>,
    stop_immediate_propagation: Vec<Span>,
    return_value: Vec<Span>,
    current_target: Vec<Span>,
    target: Vec<Span>,
    /// Other members read off the event (`key`, `clientX`, …).
    members: Vec<String>,
    /// Members *called* on the event other than the propagation trio
    /// (`composedPath()`, `getModifierState()`): only valid during dispatch.
    methods: Vec<String>,
    /// The event object itself used as a value (passed, stored, returned).
    escapes: Vec<(String, Span)>,
    /// Uses inside nested functions (a callback may run after the handler).
    deferred_uses: usize,
}

impl EventUsage {
    fn to_json(&self) -> Json {
        let mut json = Json::obj();
        json.set(
            "preventDefault",
            Json::Num(self.prevent_default.len() as i64),
        );
        json.set(
            "stopPropagation",
            Json::Num(self.stop_propagation.len() as i64),
        );
        json.set(
            "stopImmediatePropagation",
            Json::Num(self.stop_immediate_propagation.len() as i64),
        );
        json.set("returnValue", Json::Num(self.return_value.len() as i64));
        json.set("currentTarget", Json::Num(self.current_target.len() as i64));
        json.set("target", Json::Num(self.target.len() as i64));
        let mut members = self.members.clone();
        members.sort();
        members.dedup();
        json.set("members", Json::strings(members.iter().map(String::as_str)));
        let mut methods = self.methods.clone();
        methods.sort();
        methods.dedup();
        json.set("methods", Json::strings(methods.iter().map(String::as_str)));
        json.set(
            "escapes",
            Json::strings(self.escapes.iter().map(|(how, _)| how.as_str())),
        );
        json.set("deferredUses", Json::Num(self.deferred_uses as i64));
        json.set(
            "propagationSensitive",
            Json::Bool(
                !self.prevent_default.is_empty()
                    || !self.stop_propagation.is_empty()
                    || !self.stop_immediate_propagation.is_empty()
                    || !self.return_value.is_empty()
                    || !self.escapes.is_empty(),
            ),
        );
        json
    }
}

struct BodyWalker<'c, 's> {
    context: &'c Context<'s>,
    body_scope: Option<ScopeId>,
    /// The first parameter (the event for an event block).
    input: Option<SymbolId>,
    arrow: bool,
    /// Depth inside nested non-arrow functions (`this` / `arguments`).
    function_depth: usize,
    /// Depth inside nested functions of any kind.
    depth: usize,
    jsx_depth: usize,
    ops: Ops,
    captures: BTreeMap<SymbolId, CaptureUse>,
    globals: BTreeMap<String, CaptureUse>,
    escapes: Escapes,
    event: EventUsage,
    nested_blocks: usize,
    dynamic_imports: Vec<(Option<String>, Span)>,
}

impl<'c, 's> BodyWalker<'c, 's> {
    fn is_internal(&self, symbol: SymbolId) -> bool {
        let Some(body_scope) = self.body_scope else {
            return false;
        };
        let scope = self.context.scoping.symbol_scope_id(symbol);
        scope == body_scope
            || self
                .context
                .scoping
                .scope_is_descendant_of(scope, body_scope)
    }

    fn note_reference(&mut self, reference: &IdentifierReference<'_>) {
        let context = self.context;
        if !context.is_value_reference(reference) {
            return;
        }
        let flags = reference
            .reference_id
            .get()
            .map(|id| context.scoping.get_reference(id).flags())
            .unwrap_or(ReferenceFlags::None);
        let assigned = flags.intersects(ReferenceFlags::Write);
        match context.symbol_of(reference) {
            Some(symbol) => {
                if Some(symbol) == self.input {
                    self.note_event_use(reference);
                    return;
                }
                if self.is_internal(symbol) {
                    return;
                }
                let entry = self.captures.entry(symbol).or_default();
                entry.uses += 1;
                if assigned {
                    entry.assigned = true;
                    self.escapes.assigns_capture = true;
                }
            }
            None => {
                let name = reference.name.to_string();
                if name == "eval" {
                    self.escapes.eval = true;
                }
                if name == "arguments" && !self.arrow && self.function_depth == 0 {
                    self.escapes.arguments = true;
                    return;
                }
                if name == "arguments" {
                    return;
                }
                let entry = self.globals.entry(name).or_default();
                entry.uses += 1;
                if assigned {
                    entry.assigned = true;
                }
            }
        }
    }

    /// How the event parameter is used at this reference.
    fn note_event_use(&mut self, reference: &IdentifierReference<'_>) {
        let context = self.context;
        let Some(reference_id) = reference.reference_id.get() else {
            return;
        };
        let node = context.scoping.get_reference(reference_id).node_id();
        if self.depth > 0 {
            self.event.deferred_uses += 1;
        }
        let parent = context.nodes.parent_id(node);
        match context.nodes.get_node(parent).kind() {
            AstKind::StaticMemberExpression(member) if member.object.span() == reference.span => {
                let property = member.property.name.as_str();
                let grandparent = context.nodes.parent_id(parent);
                let grandparent_kind = context.nodes.get_node(grandparent).kind();
                let is_call = matches!(grandparent_kind, AstKind::CallExpression(call) if call.callee.span() == member.span);
                let is_assigned = matches!(grandparent_kind, AstKind::AssignmentExpression(assignment) if assignment.left.span() == member.span);
                match property {
                    "preventDefault" if is_call => self.event.prevent_default.push(member.span),
                    "stopPropagation" if is_call => self.event.stop_propagation.push(member.span),
                    "stopImmediatePropagation" if is_call => {
                        self.event.stop_immediate_propagation.push(member.span)
                    }
                    "returnValue" | "cancelBubble" if is_assigned => {
                        self.event.return_value.push(member.span)
                    }
                    "currentTarget" => self.event.current_target.push(member.span),
                    "target" => self.event.target.push(member.span),
                    other if is_call => self.event.methods.push(other.to_string()),
                    other => self.event.members.push(other.to_string()),
                }
            }
            AstKind::ComputedMemberExpression(_) => {
                self.event.members.push("<computed>".to_string());
            }
            AstKind::CallExpression(call) => {
                self.event.escapes.push((
                    format!("argument:{}", callee_text(context, call)),
                    reference.span,
                ));
            }
            AstKind::VariableDeclarator(_) => {
                self.event
                    .escapes
                    .push(("alias".to_string(), reference.span));
            }
            AstKind::YieldExpression(_) => {
                // `yield* call(props.onClick, event)` — handled by the call;
                // `yield* event` would be an error anyway.
                self.event
                    .escapes
                    .push(("yielded".to_string(), reference.span));
            }
            AstKind::ReturnStatement(_) => {
                self.event
                    .escapes
                    .push(("returned".to_string(), reference.span));
            }
            AstKind::TSAsExpression(_)
            | AstKind::TSNonNullExpression(_)
            | AstKind::ParenthesizedExpression(_) => {
                // Look through the wrapper.
                let wrapper_span = context.nodes.get_node(parent).kind().span();
                let outer = context.nodes.parent_id(parent);
                if let AstKind::StaticMemberExpression(member) =
                    context.nodes.get_node(outer).kind()
                    && member.object.span() == wrapper_span
                {
                    match member.property.name.as_str() {
                        "currentTarget" => self.event.current_target.push(member.span),
                        "target" => self.event.target.push(member.span),
                        other => self.event.members.push(other.to_string()),
                    }
                } else {
                    self.event
                        .escapes
                        .push(("wrapped".to_string(), reference.span));
                }
            }
            other => {
                self.event
                    .escapes
                    .push((other.debug_name().to_string(), reference.span));
            }
        }
    }
}

impl<'b> Visit<'b> for BodyWalker<'_, '_> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'b>) {
        self.note_reference(it);
    }

    fn visit_this_expression(&mut self, _it: &oxc_ast::ast::ThisExpression) {
        if !self.arrow && self.function_depth == 0 {
            self.escapes.this = true;
        }
    }

    fn visit_function(&mut self, it: &Function<'b>, flags: ScopeFlags) {
        self.depth += 1;
        self.function_depth += 1;
        walk::walk_function(self, it, flags);
        self.depth -= 1;
        self.function_depth -= 1;
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'b>) {
        self.depth += 1;
        walk::walk_arrow_function_expression(self, it);
        self.depth -= 1;
    }

    fn visit_jsx_expression_container(&mut self, it: &oxc_ast::ast::JSXExpressionContainer<'b>) {
        self.jsx_depth += 1;
        walk::walk_jsx_expression_container(self, it);
        self.jsx_depth -= 1;
    }

    fn visit_with_statement(&mut self, it: &oxc_ast::ast::WithStatement<'b>) {
        self.escapes.with = true;
        walk::walk_with_statement(self, it);
    }

    fn visit_import_meta(&mut self, _it: &oxc_ast::ast::ImportMeta) {
        self.escapes.import_meta = true;
    }

    fn visit_throw_statement(&mut self, it: &oxc_ast::ast::ThrowStatement<'b>) {
        if self.depth == 0 {
            self.ops.throws.push(it.span);
        }
        walk::walk_throw_statement(self, it);
    }

    fn visit_await_expression(&mut self, it: &oxc_ast::ast::AwaitExpression<'b>) {
        self.ops.awaits.push(it.span);
        walk::walk_await_expression(self, it);
    }

    fn visit_import_expression(&mut self, it: &oxc_ast::ast::ImportExpression<'b>) {
        let source = match &it.source {
            Expression::StringLiteral(literal) => Some(literal.value.to_string()),
            _ => None,
        };
        self.dynamic_imports.push((source, it.span));
        walk::walk_import_expression(self, it);
    }

    fn visit_new_expression(&mut self, it: &oxc_ast::ast::NewExpression<'b>) {
        if let Expression::Identifier(callee) = &it.callee
            && callee.name == "Function"
            && self.context.symbol_of(callee).is_none()
        {
            self.escapes.new_function = true;
        }
        walk::walk_new_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'b>) {
        if self.context.is_adapter_call(it) {
            self.nested_blocks += 1;
        }
        if let Expression::Identifier(callee) = &it.callee
            && self.context.symbol_of(callee).is_none()
        {
            match callee.name.as_str() {
                "eval" => self.escapes.eval = true,
                "require" => self.escapes.eval = true,
                _ => {}
            }
        }
        // Already-lowered input: `_$perform(x)` / `perform(x)`.
        if let Expression::Identifier(callee) = &it.callee
            && (callee.name == "_$perform" || callee.name == "perform")
            && self.depth == 0
        {
            self.ops.performs.push(it.span);
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_yield_expression(&mut self, it: &YieldExpression<'b>) {
        if self.depth > 0 {
            // A nested generator's own yields.
            walk::walk_yield_expression(self, it);
            return;
        }
        if !it.delegate {
            self.ops.plain_yields.push(it.span);
            walk::walk_yield_expression(self, it);
            return;
        }
        let context = self.context;
        match it.argument.as_ref() {
            Some(Expression::Identifier(reference)) => {
                self.ops.values.push((reference.name.to_string(), it.span));
            }
            Some(
                operand @ (Expression::StaticMemberExpression(_)
                | Expression::ComputedMemberExpression(_)),
            ) => match member_chain_root(operand) {
                Some(root) => {
                    let prop = is_component_props(context.scoping, context.nodes, root);
                    let keys = member_chain_keys(operand, context.source)
                        .into_iter()
                        .map(|key| key.trim_matches('"').to_string())
                        .collect();
                    self.ops
                        .paths
                        .push((root.name.to_string(), keys, prop, it.span));
                }
                None => self
                    .ops
                    .unknown_yields
                    .push((context.text(operand.span()).to_string(), it.span)),
            },
            Some(Expression::CallExpression(call)) => {
                let op = context
                    .callee_symbol(call)
                    .and_then(|symbol| context.runtime.op(symbol));
                let argument_text = |index: usize| {
                    call.arguments
                        .get(index)
                        .map(|argument| context.text(argument.span()).to_string())
                        .unwrap_or_default()
                };
                match op {
                    Some("readStore") => self.ops.store_reads.push((argument_text(0), it.span)),
                    Some("wait") => self.ops.waits.push(it.span),
                    Some("raise") => self.ops.raises.push(it.span),
                    Some("attempt") => self.ops.attempts.push((argument_text(0), it.span)),
                    Some("write") => self.ops.writes.push((argument_text(0), it.span)),
                    Some("call") => self.ops.calls.push((argument_text(0), it.span)),
                    _ => self
                        .ops
                        .unknown_yields
                        .push((context.text(call.span).to_string(), it.span)),
                }
            }
            Some(other) => self
                .ops
                .unknown_yields
                .push((context.text(other.span()).to_string(), it.span)),
            None => self.ops.plain_yields.push(it.span),
        }
        walk::walk_yield_expression(self, it);
    }
}

/// The synchronous prelude of an event body: leading statements that a hot
/// shell can replay before deferring the rest — `event.preventDefault()` /
/// `stopPropagation()` / `stopImmediatePropagation()` calls, and early-exit
/// guards `if (<test over the event and literals>) return;`.
fn prelude_json(
    context: &Context<'_>,
    statements: &[Statement<'_>],
    input: Option<SymbolId>,
) -> Json {
    let mut out = Json::Arr(Vec::new());
    let mut end: Option<Span> = None;
    for statement in statements {
        let kind = match statement {
            Statement::ExpressionStatement(expression) => match &expression.expression {
                Expression::CallExpression(call) => match &call.callee {
                    Expression::StaticMemberExpression(member)
                        if matches!(&member.object, Expression::Identifier(root) if context.symbol_of(root) == input && input.is_some())
                            && call.arguments.is_empty() =>
                    {
                        match member.property.name.as_str() {
                            "preventDefault" => Some("preventDefault"),
                            "stopPropagation" => Some("stopPropagation"),
                            "stopImmediatePropagation" => Some("stopImmediatePropagation"),
                            _ => None,
                        }
                    }
                    _ => None,
                },
                _ => None,
            },
            Statement::IfStatement(if_statement) => {
                let returns = match &if_statement.consequent {
                    Statement::ReturnStatement(ret) => ret.argument.is_none(),
                    Statement::BlockStatement(block) => {
                        block.body.len() == 1
                            && matches!(&block.body[0], Statement::ReturnStatement(ret) if ret.argument.is_none())
                    }
                    _ => false,
                };
                if returns
                    && if_statement.alternate.is_none()
                    && expression_over_event(context, &if_statement.test, input)
                {
                    Some("guardReturn")
                } else {
                    None
                }
            }
            _ => None,
        };
        let Some(kind) = kind else {
            break;
        };
        let mut json = Json::obj();
        json.set("kind", Json::str(kind));
        json.set("span", context.positions.span(statement.span()));
        out.push(json);
        end = Some(statement.span());
    }
    let mut prelude = Json::obj();
    prelude.set("statements", out);
    prelude.set(
        "end",
        end.map_or(Json::Null, |span| {
            let (offset, _, _) = context.positions.convert(span.end);
            Json::Num(i64::from(offset))
        }),
    );
    prelude
}

/// An expression that reads only the event parameter (members of it) and
/// literals — safe to evaluate synchronously in a hot shell.
fn expression_over_event(
    context: &Context<'_>,
    expression: &Expression<'_>,
    input: Option<SymbolId>,
) -> bool {
    match expression {
        Expression::Identifier(reference) => {
            context.symbol_of(reference) == input && input.is_some()
        }
        Expression::StaticMemberExpression(member) => {
            !member.optional && expression_over_event(context, &member.object, input)
        }
        Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::StringLiteral(_) => true,
        Expression::TemplateLiteral(template) => template.expressions.is_empty(),
        Expression::UnaryExpression(unary) => {
            expression_over_event(context, &unary.argument, input)
        }
        Expression::BinaryExpression(binary) => {
            expression_over_event(context, &binary.left, input)
                && expression_over_event(context, &binary.right, input)
        }
        Expression::LogicalExpression(logical) => {
            expression_over_event(context, &logical.left, input)
                && expression_over_event(context, &logical.right, input)
        }
        Expression::ParenthesizedExpression(inner) => {
            expression_over_event(context, &inner.expression, input)
        }
        Expression::TSAsExpression(inner) => {
            expression_over_event(context, &inner.expression, input)
        }
        Expression::TSNonNullExpression(inner) => {
            expression_over_event(context, &inner.expression, input)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summarize(source: &str) -> String {
        summarize_module(source, Some("src/app.tsx")).expect("summary")
    }

    #[test]
    fn records_blocks_sites_and_captures() {
        let json = summarize(
            r#"
import { $, attempt, write, createSignal } from "solid-js";
import { save } from "./api";
export function Editor(props) {
  const [count, setCount] = createSignal(0);
  const submit = $(function* (e) {
    e.preventDefault();
    if (e.key !== "Enter") return;
    const c = yield* count;
    yield* write(setCount, c + 1);
    yield* attempt(() => save(props.id, e.currentTarget.value));
  });
  return <form onSubmit={submit}><Child onPress={submit} /></form>;
}
"#,
        );
        assert!(json.contains("\"schema\":\"solid-behavior-summary\""));
        assert!(json.contains("\"kind\":\"domEvent\""));
        assert!(json.contains("\"event\":\"submit\""));
        assert!(json.contains("\"kind\":\"componentProp\""));
        assert!(json.contains("\"name\":\"count\",\"scope\":\"local\""));
        assert!(json.contains("\"name\":\"save\",\"scope\":\"import\""));
        assert!(json.contains("\"preventDefault\":1"));
        assert!(json.contains("\"kind\":\"guardReturn\""));
        assert!(json.contains("\"propagationSensitive\":true"));
    }

    #[test]
    fn records_unknowns() {
        let json = summarize(
            r#"
export * from "./all";
const mod = await import(name);
"#,
        );
        assert!(json.contains("\"kind\":\"exportStar\""));
        assert!(json.contains("\"kind\":\"dynamicImportNonLiteral\""));
        assert!(json.contains("\"kind\":\"topLevelAwait\""));
    }

    #[test]
    fn positions_are_utf16() {
        let json = summarize("const s = \"é\"; export const x = 1;\n");
        // `x` is at byte 29 but UTF-16 offset 28.
        assert!(json.contains("\"name\":\"x\",\"kind\":\"const\",\"span\":{\"start\":28"));
    }
}
