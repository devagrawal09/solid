//! Track A, stage 2: per-module capability summaries for the whole-graph
//! async-freedom proof.
//!
//! `summarize_capabilities` reads one module and reports, as JSON, the facts
//! the capability linker (`@solidjs/compiler/capabilities`) joins over a
//! complete client or server module graph:
//!
//! - `imports` / `reexports` / `dynamicImports` — the module's edges, with the
//!   imported names (the linker checks named imports of library modules
//!   against their capability manifests, and follows relative edges);
//! - `computes` — every reactive host call (`createMemo`, `createSignal(fn)`,
//!   `createEffect`, `createRenderEffect`, `createStore(fn)`,
//!   `createProjection`) resolved by symbol to a runtime import, with the
//!   local synchrony proof of its compute: a `$` block proven `BLOCK_SYNC`, a
//!   plain function whose every returned value is proven plain, or an
//!   identifier bound to such a block. `async` functions and blocks that wait
//!   are `async`; everything else is `unproven` — the linker then asks the
//!   typed summary (`solid-tsc --capabilities`) for a verdict at the same
//!   position;
//! - `componentProps` — every attribute of a JSX element whose tag is an
//!   import from a library module (`<Show when={…}>`), with the same local
//!   proof: library manifests name the props an async-aware internal
//!   computation consumes.
//!
//! Positions are UTF-16 offsets into the authored source (the typecheck
//! projection's convention), so typed facts join on `start`.
//!
//! The summary makes no whole-graph claim itself; missing information is
//! reported, never guessed.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, CallExpression, Expression, ImportDeclarationSpecifier, ImportOrExportKind,
    JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXElementName, JSXOpeningElement,
    ModuleExportName, Statement, VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{AstNodes, Scoping, SemanticBuilder, SymbolId};
use oxc_span::GetSpan;
use oxc_syntax::scope::{ScopeFlags, ScopeId};
use std::cell::Cell;

use crate::block_proofs::{BLOCK_SYNC, ProofSymbols, Prover};
use crate::compiler::{parse_program, source_type_for_filename};
use crate::error::CompileError;

/// Modules whose named exports are the block runtime and reactive hosts.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
/// Reactive hosts whose first argument is a compute.
const HOSTS: &[&str] = &[
    "createMemo",
    "createSignal",
    "createEffect",
    "createRenderEffect",
    "createStore",
    "createProjection",
];

pub fn summarize_capabilities(
    source: &str,
    filename: Option<&str>,
) -> Result<String, CompileError> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename)?;
    let program = parse_program(&allocator, source, source_type)?;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();

    let mut json = JsonWriter::default();
    json.begin_object();
    json.key("schema");
    json.number(1);

    // --- edges -------------------------------------------------------------
    let mut imports: Vec<(SymbolId, String, String)> = Vec::new();
    json.key("imports");
    json.begin_array();
    for statement in &program.body {
        let Statement::ImportDeclaration(import) = statement else {
            continue;
        };
        json.begin_object();
        json.key("source");
        json.string(import.source.value.as_str());
        json.key("typeOnly");
        json.boolean(import.import_kind == ImportOrExportKind::Type);
        json.key("names");
        json.begin_array();
        for specifier in import.specifiers.iter().flatten() {
            let (imported, local) = match specifier {
                ImportDeclarationSpecifier::ImportSpecifier(s) => {
                    if s.import_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    (s.imported.name().to_string(), &s.local)
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                    ("default".into(), &s.local)
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => ("*".into(), &s.local),
            };
            json.string(&imported);
            if import.import_kind != ImportOrExportKind::Type
                && let Some(symbol) = local.symbol_id.get()
            {
                imports.push((symbol, import.source.value.to_string(), imported));
            }
        }
        json.end_array();
        json.end_object();
    }
    json.end_array();

    json.key("reexports");
    json.begin_array();
    for statement in &program.body {
        match statement {
            Statement::ExportFromDeclaration(export) => {
                json.begin_object();
                json.key("source");
                json.string(export.source.value.as_str());
                json.key("typeOnly");
                json.boolean(export.export_kind == ImportOrExportKind::Type);
                json.key("names");
                json.begin_array();
                for specifier in &export.specifiers {
                    if specifier.export_kind == ImportOrExportKind::Type {
                        continue;
                    }
                    json.string(&export_name(&specifier.local));
                }
                json.end_array();
                json.end_object();
            }
            Statement::ExportAllDeclaration(export) => {
                json.begin_object();
                json.key("source");
                json.string(export.source.value.as_str());
                json.key("typeOnly");
                json.boolean(export.export_kind == ImportOrExportKind::Type);
                json.key("names");
                json.begin_array();
                json.string("*");
                json.end_array();
                json.end_object();
            }
            _ => {}
        }
    }
    json.end_array();

    // --- computes and component props ---------------------------------------
    let symbols_of = |names: &[&str]| -> Vec<SymbolId> {
        imports
            .iter()
            .filter(|(_, source, imported)| {
                RUNTIME_SOURCES.contains(&source.as_str()) && names.contains(&imported.as_str())
            })
            .map(|(symbol, _, _)| *symbol)
            .collect()
    };
    let prover = Prover::new(
        scoping,
        nodes,
        ProofSymbols {
            create_signal: symbols_of(&["createSignal"]),
            create_memo: symbols_of(&["createMemo"]),
            adapter: symbols_of(&["$"]),
        },
        source_type.is_typescript(),
        true,
    );
    let mut summarizer = Summarizer {
        scoping,
        nodes,
        source,
        imports: &imports,
        prover,
        scopes: Vec::new(),
        computes: JsonWriter::default(),
        props: JsonWriter::default(),
        dynamic: JsonWriter::default(),
    };
    summarizer.computes.begin_array();
    summarizer.props.begin_array();
    summarizer.dynamic.begin_array();
    summarizer.visit_program(&program);
    summarizer.computes.end_array();
    summarizer.props.end_array();
    summarizer.dynamic.end_array();

    json.key("computes");
    json.raw(&summarizer.computes.out);
    json.key("componentProps");
    json.raw(&summarizer.props.out);
    json.key("dynamicImports");
    json.raw(&summarizer.dynamic.out);
    json.end_object();
    Ok(json.out)
}

fn export_name(name: &ModuleExportName<'_>) -> String {
    name.name().to_string()
}

struct Summarizer<'s, 'i> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'s>,
    source: &'s str,
    /// (local symbol, source module, imported name).
    imports: &'i [(SymbolId, String, String)],
    prover: Prover<'s>,
    scopes: Vec<ScopeId>,
    computes: JsonWriter,
    props: JsonWriter,
    dynamic: JsonWriter,
}

impl Summarizer<'_, '_> {
    fn import_of(&self, expression: &Expression<'_>) -> Option<(&str, &str)> {
        let Expression::Identifier(identifier) = expression else {
            return None;
        };
        self.import_of_reference(identifier)
    }

    fn import_of_reference(
        &self,
        identifier: &oxc_ast::ast::IdentifierReference<'_>,
    ) -> Option<(&str, &str)> {
        let symbol = identifier
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())?;
        self.imports
            .iter()
            .find(|(s, _, _)| *s == symbol)
            .map(|(_, source, imported)| (source.as_str(), imported.as_str()))
    }

    fn position(&self, start: u32) -> (usize, usize) {
        let prefix = &self.source[..(start as usize).min(self.source.len())];
        let utf16 = prefix.encode_utf16().count();
        let line = prefix.matches('\n').count() + 1;
        (utf16, line)
    }

    /// The local proof of one compute argument.
    fn compute_proof(
        &mut self,
        host: &CallExpression<'_>,
        argument: &Argument<'_>,
    ) -> (&'static str, &'static str) {
        match argument {
            Argument::CallExpression(block)
                if self.import_of(&block.callee).is_some_and(|(source, name)| {
                    RUNTIME_SOURCES.contains(&source) && name == "$"
                }) =>
            {
                let Some(Argument::FunctionExpression(function)) = block.arguments.first() else {
                    return ("unproven", "block body is not an inline function");
                };
                if function.r#async {
                    return ("async", "async generator block");
                }
                if !function.generator {
                    return if self
                        .prover
                        .function_returns_plain(host.span.start, function)
                    {
                        ("sync", "call-form block with plain results")
                    } else {
                        ("unproven", "call-form block result not proven plain")
                    };
                }
                if contains_wait(function) {
                    return ("async", "block waits (`yield* wait`)");
                }
                let proof = self.prover.prove(block, function);
                if proof.flags & BLOCK_SYNC != 0 {
                    ("sync", "block proven BLOCK_SYNC")
                } else {
                    ("unproven", "block result not proven plain")
                }
            }
            Argument::FunctionExpression(function) => {
                if function.r#async {
                    ("async", "async compute function")
                } else if function.generator {
                    ("async", "generator compute function")
                } else if self
                    .prover
                    .function_returns_plain(host.span.start, function)
                {
                    ("sync", "every returned value proven plain")
                } else {
                    ("unproven", "returned value not proven plain")
                }
            }
            Argument::ArrowFunctionExpression(arrow) => {
                if arrow.r#async {
                    ("async", "async compute function")
                } else if self.prover.arrow_returns_plain(host.span.start, arrow) {
                    ("sync", "every returned value proven plain")
                } else {
                    ("unproven", "returned value not proven plain")
                }
            }
            Argument::Identifier(identifier) => {
                // A `$` block held in a const declared earlier.
                match self.block_binding(identifier) {
                    Some(true) => ("sync", "bound block proven BLOCK_SYNC"),
                    Some(false) => ("unproven", "bound block not proven"),
                    None => (
                        "unproven",
                        "compute is a binding the compiler cannot see through",
                    ),
                }
            }
            _ => ("unproven", "compute is not a function or block"),
        }
    }

    /// `const block = $(function* …)`: the block's proof (proven earlier in
    /// source order, since the binding is declared before its use).
    fn block_binding(&self, identifier: &oxc_ast::ast::IdentifierReference<'_>) -> Option<bool> {
        let symbol = identifier
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())?;
        let declaration = self.scoping.symbol_declaration(symbol);
        let oxc_ast::AstKind::VariableDeclarator(declarator) =
            self.nodes.get_node(declaration).kind()
        else {
            return None;
        };
        let parent = self.nodes.parent_id(declaration);
        if !matches!(
            self.nodes.get_node(parent).kind(),
            oxc_ast::AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const
        ) {
            return None;
        }
        let Some(Expression::CallExpression(block)) = &declarator.init else {
            return None;
        };
        let proof = self.prover.proof_of(block.span)?;
        Some(proof.flags & BLOCK_SYNC != 0)
    }

    fn record_compute(&mut self, host: &str, start: u32, proof: &str, reason: &str) {
        let (offset, line) = self.position(start);
        let w = &mut self.computes;
        w.begin_object();
        w.key("host");
        w.string(host);
        w.key("start");
        w.number(offset as u64);
        w.key("line");
        w.number(line as u64);
        w.key("proof");
        w.string(proof);
        w.key("reason");
        w.string(reason);
        w.end_object();
    }
}

impl<'a> Visit<'a> for Summarizer<'_, '_> {
    fn enter_scope(&mut self, _flags: ScopeFlags, scope_id: &Cell<Option<ScopeId>>) {
        if let Some(id) = scope_id.get() {
            self.scopes.push(id);
        }
    }

    fn leave_scope(&mut self) {
        self.scopes.pop();
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        // Blocks are proven in source order as the walk reaches them (so a
        // memo over a proven block is known before a later read of it).
        let is_block = self
            .import_of(&call.callee)
            .is_some_and(|(source, name)| RUNTIME_SOURCES.contains(&source) && name == "$");
        if is_block
            && let Some(Argument::FunctionExpression(function)) = call.arguments.first()
            && function.generator
            && !function.r#async
            && !contains_wait(function)
            && self.prover.proof_of(call.span).is_none()
        {
            self.prover.prove(call, function);
        }
        let host = self
            .import_of(&call.callee)
            .filter(|(source, name)| RUNTIME_SOURCES.contains(source) && HOSTS.contains(name))
            .map(|(_, name)| name.to_string());
        walk::walk_call_expression(self, call);
        let Some(host) = host else {
            return;
        };
        let Some(argument) = call.arguments.first() else {
            return;
        };
        // `createSignal(value)` / `createStore(value)`: not a computation.
        let computed_form = matches!(
            argument,
            Argument::FunctionExpression(_)
                | Argument::ArrowFunctionExpression(_)
                | Argument::CallExpression(_)
                | Argument::Identifier(_)
        );
        if (host == "createSignal" || host == "createStore") && !computed_form {
            return;
        }
        if (host == "createSignal" || host == "createStore")
            && let Argument::CallExpression(inner) = argument
            && !self
                .import_of(&inner.callee)
                .is_some_and(|(source, name)| RUNTIME_SOURCES.contains(&source) && name == "$")
        {
            // `createSignal(makeInitial())`: a value unless the call returns a
            // function — unknowable here.
            let start = argument.span().start;
            self.record_compute(&host, start, "unproven", "value-or-compute call argument");
            return;
        }
        if (host == "createSignal" || host == "createStore")
            && let Argument::Identifier(identifier) = argument
            && self.block_binding(identifier).is_none()
        {
            let start = argument.span().start;
            self.record_compute(
                &host,
                start,
                "unproven",
                "value-or-compute binding argument",
            );
            return;
        }
        let (proof, reason) = self.compute_proof(call, argument);
        let start = argument.span().start;
        self.record_compute(&host, start, proof, reason);
    }

    fn visit_import_expression(&mut self, it: &oxc_ast::ast::ImportExpression<'a>) {
        let (offset, line) = self.position(it.span.start);
        let w = &mut self.dynamic;
        w.begin_object();
        w.key("source");
        match &it.source {
            Expression::StringLiteral(literal) => w.string(literal.value.as_str()),
            _ => w.null(),
        }
        w.key("start");
        w.number(offset as u64);
        w.key("line");
        w.number(line as u64);
        w.end_object();
        walk::walk_import_expression(self, it);
    }

    fn visit_jsx_opening_element(&mut self, it: &JSXOpeningElement<'a>) {
        let component = match &it.name {
            JSXElementName::IdentifierReference(reference) => self
                .import_of_reference(reference)
                .map(|(source, name)| (source.to_string(), name.to_string())),
            _ => None,
        };
        if let Some((source, name)) = component {
            let scope = self.scopes.last().copied();
            for attribute in &it.attributes {
                let JSXAttributeItem::Attribute(attribute) = attribute else {
                    // A spread can carry any prop: recorded as unproven `*`.
                    let (offset, line) = self.position(attribute.span().start);
                    let w = &mut self.props;
                    w.begin_object();
                    w.key("source");
                    w.string(&source);
                    w.key("component");
                    w.string(&name);
                    w.key("prop");
                    w.string("*");
                    w.key("start");
                    w.number(offset as u64);
                    w.key("line");
                    w.number(line as u64);
                    w.key("proof");
                    w.string("unproven");
                    w.end_object();
                    continue;
                };
                let prop = match &attribute.name {
                    JSXAttributeName::Identifier(id) => id.name.to_string(),
                    JSXAttributeName::NamespacedName(n) => {
                        format!("{}:{}", n.namespace.name, n.name.name)
                    }
                };
                let (start, proof) = match &attribute.value {
                    None | Some(JSXAttributeValue::StringLiteral(_)) => {
                        (attribute.span.start, "sync")
                    }
                    Some(JSXAttributeValue::ExpressionContainer(container)) => {
                        match container.expression.as_expression() {
                            Some(expression) => (
                                expression.span().start,
                                if scope
                                    .is_some_and(|s| self.prover.expression_plain(s, expression))
                                {
                                    "sync"
                                } else {
                                    "unproven"
                                },
                            ),
                            None => (attribute.span.start, "sync"),
                        }
                    }
                    Some(JSXAttributeValue::Element(_)) | Some(JSXAttributeValue::Fragment(_)) => {
                        (attribute.span.start, "unproven")
                    }
                };
                let (offset, line) = self.position(start);
                let w = &mut self.props;
                w.begin_object();
                w.key("source");
                w.string(&source);
                w.key("component");
                w.string(&name);
                w.key("prop");
                w.string(&prop);
                w.key("start");
                w.number(offset as u64);
                w.key("line");
                w.number(line as u64);
                w.key("proof");
                w.string(proof);
                w.end_object();
            }
        }
        walk::walk_jsx_opening_element(self, it);
    }
}

/// Whether a generator block's body (nested functions excluded) delegates to
/// `wait(...)` — the only suspension; such a block stays with the runtime
/// driver and its host becomes asynchronous.
fn contains_wait(function: &oxc_ast::ast::Function<'_>) -> bool {
    struct Finder(bool);
    impl<'a> Visit<'a> for Finder {
        fn visit_function(&mut self, _it: &oxc_ast::ast::Function<'a>, _flags: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _it: &oxc_ast::ast::ArrowFunctionExpression<'a>,
        ) {
        }
        fn visit_yield_expression(&mut self, it: &oxc_ast::ast::YieldExpression<'a>) {
            if it.delegate
                && let Some(Expression::CallExpression(call)) = it.argument.as_ref()
                && matches!(&call.callee, Expression::Identifier(id) if id.name == "wait")
            {
                self.0 = true;
            }
            walk::walk_yield_expression(self, it);
        }
    }
    let mut finder = Finder(false);
    if let Some(body) = function.body.as_ref() {
        finder.visit_function_body(body);
    }
    finder.0
}

/// A minimal JSON writer (the crate carries no serde).
#[derive(Default)]
struct JsonWriter {
    out: String,
    /// Per open container: whether the next element is its first.
    first: Vec<bool>,
    /// A key was just written: the next value takes no separator.
    after_key: bool,
}

impl JsonWriter {
    fn separator(&mut self) {
        if self.after_key {
            self.after_key = false;
            return;
        }
        if let Some(first) = self.first.last_mut() {
            if !*first {
                self.out.push(',');
            }
            *first = false;
        }
    }

    fn begin_object(&mut self) {
        self.separator();
        self.out.push('{');
        self.first.push(true);
    }

    fn end_object(&mut self) {
        self.first.pop();
        self.out.push('}');
    }

    fn begin_array(&mut self) {
        self.separator();
        self.out.push('[');
        self.first.push(true);
    }

    fn end_array(&mut self) {
        self.first.pop();
        self.out.push(']');
    }

    fn key(&mut self, key: &str) {
        self.separator();
        self.push_string(key);
        self.out.push(':');
        self.after_key = true;
    }

    fn string(&mut self, value: &str) {
        self.separator();
        self.push_string(value);
    }

    fn number(&mut self, value: u64) {
        self.separator();
        self.out.push_str(&value.to_string());
    }

    fn boolean(&mut self, value: bool) {
        self.separator();
        self.out.push_str(if value { "true" } else { "false" });
    }

    fn null(&mut self) {
        self.separator();
        self.out.push_str("null");
    }

    /// An already-serialized value.
    fn raw(&mut self, json: &str) {
        self.separator();
        self.out.push_str(json);
    }

    fn push_string(&mut self, value: &str) {
        self.out.push('"');
        for c in value.chars() {
            match c {
                '"' => self.out.push_str("\\\""),
                '\\' => self.out.push_str("\\\\"),
                '\n' => self.out.push_str("\\n"),
                '\r' => self.out.push_str("\\r"),
                '\t' => self.out.push_str("\\t"),
                c if (c as u32) < 0x20 => self.out.push_str(&format!("\\u{:04x}", c as u32)),
                c => self.out.push(c),
            }
        }
        self.out.push('"');
    }
}
