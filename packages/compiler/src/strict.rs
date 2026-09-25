//! Strict, generator-free `$` callbacks.
//!
//! `$(fn)` with an ordinary (non-generator) arrow or function expression is a
//! *marker*: it asks the compiler to compile `fn` strictly for the host that
//! consumes it. The marker is not a runtime host, a memo, an effect or an
//! event — the statically known consumer decides:
//!
//! ```tsx
//! const doubled = createMemo($(() => count() * 2));        // host: memo
//! createEffect($(() => count()), value => log(value));    // host: effect (compute phase)
//! const [c] = createSignal($(() => count() + 1));         // host: signal (computed)
//! <button onClick={$(() => setCount(v => v + 1))} />      // host: event
//! const inc = $(() => setCount(v => v + 1));              // host: every use site
//! <button onClick={inc} />
//! ```
//!
//! The source is ordinary TypeScript/TSX: `count()` is a graph read,
//! `setCount(v)` a write, `createSignal(...)` an owned creation, `await` an
//! ordinary suspension. The pass analyzes the body against the host and
//! either **erases the marker** (`createMemo(() => count() * 2)` — plain
//! Solid, with runtime tracking, scheduling, equality, ownership and error
//! behavior untouched) and records the static graph in a sidecar summary, or
//! fails the build with a source-located `[STRICT_…]` diagnostic. A marked
//! callback never reaches the generator driver or any other fallback runtime.
//!
//! Generator blocks (`$(function* …)`) are untouched by this pass; they keep
//! the lowering in `generators.rs`.
//!
//! # Rules (this slice)
//!
//! - Host: the first argument of `createMemo` / `createSignal` /
//!   `createEffect` / `createRenderEffect` imported from a runtime source, the
//!   value of an `on*` / `on:*` attribute on an intrinsic JSX element, or a
//!   `const` binding whose every reference is one of those (one host kind).
//!   Anything else — an unknown callee, a component prop, an export, a `let`,
//!   a value use — is `[STRICT_HOST_UNKNOWN]` / `[STRICT_HOST_AMBIGUOUS]`.
//! - Reads: a call of a known accessor (`createSignal` / `createMemo` /
//!   `createOptimistic` / computed `createSignal` bindings), a member chain on
//!   a known store (`createStore` / `createProjection` / `createOptimisticStore`)
//!   or on a component's props parameter, or on a `const` alias of such a
//!   chain. Conditional, looped, closured and JSX-embedded reads are
//!   `bounded`; straight-line reads are `exact`.
//! - Writes: a call of a known setter. Refused in reactive hosts.
//! - Creations: calls of known runtime factories. Refused after `await`.
//! - Unknown helpers: allowed with plain arguments; passing an accessor,
//!   setter, store (or a store path), props, a marked callback, a closure that
//!   captures one of those, or an unsummarized import is an escape and is
//!   refused. Calls are recorded so a consumer knows the graph is `bounded`.
//! - Async: reads before the first `await` are the reactive parent's
//!   dependencies; a reactive read after `await` is refused. Events are
//!   untracked hosts: reads are recorded but never dependencies.
//! - `useContext` inside a marked callback is refused; `this`, `super`,
//!   `arguments` and classes are unsupported.

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, BindingPattern, CallExpression, ChainElement, Class,
    Expression, FormalParameters, Function, IdentifierReference, ImportDeclarationSpecifier,
    ImportOrExportKind, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXElementName,
    Program, SimpleAssignmentTarget, Statement, VariableDeclarationKind, VariableDeclarator,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::operator::UnaryOperator;
use oxc_syntax::scope::ScopeFlags;

use crate::compiler::{parse_program, source_type_for_filename};
use crate::error::CompileError;
use crate::shared::ast_builder::AstBuilder;

/// Modules whose named exports are the reactive runtime.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];

/// Runtime factories whose first argument may be a marked callback, with the
/// host kind that argument runs under.
const HOST_FACTORIES: &[(&str, HostKind)] = &[
    ("createMemo", HostKind::Memo),
    ("createSignal", HostKind::Signal),
    ("createEffect", HostKind::Effect),
    ("createRenderEffect", HostKind::RenderEffect),
];

/// Runtime factories that create owned reactive nodes or registrations.
const CREATION_FACTORIES: &[&str] = &[
    "createSignal",
    "createMemo",
    "createEffect",
    "createRenderEffect",
    "createTrackedEffect",
    "createStore",
    "createProjection",
    "createOptimistic",
    "createOptimisticStore",
    "createRoot",
    "createContext",
    "createErrorBoundary",
    "createLoadingBoundary",
    "onCleanup",
    "onMount",
    "onSettled",
];

// --- public summary contract -------------------------------------------------------

/// A source location: UTF-16 offsets (TypeScript's unit) plus 1-based line and
/// column (in characters).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StrictSite {
    pub start: u32,
    pub end: u32,
    pub line: u32,
    pub column: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictDiagnostic {
    pub code: String,
    pub message: String,
    pub site: StrictSite,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StrictHost {
    /// `memo` | `signal` | `effect` | `render-effect` | `event`, or `unknown`
    /// when host resolution failed.
    pub kind: String,
    /// The runtime factory for reactive hosts.
    pub factory: Option<String>,
    /// The bound DOM event names for event hosts.
    pub events: Vec<String>,
    /// Every site that consumes the callback.
    pub sites: Vec<StrictSite>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictRead {
    /// `signal` (an accessor call), `store` (a store path), `prop` (a props path).
    pub kind: String,
    pub root: String,
    pub path: Vec<String>,
    /// `path` (the path's value) or `structural` (a method called on the path).
    pub access: String,
    /// `exact` (every normal run performs it) or `bounded` (a possible read).
    pub certainty: String,
    /// False in event hosts, inside `untrack`, and after the first `await`.
    pub tracked: bool,
    pub after_await: bool,
    pub site: StrictSite,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictWrite {
    /// `signal` or `store`.
    pub kind: String,
    pub target: String,
    pub certainty: String,
    pub after_await: bool,
    pub site: StrictSite,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictCreation {
    pub factory: String,
    /// The callback handed to the factory is itself a marked callback (with
    /// its own summary) rather than an unanalyzed ordinary callback.
    pub marked: bool,
    pub certainty: String,
    pub after_await: bool,
    pub site: StrictSite,
}

/// A call the compiler has no summary for (allowed with plain arguments).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictCall {
    pub callee: String,
    pub certainty: String,
    pub after_await: bool,
    pub site: StrictSite,
}

/// A use of a binding the compiler cannot classify (an import, a context
/// value, a mutable outer variable): allowed locally, refused as an argument.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictOpaque {
    pub name: String,
    pub site: StrictSite,
}

/// A capability that left the callback (refused in strict mode).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictEscape {
    pub kind: String,
    pub name: String,
    pub site: StrictSite,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StrictBlockSummary {
    /// `<filename>#<index>` (index in source order).
    pub id: String,
    pub host: StrictHost,
    pub marker: StrictSite,
    pub callback: StrictSite,
    pub is_async: bool,
    pub awaits: Vec<StrictSite>,
    pub reads: Vec<StrictRead>,
    pub writes: Vec<StrictWrite>,
    pub creations: Vec<StrictCreation>,
    pub calls: Vec<StrictCall>,
    pub opaque: Vec<StrictOpaque>,
    pub escapes: Vec<StrictEscape>,
    /// `exact` | `bounded` | `unknown`.
    pub completeness: String,
    pub diagnostics: Vec<StrictDiagnostic>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StrictAnalysis {
    pub blocks: Vec<StrictBlockSummary>,
    /// Every diagnostic (block diagnostics plus host-resolution failures), in
    /// source order.
    pub diagnostics: Vec<StrictDiagnostic>,
}

/// Analyze every marked callback in `source` without rewriting anything.
pub fn analyze_strict_blocks(
    source: &str,
    filename: Option<&str>,
) -> Result<StrictAnalysis, CompileError> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename)?;
    let program = parse_program(&allocator, source, source_type)?;
    let (analysis, _, _) = analyze(&program, source, filename.unwrap_or("input"));
    Ok(analysis)
}

/// Compile every marked callback in `program` in place: analyze, and erase
/// the markers when every callback compiled. Returns the analysis (for the
/// output sidecar), `None` when the module has no marked callback, or the
/// first diagnostic as a compile error string.
pub(crate) fn transform_strict_blocks<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &'a str,
    filename: Option<&str>,
    resumable: Option<&crate::resumable::ResumableConfig>,
) -> Result<(Option<StrictAnalysis>, Option<crate::resumable::Plan>), String> {
    if !imports_marker(program) {
        return Ok((None, None));
    }
    let (analysis, markers, block_spans) = analyze(program, source, filename.unwrap_or("input"));
    if let Some(diagnostic) = analysis.diagnostics.first() {
        return Err(format!(
            "[{}] {} ({}:{})",
            diagnostic.code, diagnostic.message, diagnostic.site.line, diagnostic.site.column
        ));
    }
    if markers.is_empty() {
        return Ok((None, None));
    }
    // Resumable events plan against the authored program (markers intact,
    // callbacks and host sites at their analyzed spans), before erasure.
    let plan = match resumable {
        Some(config) => Some(crate::resumable::analyze(
            program,
            source,
            filename.unwrap_or("input"),
            &analysis,
            &block_spans,
            config,
        )?),
        None => None,
    };
    let mut rewriter = Eraser { allocator, markers };
    rewriter.visit_program(program);
    Ok((Some(analysis), plan))
}

/// Cheap syntactic gate: is `$` imported by name from a runtime source?
fn imports_marker(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return false;
        };
        RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.specifiers.iter().flatten().any(|specifier| {
                matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if specifier.imported.name() == "$"
                )
            })
    })
}

// --- JSON ------------------------------------------------------------------------------

impl StrictAnalysis {
    /// The summary as JSON (camelCase keys): the sidecar shape `solid-tsc`
    /// and editor tooling consume.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        out.push_str("{\"version\":1,\"blocks\":[");
        for (i, block) in self.blocks.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            block.write_json(&mut out);
        }
        out.push_str("],\"diagnostics\":[");
        write_diagnostics(&mut out, &self.diagnostics);
        out.push_str("]}");
        out
    }
}

fn write_diagnostics(out: &mut String, diagnostics: &[StrictDiagnostic]) {
    for (i, diagnostic) in diagnostics.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"code\":");
        json_string(out, &diagnostic.code);
        out.push_str(",\"message\":");
        json_string(out, &diagnostic.message);
        out.push_str(",\"site\":");
        diagnostic.site.write_json(out);
        out.push('}');
    }
}

fn write_sites(out: &mut String, sites: &[StrictSite]) {
    for (i, site) in sites.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        site.write_json(out);
    }
}

fn write_strings(out: &mut String, strings: &[String]) {
    for (i, string) in strings.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_string(out, string);
    }
}

impl StrictSite {
    pub(crate) fn write_json(&self, out: &mut String) {
        out.push_str(&format!(
            "{{\"start\":{},\"end\":{},\"line\":{},\"column\":{}}}",
            self.start, self.end, self.line, self.column
        ));
    }
}

impl StrictBlockSummary {
    fn write_json(&self, out: &mut String) {
        out.push_str("{\"id\":");
        json_string(out, &self.id);
        out.push_str(",\"host\":{\"kind\":");
        json_string(out, &self.host.kind);
        out.push_str(",\"factory\":");
        match &self.host.factory {
            Some(factory) => json_string(out, factory),
            None => out.push_str("null"),
        }
        out.push_str(",\"events\":[");
        write_strings(out, &self.host.events);
        out.push_str("],\"sites\":[");
        write_sites(out, &self.host.sites);
        out.push_str("]},\"marker\":");
        self.marker.write_json(out);
        out.push_str(",\"callback\":");
        self.callback.write_json(out);
        out.push_str(&format!(",\"async\":{},\"awaits\":[", self.is_async));
        write_sites(out, &self.awaits);
        out.push_str("],\"reads\":[");
        for (i, read) in self.reads.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"kind\":");
            json_string(out, &read.kind);
            out.push_str(",\"root\":");
            json_string(out, &read.root);
            out.push_str(",\"path\":[");
            write_strings(out, &read.path);
            out.push_str("],\"access\":");
            json_string(out, &read.access);
            out.push_str(",\"certainty\":");
            json_string(out, &read.certainty);
            out.push_str(&format!(
                ",\"tracked\":{},\"afterAwait\":{},\"site\":",
                read.tracked, read.after_await
            ));
            read.site.write_json(out);
            out.push('}');
        }
        out.push_str("],\"writes\":[");
        for (i, write) in self.writes.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"kind\":");
            json_string(out, &write.kind);
            out.push_str(",\"target\":");
            json_string(out, &write.target);
            out.push_str(",\"certainty\":");
            json_string(out, &write.certainty);
            out.push_str(&format!(",\"afterAwait\":{},\"site\":", write.after_await));
            write.site.write_json(out);
            out.push('}');
        }
        out.push_str("],\"creations\":[");
        for (i, creation) in self.creations.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"factory\":");
            json_string(out, &creation.factory);
            out.push_str(&format!(",\"marked\":{},\"certainty\":", creation.marked));
            json_string(out, &creation.certainty);
            out.push_str(&format!(
                ",\"afterAwait\":{},\"site\":",
                creation.after_await
            ));
            creation.site.write_json(out);
            out.push('}');
        }
        out.push_str("],\"calls\":[");
        for (i, call) in self.calls.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"callee\":");
            json_string(out, &call.callee);
            out.push_str(",\"certainty\":");
            json_string(out, &call.certainty);
            out.push_str(&format!(",\"afterAwait\":{},\"site\":", call.after_await));
            call.site.write_json(out);
            out.push('}');
        }
        out.push_str("],\"opaque\":[");
        for (i, opaque) in self.opaque.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"name\":");
            json_string(out, &opaque.name);
            out.push_str(",\"site\":");
            opaque.site.write_json(out);
            out.push('}');
        }
        out.push_str("],\"escapes\":[");
        for (i, escape) in self.escapes.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"kind\":");
            json_string(out, &escape.kind);
            out.push_str(",\"name\":");
            json_string(out, &escape.name);
            out.push_str(",\"site\":");
            escape.site.write_json(out);
            out.push('}');
        }
        out.push_str("],\"completeness\":");
        json_string(out, &self.completeness);
        out.push_str(",\"diagnostics\":[");
        write_diagnostics(out, &self.diagnostics);
        out.push_str("]}");
    }
}

pub(crate) fn json_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// --- positions -------------------------------------------------------------------------

/// Byte offsets → UTF-16 offsets and 1-based line/column.
pub(crate) struct Positions {
    /// `utf16[i]` = UTF-16 length of `source[..i]` for every byte index.
    utf16: Vec<u32>,
    /// Byte offset of every line start.
    lines: Vec<u32>,
}

impl Positions {
    pub(crate) fn new(source: &str) -> Self {
        let mut utf16 = vec![0u32; source.len() + 1];
        let mut count = 0u32;
        let mut lines = vec![0u32];
        for (i, c) in source.char_indices() {
            utf16[i] = count;
            count += c.len_utf16() as u32;
            if c == '\n' {
                lines.push((i + 1) as u32);
            }
            // Continuation bytes share the character's end.
            for slot in utf16.iter_mut().take(i + c.len_utf8()).skip(i + 1) {
                *slot = count;
            }
        }
        utf16[source.len()] = count;
        Self { utf16, lines }
    }

    pub(crate) fn site(&self, source: &str, span: Span) -> StrictSite {
        let start = (span.start as usize).min(source.len());
        let end = (span.end as usize).min(source.len());
        let line_index = match self.lines.binary_search(&(start as u32)) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        let line_start = self.lines[line_index] as usize;
        let column = source[line_start..start].chars().count() as u32 + 1;
        StrictSite {
            start: self.utf16[start],
            end: self.utf16[end],
            line: line_index as u32 + 1,
            column,
        }
    }
}

// --- binding classification ---------------------------------------------------------

/// A function literal, by reference into the AST.
#[derive(Clone, Copy)]
pub(crate) enum FnRef<'b, 'a> {
    Function(&'b Function<'a>),
    Arrow(&'b ArrowFunctionExpression<'a>),
}

impl FnRef<'_, '_> {
    fn span(self) -> Span {
        match self {
            FnRef::Function(f) => f.span,
            FnRef::Arrow(a) => a.span,
        }
    }

    fn is_async(self) -> bool {
        match self {
            FnRef::Function(f) => f.r#async,
            FnRef::Arrow(a) => a.r#async,
        }
    }
}

#[derive(Clone)]
pub(crate) enum BindingKind<'a> {
    /// A signal / memo accessor: `count()` is a read.
    Accessor,
    /// A signal setter: `setCount(v)` is a write.
    Setter,
    /// A store proxy: `store.a.b` is a path read.
    Store,
    /// A store setter: `setStore(...)` is a write.
    StoreSetter,
    /// A component's props parameter: `props.a` is a path read.
    Props,
    /// `const u = store.user` / `const t = props.todo`: a path prefix.
    PathAlias { root: SymbolId, keys: Vec<String> },
    /// A function declaration or a closure held in a binding.
    Callback(FnRef<'a, 'a>),
    /// `const x = $(fn)`.
    Marked,
    /// A runtime import by its imported name.
    Factory(String),
    /// The `$` import.
    Marker,
    /// A value the compiler can see is plain (a literal, a parameter of the
    /// callback, a local computed inside it, a global).
    Plain,
    /// A binding the compiler cannot classify (an import, a context value, a
    /// mutable outer variable, an unknown initializer).
    Opaque,
}

impl BindingKind<'_> {
    pub(crate) fn is_capability(&self) -> bool {
        matches!(
            self,
            BindingKind::Accessor
                | BindingKind::Setter
                | BindingKind::Store
                | BindingKind::StoreSetter
                | BindingKind::Props
                | BindingKind::PathAlias { .. }
                | BindingKind::Marked
                | BindingKind::Factory(_)
                | BindingKind::Marker
        )
    }

    /// Capabilities a closure must not capture to be handed to unsummarized
    /// code: reactive state and its handles. Runtime factories are not
    /// state (a closure calling `createSignal` later is still an owned
    /// creation recorded in the graph), and a path alias holds a value
    /// already read (its own reads inside the closure are recorded).
    fn is_captured_capability(&self) -> bool {
        self.is_capability()
            && !matches!(
                self,
                BindingKind::Factory(_) | BindingKind::Marker | BindingKind::PathAlias { .. }
            )
    }

    pub(crate) fn describe(&self) -> &'static str {
        match self {
            BindingKind::Accessor => "an accessor",
            BindingKind::Setter => "a setter",
            BindingKind::Store => "a store",
            BindingKind::StoreSetter => "a store setter",
            BindingKind::Props => "the component's props",
            BindingKind::PathAlias { .. } => "a store or props path",
            BindingKind::Callback(_) => "a callback",
            BindingKind::Marked => "a marked callback",
            BindingKind::Factory(_) => "a runtime factory",
            BindingKind::Marker => "the `$` marker",
            BindingKind::Plain => "a value",
            BindingKind::Opaque => "an unsummarized value",
        }
    }

    fn escape_kind(&self) -> &'static str {
        match self {
            BindingKind::Accessor => "accessor",
            BindingKind::Setter => "setter",
            BindingKind::Store => "store",
            BindingKind::StoreSetter => "store-setter",
            BindingKind::Props => "props",
            BindingKind::PathAlias { .. } => "path",
            BindingKind::Callback(_) => "callback",
            BindingKind::Marked => "marked",
            BindingKind::Factory(_) | BindingKind::Marker => "runtime",
            _ => "value",
        }
    }
}

/// Shared, memoized classification of every binding the walkers touch.
pub(crate) struct Classifier<'b, 'a> {
    scoping: &'b Scoping,
    nodes: &'b AstNodes<'a>,
    /// Local symbol → imported name for runtime imports.
    runtime_imports: HashMap<SymbolId, String>,
    cache: HashMap<SymbolId, BindingKind<'a>>,
    in_progress: HashSet<SymbolId>,
}

impl<'b, 'a> Classifier<'b, 'a> {
    pub(crate) fn new(scoping: &'b Scoping, nodes: &'b AstNodes<'a>, program: &Program<'a>) -> Self {
        let mut runtime_imports = HashMap::new();
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if !RUNTIME_SOURCES.contains(&import.source.value.as_str())
                || import.import_kind == ImportOrExportKind::Type
            {
                continue;
            }
            for specifier in import.specifiers.iter().flatten() {
                let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                    continue;
                };
                if specifier.import_kind == ImportOrExportKind::Type {
                    continue;
                }
                if let Some(symbol) = specifier.local.symbol_id.get() {
                    runtime_imports.insert(symbol, specifier.imported.name().to_string());
                }
            }
        }
        Self {
            scoping,
            nodes,
            runtime_imports,
            cache: HashMap::new(),
            in_progress: HashSet::new(),
        }
    }

    fn imports_marker(&self) -> bool {
        self.runtime_imports.values().any(|name| name == "$")
    }

    pub(crate) fn symbol_of(&self, reference: &IdentifierReference<'_>) -> Option<SymbolId> {
        reference
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
    }

    fn name(&self, symbol: SymbolId) -> &'b str {
        self.scoping.symbol_name(symbol)
    }

    /// Classify a reference: unresolved (global) references are plain values.
    pub(crate) fn classify_reference(
        &mut self,
        reference: &IdentifierReference<'_>,
        block: Span,
    ) -> (Option<SymbolId>, BindingKind<'a>) {
        match self.symbol_of(reference) {
            Some(symbol) => (Some(symbol), self.classify(symbol, block)),
            None => (None, BindingKind::Plain),
        }
    }

    /// `block` is the span of the marked callback being analyzed: bindings
    /// declared inside it are locals (values by construction), bindings
    /// outside it are classified conservatively.
    pub(crate) fn classify(&mut self, symbol: SymbolId, block: Span) -> BindingKind<'a> {
        if let Some(kind) = self.cache.get(&symbol) {
            return kind.clone();
        }
        if !self.in_progress.insert(symbol) {
            return BindingKind::Opaque;
        }
        let kind = self.classify_uncached(symbol, block);
        self.in_progress.remove(&symbol);
        self.cache.insert(symbol, kind.clone());
        kind
    }

    fn classify_uncached(&mut self, symbol: SymbolId, block: Span) -> BindingKind<'a> {
        if let Some(imported) = self.runtime_imports.get(&symbol) {
            return if imported == "$" {
                BindingKind::Marker
            } else {
                BindingKind::Factory(imported.clone())
            };
        }
        let declaration = self.scoping.symbol_declaration(symbol);
        let mut node_id = declaration;
        let mut saw_parameter = false;
        loop {
            let node = self.nodes.get_node(node_id);
            match node.kind() {
                AstKind::VariableDeclarator(declarator) => {
                    let is_const = matches!(
                        self.nodes.parent_node(node_id).kind(),
                        AstKind::VariableDeclaration(declaration)
                            if declaration.kind == VariableDeclarationKind::Const
                    );
                    let local = block.contains_inclusive(declarator.span);
                    return self.classify_declarator(symbol, declarator, is_const, local, block);
                }
                AstKind::FormalParameter(_) => saw_parameter = true,
                AstKind::Function(function) => {
                    if saw_parameter {
                        return self.classify_parameter(
                            symbol,
                            function.span,
                            function.id.as_ref().map(|id| id.name.as_str()),
                            &function.params,
                            block,
                        );
                    }
                    return BindingKind::Callback(FnRef::Function(function));
                }
                AstKind::ArrowFunctionExpression(arrow) => {
                    if saw_parameter {
                        let name = match self.nodes.parent_node(node_id).kind() {
                            AstKind::VariableDeclarator(declarator) => {
                                declarator.id.get_identifier_name().map(|n| n.as_str())
                            }
                            _ => None,
                        };
                        return self.classify_parameter(
                            symbol,
                            arrow.span,
                            name,
                            &arrow.params,
                            block,
                        );
                    }
                    return BindingKind::Opaque;
                }
                AstKind::Class(_) => return BindingKind::Opaque,
                AstKind::CatchClause(_) | AstKind::CatchParameter(_) => return BindingKind::Plain,
                AstKind::ImportDeclaration(_)
                | AstKind::ImportSpecifier(_)
                | AstKind::ImportDefaultSpecifier(_)
                | AstKind::ImportNamespaceSpecifier(_)
                | AstKind::Program(_) => return BindingKind::Opaque,
                _ => {}
            }
            let parent = self.nodes.parent_id(node_id);
            if parent == node_id {
                return BindingKind::Opaque;
            }
            node_id = parent;
        }
    }

    fn classify_parameter(
        &self,
        symbol: SymbolId,
        function_span: Span,
        function_name: Option<&str>,
        params: &FormalParameters<'a>,
        block: Span,
    ) -> BindingKind<'a> {
        let declaration_span = self
            .nodes
            .get_node(self.scoping.symbol_declaration(symbol))
            .kind()
            .span();
        let first = params.items.first();
        let is_first = first.is_some_and(|param| param.span().contains_inclusive(declaration_span));
        let is_component = function_name
            .is_some_and(|name| name.chars().next().is_some_and(|c| c.is_ascii_uppercase()));
        if is_first
            && is_component
            && matches!(
                first.map(|p| &p.pattern),
                Some(BindingPattern::BindingIdentifier(_))
            )
        {
            return BindingKind::Props;
        }
        // Parameters of the marked callback and of closures inside it are
        // values; parameters of other functions are unknown.
        if block.contains_inclusive(function_span) {
            BindingKind::Plain
        } else {
            BindingKind::Opaque
        }
    }

    fn classify_declarator(
        &mut self,
        symbol: SymbolId,
        declarator: &'a VariableDeclarator<'a>,
        is_const: bool,
        local: bool,
        block: Span,
    ) -> BindingKind<'a> {
        let Some(init) = declarator.init.as_ref() else {
            return if local {
                BindingKind::Plain
            } else {
                BindingKind::Opaque
            };
        };
        let init = strip_ts(init);
        // Destructuring position of `symbol` in an array pattern.
        let array_index = match &declarator.id {
            BindingPattern::ArrayPattern(pattern) => pattern.elements.iter().position(|element| {
                matches!(
                    element,
                    Some(BindingPattern::BindingIdentifier(id)) if id.symbol_id.get() == Some(symbol)
                )
            }),
            _ => None,
        };
        let is_identifier = matches!(
            &declarator.id,
            BindingPattern::BindingIdentifier(id) if id.symbol_id.get() == Some(symbol)
        );

        match init {
            Expression::CallExpression(call) => {
                if let Expression::Identifier(callee) = strip_ts(&call.callee) {
                    let (_, kind) = self.classify_reference(callee, block);
                    match kind {
                        BindingKind::Factory(name) => {
                            return match (name.as_str(), array_index, is_identifier) {
                                ("createSignal" | "createOptimistic", Some(0), _) => {
                                    BindingKind::Accessor
                                }
                                ("createSignal" | "createOptimistic", Some(1), _) => {
                                    BindingKind::Setter
                                }
                                ("createMemo", _, true) => BindingKind::Accessor,
                                ("createStore" | "createOptimisticStore", Some(0), _) => {
                                    BindingKind::Store
                                }
                                ("createStore" | "createOptimisticStore", Some(1), _) => {
                                    BindingKind::StoreSetter
                                }
                                ("createProjection", _, true) => BindingKind::Store,
                                // `untrack(...)`, `resolve(...)`, …: a value
                                // when computed inside the callback.
                                _ if local && is_identifier => BindingKind::Plain,
                                _ => BindingKind::Opaque,
                            };
                        }
                        BindingKind::Marker if is_identifier => {
                            return if marked_function(call).is_some() {
                                BindingKind::Marked
                            } else if local {
                                BindingKind::Plain
                            } else {
                                BindingKind::Opaque
                            };
                        }
                        _ => {}
                    }
                }
                if local && is_identifier {
                    BindingKind::Plain
                } else {
                    BindingKind::Opaque
                }
            }
            Expression::ArrowFunctionExpression(arrow) if is_identifier => {
                BindingKind::Callback(FnRef::Arrow(arrow))
            }
            Expression::FunctionExpression(function) if is_identifier => {
                BindingKind::Callback(FnRef::Function(function))
            }
            Expression::Identifier(reference) if is_identifier => {
                // An alias keeps the kind of what it aliases (`const c = count`
                // outside a block); inside a block the walker refuses the
                // alias of a capability at the reference.
                let (_, kind) = self.classify_reference(reference, block);
                match kind {
                    BindingKind::Plain => BindingKind::Plain,
                    BindingKind::Opaque => BindingKind::Opaque,
                    kind if is_const => kind,
                    _ => BindingKind::Opaque,
                }
            }
            Expression::StaticMemberExpression(_) | Expression::ComputedMemberExpression(_)
                if is_identifier =>
            {
                if let Some((root, keys)) = chain_root(init) {
                    let (root_symbol, kind) = self.classify_reference(root, block);
                    match (kind, root_symbol) {
                        (BindingKind::Store | BindingKind::Props, Some(root)) if is_const => {
                            return BindingKind::PathAlias { root, keys };
                        }
                        (BindingKind::PathAlias { root, keys: prefix }, _) if is_const => {
                            let mut all = prefix;
                            all.extend(keys);
                            return BindingKind::PathAlias { root, keys: all };
                        }
                        (BindingKind::Plain, _) => return BindingKind::Plain,
                        _ => {}
                    }
                }
                if local {
                    BindingKind::Plain
                } else {
                    BindingKind::Opaque
                }
            }
            _ => {
                if local || self.is_plain_expression(init, block) {
                    BindingKind::Plain
                } else {
                    BindingKind::Opaque
                }
            }
        }
    }

    /// A literal-shaped expression whose identifiers are all plain.
    pub(crate) fn is_plain_expression(&mut self, expression: &Expression<'a>, block: Span) -> bool {
        match strip_ts(expression) {
            Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BigIntLiteral(_)
            | Expression::StringLiteral(_)
            | Expression::RegExpLiteral(_) => true,
            Expression::TemplateLiteral(template) => template
                .expressions
                .iter()
                .all(|e| self.is_plain_expression(e, block)),
            Expression::Identifier(reference) => {
                matches!(
                    self.classify_reference(reference, block).1,
                    BindingKind::Plain
                )
            }
            Expression::UnaryExpression(unary) => self.is_plain_expression(&unary.argument, block),
            Expression::BinaryExpression(binary) => {
                self.is_plain_expression(&binary.left, block)
                    && self.is_plain_expression(&binary.right, block)
            }
            Expression::LogicalExpression(logical) => {
                self.is_plain_expression(&logical.left, block)
                    && self.is_plain_expression(&logical.right, block)
            }
            Expression::ConditionalExpression(conditional) => {
                self.is_plain_expression(&conditional.test, block)
                    && self.is_plain_expression(&conditional.consequent, block)
                    && self.is_plain_expression(&conditional.alternate, block)
            }
            Expression::ArrayExpression(array) => {
                array.elements.iter().all(|element| match element {
                    oxc_ast::ast::ArrayExpressionElement::Elision(_) => true,
                    oxc_ast::ast::ArrayExpressionElement::SpreadElement(spread) => {
                        self.is_plain_expression(&spread.argument, block)
                    }
                    element => element
                        .as_expression()
                        .is_some_and(|e| self.is_plain_expression(e, block)),
                })
            }
            Expression::ObjectExpression(object) => {
                object.properties.iter().all(|property| match property {
                    oxc_ast::ast::ObjectPropertyKind::ObjectProperty(property) => {
                        !property.computed
                            && !property.method
                            && self.is_plain_expression(&property.value, block)
                    }
                    oxc_ast::ast::ObjectPropertyKind::SpreadProperty(spread) => {
                        self.is_plain_expression(&spread.argument, block)
                    }
                })
            }
            _ => false,
        }
    }

    /// The capability bindings a closure references (transitively through
    /// other closures it references, and `this`). Empty means the closure may
    /// escape: whoever calls it later cannot reach reactive state through it.
    fn captured_capabilities(&mut self, function: FnRef<'_, 'a>, block: Span) -> Vec<String> {
        let mut visited = HashSet::new();
        let mut captured = Vec::new();
        let mut pending = vec![function.span()];
        // The first function is walked directly; callbacks it references are
        // classified (their literals live in the AST) and queued.
        let mut queue: Vec<FnRef<'_, 'a>> = vec![function];
        while let Some(function) = queue.pop() {
            if !visited.insert(function.span().start) && pending.len() > 1 {
                continue;
            }
            pending.push(function.span());
            let mut collector = Captures {
                classifier: self,
                block,
                captured: &mut captured,
                callbacks: Vec::new(),
            };
            match function {
                FnRef::Function(f) => {
                    collector.visit_formal_parameters(&f.params);
                    if let Some(body) = f.body.as_ref() {
                        collector.visit_function_body(body);
                    }
                }
                FnRef::Arrow(a) => {
                    collector.visit_formal_parameters(&a.params);
                    collector.visit_arrow_function_body(&a.body);
                }
            }
            let callbacks = collector.callbacks;
            for callback in callbacks {
                if !visited.contains(&callback.span().start) {
                    queue.push(callback);
                }
            }
        }
        captured
    }
}

/// Collects the capabilities a closure references (see `captured_capabilities`).
struct Captures<'c, 'b, 'a> {
    classifier: &'c mut Classifier<'b, 'a>,
    block: Span,
    captured: &'c mut Vec<String>,
    callbacks: Vec<FnRef<'a, 'a>>,
}

impl<'a> Visit<'a> for Captures<'_, '_, 'a> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        let (symbol, kind) = self.classifier.classify_reference(it, self.block);
        match kind {
            BindingKind::Callback(inner) => self.callbacks.push(inner),
            kind if kind.is_captured_capability() => {
                let name = symbol.map_or_else(
                    || it.name.to_string(),
                    |symbol| self.classifier.name(symbol).to_string(),
                );
                if !self.captured.contains(&name) {
                    self.captured.push(name);
                }
            }
            _ => {}
        }
    }

    fn visit_this_expression(&mut self, _it: &oxc_ast::ast::ThisExpression) {
        if !self.captured.iter().any(|name| name == "this") {
            self.captured.push("this".to_string());
        }
    }
}

pub(crate) fn strip_ts<'b, 'a>(expression: &'b Expression<'a>) -> &'b Expression<'a> {
    match expression {
        Expression::TSAsExpression(e) => strip_ts(&e.expression),
        Expression::TSSatisfiesExpression(e) => strip_ts(&e.expression),
        Expression::TSNonNullExpression(e) => strip_ts(&e.expression),
        Expression::TSTypeAssertion(e) => strip_ts(&e.expression),
        Expression::TSInstantiationExpression(e) => strip_ts(&e.expression),
        Expression::ParenthesizedExpression(e) => strip_ts(&e.expression),
        other => other,
    }
}

fn computed_key(expression: &Expression<'_>) -> String {
    match strip_ts(expression) {
        Expression::StringLiteral(s) => s.value.to_string(),
        Expression::NumericLiteral(n) => n
            .raw
            .as_ref()
            .map_or_else(|| n.value.to_string(), |r| r.to_string()),
        Expression::Identifier(id) => id.name.to_string(),
        _ => "[…]".to_string(),
    }
}

fn is_literal_key(expression: &Expression<'_>) -> bool {
    matches!(
        strip_ts(expression),
        Expression::StringLiteral(_) | Expression::NumericLiteral(_)
    )
}

/// The root identifier and keys of a member chain (`root.a[0][k]?.b`),
/// including a bare identifier (no keys). Optional links are allowed (the
/// read is bounded); computed keys other than literals and identifiers are
/// recorded as `[…]`.
pub(crate) fn chain_root<'b, 'a>(
    expression: &'b Expression<'a>,
) -> Option<(&'b IdentifierReference<'a>, Vec<String>)> {
    let mut keys = Vec::new();
    let mut current = strip_ts(expression);
    loop {
        match current {
            Expression::StaticMemberExpression(member) => {
                keys.push(member.property.name.to_string());
                current = strip_ts(&member.object);
            }
            Expression::ComputedMemberExpression(member) => {
                keys.push(computed_key(&member.expression));
                current = strip_ts(&member.object);
            }
            Expression::ChainExpression(chain) => match &chain.expression {
                ChainElement::StaticMemberExpression(member) => {
                    keys.push(member.property.name.to_string());
                    current = strip_ts(&member.object);
                }
                ChainElement::ComputedMemberExpression(member) => {
                    keys.push(computed_key(&member.expression));
                    current = strip_ts(&member.object);
                }
                ChainElement::TSNonNullExpression(e) => current = strip_ts(&e.expression),
                _ => return None,
            },
            Expression::Identifier(root) => {
                keys.reverse();
                return Some((root, keys));
            }
            _ => return None,
        }
    }
}

fn has_optional_link(expression: &Expression<'_>) -> bool {
    let mut current = strip_ts(expression);
    loop {
        match current {
            Expression::StaticMemberExpression(member) => {
                if member.optional {
                    return true;
                }
                current = strip_ts(&member.object);
            }
            Expression::ComputedMemberExpression(member) => {
                if member.optional {
                    return true;
                }
                current = strip_ts(&member.object);
            }
            Expression::ChainExpression(_) => return true,
            _ => return false,
        }
    }
}

fn marked_function<'b, 'a>(call: &'b CallExpression<'a>) -> Option<FnRef<'b, 'a>> {
    if call.arguments.len() != 1 {
        return None;
    }
    match &call.arguments[0] {
        Argument::ArrowFunctionExpression(arrow) => Some(FnRef::Arrow(arrow)),
        Argument::FunctionExpression(function) if !function.generator => {
            Some(FnRef::Function(function))
        }
        _ => None,
    }
}

// --- analysis ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum HostKind {
    Memo,
    Signal,
    Effect,
    RenderEffect,
    Event,
}

impl HostKind {
    fn name(self) -> &'static str {
        match self {
            HostKind::Memo => "memo",
            HostKind::Signal => "signal",
            HostKind::Effect => "effect",
            HostKind::RenderEffect => "render-effect",
            HostKind::Event => "event",
        }
    }

    fn is_reactive(self) -> bool {
        self != HostKind::Event
    }
}

/// One consuming site of a marked callback.
struct HostUse {
    kind: HostKind,
    factory: Option<String>,
    event: Option<String>,
    span: Span,
}

/// Byte spans of one analyzed block, aligned with `StrictAnalysis::blocks`:
/// what a later pass (resumable events) needs to find the callback and its
/// host sites in the AST without re-deriving host resolution.
#[derive(Clone, Debug, Default)]
pub(crate) struct BlockSpans {
    /// The `$(fn)` call.
    pub call: Span,
    /// The callback function expression.
    pub callback: Span,
    /// Every host use site (the `$()` call or the reference to the marked
    /// binding) with its DOM event name for event hosts.
    pub uses: Vec<(Span, Option<String>)>,
}

/// A `$(fn)` call found in the program.
struct Marked<'a> {
    node_id: NodeId,
    call: &'a CallExpression<'a>,
    function: FnRef<'a, 'a>,
}

fn analyze<'a>(
    program: &'a Program<'a>,
    source: &str,
    filename: &str,
) -> (StrictAnalysis, Vec<Span>, Vec<BlockSpans>) {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let mut classifier = Classifier::new(scoping, nodes, program);
    let positions = Positions::new(source);
    let mut analysis = StrictAnalysis::default();
    let mut markers = Vec::new();
    let mut block_spans = Vec::new();
    if !classifier.imports_marker() {
        return (analysis, markers, block_spans);
    }

    // Every marked call, in source order.
    let mut marked: Vec<Marked<'a>> = Vec::new();
    for node in nodes.iter() {
        let AstKind::CallExpression(call) = node.kind() else {
            continue;
        };
        let Expression::Identifier(callee) = &call.callee else {
            continue;
        };
        if !matches!(
            classifier.classify_reference(callee, Span::new(0, 0)).1,
            BindingKind::Marker
        ) {
            continue;
        }
        if let Some(function) = marked_function(call) {
            marked.push(Marked {
                node_id: node.id(),
                call,
                function,
            });
        }
    }
    marked.sort_by_key(|item| item.call.span.start);

    // Resolve hosts.
    let mut host_reference_spans: HashSet<u32> = HashSet::new();
    let mut resolved: Vec<Vec<HostUse>> = Vec::new();
    for item in &marked {
        let parent_id = nodes.parent_id(item.node_id);
        let mut uses = Vec::new();
        let mut failure: Option<StrictDiagnostic> = None;
        let fail = |code: &str, span: Span, message: String| StrictDiagnostic {
            code: code.into(),
            message,
            site: positions.site(source, span),
        };
        match nodes.get_node(parent_id).kind() {
            AstKind::VariableDeclarator(declarator)
                if declarator
                    .init
                    .as_ref()
                    .is_some_and(|init| init.span() == item.call.span) =>
            {
                let declaration = nodes.parent_node(parent_id);
                let is_const = matches!(
                    declaration.kind(),
                    AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const
                );
                // `export const x = $(…)`: the declaration sits directly under
                // an export (a marker inside an exported function is local).
                let exported = nodes
                    .ancestors(declaration.id())
                    .take_while(|ancestor| {
                        !matches!(
                            ancestor.kind(),
                            AstKind::Function(_)
                                | AstKind::ArrowFunctionExpression(_)
                                | AstKind::Class(_)
                                | AstKind::Program(_)
                        )
                    })
                    .any(|ancestor| {
                        matches!(
                            ancestor.kind(),
                            AstKind::ExportDeclaration(_)
                                | AstKind::ExportNamedDeclaration(_)
                                | AstKind::ExportDefaultDeclaration(_)
                        )
                    });
                let binding = match &declarator.id {
                    BindingPattern::BindingIdentifier(id) => id.symbol_id.get(),
                    _ => None,
                };
                match binding {
                    None => {
                        failure = Some(fail(
                            "STRICT_HOST_UNKNOWN",
                            item.call.span,
                            "a marked callback must be bound to a plain `const` name so every use site can be checked; destructuring hides its host".into(),
                        ));
                    }
                    Some(_) if !is_const => {
                        failure = Some(fail(
                            "STRICT_HOST_UNKNOWN",
                            item.call.span,
                            "a marked callback bound with `let` / `var` may be reassigned, so its host is not statically known; bind it with `const`".into(),
                        ));
                    }
                    Some(_) if exported => {
                        failure = Some(fail(
                            "STRICT_HOST_UNKNOWN",
                            item.call.span,
                            "an exported marked callback can be consumed by any module, so its host is not statically known; export a plain callback or a generator block instead".into(),
                        ));
                    }
                    Some(symbol) => {
                        let name = scoping.symbol_name(symbol);
                        // `typeof handler` in a type position is not a use.
                        let references: Vec<_> = scoping
                            .get_resolved_references(symbol)
                            .filter(|reference| {
                                reference.is_value() && !reference.flags().is_value_as_type()
                            })
                            .collect();
                        if references.is_empty() {
                            failure = Some(fail(
                                "STRICT_HOST_UNKNOWN",
                                item.call.span,
                                format!(
                                    "`{name}` is never consumed, so the marked callback has no host; pass it to createMemo / createSignal / createEffect / createRenderEffect or bind it to a DOM `on*` attribute"
                                ),
                            ));
                        }
                        for reference in references {
                            let reference_span = nodes.get_node(reference.node_id()).kind().span();
                            match host_use_of(
                                &mut classifier,
                                nodes,
                                reference.node_id(),
                                reference_span,
                            ) {
                                Ok(host_use) => {
                                    host_reference_spans.insert(reference_span.start);
                                    uses.push(host_use);
                                }
                                Err(message) => {
                                    if failure.is_none() {
                                        failure = Some(fail(
                                            "STRICT_HOST_UNKNOWN",
                                            reference_span,
                                            format!(
                                                "`{name}` is used here as a value, so the marked callback's host is not statically known ({message}); every use of a marked callback must be a createMemo / createSignal / createEffect / createRenderEffect argument or a DOM `on*` attribute"
                                            ),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => match host_use_of(&mut classifier, nodes, item.node_id, item.call.span) {
                Ok(host_use) => uses.push(host_use),
                Err(message) => {
                    failure = Some(fail(
                        "STRICT_HOST_UNKNOWN",
                        item.call.span,
                        format!(
                            "a marked callback must have a statically known host ({message}); pass it directly to createMemo / createSignal / createEffect / createRenderEffect, bind it to a DOM `on*` attribute, or hold it in a `const` used only in those positions"
                        ),
                    ));
                }
            },
        }
        if failure.is_none() && !uses.is_empty() {
            let first = uses[0].kind;
            if let Some(other) = uses.iter().find(|u| u.kind != first) {
                failure = Some(fail(
                    "STRICT_HOST_AMBIGUOUS",
                    other.span,
                    format!(
                        "the marked callback is used as a `{}` host here and as a `{}` host elsewhere; a marked callback compiles for exactly one host kind, so split it into two markers",
                        other.kind.name(),
                        first.name()
                    ),
                ));
            }
        }
        if let Some(diagnostic) = failure {
            analysis.diagnostics.push(diagnostic);
            resolved.push(Vec::new());
        } else {
            resolved.push(uses);
        }
    }

    // Analyze bodies.
    for (index, (item, uses)) in marked.iter().zip(resolved).enumerate() {
        let callback_span = item.function.span();
        let host_kind = uses.first().map(|u| u.kind);
        let mut events: Vec<String> = uses.iter().filter_map(|u| u.event.clone()).collect();
        events.dedup();
        let mut summary = StrictBlockSummary {
            id: format!("{filename}#{index}"),
            host: StrictHost {
                kind: host_kind.map_or_else(|| "unknown".to_string(), |k| k.name().to_string()),
                factory: uses.iter().find_map(|u| u.factory.clone()),
                events,
                sites: uses
                    .iter()
                    .map(|u| positions.site(source, u.span))
                    .collect(),
            },
            marker: positions.site(source, item.call.span),
            callback: positions.site(source, callback_span),
            is_async: item.function.is_async(),
            awaits: Vec::new(),
            reads: Vec::new(),
            writes: Vec::new(),
            creations: Vec::new(),
            calls: Vec::new(),
            opaque: Vec::new(),
            escapes: Vec::new(),
            completeness: "unknown".into(),
            diagnostics: Vec::new(),
        };
        if let Some(host) = host_kind {
            // Locality is per block: classify afresh.
            classifier.cache.clear();
            {
                let mut walker = BodyWalker {
                    classifier: &mut classifier,
                    positions: &positions,
                    source,
                    host,
                    block: callback_span,
                    summary: &mut summary,
                    host_reference_spans: &host_reference_spans,
                    consumed: HashSet::new(),
                    allowed_closures: HashSet::new(),
                    conditional_depth: 0,
                    closure_depth: 0,
                    plain_function_depth: 0,
                    loop_depth: 0,
                    jsx_depth: 0,
                    untrack_depth: 0,
                    may_have_exited: false,
                    awaited: false,
                    diagnostic_sites: HashSet::new(),
                };
                match item.function {
                    FnRef::Function(f) => {
                        walker.visit_formal_parameters(&f.params);
                        if let Some(body) = f.body.as_ref() {
                            walker.visit_function_body(body);
                        }
                    }
                    FnRef::Arrow(a) => {
                        walker.visit_formal_parameters(&a.params);
                        walker.visit_arrow_function_body(&a.body);
                    }
                }
            }
            summary.completeness = if !summary.diagnostics.is_empty() || !summary.escapes.is_empty()
            {
                "unknown".into()
            } else if summary.reads.iter().all(|r| r.certainty == "exact")
                && summary.writes.iter().all(|w| w.certainty == "exact")
                && summary.creations.iter().all(|c| c.certainty == "exact")
                && summary.calls.is_empty()
                && summary.opaque.is_empty()
            {
                "exact".into()
            } else {
                "bounded".into()
            };
            summary
                .diagnostics
                .sort_by_key(|d| (d.site.start, d.site.end));
            analysis
                .diagnostics
                .extend(summary.diagnostics.iter().cloned());
            if summary.diagnostics.is_empty() {
                markers.push(item.call.span);
            }
        }
        block_spans.push(BlockSpans {
            call: item.call.span,
            callback: callback_span,
            uses: uses.iter().map(|u| (u.span, u.event.clone())).collect(),
        });
        analysis.blocks.push(summary);
    }
    analysis
        .diagnostics
        .sort_by_key(|d| (d.site.start, d.site.end));
    (analysis, markers, block_spans)
}

/// The host that consumes the expression at `node_id` (a `$` call or a
/// reference to a marked binding) whose span is `span`.
fn host_use_of<'a>(
    classifier: &mut Classifier<'_, 'a>,
    nodes: &AstNodes<'a>,
    node_id: NodeId,
    span: Span,
) -> Result<HostUse, String> {
    let parent_id = nodes.parent_id(node_id);
    match nodes.get_node(parent_id).kind() {
        AstKind::CallExpression(call) => {
            let position = call
                .arguments
                .iter()
                .position(|argument| argument.span() == span);
            let Expression::Identifier(callee) = &call.callee else {
                return Err("the callee is not a runtime factory".into());
            };
            let (_, kind) = classifier.classify_reference(callee, Span::new(0, 0));
            let BindingKind::Factory(name) = kind else {
                return Err(format!(
                    "`{}` is not a runtime factory the compiler summarizes",
                    callee.name
                ));
            };
            let Some((_, host)) = HOST_FACTORIES
                .iter()
                .find(|(factory, _)| *factory == name.as_str())
            else {
                return Err(format!(
                    "`{name}` does not take a marked callback in this slice"
                ));
            };
            match position {
                Some(0) => Ok(HostUse {
                    kind: *host,
                    factory: Some(name.clone()),
                    event: None,
                    span,
                }),
                _ => Err(format!(
                    "only the first argument of `{name}` (the compute callback) is a strict host in this slice"
                )),
            }
        }
        AstKind::JSXExpressionContainer(_) => {
            let attribute_id = nodes.parent_id(parent_id);
            let AstKind::JSXAttribute(attribute) = nodes.get_node(attribute_id).kind() else {
                return Err("a JSX child is not a host".into());
            };
            let (attribute_name, event) = match &attribute.name {
                JSXAttributeName::Identifier(name) => {
                    (name.name.to_string(), event_name(&name.name))
                }
                JSXAttributeName::NamespacedName(name) => (
                    format!("{}:{}", name.namespace.name, name.name.name),
                    (name.namespace.name == "on").then(|| name.name.name.to_string()),
                ),
            };
            let Some(event) = event else {
                return Err(format!(
                    "`{attribute_name}` is not an `on*` attribute, so it is not an event host"
                ));
            };
            let element_id = nodes.parent_id(attribute_id);
            let AstKind::JSXOpeningElement(element) = nodes.get_node(element_id).kind() else {
                return Err("the attribute is not on an element".into());
            };
            match &element.name {
                JSXElementName::Identifier(tag)
                    if tag
                        .name
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_lowercase()) =>
                {
                    Ok(HostUse {
                        kind: HostKind::Event,
                        factory: None,
                        event: Some(event),
                        span,
                    })
                }
                _ => Err(format!(
                    "`{attribute_name}` is a component prop, not a DOM event binding, so the component decides how the callback runs"
                )),
            }
        }
        _ => Err("it is used as a value".into()),
    }
}

/// `onClick` → `click`, `onclick` → `click`; anything not `on` + a name is not an event.
fn event_name(attribute: &str) -> Option<String> {
    let rest = attribute.strip_prefix("on")?;
    if rest.is_empty() {
        return None;
    }
    Some(rest.to_ascii_lowercase())
}

// --- body walker -------------------------------------------------------------------------

struct BodyWalker<'w, 'b, 'a> {
    classifier: &'w mut Classifier<'b, 'a>,
    positions: &'w Positions,
    source: &'w str,
    host: HostKind,
    block: Span,
    summary: &'w mut StrictBlockSummary,
    host_reference_spans: &'w HashSet<u32>,
    /// Identifier references already accounted for (callees, chain roots).
    consumed: HashSet<u32>,
    /// Closure literals in a summarized position (setter updaters, `untrack`
    /// bodies, local `const` initializers, arguments already checked) that
    /// may capture capabilities.
    allowed_closures: HashSet<u32>,
    conditional_depth: u32,
    closure_depth: u32,
    plain_function_depth: u32,
    loop_depth: u32,
    jsx_depth: u32,
    untrack_depth: u32,
    may_have_exited: bool,
    awaited: bool,
    diagnostic_sites: HashSet<(u32, &'static str)>,
}

impl<'a> BodyWalker<'_, '_, 'a> {
    fn site(&self, span: Span) -> StrictSite {
        self.positions.site(self.source, span)
    }

    fn certainty(&self) -> String {
        if self.conditional_depth == 0
            && self.closure_depth == 0
            && self.loop_depth == 0
            && self.jsx_depth == 0
            && !self.may_have_exited
        {
            "exact".into()
        } else {
            "bounded".into()
        }
    }

    fn text(&self, span: Span) -> String {
        self.source[span.start as usize..span.end as usize].to_string()
    }

    fn diagnose(&mut self, code: &'static str, span: Span, message: String) {
        if !self.diagnostic_sites.insert((span.start, code)) {
            return;
        }
        self.summary.diagnostics.push(StrictDiagnostic {
            code: code.into(),
            message,
            site: self.site(span),
        });
    }

    fn escape(&mut self, kind: &str, name: &str, span: Span, message: String) {
        self.summary.escapes.push(StrictEscape {
            kind: kind.into(),
            name: name.into(),
            site: self.site(span),
        });
        self.diagnose("STRICT_CAPABILITY_ESCAPE", span, message);
    }

    fn classify(&mut self, reference: &IdentifierReference<'_>) -> BindingKind<'a> {
        self.classifier.classify_reference(reference, self.block).1
    }

    fn classify_symbol(&mut self, symbol: SymbolId) -> BindingKind<'a> {
        self.classifier.classify(symbol, self.block)
    }

    fn closure_captures(&mut self, function: FnRef<'_, 'a>) -> Vec<String> {
        self.classifier.captured_capabilities(function, self.block)
    }

    fn record_read(&mut self, kind: &str, root: &str, path: Vec<String>, access: &str, span: Span) {
        let tracked = self.host.is_reactive() && self.untrack_depth == 0 && !self.awaited;
        if self.host.is_reactive() && self.awaited && self.closure_depth == 0 {
            self.diagnose(
                "STRICT_READ_AFTER_AWAIT",
                span,
                format!(
                    "`{}` is read after the first `await`, where the {} host no longer tracks dependencies; read it before the first `await` (`const value = {}…; await …`) so it becomes a dependency of the parent computation",
                    self.text(span),
                    self.host.name(),
                    root
                ),
            );
        }
        self.summary.reads.push(StrictRead {
            kind: kind.into(),
            root: root.into(),
            path,
            access: access.into(),
            certainty: self.certainty(),
            tracked,
            after_await: self.awaited,
            site: self.site(span),
        });
    }

    fn record_write(&mut self, kind: &str, target: &str, span: Span) {
        if self.host.is_reactive() {
            self.diagnose(
                "STRICT_WRITE_IN_REACTIVE_HOST",
                span,
                format!(
                    "`{target}` is written inside a `{}` host, which may not write reactive state; move the write into an event handler or the effect phase (the second argument of createEffect)",
                    self.host.name()
                ),
            );
        }
        self.summary.writes.push(StrictWrite {
            kind: kind.into(),
            target: target.into(),
            certainty: self.certainty(),
            after_await: self.awaited,
            site: self.site(span),
        });
    }

    fn record_creation(&mut self, factory: &str, marked: bool, span: Span) {
        if self.awaited {
            self.diagnose(
                "STRICT_CREATION_AFTER_AWAIT",
                span,
                format!(
                    "`{factory}` is called after an `await`, where the owner that was active when the callback started is no longer restored; this slice does not support owned creation after `await` — create it before the first `await`, or in a synchronous computation"
                ),
            );
        }
        self.summary.creations.push(StrictCreation {
            factory: factory.into(),
            marked,
            certainty: self.certainty(),
            after_await: self.awaited,
            site: self.site(span),
        });
    }

    fn record_call(&mut self, callee: String, span: Span) {
        self.summary.calls.push(StrictCall {
            callee,
            certainty: self.certainty(),
            after_await: self.awaited,
            site: self.site(span),
        });
    }

    fn record_opaque(&mut self, name: &str, span: Span) {
        self.summary.opaque.push(StrictOpaque {
            name: name.into(),
            site: self.site(span),
        });
    }

    /// Refuse a capability reference in a value position.
    fn escape_reference(
        &mut self,
        reference: &IdentifierReference<'_>,
        kind: &BindingKind<'a>,
        how: &str,
    ) {
        let name = reference.name.to_string();
        let fix = match kind {
            BindingKind::Accessor => format!("read its value with `{name}()` and pass or store that"),
            BindingKind::Setter | BindingKind::StoreSetter => {
                format!("call `{name}(...)` directly from the callback instead")
            }
            BindingKind::Store => {
                "read the value you need (`store.a.b`) and pass that; only the store itself is a capability".into()
            }
            BindingKind::Props => {
                "read the props you need (`props.x`) instead of passing the props object".into()
            }
            BindingKind::PathAlias { .. } => "read the value you need from the path and pass that".into(),
            BindingKind::Marked => {
                "a marked callback is consumed only by its host; share the logic through a plain function".into()
            }
            BindingKind::Factory(_) | BindingKind::Marker => {
                "call it directly instead of passing it around".into()
            }
            _ => "pass a plain value".into(),
        };
        let message = format!(
            "`{name}` is {} and {how}; strict mode cannot see what happens to it there, so its reads and writes would be hidden from the graph — {fix}",
            kind.describe()
        );
        self.escape(kind.escape_kind(), &name, reference.span, message);
    }

    fn closure_escape(
        &mut self,
        name: &str,
        span: Span,
        captured: &[String],
        context: &str,
        fix: &str,
    ) {
        let message = format!(
            "{context}, but it captures {} (`{}`); whoever holds it could call it at any time and hide those reads or writes from the graph — {fix}",
            if captured.len() == 1 {
                "a capability"
            } else {
                "capabilities"
            },
            captured.join("`, `")
        );
        self.escape("callback", name, span, message);
    }

    /// Arguments of a call the compiler has no summary for must be plain.
    /// `primitive` is true under an operator that yields a primitive, where
    /// an opaque value is only read, never handed over.
    fn check_plain_argument(&mut self, expression: &Expression<'a>, callee: &str, primitive: bool) {
        match strip_ts(expression) {
            Expression::Identifier(reference) => {
                let kind = self.classify(reference);
                match kind {
                    BindingKind::Plain => {}
                    BindingKind::Opaque => {
                        self.consumed.insert(reference.span.start);
                        self.record_opaque(&reference.name, reference.span);
                        self.diagnose(
                            "STRICT_OPAQUE_ARGUMENT",
                            reference.span,
                            format!(
                                "`{0}` is passed to `{callee}`, which has no strict summary, and strict mode cannot tell whether `{0}` carries an accessor, a store or a callback (it is an import, a context value or an unknown outer binding); pass a value you computed in the callback, or bind a literal `const` before the callback",
                                reference.name
                            ),
                        );
                    }
                    BindingKind::Callback(function) => {
                        let captured = self.closure_captures(function);
                        if !captured.is_empty() {
                            self.consumed.insert(reference.span.start);
                            let name = reference.name.to_string();
                            self.closure_escape(
                                &name,
                                reference.span,
                                &captured,
                                &format!("`{name}` is passed to `{callee}`, which has no strict summary"),
                                "inline the logic, or pass a closure that only captures plain values",
                            );
                        }
                    }
                    // A path alias is a read whose value is data (as `yield*
                    // store.a` is in a generator block); the read itself is
                    // recorded where the alias is declared.
                    BindingKind::PathAlias { .. } => {}
                    kind if kind.is_capability() => {
                        self.consumed.insert(reference.span.start);
                        self.escape_reference(
                            reference,
                            &kind,
                            &format!("is passed to `{callee}`, which has no strict summary"),
                        );
                    }
                    _ => {}
                }
            }
            Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::ChainExpression(_) => {
                let Some((root, keys)) = chain_root(expression) else {
                    return;
                };
                if keys.is_empty() {
                    return;
                }
                // A store / props path argument is a path read whose value is
                // handed over as data (the walk records the read); only the
                // roots themselves are capabilities.
                let kind = self.classify(root);
                if matches!(kind, BindingKind::Opaque) && !primitive {
                    self.diagnose(
                        "STRICT_OPAQUE_ARGUMENT",
                        expression.span(),
                        format!(
                            "`{}` is passed to `{callee}`, which has no strict summary, and `{}` is unsummarized (an import, a context value or an unknown outer binding), so strict mode cannot tell whether the value carries reactive capabilities; pass a value you computed in the callback",
                            self.text(expression.span()),
                            root.name
                        ),
                    );
                } else if matches!(
                    kind,
                    BindingKind::Accessor
                        | BindingKind::Setter
                        | BindingKind::StoreSetter
                        | BindingKind::Marked
                ) {
                    self.consumed.insert(root.span.start);
                    self.escape_reference(
                        root,
                        &kind,
                        &format!("is passed to `{callee}`, which has no strict summary"),
                    );
                }
            }
            Expression::ArrowFunctionExpression(arrow) => {
                let captured = self.closure_captures(FnRef::Arrow(arrow));
                self.check_closure_argument(arrow.span, &captured, callee);
            }
            Expression::FunctionExpression(function) => {
                let captured = self.closure_captures(FnRef::Function(function));
                self.check_closure_argument(function.span, &captured, callee);
            }
            Expression::ArrayExpression(array) => {
                for element in &array.elements {
                    match element {
                        oxc_ast::ast::ArrayExpressionElement::SpreadElement(spread) => {
                            self.check_plain_argument(&spread.argument, callee, false);
                        }
                        element => {
                            if let Some(expression) = element.as_expression() {
                                self.check_plain_argument(expression, callee, false);
                            }
                        }
                    }
                }
            }
            Expression::ObjectExpression(object) => {
                for property in &object.properties {
                    match property {
                        oxc_ast::ast::ObjectPropertyKind::ObjectProperty(property) => {
                            self.check_plain_argument(&property.value, callee, false);
                        }
                        oxc_ast::ast::ObjectPropertyKind::SpreadProperty(spread) => {
                            self.check_plain_argument(&spread.argument, callee, false);
                        }
                    }
                }
            }
            Expression::UnaryExpression(unary) => {
                self.check_plain_argument(&unary.argument, callee, true);
            }
            Expression::BinaryExpression(binary) => {
                self.check_plain_argument(&binary.left, callee, true);
                self.check_plain_argument(&binary.right, callee, true);
            }
            Expression::TemplateLiteral(template) => {
                for expression in &template.expressions {
                    self.check_plain_argument(expression, callee, true);
                }
            }
            Expression::LogicalExpression(logical) => {
                self.check_plain_argument(&logical.left, callee, primitive);
                self.check_plain_argument(&logical.right, callee, primitive);
            }
            Expression::ConditionalExpression(conditional) => {
                self.check_plain_argument(&conditional.consequent, callee, primitive);
                self.check_plain_argument(&conditional.alternate, callee, primitive);
            }
            Expression::SequenceExpression(sequence) => {
                if let Some(last) = sequence.expressions.last() {
                    self.check_plain_argument(last, callee, primitive);
                }
            }
            Expression::AwaitExpression(awaited) => {
                self.check_plain_argument(&awaited.argument, callee, primitive);
            }
            Expression::AssignmentExpression(assignment) => {
                self.check_plain_argument(&assignment.right, callee, primitive);
            }
            _ => {}
        }
    }

    fn check_closure_argument(&mut self, span: Span, captured: &[String], callee: &str) {
        if !captured.is_empty() {
            self.closure_escape(
                "closure",
                span,
                captured,
                &format!("this closure is passed to `{callee}`, which has no strict summary"),
                "pass a closure that only captures plain values, or read the values first and capture those",
            );
        }
        // Walked anyway (bounded) so its reads are still listed.
        self.allowed_closures.insert(span.start);
    }

    fn check_arguments(&mut self, arguments: &[Argument<'a>], callee: &str) {
        for argument in arguments {
            match argument {
                Argument::SpreadElement(spread) => {
                    self.check_plain_argument(&spread.argument, callee, false);
                }
                argument => {
                    if let Some(expression) = argument.as_expression() {
                        self.check_plain_argument(expression, callee, false);
                    }
                }
            }
        }
    }

    fn allow_closure_arguments(&mut self, arguments: &[Argument<'a>]) {
        for argument in arguments {
            match argument {
                Argument::ArrowFunctionExpression(arrow) => {
                    self.allowed_closures.insert(arrow.span.start);
                }
                Argument::FunctionExpression(function) => {
                    self.allowed_closures.insert(function.span.start);
                }
                _ => {}
            }
        }
    }

    /// A member chain (`root.a.b`, possibly optional) in value or callee
    /// position. Records the read, opaque access or escape for the whole
    /// chain and walks its computed keys; returns false for a plain root so
    /// the caller walks the expression normally.
    fn handle_chain(&mut self, expression: &Expression<'a>, access: &str) -> bool {
        let Some((root, keys)) = chain_root(expression) else {
            return false;
        };
        if keys.is_empty() {
            return false;
        }
        let kind = self.classify(root);
        let saved = self.conditional_depth;
        if has_optional_link(expression) {
            self.conditional_depth += 1;
        }
        let span = expression.span();
        let handled = match kind {
            BindingKind::Store | BindingKind::Props => {
                self.consumed.insert(root.span.start);
                let read_kind = if matches!(kind, BindingKind::Store) {
                    "store"
                } else {
                    "prop"
                };
                self.record_read(read_kind, &root.name, keys, access, span);
                true
            }
            BindingKind::PathAlias {
                root: alias_root,
                keys: prefix,
            } => {
                self.consumed.insert(root.span.start);
                let read_kind = if matches!(self.classify_symbol(alias_root), BindingKind::Store) {
                    "store"
                } else {
                    "prop"
                };
                let root_name = self.classifier.name(alias_root).to_string();
                let mut path = prefix;
                path.extend(keys);
                self.record_read(read_kind, &root_name, path, access, span);
                true
            }
            BindingKind::Opaque => {
                self.consumed.insert(root.span.start);
                self.record_opaque(&root.name, span);
                true
            }
            BindingKind::Accessor
            | BindingKind::Setter
            | BindingKind::StoreSetter
            | BindingKind::Marked
            | BindingKind::Factory(_)
            | BindingKind::Marker => {
                self.consumed.insert(root.span.start);
                self.escape_reference(root, &kind, "is used as an object");
                true
            }
            BindingKind::Callback(_) => {
                // `fn.name`, `fn.length`, `fn.call(...)`: nothing reactive.
                self.consumed.insert(root.span.start);
                true
            }
            BindingKind::Plain => false,
        };
        if handled {
            self.visit_chain_keys(expression);
        }
        self.conditional_depth = saved;
        handled
    }

    /// Computed keys are ordinary expressions (`store.items[index()]`).
    fn visit_chain_keys(&mut self, expression: &Expression<'a>) {
        let mut current = strip_ts(expression);
        loop {
            match current {
                Expression::StaticMemberExpression(member) => current = strip_ts(&member.object),
                Expression::ComputedMemberExpression(member) => {
                    if !is_literal_key(&member.expression) {
                        self.visit_expression(&member.expression);
                    }
                    current = strip_ts(&member.object);
                }
                Expression::ChainExpression(chain) => match &chain.expression {
                    ChainElement::StaticMemberExpression(member) => {
                        current = strip_ts(&member.object);
                    }
                    ChainElement::ComputedMemberExpression(member) => {
                        if !is_literal_key(&member.expression) {
                            self.visit_expression(&member.expression);
                        }
                        current = strip_ts(&member.object);
                    }
                    ChainElement::TSNonNullExpression(e) => current = strip_ts(&e.expression),
                    _ => return,
                },
                _ => return,
            }
        }
    }

    /// `object.key = value` / `object[key] = value` / `delete object.key`:
    /// refused on stores, props and reactive capabilities; plain on locals
    /// and opaque objects.
    fn visit_member_assignment(&mut self, object: &Expression<'a>, span: Span) {
        let Some((root, _)) = chain_root(object) else {
            self.visit_expression(object);
            return;
        };
        let kind = self.classify(root);
        self.consumed.insert(root.span.start);
        match kind {
            BindingKind::Store | BindingKind::PathAlias { .. } | BindingKind::Props => {
                let reason = if matches!(kind, BindingKind::Props) {
                    "props are read-only"
                } else {
                    "stores change through their setter"
                };
                self.diagnose(
                    "STRICT_STORE_ASSIGNMENT",
                    span,
                    format!(
                        "`{}` assigns through `{}` inside a marked callback; {reason} — use `setStore(...)` from an event handler",
                        self.text(span),
                        root.name
                    ),
                );
            }
            kind if kind.is_capability() => {
                self.escape_reference(root, &kind, "is written through as an object");
            }
            BindingKind::Opaque => self.record_opaque(&root.name, span),
            _ => {}
        }
        self.visit_chain_keys(object);
    }

    fn visit_assignment_root(&mut self, target: &SimpleAssignmentTarget<'a>) {
        match target {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(reference) => {
                let kind = self.classify(reference);
                self.consumed.insert(reference.span.start);
                if kind.is_capability() || matches!(kind, BindingKind::Callback(_)) {
                    self.diagnose(
                        "STRICT_ASSIGNMENT_TO_CAPABILITY",
                        reference.span,
                        format!(
                            "`{}` is {} and cannot be reassigned inside a marked callback; reactive state changes only through its setter",
                            reference.name,
                            kind.describe()
                        ),
                    );
                }
            }
            SimpleAssignmentTarget::StaticMemberExpression(member) => {
                self.visit_member_assignment(&member.object, member.span);
            }
            SimpleAssignmentTarget::ComputedMemberExpression(member) => {
                self.visit_expression(&member.expression);
                self.visit_member_assignment(&member.object, member.span);
            }
            _ => walk::walk_simple_assignment_target(self, target),
        }
    }

    fn enter_closure(&mut self, function: FnRef<'_, 'a>) -> (bool, bool) {
        let span = function.span();
        if !self.allowed_closures.contains(&span.start) {
            let captured = self.closure_captures(function);
            if !captured.is_empty() {
                self.closure_escape(
                    "closure",
                    span,
                    &captured,
                    "this closure is not in a position the compiler summarizes (a setter updater, an `untrack` body, a local `const`)",
                    "read the values first and capture those, or move the logic into the marked callback itself",
                );
            }
        }
        self.closure_depth += 1;
        let saved = (self.awaited, self.may_have_exited);
        self.awaited = false;
        self.may_have_exited = false;
        saved
    }

    fn leave_closure(&mut self, saved: (bool, bool)) {
        self.closure_depth -= 1;
        self.awaited = saved.0;
        self.may_have_exited = saved.1;
    }

    fn note_loop(&mut self, body: &Statement<'a>) {
        if contains_await(body) {
            self.awaited = true;
        }
    }

    fn after_loop(&mut self, body: &Statement<'a>) {
        if contains_exit(body) {
            self.may_have_exited = true;
        }
    }
}

/// Does `statement` contain a `return` / `throw` of the enclosing function
/// (nested functions excluded)?
fn contains_exit(statement: &Statement<'_>) -> bool {
    struct Finder(bool);
    impl<'a> Visit<'a> for Finder {
        fn visit_function(&mut self, _it: &Function<'a>, _flags: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _it: &ArrowFunctionExpression<'a>) {}
        fn visit_return_statement(&mut self, _it: &oxc_ast::ast::ReturnStatement<'a>) {
            self.0 = true;
        }
        fn visit_throw_statement(&mut self, _it: &oxc_ast::ast::ThrowStatement<'a>) {
            self.0 = true;
        }
    }
    let mut finder = Finder(false);
    finder.visit_statement(statement);
    finder.0
}

/// Does `statement` contain an `await` of the enclosing function?
fn contains_await(statement: &Statement<'_>) -> bool {
    struct Finder(bool);
    impl<'a> Visit<'a> for Finder {
        fn visit_function(&mut self, _it: &Function<'a>, _flags: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _it: &ArrowFunctionExpression<'a>) {}
        fn visit_await_expression(&mut self, _it: &oxc_ast::ast::AwaitExpression<'a>) {
            self.0 = true;
        }
        fn visit_for_of_statement(&mut self, it: &oxc_ast::ast::ForOfStatement<'a>) {
            if it.r#await {
                self.0 = true;
            }
            walk::walk_for_of_statement(self, it);
        }
    }
    let mut finder = Finder(false);
    finder.visit_statement(statement);
    finder.0
}

impl<'a> Visit<'a> for BodyWalker<'_, '_, 'a> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        if self.consumed.remove(&it.span.start)
            || self.host_reference_spans.contains(&it.span.start)
        {
            return;
        }
        let kind = self.classify(it);
        match kind {
            BindingKind::Plain | BindingKind::Opaque => {
                if it.name == "arguments" && self.classifier.symbol_of(it).is_none() {
                    self.diagnose(
                        "STRICT_UNSUPPORTED_SYNTAX",
                        it.span,
                        "`arguments` is not supported inside a marked callback; use named or rest parameters".into(),
                    );
                }
            }
            BindingKind::Callback(function) => {
                let captured = self.closure_captures(function);
                if !captured.is_empty() {
                    let name = it.name.to_string();
                    self.closure_escape(
                        &name,
                        it.span,
                        &captured,
                        &format!("`{name}` is used as a value here"),
                        "call it here instead, or make it capture only plain values",
                    );
                }
            }
            // The alias holds the value the path read produced; using it is
            // not a new read of the root (reads through it are chains).
            BindingKind::PathAlias { .. } => {}
            kind => self.escape_reference(it, &kind, "is used as a value here"),
        }
    }

    fn visit_this_expression(&mut self, it: &oxc_ast::ast::ThisExpression) {
        if self.plain_function_depth == 0 {
            self.diagnose(
                "STRICT_UNSUPPORTED_SYNTAX",
                it.span,
                "`this` is not supported inside a marked callback: the host decides how the callback is invoked, so `this` has no stable meaning; capture what you need in a local".into(),
            );
        }
    }

    fn visit_super(&mut self, it: &oxc_ast::ast::Super) {
        self.diagnose(
            "STRICT_UNSUPPORTED_SYNTAX",
            it.span,
            "`super` is not supported inside a marked callback".into(),
        );
    }

    fn visit_class(&mut self, it: &Class<'a>) {
        self.diagnose(
            "STRICT_UNSUPPORTED_SYNTAX",
            it.span,
            "a class inside a marked callback is not analyzed in this slice; move it outside the callback".into(),
        );
    }

    fn visit_await_expression(&mut self, it: &oxc_ast::ast::AwaitExpression<'a>) {
        walk::walk_await_expression(self, it);
        if self.closure_depth == 0 {
            let site = self.site(it.span);
            self.summary.awaits.push(site);
        }
        self.awaited = true;
    }

    fn visit_function(&mut self, it: &Function<'a>, _flags: ScopeFlags) {
        // `function helper() {}` inside the callback is a local callback,
        // like `const helper = () => {}`: checked where it is used.
        if it.is_declaration() {
            self.allowed_closures.insert(it.span.start);
        }
        let saved = self.enter_closure(FnRef::Function(it));
        self.plain_function_depth += 1;
        self.visit_formal_parameters(&it.params);
        if let Some(body) = it.body.as_ref() {
            self.visit_function_body(body);
        }
        self.plain_function_depth -= 1;
        self.leave_closure(saved);
    }

    fn visit_arrow_function_expression(&mut self, it: &ArrowFunctionExpression<'a>) {
        let saved = self.enter_closure(FnRef::Arrow(it));
        self.visit_formal_parameters(&it.params);
        self.visit_arrow_function_body(&it.body);
        self.leave_closure(saved);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let Some(init) = it.init.as_ref() {
            match strip_ts(init) {
                Expression::ArrowFunctionExpression(arrow) => {
                    self.allowed_closures.insert(arrow.span.start);
                }
                Expression::FunctionExpression(function) => {
                    self.allowed_closures.insert(function.span.start);
                }
                _ => {}
            }
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let callee = strip_ts(&call.callee);
        match callee {
            Expression::Identifier(reference) => {
                let kind = self.classify(reference);
                let name = reference.name.to_string();
                match kind {
                    BindingKind::Marker => {
                        // A nested marked callback: its own block, its own host.
                    }
                    BindingKind::Accessor => {
                        self.consumed.insert(reference.span.start);
                        self.record_read("signal", &name, Vec::new(), "path", call.span);
                        walk::walk_call_expression(self, call);
                    }
                    BindingKind::Setter | BindingKind::StoreSetter => {
                        self.consumed.insert(reference.span.start);
                        let kind_name = if matches!(kind, BindingKind::Setter) {
                            "signal"
                        } else {
                            "store"
                        };
                        self.record_write(kind_name, &name, call.span);
                        // Updaters run synchronously inside the setter.
                        self.allow_closure_arguments(&call.arguments);
                        walk::walk_call_expression(self, call);
                    }
                    BindingKind::Factory(factory) => {
                        self.consumed.insert(reference.span.start);
                        self.visit_factory_call(call, &factory);
                    }
                    BindingKind::Callback(function) => {
                        self.consumed.insert(reference.span.start);
                        // A closure defined inside the callback is walked where
                        // it is defined; an outer function is an unsummarized
                        // helper (it may capture the component's state).
                        if !self.block.contains_inclusive(function.span()) {
                            self.record_call(name.clone(), call.span);
                        }
                        self.check_arguments(&call.arguments, &name);
                        walk::walk_call_expression(self, call);
                    }
                    BindingKind::Marked => {
                        self.consumed.insert(reference.span.start);
                        self.escape_reference(
                            reference,
                            &kind,
                            "is called from another marked callback",
                        );
                        walk::walk_call_expression(self, call);
                    }
                    BindingKind::Store | BindingKind::Props | BindingKind::PathAlias { .. } => {
                        self.consumed.insert(reference.span.start);
                        self.escape_reference(reference, &kind, "is called like a function");
                        walk::walk_call_expression(self, call);
                    }
                    BindingKind::Plain | BindingKind::Opaque => {
                        self.consumed.insert(reference.span.start);
                        self.record_call(name.clone(), call.span);
                        self.check_arguments(&call.arguments, &name);
                        walk::walk_call_expression(self, call);
                    }
                }
            }
            Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::ChainExpression(_) => {
                let name = self.text(callee.span());
                let handled = self.handle_chain(callee, "structural");
                self.record_call(name.clone(), call.span);
                self.check_arguments(&call.arguments, &name);
                if handled {
                    for argument in &call.arguments {
                        self.visit_argument(argument);
                    }
                } else {
                    walk::walk_call_expression(self, call);
                }
            }
            _ => {
                let name = self.text(callee.span());
                self.record_call(name.clone(), call.span);
                self.check_arguments(&call.arguments, &name);
                walk::walk_call_expression(self, call);
            }
        }
    }

    fn visit_new_expression(&mut self, it: &oxc_ast::ast::NewExpression<'a>) {
        let name = format!("new {}", self.text(it.callee.span()));
        self.record_call(name.clone(), it.span);
        self.check_arguments(&it.arguments, &name);
        walk::walk_new_expression(self, it);
    }

    fn visit_tagged_template_expression(
        &mut self,
        it: &oxc_ast::ast::TaggedTemplateExpression<'a>,
    ) {
        let name = self.text(it.tag.span());
        self.record_call(name, it.span);
        walk::walk_tagged_template_expression(self, it);
    }

    fn visit_import_expression(&mut self, it: &oxc_ast::ast::ImportExpression<'a>) {
        self.record_call("import()".into(), it.span);
        walk::walk_import_expression(self, it);
    }

    fn visit_expression(&mut self, it: &Expression<'a>) {
        // Member chains are handled whole (the outermost link classifies the
        // root); inner links are reached only when the root is plain.
        if matches!(
            it,
            Expression::StaticMemberExpression(_)
                | Expression::ComputedMemberExpression(_)
                | Expression::ChainExpression(_)
        ) && self.handle_chain(it, "path")
        {
            return;
        }
        walk::walk_expression(self, it);
    }

    fn visit_assignment_expression(&mut self, it: &oxc_ast::ast::AssignmentExpression<'a>) {
        match it.left.as_simple_assignment_target() {
            Some(target) => self.visit_assignment_root(target),
            None => self.visit_assignment_target(&it.left),
        }
        self.visit_expression(&it.right);
    }

    fn visit_update_expression(&mut self, it: &oxc_ast::ast::UpdateExpression<'a>) {
        self.visit_assignment_root(&it.argument);
    }

    fn visit_unary_expression(&mut self, it: &oxc_ast::ast::UnaryExpression<'a>) {
        if it.operator == UnaryOperator::Delete {
            match strip_ts(&it.argument) {
                Expression::StaticMemberExpression(member) => {
                    self.visit_member_assignment(&member.object, it.span);
                    return;
                }
                Expression::ComputedMemberExpression(member) => {
                    self.visit_expression(&member.expression);
                    self.visit_member_assignment(&member.object, it.span);
                    return;
                }
                _ => {}
            }
        }
        walk::walk_unary_expression(self, it);
    }

    fn visit_if_statement(&mut self, it: &oxc_ast::ast::IfStatement<'a>) {
        self.visit_expression(&it.test);
        self.conditional_depth += 1;
        self.visit_statement(&it.consequent);
        if let Some(alternate) = it.alternate.as_ref() {
            self.visit_statement(alternate);
        }
        self.conditional_depth -= 1;
        if contains_exit(&it.consequent) || it.alternate.as_ref().is_some_and(contains_exit) {
            self.may_have_exited = true;
        }
    }

    fn visit_conditional_expression(&mut self, it: &oxc_ast::ast::ConditionalExpression<'a>) {
        self.visit_expression(&it.test);
        self.conditional_depth += 1;
        self.visit_expression(&it.consequent);
        self.visit_expression(&it.alternate);
        self.conditional_depth -= 1;
    }

    fn visit_logical_expression(&mut self, it: &oxc_ast::ast::LogicalExpression<'a>) {
        self.visit_expression(&it.left);
        self.conditional_depth += 1;
        self.visit_expression(&it.right);
        self.conditional_depth -= 1;
    }

    fn visit_switch_statement(&mut self, it: &oxc_ast::ast::SwitchStatement<'a>) {
        self.visit_expression(&it.discriminant);
        self.conditional_depth += 1;
        let mut exits = false;
        for case in &it.cases {
            if let Some(test) = case.test.as_ref() {
                self.visit_expression(test);
            }
            for statement in &case.consequent {
                self.visit_statement(statement);
                exits |= contains_exit(statement);
            }
        }
        self.conditional_depth -= 1;
        if exits {
            self.may_have_exited = true;
        }
    }

    fn visit_try_statement(&mut self, it: &oxc_ast::ast::TryStatement<'a>) {
        self.visit_block_statement(&it.block);
        self.conditional_depth += 1;
        if let Some(handler) = it.handler.as_ref() {
            self.visit_catch_clause(handler);
        }
        if let Some(finalizer) = it.finalizer.as_ref() {
            self.visit_block_statement(finalizer);
        }
        self.conditional_depth -= 1;
        let mut exits = it.block.body.iter().any(contains_exit);
        if let Some(handler) = it.handler.as_ref() {
            exits |= handler.body.body.iter().any(contains_exit);
        }
        if exits {
            self.may_have_exited = true;
        }
    }

    fn visit_while_statement(&mut self, it: &oxc_ast::ast::WhileStatement<'a>) {
        self.note_loop(&it.body);
        self.visit_expression(&it.test);
        self.loop_depth += 1;
        self.visit_statement(&it.body);
        self.loop_depth -= 1;
        self.after_loop(&it.body);
    }

    fn visit_do_while_statement(&mut self, it: &oxc_ast::ast::DoWhileStatement<'a>) {
        self.note_loop(&it.body);
        self.loop_depth += 1;
        self.visit_statement(&it.body);
        self.visit_expression(&it.test);
        self.loop_depth -= 1;
        self.after_loop(&it.body);
    }

    fn visit_for_statement(&mut self, it: &oxc_ast::ast::ForStatement<'a>) {
        self.note_loop(&it.body);
        if let Some(init) = it.init.as_ref() {
            self.visit_for_statement_init(init);
        }
        if let Some(test) = it.test.as_ref() {
            self.visit_expression(test);
        }
        self.loop_depth += 1;
        if let Some(update) = it.update.as_ref() {
            self.visit_expression(update);
        }
        self.visit_statement(&it.body);
        self.loop_depth -= 1;
        self.after_loop(&it.body);
    }

    fn visit_for_in_statement(&mut self, it: &oxc_ast::ast::ForInStatement<'a>) {
        self.note_loop(&it.body);
        self.visit_for_statement_left(&it.left);
        self.visit_expression(&it.right);
        self.loop_depth += 1;
        self.visit_statement(&it.body);
        self.loop_depth -= 1;
        self.after_loop(&it.body);
    }

    fn visit_for_of_statement(&mut self, it: &oxc_ast::ast::ForOfStatement<'a>) {
        if it.r#await {
            self.awaited = true;
        }
        self.note_loop(&it.body);
        self.visit_for_statement_left(&it.left);
        self.visit_expression(&it.right);
        self.loop_depth += 1;
        self.visit_statement(&it.body);
        self.loop_depth -= 1;
        self.after_loop(&it.body);
    }

    fn visit_jsx_expression_container(&mut self, it: &oxc_ast::ast::JSXExpressionContainer<'a>) {
        self.jsx_depth += 1;
        walk::walk_jsx_expression_container(self, it);
        self.jsx_depth -= 1;
    }

    fn visit_jsx_opening_element(&mut self, it: &oxc_ast::ast::JSXOpeningElement<'a>) {
        // The tag names a component or element, not a value use: only the
        // attribute values are walked.
        for attribute in &it.attributes {
            match attribute {
                JSXAttributeItem::Attribute(attribute) => {
                    if let Some(JSXAttributeValue::ExpressionContainer(container)) =
                        attribute.value.as_ref()
                    {
                        self.visit_jsx_expression_container(container);
                    }
                }
                JSXAttributeItem::SpreadAttribute(spread) => {
                    self.jsx_depth += 1;
                    self.visit_expression(&spread.argument);
                    self.jsx_depth -= 1;
                }
            }
        }
    }
}

impl<'a> BodyWalker<'_, '_, 'a> {
    /// A call of a runtime import: a summarized helper, a creation, or a
    /// refused construct.
    fn visit_factory_call(&mut self, call: &CallExpression<'a>, factory: &str) {
        match factory {
            "useContext" => {
                self.diagnose(
                    "STRICT_CONTEXT_IN_BLOCK",
                    call.span,
                    "`useContext` cannot be called inside a marked callback: context is resolved during component setup, not at compute or event time; call it in the component body and capture the value".into(),
                );
            }
            "untrack" => {
                // The body runs synchronously, once, untracked.
                self.allow_closure_arguments(&call.arguments);
                self.untrack_depth += 1;
                walk::walk_call_expression(self, call);
                self.untrack_depth -= 1;
            }
            "perform" => {
                if let Some(Argument::Identifier(target)) = call.arguments.first()
                    && matches!(self.classify(target), BindingKind::Accessor)
                {
                    self.consumed.insert(target.span.start);
                    let name = target.name.to_string();
                    self.record_read("signal", &name, Vec::new(), "path", call.span);
                    return;
                }
                self.diagnose(
                    "STRICT_UNSUPPORTED_SYNTAX",
                    call.span,
                    "`perform` inside a marked callback only accepts a known accessor; read signals with `signal()` directly".into(),
                );
            }
            factory if CREATION_FACTORIES.contains(&factory) => {
                let marked = call.arguments.first().is_some_and(|argument| {
                    matches!(argument, Argument::CallExpression(inner)
                        if matches!(strip_ts(&inner.callee), Expression::Identifier(callee)
                            if matches!(self.classify(callee), BindingKind::Marker)))
                });
                self.record_creation(factory, marked, call.span);
                // Callbacks handed to a factory belong to the created node
                // (a marked one has its own summary); other arguments are
                // ordinary expressions.
                for (index, argument) in call.arguments.iter().enumerate() {
                    match argument {
                        Argument::CallExpression(_) if index == 0 && marked => {}
                        Argument::ArrowFunctionExpression(_) | Argument::FunctionExpression(_) => {}
                        argument => self.visit_argument(argument),
                    }
                }
            }
            factory => {
                // Another runtime helper: unsummarized.
                self.record_call(factory.to_string(), call.span);
                self.check_arguments(&call.arguments, factory);
                walk::walk_call_expression(self, call);
            }
        }
    }
}

// --- erasure -----------------------------------------------------------------------------

struct Eraser<'a> {
    allocator: &'a Allocator,
    /// Spans of `$(fn)` calls to replace with `fn`.
    markers: Vec<Span>,
}

impl<'a> VisitMut<'a> for Eraser<'a> {
    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::CallExpression(call) = expression
            && self.markers.contains(&call.span)
        {
            let ast = AstBuilder::new(self.allocator);
            let placeholder = ast.expression_null_literal(Span::new(0, 0));
            let owned = std::mem::replace(expression, placeholder);
            if let Expression::CallExpression(call) = owned {
                let mut call = call.unbox();
                if let Some(function) = call.arguments.pop()
                    && let Some(function) = crate::shared::ast::argument_to_expression(function)
                {
                    *expression = function;
                }
            }
        }
        walk_mut::walk_expression(self, expression);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompileOptions, Generate, compile};

    fn dom(source: &str) -> Result<String, String> {
        compile(
            source,
            &CompileOptions {
                generate: Generate::Dom,
                filename: Some("app.tsx".into()),
                ..CompileOptions::default()
            },
        )
        .map(|output| output.code)
        .map_err(|error| error.to_string())
    }

    fn summaries(source: &str) -> StrictAnalysis {
        analyze_strict_blocks(source, Some("app.tsx")).unwrap()
    }

    #[test]
    fn erases_markers_for_memo_effect_signal_and_event_hosts() {
        let out = dom(
            r#"import { $, createEffect, createMemo, createSignal } from "solid-js";
function Counter() {
  const [count, setCount] = createSignal(1);
  const doubled = createMemo($(() => count() * 2));
  const [tripled] = createSignal($(() => count() * 3));
  createEffect($(() => doubled()), value => console.log(value));
  const inc = $(() => setCount(value => value + 1));
  return <button onClick={inc} onDblClick={$(() => setCount(0))}>{doubled()}{tripled()}</button>;
}
"#,
        )
        .unwrap();
        assert!(out.contains("createMemo(() => count() * 2)"), "{out}");
        assert!(out.contains("createSignal(() => count() * 3)"), "{out}");
        assert!(
            out.contains("createEffect(() => doubled(), (value) => console.log(value))"),
            "{out}"
        );
        assert!(
            out.contains("const inc = () => setCount((value) => value + 1);"),
            "{out}"
        );
        assert!(out.contains("$$click = inc;"), "{out}");
        assert!(out.contains("$$dblclick = () => setCount(0);"), "{out}");
        assert!(!out.contains("$(()"), "{out}");
        assert!(!out.contains("$(function"), "{out}");
    }

    #[test]
    fn summarizes_reads_writes_creations_and_calls() {
        let analysis = summaries(
            r#"import { $, createEffect, createMemo, createSignal, createStore } from "solid-js";
function View(props) {
  const [count, setCount] = createSignal(1);
  const [store, setStore] = createStore({ user: { name: "Ada" }, items: [] });
  const user = store.user;
  const total = createMemo($(() => {
    const base = count() + props.offset;
    const name = user.name;
    if (base > 1) return store.items.length;
    return name.length + format(base);
  }));
  const save = $(async (event) => {
    const [local] = createSignal(0);
    const next = count() + local();
    await persist(next);
    setCount(next);
    setStore("user", "name", event.currentTarget.value);
  });
  return <input onInput={save} value={total()} />;
}
"#,
        );
        assert!(
            analysis.diagnostics.is_empty(),
            "{:?}",
            analysis.diagnostics
        );
        assert_eq!(analysis.blocks.len(), 2);
        let memo = &analysis.blocks[0];
        assert_eq!(memo.host.kind, "memo");
        assert_eq!(memo.host.factory.as_deref(), Some("createMemo"));
        let reads: Vec<(String, String, Vec<String>, String)> = memo
            .reads
            .iter()
            .map(|r| {
                (
                    r.kind.clone(),
                    r.root.clone(),
                    r.path.clone(),
                    r.certainty.clone(),
                )
            })
            .collect();
        assert_eq!(
            reads,
            vec![
                ("signal".into(), "count".into(), vec![], "exact".into()),
                (
                    "prop".into(),
                    "props".into(),
                    vec!["offset".into()],
                    "exact".into()
                ),
                (
                    "store".into(),
                    "store".into(),
                    vec!["user".into(), "name".into()],
                    "exact".into()
                ),
                (
                    "store".into(),
                    "store".into(),
                    vec!["items".into(), "length".into()],
                    "bounded".into()
                ),
                // A local alias of a path extends it: `name.length` may walk a
                // nested proxy, so it is a bounded read of the longer path.
                (
                    "store".into(),
                    "store".into(),
                    vec!["user".into(), "name".into(), "length".into()],
                    "bounded".into()
                ),
            ]
        );
        assert_eq!(memo.calls.len(), 1);
        assert_eq!(memo.calls[0].callee, "format");
        assert_eq!(memo.calls[0].certainty, "bounded");
        assert_eq!(memo.completeness, "bounded");
        assert!(memo.writes.is_empty());

        let event = &analysis.blocks[1];
        assert_eq!(event.host.kind, "event");
        assert_eq!(event.host.events, vec!["input".to_string()]);
        assert!(event.is_async);
        assert_eq!(event.awaits.len(), 1);
        assert_eq!(event.creations.len(), 1);
        assert_eq!(event.creations[0].factory, "createSignal");
        assert!(!event.creations[0].after_await);
        assert!(event.reads.iter().all(|r| !r.tracked));
        assert_eq!(event.writes.len(), 2);
        assert_eq!(event.writes[0].target, "setCount");
        assert!(event.writes[0].after_await);
        assert_eq!(event.writes[1].kind, "store");
        assert_eq!(event.calls.len(), 1);
        assert_eq!(event.calls[0].callee, "persist");
        assert_eq!(event.completeness, "bounded");
        let json = analysis.to_json();
        assert!(json.contains("\"version\":1"));
        assert!(json.contains("\"kind\":\"event\""));
    }

    #[test]
    fn exact_completeness_for_straight_line_reads() {
        let analysis = summaries(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [a] = createSignal(1);
const [b] = createSignal(2);
const sum = createMemo($(() => a() + b()));
"#,
        );
        assert_eq!(analysis.blocks[0].completeness, "exact");
        assert!(
            analysis.blocks[0]
                .reads
                .iter()
                .all(|r| r.tracked && r.certainty == "exact")
        );
    }

    #[test]
    fn refuses_escapes_writes_in_memos_and_reads_after_await() {
        let escape = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const m = createMemo($(() => helper(count)));
"#)
        .unwrap_err();
        assert!(escape.contains("[STRICT_CAPABILITY_ESCAPE]"), "{escape}");
        assert!(escape.contains("`count` is an accessor"), "{escape}");
        assert!(escape.contains("(3:37)"), "{escape}");

        let write = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [count, setCount] = createSignal(1);
const m = createMemo($(() => { setCount(2); return count(); }));
"#)
        .unwrap_err();
        assert!(write.contains("[STRICT_WRITE_IN_REACTIVE_HOST]"), "{write}");

        let after = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [id] = createSignal(1);
const [detail] = createSignal("x");
const user = createMemo($(async () => {
  const current = id();
  const loaded = await fetchUser(current);
  return loaded.name + detail();
}));
"#)
        .unwrap_err();
        assert!(after.contains("[STRICT_READ_AFTER_AWAIT]"), "{after}");
        assert!(after.contains("(7:24)"), "{after}");

        let store = dom(r#"import { $, createMemo, createStore } from "solid-js";
const [store] = createStore({ items: [] });
const m = createMemo($(() => summarize(store)));
"#)
        .unwrap_err();
        assert!(store.contains("[STRICT_CAPABILITY_ESCAPE]"), "{store}");
        assert!(
            store.contains("`store` is a store and is passed to `summarize`"),
            "{store}"
        );
        // A path value is data: the read is recorded, the call is unsummarized.
        let path = summaries(
            r#"import { $, createMemo, createStore } from "solid-js";
const [store] = createStore({ items: [] });
const m = createMemo($(() => summarize(store.items)));
"#,
        );
        assert!(path.diagnostics.is_empty(), "{:?}", path.diagnostics);
        assert_eq!(path.blocks[0].reads[0].path, vec!["items".to_string()]);
        assert_eq!(path.blocks[0].calls[0].callee, "summarize");

        let closure = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const m = createMemo($(() => items.map(item => item + count())));
"#)
        .unwrap_err();
        assert!(closure.contains("[STRICT_CAPABILITY_ESCAPE]"), "{closure}");
        assert!(
            closure.contains("captures a capability (`count`)"),
            "{closure}"
        );

        let context = dom(r#"import { $, createMemo, useContext } from "solid-js";
const m = createMemo($(() => useContext(Ctx).value));
"#)
        .unwrap_err();
        assert!(context.contains("[STRICT_CONTEXT_IN_BLOCK]"), "{context}");

        let creation = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [id] = createSignal(1);
const m = createMemo($(async () => {
  const current = id();
  await load(current);
  const [late] = createSignal(0);
  return late;
}));
"#)
        .unwrap_err();
        assert!(
            creation.contains("[STRICT_CREATION_AFTER_AWAIT]"),
            "{creation}"
        );
    }

    #[test]
    fn allows_plain_helpers_and_capability_free_closures() {
        let analysis = summaries(
            r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const [items] = createSignal([1, 2]);
const m = createMemo($(() => {
  const c = count();
  return items().filter(item => item > c).map(item => format(item, c)).length + Math.max(c, 2);
}));
"#,
        );
        assert!(
            analysis.diagnostics.is_empty(),
            "{:?}",
            analysis.diagnostics
        );
        let block = &analysis.blocks[0];
        assert_eq!(block.reads.len(), 2);
        let callees: Vec<&str> = block.calls.iter().map(|c| c.callee.as_str()).collect();
        assert!(callees.contains(&"format"), "{callees:?}");
        assert!(callees.contains(&"Math.max"), "{callees:?}");
        assert_eq!(block.completeness, "bounded");
    }

    #[test]
    fn resolves_hosts_through_const_bindings_and_rejects_ambiguity() {
        let ambiguous = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const both = $(() => count());
const m = createMemo(both);
const view = <button onClick={both} />;
"#)
        .unwrap_err();
        assert!(ambiguous.contains("[STRICT_HOST_AMBIGUOUS]"), "{ambiguous}");

        let exported = dom(r#"import { $, createSignal } from "solid-js";
const [count] = createSignal(1);
export const exported = $(() => count());
"#)
        .unwrap_err();
        assert!(exported.contains("exported marked callback"), "{exported}");

        let unused = dom(r#"import { $, createSignal } from "solid-js";
const [count] = createSignal(1);
const lonely = $(() => count());
"#)
        .unwrap_err();
        assert!(unused.contains("[STRICT_HOST_UNKNOWN]"), "{unused}");
        assert!(unused.contains("never consumed"), "{unused}");

        let component_prop = dom(r#"import { $, createSignal } from "solid-js";
const [count, setCount] = createSignal(1);
const view = <Child onPress={$(() => setCount(2))} />;
"#)
        .unwrap_err();
        assert!(
            component_prop.contains("[STRICT_HOST_UNKNOWN]"),
            "{component_prop}"
        );
        assert!(
            component_prop.contains("component prop"),
            "{component_prop}"
        );

        let value = dom(r#"import { $, createSignal } from "solid-js";
const [count] = createSignal(1);
const passed = $(() => count());
register(passed);
"#)
        .unwrap_err();
        assert!(value.contains("[STRICT_HOST_UNKNOWN]"), "{value}");
        assert!(value.contains("(4:10)"), "{value}");

        let shared = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const read = $(() => count());
const a = createMemo(read);
const b = createMemo(read);
"#)
        .unwrap();
        assert!(shared.contains("const read = () => count();"), "{shared}");
    }

    #[test]
    fn leaves_generator_blocks_and_other_markers_alone() {
        let out = dom(r#"import { $, createMemo, createSignal } from "solid-js";
const [count] = createSignal(1);
const gen = createMemo($(function* () { return (yield* count) * 2; }));
const plain = createMemo($(() => count() * 2));
const opaque = $(someGenerator);
"#)
        .unwrap();
        assert!(out.contains("createMemo($(function() {"), "{out}");
        assert!(out.contains("_$perform(count)"), "{out}");
        assert!(out.contains("createMemo(() => count() * 2)"), "{out}");
        assert!(out.contains("$(someGenerator)"), "{out}");
    }

    #[test]
    fn analysis_reports_all_diagnostics_with_utf16_sites() {
        let analysis = summaries(
            "import { $, createMemo, createSignal } from \"solid-js\";\nconst [count] = createSignal(\"🚀\");\nconst m = createMemo($(() => helper(count)));\nconst n = $(() => count());\n",
        );
        assert_eq!(analysis.diagnostics.len(), 2, "{:?}", analysis.diagnostics);
        let escape = &analysis.diagnostics[0];
        assert_eq!(escape.code, "STRICT_CAPABILITY_ESCAPE");
        assert_eq!((escape.site.line, escape.site.column), (3, 37));
        // UTF-16 offset: the rocket is two units.
        let prefix = "import { $, createMemo, createSignal } from \"solid-js\";\nconst [count] = createSignal(\"🚀\");\nconst m = createMemo($(() => helper(";
        assert_eq!(escape.site.start, prefix.encode_utf16().count() as u32);
        assert_eq!(analysis.diagnostics[1].code, "STRICT_HOST_UNKNOWN");
        assert_eq!(analysis.blocks.len(), 2);
        assert_eq!(analysis.blocks[0].completeness, "unknown");
        assert_eq!(analysis.blocks[1].host.kind, "unknown");
    }
}
