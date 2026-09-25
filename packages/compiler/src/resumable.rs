//! Resumable events (experimental, private, off by default).
//!
//! A vertical slice of "resumable event blocks" (typed-generator-compiler.md,
//! optimization slice 8): a strict `$(fn)` DOM event handler whose captures
//! are all addressable — serializable component values, module constants,
//! link-verified imports (registered server actions), or the accessor/setter
//! of a signal the same component declares — can run on the client without
//! hydrating (or even loading) the component that created it.
//!
//! The pass is driven by the strict analysis (`strict.rs`): it never
//! re-derives hosts, and it reuses the strict classifier for every captured
//! binding. It produces, per module:
//!
//! - a **plan** — per component ("scope") the values the server must
//!   serialize per instance, the exact text bindings the client can
//!   reconstruct, and the elements that carry resumable handlers; per handler
//!   its captures (each with a reason code), the synchronous prelude the
//!   bootstrap replays on the live event, and the event fields the body reads
//!   (the snapshot);
//! - the **event module** — a separate program holding every accepted
//!   callback verbatim (the same AST nodes, cloned, so the source map points
//!   at the authored lines), wrapped in a factory that rebinds the captures;
//! - **diagnostics** explaining, per handler and per scope, whether it is
//!   `resumable` or stays `hydrated`, and why.
//!
//! On an SSR generate the pass also rewrites the program so the server
//! runtime emits the coordinates: a `_$srScope` instance before the
//! component's return, `$sr={instance}` on the template root (the SSR
//! transform turns the hydration-key hole into `_$srRoot(instance)`, which
//! records the instance under the root's hydration key) and
//! `$srel={_$srEl(instance, n)}` on every handler element (a whole-attribute
//! hole that renders ` data-sr="<hk>/<n>"`). The DOM generate is untouched:
//! ordinary hydration of the same source stays available.
//!
//! Everything the pass cannot prove is refused with a reason; `require`
//! turns a refusal into a build error. It never moves a top-level
//! initializer, never rewrites text, and never serializes function source.
use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrowFunctionBody, BindingPattern, CallExpression, Declaration,
    Expression, ImportOrExportKind, JSXAttributeItem,
    JSXAttributeName, JSXAttributeValue, JSXChild, JSXElement, JSXElementName, JSXExpression,
    JSXOpeningElement, ModuleDeclaration, Program, PropertyKind, SimpleAssignmentTarget,
    Statement, VariableDeclarationKind, VariableDeclarator,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::operator::{BinaryOperator, UnaryOperator};
use oxc_syntax::scope::ScopeFlags;

use crate::shared::ast::expression_to_argument;
use crate::shared::ast_builder::AstBuilder;
use crate::shared::classify::significant_children;
use crate::shared::paths::relative_id;
use crate::shared::utils::is_component_name;
use crate::shared::xxhash::xxhash32_hex;
use crate::strict::{
    BindingKind, BlockSpans, Classifier, Positions, StrictAnalysis, StrictSite, chain_root,
    json_string, strip_ts,
};

/// The manifest schema this compiler emits. The server runtime, the bootstrap
/// and the event module all carry it; a mismatch anywhere refuses to resume.
pub const SCHEMA: u32 = 1;

/// Default server helper module the SSR rewrite imports from.
pub const DEFAULT_SERVER_MODULE: &str = "@solidjs/resumable/server";

/// Approved scalar event fields the body may read (snapshotted at dispatch).
const EVENT_SCALARS: &[&str] = &[
    "type",
    "isTrusted",
    "timeStamp",
    "defaultPrevented",
    "bubbles",
    "cancelable",
    "detail",
    "button",
    "buttons",
    "clientX",
    "clientY",
    "pageX",
    "pageY",
    "screenX",
    "screenY",
    "offsetX",
    "offsetY",
    "movementX",
    "movementY",
    "altKey",
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "key",
    "code",
    "keyCode",
    "which",
    "repeat",
    "location",
    "data",
    "inputType",
    "isComposing",
    "deltaX",
    "deltaY",
    "deltaZ",
    "deltaMode",
    "pointerId",
    "pointerType",
    "pressure",
    "width",
    "height",
];

/// Approved node roots and the fields the body may read on them. The snapshot
/// records the field values at dispatch; the live node is not retained.
const EVENT_NODES: &[&str] = &["target", "currentTarget"];
const EVENT_NODE_FIELDS: &[&str] = &["value", "checked", "name", "id", "type", "selectedIndex"];

/// Event methods a leading prelude statement may call.
const PRELUDE_METHODS: &[&str] = &["preventDefault", "stopPropagation", "stopImmediatePropagation"];

/// Compile-time configuration (from the `resumableEvents` option).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResumableConfig {
    /// Refuse the build instead of leaving a handler hydrated.
    pub require: bool,
    /// Project root; module ids hash the root-relative filename.
    pub root: Option<String>,
    /// Module the SSR rewrite imports its helpers from.
    pub server_module: Option<String>,
    /// Link facts for imports a handler may capture.
    pub imports: Vec<ImportFact>,
}

/// One verified import: `kind` is `action` (a registered server function,
/// with its wire `id`) or `trusted` (a plain value the linker vouches for).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportFact {
    pub source: String,
    pub imported: String,
    pub kind: String,
    pub id: Option<String>,
}

// --- plan --------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum LiteralValue {
    Str(String),
    Num(f64),
    Bool(bool),
    Null,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Capture {
    /// A component-local value serialized per instance (`reason` says why it
    /// is data: `component-const` or `props-path`).
    Value { name: String, reason: &'static str },
    /// A module-level literal `const`, carried in the manifest.
    Constant { name: String, value: LiteralValue },
    SignalSetter { name: String, signal: String },
    SignalAccessor { name: String, signal: String },
    /// A link-verified import; the event module imports it itself.
    Import {
        local: String,
        source: String,
        imported: String,
        kind: String,
        id: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum GuardTest {
    Truthy,
    Falsy,
    Eq(LiteralValue),
    NotEq(LiteralValue),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PreludeOp {
    Method(String),
    /// `if (<test on path>) return;` — the bootstrap drops the event when the
    /// test holds.
    Guard { path: Vec<String>, test: GuardTest },
}

#[derive(Clone, Debug)]
pub(crate) struct HandlerPlan {
    pub id: String,
    pub scope: usize,
    pub block: String,
    pub event: String,
    pub export: String,
    pub callback: Span,
    pub source_hash: String,
    pub is_async: bool,
    pub captures: Vec<Capture>,
    pub prelude: Vec<PreludeOp>,
    pub snapshot: Vec<Vec<String>>,
}

#[derive(Clone, Debug)]
pub(crate) struct Binding {
    pub path: Vec<usize>,
    /// The ordinal of the `<!--$-->` marker inside the element, or `None`
    /// when the expression is the element's only significant child (SSR
    /// emits no markers then).
    pub hole: Option<usize>,
    pub signal: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ElementPlan {
    pub opening: Span,
    pub path: Vec<usize>,
    pub on: Vec<(String, usize)>,
    /// Handler attributes to drop in the SSR rewrite.
    pub attributes: Vec<Span>,
}

#[derive(Clone, Debug)]
pub(crate) enum ValueSource {
    Binding(String),
    SignalRead(String),
}

#[derive(Clone, Debug)]
pub(crate) struct ScopePlan {
    pub id: String,
    pub component: String,
    pub return_span: Span,
    pub root: Span,
    pub values: Vec<(String, ValueSource)>,
    pub signals: Vec<String>,
    pub bindings: Vec<Binding>,
    pub elements: Vec<ElementPlan>,
}

#[derive(Clone, Debug)]
pub(crate) struct Diagnostic {
    pub block: Option<String>,
    pub scope: Option<String>,
    pub status: &'static str,
    pub reason: Option<String>,
    pub message: String,
    pub site: StrictSite,
}

/// The module's resumable-event plan (analysis result).
#[derive(Clone, Debug)]
pub struct Plan {
    module: String,
    file: String,
    scopes: Vec<ScopePlan>,
    handlers: Vec<HandlerPlan>,
    diagnostics: Vec<Diagnostic>,
    /// Import sources the event module needs: source → (imported, local).
    imports: Vec<(String, Vec<(String, String)>)>,
    server_module: String,
}

/// The generated event module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventModule {
    pub name: String,
    pub code: String,
    pub map: Option<String>,
}

impl Plan {
    pub fn has_handlers(&self) -> bool {
        !self.handlers.is_empty()
    }

    /// The resumable manifest for this module (JSON), with the event module
    /// when one was generated.
    pub fn to_json(&self, module: Option<&EventModule>) -> String {
        let mut out = String::new();
        out.push_str(&format!("{{\"schema\":{SCHEMA},\"module\":"));
        json_string(&mut out, &self.module);
        out.push_str(",\"file\":");
        json_string(&mut out, &self.file);
        out.push_str(",\"scopes\":[");
        for (i, scope) in self.scopes.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"id\":");
            json_string(&mut out, &scope.id);
            out.push_str(",\"component\":");
            json_string(&mut out, &scope.component);
            out.push_str(",\"values\":[");
            for (j, (name, _)) in scope.values.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                json_string(&mut out, name);
            }
            out.push_str("],\"signals\":[");
            for (j, name) in scope.signals.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                json_string(&mut out, name);
            }
            out.push_str("],\"bindings\":[");
            for (j, binding) in scope.bindings.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                out.push_str("{\"kind\":\"text\",\"path\":");
                write_usize_array(&mut out, &binding.path);
                out.push_str(",\"hole\":");
                match binding.hole {
                    Some(hole) => out.push_str(&hole.to_string()),
                    None => out.push_str("null"),
                }
                out.push_str(",\"signal\":");
                json_string(&mut out, &binding.signal);
                out.push('}');
            }
            out.push_str("],\"elements\":[");
            for (j, element) in scope.elements.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                out.push_str("{\"path\":");
                write_usize_array(&mut out, &element.path);
                out.push_str(",\"on\":{");
                for (k, (event, handler)) in element.on.iter().enumerate() {
                    if k > 0 {
                        out.push(',');
                    }
                    json_string(&mut out, event);
                    out.push(':');
                    json_string(&mut out, &self.handlers[*handler].id);
                }
                out.push_str("}}");
            }
            out.push_str("]}");
        }
        out.push_str("],\"handlers\":[");
        for (i, handler) in self.handlers.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"id\":");
            json_string(&mut out, &handler.id);
            out.push_str(",\"scope\":");
            json_string(&mut out, &self.scopes[handler.scope].id);
            out.push_str(",\"block\":");
            json_string(&mut out, &handler.block);
            out.push_str(",\"event\":");
            json_string(&mut out, &handler.event);
            out.push_str(",\"export\":");
            json_string(&mut out, &handler.export);
            out.push_str(",\"source\":");
            json_string(&mut out, &handler.source_hash);
            out.push_str(&format!(",\"async\":{}", handler.is_async));
            out.push_str(",\"captures\":[");
            for (j, capture) in handler.captures.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                write_capture(&mut out, capture);
            }
            out.push_str("],\"prelude\":[");
            for (j, op) in handler.prelude.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                match op {
                    PreludeOp::Method(name) => {
                        out.push_str("{\"op\":");
                        json_string(&mut out, name);
                        out.push('}');
                    }
                    PreludeOp::Guard { path, test } => {
                        out.push_str("{\"op\":\"guard\",\"path\":");
                        write_string_array(&mut out, path);
                        out.push_str(",\"test\":");
                        match test {
                            GuardTest::Truthy => out.push_str("\"truthy\""),
                            GuardTest::Falsy => out.push_str("\"falsy\""),
                            GuardTest::Eq(value) => {
                                out.push_str("\"eq\",\"value\":");
                                write_literal(&mut out, value);
                            }
                            GuardTest::NotEq(value) => {
                                out.push_str("\"neq\",\"value\":");
                                write_literal(&mut out, value);
                            }
                        }
                        out.push('}');
                    }
                }
            }
            out.push_str("],\"snapshot\":[");
            for (j, path) in handler.snapshot.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                write_string_array(&mut out, path);
            }
            out.push_str("]}");
        }
        out.push_str("],\"diagnostics\":[");
        for (i, diagnostic) in self.diagnostics.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push('{');
            if let Some(block) = &diagnostic.block {
                out.push_str("\"block\":");
                json_string(&mut out, block);
                out.push(',');
            }
            if let Some(scope) = &diagnostic.scope {
                out.push_str("\"scope\":");
                json_string(&mut out, scope);
                out.push(',');
            }
            out.push_str("\"status\":");
            json_string(&mut out, diagnostic.status);
            if let Some(reason) = &diagnostic.reason {
                out.push_str(",\"reason\":");
                json_string(&mut out, reason);
            }
            out.push_str(",\"message\":");
            json_string(&mut out, &diagnostic.message);
            out.push_str(",\"site\":");
            diagnostic.site.write_json(&mut out);
            out.push('}');
        }
        out.push_str("],\"eventModule\":");
        match module {
            Some(module) => {
                out.push_str("{\"name\":");
                json_string(&mut out, &module.name);
                out.push_str(",\"code\":");
                json_string(&mut out, &module.code);
                out.push_str(",\"map\":");
                match &module.map {
                    Some(map) => out.push_str(map),
                    None => out.push_str("null"),
                }
                out.push('}');
            }
            None => out.push_str("null"),
        }
        out.push('}');
        out
    }
}

fn write_usize_array(out: &mut String, values: &[usize]) {
    out.push('[');
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&value.to_string());
    }
    out.push(']');
}

fn write_string_array(out: &mut String, values: &[String]) {
    out.push('[');
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_string(out, value);
    }
    out.push(']');
}

fn write_literal(out: &mut String, value: &LiteralValue) {
    match value {
        LiteralValue::Str(text) => json_string(out, text),
        LiteralValue::Num(number) => {
            if number.is_finite() {
                out.push_str(&crate::shared::utils::format_number(*number));
            } else {
                out.push_str("null");
            }
        }
        LiteralValue::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        LiteralValue::Null => out.push_str("null"),
    }
}

fn write_capture(out: &mut String, capture: &Capture) {
    match capture {
        Capture::Value { name, reason } => {
            out.push_str("{\"name\":");
            json_string(out, name);
            out.push_str(",\"kind\":\"value\",\"reason\":");
            json_string(out, reason);
            out.push('}');
        }
        Capture::Constant { name, value } => {
            out.push_str("{\"name\":");
            json_string(out, name);
            out.push_str(",\"kind\":\"constant\",\"value\":");
            write_literal(out, value);
            out.push('}');
        }
        Capture::SignalSetter { name, signal } => {
            out.push_str("{\"name\":");
            json_string(out, name);
            out.push_str(",\"kind\":\"signal-setter\",\"signal\":");
            json_string(out, signal);
            out.push('}');
        }
        Capture::SignalAccessor { name, signal } => {
            out.push_str("{\"name\":");
            json_string(out, name);
            out.push_str(",\"kind\":\"signal-accessor\",\"signal\":");
            json_string(out, signal);
            out.push('}');
        }
        Capture::Import {
            local,
            source,
            imported,
            kind,
            id,
        } => {
            out.push_str("{\"name\":");
            json_string(out, local);
            out.push_str(",\"kind\":\"import\",\"source\":");
            json_string(out, source);
            out.push_str(",\"imported\":");
            json_string(out, imported);
            out.push_str(",\"import\":");
            json_string(out, kind);
            if let Some(id) = id {
                out.push_str(",\"id\":");
                json_string(out, id);
            }
            out.push('}');
        }
    }
}

// --- analysis ----------------------------------------------------------------------------

/// A refusal: reason code plus a message and the site it points at.
struct Refusal {
    reason: String,
    message: String,
    span: Span,
}

fn refuse(reason: &str, message: impl Into<String>, span: Span) -> Refusal {
    Refusal {
        reason: reason.to_string(),
        message: message.into(),
        span,
    }
}

/// One host use of an event block, resolved to its JSX position.
struct EventUse {
    attribute: Span,
    element: NodeId,
    component: NodeId,
    event: String,
}

struct SignalInfo {
    name: String,
    accessor: SymbolId,
    setter: Option<SymbolId>,
}

struct ComponentInfo {
    name: String,
    return_span: Span,
    signals: Vec<SignalInfo>,
    /// Top-level `const` bindings whose initializer is literal-shaped.
    plain_consts: HashSet<SymbolId>,
}

/// Analyze the module against the strict analysis and produce the plan.
/// Returns an error string only for a configuration problem or, with
/// `require`, a refusal.
pub(crate) fn analyze<'a>(
    program: &'a Program<'a>,
    source: &str,
    filename: &str,
    analysis: &StrictAnalysis,
    spans: &[BlockSpans],
    config: &ResumableConfig,
) -> Result<Plan, String> {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let mut classifier = Classifier::new(scoping, nodes, program);
    let positions = Positions::new(source);
    let module_hash = xxhash32_hex(&relative_id(config.root.as_deref(), filename));
    let mut plan = Plan {
        module: module_hash.clone(),
        file: filename.to_string(),
        scopes: Vec::new(),
        handlers: Vec::new(),
        diagnostics: Vec::new(),
        imports: Vec::new(),
        server_module: config
            .server_module
            .clone()
            .unwrap_or_else(|| DEFAULT_SERVER_MODULE.to_string()),
    };

    // 1. Event blocks and their JSX positions.
    struct Candidate {
        index: usize,
        uses: Vec<EventUse>,
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut refused_blocks: Vec<(usize, Refusal)> = Vec::new();
    for (index, block) in analysis.blocks.iter().enumerate() {
        if block.host.kind != "event" || !block.diagnostics.is_empty() {
            continue;
        }
        let spans = &spans[index];
        let mut uses = Vec::new();
        let mut failure = None;
        for (use_span, event) in &spans.uses {
            match resolve_event_use(nodes, *use_span, event.clone()) {
                Some(event_use) => uses.push(event_use),
                None => {
                    failure = Some(refuse(
                        "host-site",
                        "the handler's host site could not be located in the JSX tree",
                        *use_span,
                    ));
                    break;
                }
            }
        }
        if failure.is_none() && !uses.is_empty() {
            let first = uses[0].component;
            if uses.iter().any(|u| u.component != first) {
                failure = Some(refuse(
                    "handler-shared-across-components",
                    "the marked handler is bound in more than one component; a resumable handler belongs to exactly one scope",
                    spans.call,
                ));
            }
        }
        match failure {
            Some(refusal) => refused_blocks.push((index, refusal)),
            None if uses.is_empty() => {}
            None => candidates.push(Candidate { index, uses }),
        }
    }

    // 2. Group by component.
    let mut order: Vec<NodeId> = Vec::new();
    let mut by_component: HashMap<NodeId, Vec<usize>> = HashMap::new();
    for (i, candidate) in candidates.iter().enumerate() {
        let component = candidate.uses[0].component;
        if !by_component.contains_key(&component) {
            order.push(component);
        }
        by_component.entry(component).or_default().push(i);
    }
    order.sort_by_key(|id| nodes.get_node(*id).kind().span().start);

    for component_id in order {
        let candidate_indexes = &by_component[&component_id];
        let component_span = nodes.get_node(component_id).kind().span();
        let outcome = plan_component(
            program,
            source,
            &positions,
            scoping,
            nodes,
            &mut classifier,
            config,
            &module_hash,
            analysis,
            spans,
            &candidates
                .iter()
                .enumerate()
                .filter(|(i, _)| candidate_indexes.contains(i))
                .map(|(_, c)| (c.index, c.uses.as_slice()))
                .collect::<Vec<_>>(),
            component_id,
            plan.scopes.len(),
            plan.handlers.len(),
        );
        match outcome {
            Ok((scope, handlers, imports)) => {
                let scope_id = scope.id.clone();
                for handler in &handlers {
                    plan.diagnostics.push(Diagnostic {
                        block: Some(handler.block.clone()),
                        scope: Some(scope_id.clone()),
                        status: "resumable",
                        reason: None,
                        message: format!(
                            "`{}` handler resumes from serialized captures ({})",
                            handler.event,
                            describe_captures(&handler.captures)
                        ),
                        site: positions.site(source, handler.callback),
                    });
                }
                plan.scopes.push(scope);
                plan.handlers.extend(handlers);
                for (source_name, specifiers) in imports {
                    let entry = match plan.imports.iter_mut().find(|(s, _)| *s == source_name) {
                        Some(entry) => entry,
                        None => {
                            plan.imports.push((source_name, Vec::new()));
                            plan.imports.last_mut().expect("just pushed")
                        }
                    };
                    for specifier in specifiers {
                        if !entry.1.contains(&specifier) {
                            entry.1.push(specifier);
                        }
                    }
                }
            }
            Err(refused) => {
                let component_name = refused.component;
                let scope = refused.scope;
                for (position, i) in candidate_indexes.iter().enumerate() {
                    let block = &analysis.blocks[candidates[*i].index];
                    let own = refused.handlers.iter().find(|(p, _)| *p == position);
                    plan.diagnostics.push(match own {
                        Some((_, refusal)) => Diagnostic {
                            block: Some(block.id.clone()),
                            scope: Some(component_name.clone()),
                            status: "hydrated",
                            reason: Some(refusal.reason.clone()),
                            message: refusal.message.clone(),
                            site: positions.site(source, refusal.span),
                        },
                        None => Diagnostic {
                            block: Some(block.id.clone()),
                            scope: Some(component_name.clone()),
                            status: "hydrated",
                            reason: Some("scope-refused".into()),
                            message: format!(
                                "the handler is sound but its scope `{component_name}` is not resumable: {} ({})",
                                scope.message, scope.reason
                            ),
                            site: positions.site(source, scope.span),
                        },
                    });
                }
                plan.diagnostics.push(Diagnostic {
                    block: None,
                    scope: Some(component_name),
                    status: "hydrated",
                    reason: Some(scope.reason),
                    message: scope.message,
                    site: positions.site(source, if candidate_indexes.is_empty() { component_span } else { scope.span }),
                });
            }
        }
    }
    for (index, refusal) in refused_blocks {
        plan.diagnostics.push(Diagnostic {
            block: Some(analysis.blocks[index].id.clone()),
            scope: None,
            status: "hydrated",
            reason: Some(refusal.reason),
            message: refusal.message,
            site: positions.site(source, refusal.span),
        });
    }
    plan.diagnostics
        .sort_by_key(|d| (d.site.start, d.site.end));

    if config.require
        && let Some(diagnostic) = plan.diagnostics.iter().find(|d| d.status == "hydrated")
    {
        return Err(format!(
            "[RESUME_REFUSED] {} ({}:{})",
            diagnostic.message, diagnostic.site.line, diagnostic.site.column
        ));
    }
    Ok(plan)
}

fn describe_captures(captures: &[Capture]) -> String {
    if captures.is_empty() {
        return "no captures".into();
    }
    captures
        .iter()
        .map(|capture| match capture {
            Capture::Value { name, reason } => format!("{name}: value[{reason}]"),
            Capture::Constant { name, .. } => format!("{name}: constant"),
            Capture::SignalSetter { name, signal } => format!("{name}: setter of {signal}"),
            Capture::SignalAccessor { name, signal } => format!("{name}: accessor of {signal}"),
            Capture::Import { local, kind, .. } => format!("{local}: {kind} import"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Locate the JSX attribute, element and enclosing component of a host use.
fn resolve_event_use(nodes: &AstNodes<'_>, use_span: Span, event: Option<String>) -> Option<EventUse> {
    let event = event?;
    let node = nodes.iter().find(|node| {
        matches!(
            node.kind(),
            AstKind::CallExpression(_) | AstKind::IdentifierReference(_)
        ) && node.kind().span() == use_span
    })?;
    let container = nodes.parent_node(node.id());
    let AstKind::JSXExpressionContainer(_) = container.kind() else {
        return None;
    };
    let attribute = nodes.parent_node(container.id());
    let AstKind::JSXAttribute(attribute_node) = attribute.kind() else {
        return None;
    };
    let opening = nodes.parent_node(attribute.id());
    let AstKind::JSXOpeningElement(_) = opening.kind() else {
        return None;
    };
    let element = nodes.parent_node(opening.id());
    let AstKind::JSXElement(_) = element.kind() else {
        return None;
    };
    let component = nodes.ancestors(element.id()).find(|ancestor| {
        matches!(
            ancestor.kind(),
            AstKind::Function(_) | AstKind::ArrowFunctionExpression(_)
        )
    })?;
    Some(EventUse {
        attribute: attribute_node.span,
        element: element.id(),
        component: component.id(),
        event,
    })
}

/// The component's name and body statements, or a refusal.
fn component_info<'a>(
    nodes: &AstNodes<'a>,
    scoping: &Scoping,
    classifier: &mut Classifier<'_, 'a>,
    component_id: NodeId,
) -> Result<(ComponentInfo, &'a [Statement<'a>]), Refusal> {
    let node = nodes.get_node(component_id);
    let span = node.kind().span();
    let (name, statements): (Option<String>, Option<&'a [Statement<'a>]>) = match node.kind() {
        AstKind::Function(function) => (
            function
                .id
                .as_ref()
                .map(|id| id.name.to_string())
                .or_else(|| declarator_name(nodes, component_id)),
            function.body.as_ref().map(|body| body.statements.as_slice()),
        ),
        AstKind::ArrowFunctionExpression(arrow) => (
            declarator_name(nodes, component_id),
            match &arrow.body {
                ArrowFunctionBody::FunctionBody(body) => Some(body.statements.as_slice()),
                _ => None,
            },
        ),
        _ => (None, None),
    };
    let Some(name) = name else {
        return Err(refuse(
            "component-shape",
            "the handler's enclosing function has no name; a resumable scope is a named component",
            span,
        ));
    };
    if !name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
        return Err(refuse(
            "component-shape",
            format!("`{name}` is not a component (its name does not start with a capital letter), so the handler has no resumable scope"),
            span,
        ));
    }
    let Some(statements) = statements else {
        return Err(refuse(
            "component-shape",
            format!("`{name}` has an expression body; a resumable scope needs a block body whose last statement returns the template"),
            span,
        ));
    };
    let Some(Statement::ReturnStatement(ret)) = statements.last() else {
        return Err(refuse(
            "component-shape",
            format!("`{name}` does not end with `return <element>`; a resumable scope needs the template as the last statement"),
            span,
        ));
    };
    let Some(argument) = ret.argument.as_ref() else {
        return Err(refuse("component-shape", "the component returns nothing", ret.span));
    };
    if !matches!(strip_ts(argument), Expression::JSXElement(_)) {
        return Err(refuse(
            "component-shape",
            format!("`{name}` returns something other than a single JSX element (a fragment, a conditional, a component call); the narrow resume-scope IR covers one static template"),
            ret.span,
        ));
    }

    // Signals and plain consts declared at the top level of the body.
    let mut signals = Vec::new();
    let mut plain_consts = HashSet::new();
    for statement in statements {
        let Statement::VariableDeclaration(declaration) = statement else {
            continue;
        };
        let is_const = declaration.kind == VariableDeclarationKind::Const;
        for declarator in &declaration.declarations {
            if let Some(signal) = signal_declarator(classifier, declarator, is_const) {
                signals.push(signal);
                continue;
            }
            if !is_const {
                continue;
            }
            let BindingPattern::BindingIdentifier(id) = &declarator.id else {
                continue;
            };
            let Some(symbol) = id.symbol_id.get() else {
                continue;
            };
            if let Some(init) = declarator.init.as_ref()
                && classifier.is_plain_expression(init, Span::new(0, 0))
                && !matches!(strip_ts(init), Expression::Identifier(_))
            {
                plain_consts.insert(symbol);
            }
        }
    }
    let _ = scoping;
    Ok((
        ComponentInfo {
            name,
            return_span: ret.span,
            signals,
            plain_consts,
        },
        statements,
    ))
}

fn declarator_name(nodes: &AstNodes<'_>, id: NodeId) -> Option<String> {
    match nodes.parent_node(id).kind() {
        AstKind::VariableDeclarator(declarator) => declarator
            .id
            .get_identifier_name()
            .map(|name| name.to_string()),
        _ => None,
    }
}

/// `const [count, setCount] = createSignal(...)`.
fn signal_declarator<'a>(
    classifier: &mut Classifier<'_, 'a>,
    declarator: &VariableDeclarator<'a>,
    is_const: bool,
) -> Option<SignalInfo> {
    if !is_const {
        return None;
    }
    let BindingPattern::ArrayPattern(pattern) = &declarator.id else {
        return None;
    };
    let Expression::CallExpression(call) = strip_ts(declarator.init.as_ref()?) else {
        return None;
    };
    let Expression::Identifier(callee) = strip_ts(&call.callee) else {
        return None;
    };
    let (_, kind) = classifier.classify_reference(callee, Span::new(0, 0));
    if !matches!(kind, BindingKind::Factory(name) if name == "createSignal") {
        return None;
    }
    // A computed signal (`createSignal(fn)`) is not a plain value store.
    if call.arguments.first().is_some_and(|argument| {
        matches!(
            argument,
            Argument::ArrowFunctionExpression(_) | Argument::FunctionExpression(_)
        )
    }) {
        return None;
    }
    let mut elements = pattern.elements.iter();
    let accessor = match elements.next()? {
        Some(BindingPattern::BindingIdentifier(id)) => (id.name.to_string(), id.symbol_id.get()?),
        _ => return None,
    };
    let setter = match elements.next() {
        Some(Some(BindingPattern::BindingIdentifier(id))) => id.symbol_id.get(),
        Some(None) | None => None,
        _ => return None,
    };
    Some(SignalInfo {
        name: accessor.0,
        accessor: accessor.1,
        setter,
    })
}

/// Why a component is not a resumable scope: the scope-level refusal plus
/// every handler's own refusal (a handler without one is refused because
/// its scope is).
struct ComponentRefusal {
    component: String,
    scope: Refusal,
    handlers: Vec<(usize, Refusal)>,
}

type ComponentOutcome = Result<
    (ScopePlan, Vec<HandlerPlan>, Vec<(String, Vec<(String, String)>)>),
    ComponentRefusal,
>;

fn scope_refusal(component: &str, refusal: Refusal) -> ComponentRefusal {
    ComponentRefusal {
        component: component.to_string(),
        scope: refusal,
        handlers: Vec::new(),
    }
}

#[allow(clippy::too_many_arguments)]
fn plan_component<'a>(
    program: &'a Program<'a>,
    source: &str,
    positions: &Positions,
    scoping: &Scoping,
    nodes: &AstNodes<'a>,
    classifier: &mut Classifier<'_, 'a>,
    config: &ResumableConfig,
    module_hash: &str,
    analysis: &StrictAnalysis,
    spans: &[BlockSpans],
    candidates: &[(usize, &[EventUse])],
    component_id: NodeId,
    scope_index: usize,
    handler_base: usize,
) -> ComponentOutcome {
    let _ = positions;
    let component_name = match nodes.get_node(component_id).kind() {
        AstKind::Function(function) => function
            .id
            .as_ref()
            .map(|id| id.name.to_string())
            .or_else(|| declarator_name(nodes, component_id)),
        _ => declarator_name(nodes, component_id),
    }
    .unwrap_or_else(|| "<anonymous>".to_string());
    let (info, statements) = component_info(nodes, scoping, classifier, component_id)
        .map_err(|r| scope_refusal(&component_name, r))?;
    let Some(Statement::ReturnStatement(ret)) = statements.last() else {
        unreachable!("component_info checked the return");
    };
    let Expression::JSXElement(root) = strip_ts(ret.argument.as_ref().expect("checked")) else {
        unreachable!("component_info checked the element");
    };

    // Handler attribute span → (candidate index, event).
    let mut handler_attributes: HashMap<u32, (usize, String)> = HashMap::new();
    for (i, (_, uses)) in candidates.iter().enumerate() {
        for event_use in uses.iter() {
            handler_attributes.insert(event_use.attribute.start, (i, event_use.event.clone()));
        }
    }
    let mut handler_elements: HashSet<NodeId> = HashSet::new();
    for (_, uses) in candidates {
        for event_use in uses.iter() {
            handler_elements.insert(event_use.element);
        }
    }

    // 3. Walk the template.
    let mut walker = TemplateWalker {
        classifier,
        signals: &info.signals,
        handler_attributes: &handler_attributes,
        bindings: Vec::new(),
        elements: Vec::new(),
        binding_call_spans: HashSet::new(),
        path: Vec::new(),
        failure: None,
    };
    walker.walk_element(root);
    if let Some(refusal) = walker.failure {
        return Err(scope_refusal(&info.name, refusal));
    }
    let bindings = walker.bindings;
    let elements = walker.elements;
    let binding_call_spans = walker.binding_call_spans;
    // Every handler element must have been reached inside the root template.
    let seen: HashSet<u32> = elements.iter().map(|e| e.opening.start).collect();
    for element_id in &handler_elements {
        let AstKind::JSXElement(element) = nodes.get_node(*element_id).kind() else {
            continue;
        };
        if !seen.contains(&element.opening_element.span.start) {
            return Err(scope_refusal(
                &info.name,
                refuse(
                    "handler-outside-template",
                    "a resumable handler is bound on an element outside the component's returned template (inside a nested callback or another expression)",
                    element.span,
                ),
            ));
        }
    }

    // 4. Analyze each handler; every refusal is reported at its own handler.
    let mut handlers = Vec::new();
    let mut imports: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut accepted_callbacks: Vec<Span> = Vec::new();
    let mut handler_refusals: Vec<(usize, Refusal)> = Vec::new();
    let mut analyzed_handlers = Vec::new();
    for (i, (block_index, _)) in candidates.iter().enumerate() {
        let block_spans = &spans[*block_index];
        let Some(callback) = find_callback(program, block_spans.callback) else {
            handler_refusals.push((
                i,
                refuse("host-site", "the callback could not be located", block_spans.callback),
            ));
            continue;
        };
        match analyze_handler(
            classifier,
            scoping,
            nodes,
            config,
            &info,
            callback,
            block_spans.callback,
        ) {
            Ok(analyzed) => analyzed_handlers.push(analyzed),
            Err(refusal) => handler_refusals.push((i, refusal)),
        }
    }
    if let Some((_, first)) = handler_refusals.first() {
        return Err(ComponentRefusal {
            component: info.name.clone(),
            scope: refuse(
                "handler-refused",
                format!("a handler of `{}` is not resumable ({})", info.name, first.reason),
                first.span,
            ),
            handlers: handler_refusals,
        });
    }
    for ((i, (block_index, uses)), analyzed) in candidates.iter().enumerate().zip(analyzed_handlers) {
        let block = &analysis.blocks[*block_index];
        let block_spans = &spans[*block_index];
        for capture in &analyzed.captures {
            if let Capture::Import {
                local,
                source,
                imported,
                ..
            } = capture
            {
                let entry = match imports.iter_mut().find(|(s, _)| s == source) {
                    Some(entry) => entry,
                    None => {
                        imports.push((source.clone(), Vec::new()));
                        imports.last_mut().expect("just pushed")
                    }
                };
                let specifier = (imported.clone(), local.clone());
                if !entry.1.contains(&specifier) {
                    entry.1.push(specifier);
                }
            }
        }
        let event = uses
            .first()
            .map(|u| u.event.clone())
            .unwrap_or_default();
        let index = handler_base + handlers.len();
        let source_text = &source[block_spans.callback.start as usize..block_spans.callback.end as usize];
        handlers.push(HandlerPlan {
            id: format!("{module_hash}.h{index}"),
            scope: scope_index,
            block: block.id.clone(),
            event,
            export: format!("h{index}"),
            callback: block_spans.callback,
            source_hash: xxhash32_hex(source_text),
            is_async: block.is_async,
            captures: analyzed.captures,
            prelude: analyzed.prelude,
            snapshot: analyzed.snapshot,
        });
        accepted_callbacks.push(block_spans.callback);
        let _ = i;
    }

    // 5. Signals used by handlers or bindings must not escape.
    let mut used_signals: Vec<String> = Vec::new();
    for handler in &handlers {
        for capture in &handler.captures {
            if let Capture::SignalSetter { signal, .. } | Capture::SignalAccessor { signal, .. } =
                capture
                && !used_signals.contains(signal)
            {
                used_signals.push(signal.clone());
            }
        }
    }
    for binding in &bindings {
        if !used_signals.contains(&binding.signal) {
            used_signals.push(binding.signal.clone());
        }
    }
    for name in &used_signals {
        let signal = info
            .signals
            .iter()
            .find(|s| s.name == *name)
            .expect("used signals come from the declared set");
        let inside_handler = |span: Span| accepted_callbacks.iter().any(|c| c.contains_inclusive(span));
        for reference in scoping.get_resolved_references(signal.accessor) {
            let span = nodes.get_node(reference.node_id()).kind().span();
            if inside_handler(span) || binding_call_spans.contains(&span.start) {
                continue;
            }
            return Err(scope_refusal(
                &info.name,
                refuse(
                    "signal-escapes",
                    format!(
                        "`{name}` is read outside the resumable handlers and exact text bindings of `{}`; the client cannot reconstruct a signal whose other readers it never runs",
                        info.name
                    ),
                    span,
                ),
            ));
        }
        if let Some(setter) = signal.setter {
            for reference in scoping.get_resolved_references(setter) {
                let span = nodes.get_node(reference.node_id()).kind().span();
                if inside_handler(span) {
                    continue;
                }
                return Err(scope_refusal(
                    &info.name,
                    refuse(
                        "signal-escapes",
                        format!(
                            "the setter of `{name}` is used outside the resumable handlers of `{}`; a resumable signal changes only through resumed handlers",
                            info.name
                        ),
                        span,
                    ),
                ));
            }
        }
    }

    // 6. Per-instance values: value captures, then the signals.
    let mut values: Vec<(String, ValueSource)> = Vec::new();
    for handler in &handlers {
        for capture in &handler.captures {
            if let Capture::Value { name, .. } = capture
                && !values.iter().any(|(n, _)| n == name)
            {
                values.push((name.clone(), ValueSource::Binding(name.clone())));
            }
        }
    }
    for name in &used_signals {
        values.push((name.clone(), ValueSource::SignalRead(name.clone())));
    }

    // 7. Element on-maps reference handler indexes in the plan.
    let elements = elements
        .into_iter()
        .map(|element| ElementPlan {
            on: element
                .on
                .into_iter()
                .map(|(event, candidate)| (event, handler_base + candidate))
                .collect(),
            ..element
        })
        .collect();

    Ok((
        ScopePlan {
            id: format!("{module_hash}.s{scope_index}"),
            component: info.name.clone(),
            return_span: info.return_span,
            root: root.span,
            values,
            signals: used_signals,
            bindings,
            elements,
        },
        handlers,
        imports,
    ))
}

/// Find a function expression by span in the (pre-erasure) program.
fn find_callback<'b, 'a>(program: &'b Program<'a>, span: Span) -> Option<&'b Expression<'a>> {
    struct Finder<'b, 'a> {
        span: Span,
        found: Option<&'b Expression<'a>>,
    }
    impl<'b, 'a> Visit<'a> for Finder<'b, 'a>
    where
        'a: 'b,
    {
        fn visit_expression(&mut self, it: &Expression<'a>) {
            if self.found.is_some() {
                return;
            }
            if it.span() == self.span
                && matches!(
                    it,
                    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
                )
            {
                // SAFETY of lifetimes: the visitor only hands out references
                // that live as long as the program it walks; the visit trait
                // signature narrows them, so extend back to the program's
                // borrow here.
                let extended: &'b Expression<'a> = unsafe { std::mem::transmute(it) };
                self.found = Some(extended);
                return;
            }
            walk::walk_expression(self, it);
        }
    }
    let mut finder = Finder { span, found: None };
    finder.visit_program(program);
    finder.found
}

// --- template walk -----------------------------------------------------------------------

struct TemplateWalker<'w, 'b, 'a> {
    classifier: &'w mut Classifier<'b, 'a>,
    signals: &'w [SignalInfo],
    handler_attributes: &'w HashMap<u32, (usize, String)>,
    bindings: Vec<Binding>,
    elements: Vec<ElementPlan>,
    /// Spans of the accessor call expressions that are exact text bindings.
    binding_call_spans: HashSet<u32>,
    path: Vec<usize>,
    failure: Option<Refusal>,
}

impl<'a> TemplateWalker<'_, '_, 'a> {
    fn fail(&mut self, reason: &str, message: impl Into<String>, span: Span) {
        if self.failure.is_none() {
            self.failure = Some(refuse(reason, message, span));
        }
    }

    fn walk_element(&mut self, element: &JSXElement<'a>) {
        if self.failure.is_some() {
            return;
        }
        let opening: &JSXOpeningElement<'a> = &element.opening_element;
        if is_component_name(&opening.name) {
            self.fail(
                "template-dynamic:component",
                "the template renders a component; the narrow resume-scope IR covers static intrinsic elements and exact text bindings only",
                element.span,
            );
            return;
        }
        let JSXElementName::Identifier(_) = &opening.name else {
            self.fail(
                "template-dynamic:element-name",
                "only plain intrinsic element names are supported",
                element.span,
            );
            return;
        };
        let mut on: Vec<(String, usize)> = Vec::new();
        let mut attribute_spans = Vec::new();
        for attribute in &opening.attributes {
            let JSXAttributeItem::Attribute(attribute) = attribute else {
                self.fail(
                    "template-dynamic:spread",
                    "a spread attribute makes the element's attributes dynamic",
                    attribute.span(),
                );
                return;
            };
            let key = match &attribute.name {
                JSXAttributeName::Identifier(name) => name.name.to_string(),
                JSXAttributeName::NamespacedName(name) => {
                    format!("{}:{}", name.namespace.name, name.name.name)
                }
            };
            if let Some((candidate, event)) = self.handler_attributes.get(&attribute.span.start) {
                if on.iter().any(|(e, _)| e == event) {
                    self.fail(
                        "template-dynamic:duplicate-event",
                        format!("`{event}` is bound twice on the same element"),
                        attribute.span,
                    );
                    return;
                }
                on.push((event.clone(), *candidate));
                attribute_spans.push(attribute.span);
                continue;
            }
            let is_event = key.starts_with("on") && key.len() > 2;
            if is_event {
                self.fail(
                    "template-dynamic:handler",
                    format!("`{key}` is not a resumable strict handler (`$(fn)`); a resumable scope cannot leave an ordinary handler unbound"),
                    attribute.span,
                );
                return;
            }
            let reserved = matches!(
                key.as_str(),
                "ref" | "innerHTML" | "textContent" | "innerText" | "children" | "classList" | "$key"
            ) || key.contains(':');
            if reserved {
                self.fail(
                    "template-dynamic:attribute",
                    format!("`{key}` needs client behavior (a ref, directive, property or namespace) the resumed scope does not reconstruct"),
                    attribute.span,
                );
                return;
            }
            match &attribute.value {
                None | Some(JSXAttributeValue::StringLiteral(_)) => {}
                Some(JSXAttributeValue::ExpressionContainer(container)) => {
                    let literal = matches!(
                        &container.expression,
                        JSXExpression::StringLiteral(_)
                            | JSXExpression::NumericLiteral(_)
                            | JSXExpression::BooleanLiteral(_)
                    );
                    if !literal {
                        self.fail(
                            "template-dynamic:attribute",
                            format!("`{key}` has a dynamic value; the resumed scope reconstructs exact text bindings only"),
                            attribute.span,
                        );
                        return;
                    }
                }
                Some(_) => {
                    self.fail(
                        "template-dynamic:attribute",
                        format!("`{key}` has an unsupported value"),
                        attribute.span,
                    );
                    return;
                }
            }
        }
        if !on.is_empty() {
            self.elements.push(ElementPlan {
                opening: opening.span,
                path: self.path.clone(),
                on,
                attributes: attribute_spans,
            });
        }
        // Children.
        let markers = significant_children(&element.children) > 1;
        let mut element_index = 0usize;
        let mut hole_index = 0usize;
        for child in &element.children {
            match child {
                JSXChild::Text(_) => {}
                JSXChild::Element(child_element) => {
                    self.path.push(element_index);
                    self.walk_element(child_element);
                    self.path.pop();
                    element_index += 1;
                    if self.failure.is_some() {
                        return;
                    }
                }
                JSXChild::Fragment(fragment) => {
                    self.fail(
                        "template-dynamic:fragment",
                        "a fragment child is not supported",
                        fragment.span,
                    );
                    return;
                }
                JSXChild::Spread(spread) => {
                    self.fail(
                        "template-dynamic:spread-child",
                        "a spread child is dynamic content",
                        spread.span,
                    );
                    return;
                }
                JSXChild::ExpressionContainer(container) => {
                    if matches!(container.expression, JSXExpression::EmptyExpression(_)) {
                        continue;
                    }
                    let Some(expression) = container.expression.as_expression() else {
                        self.fail(
                            "template-dynamic:child-expression",
                            "an unsupported child expression",
                            container.span,
                        );
                        return;
                    };
                    match self.exact_signal_read(expression) {
                        Some(signal) => {
                            self.binding_call_spans.insert(expression.span().start);
                            self.bindings.push(Binding {
                                path: self.path.clone(),
                                hole: if markers { Some(hole_index) } else { None },
                                signal,
                            });
                        }
                        // A value hole (`{sku}`, a literal): rendered once
                        // by the server, never bound; it still occupies a
                        // marker, so it counts.
                        None if self.static_value_hole(expression) => {}
                        None => {
                            self.fail(
                                "template-dynamic:child-expression",
                                "a child expression other than an exact `signal()` read of a signal this component declares or a plain value; the narrow resume-scope IR reconstructs only exact text bindings",
                                container.span,
                            );
                            return;
                        }
                    }
                    hole_index += 1;
                }
            }
        }
    }

    /// A hole whose value is fixed once rendered: a literal-shaped
    /// expression over plain bindings, or a `const` alias of a props path.
    fn static_value_hole(&mut self, expression: &Expression<'a>) -> bool {
        if self.classifier.is_plain_expression(expression, Span::new(0, 0)) {
            return true;
        }
        let Expression::Identifier(reference) = strip_ts(expression) else {
            return false;
        };
        let (symbol, kind) = self.classifier.classify_reference(reference, Span::new(0, 0));
        match (symbol, kind) {
            (Some(_), BindingKind::PathAlias { root, .. }) => {
                matches!(self.classifier.classify(root, Span::new(0, 0)), BindingKind::Props)
            }
            _ => false,
        }
    }

    /// `count()` where `count` is a declared signal accessor.
    fn exact_signal_read(&mut self, expression: &Expression<'a>) -> Option<String> {
        let Expression::CallExpression(call) = strip_ts(expression) else {
            return None;
        };
        if !call.arguments.is_empty() || call.optional {
            return None;
        }
        let Expression::Identifier(callee) = strip_ts(&call.callee) else {
            return None;
        };
        let symbol = self.classifier.symbol_of(callee)?;
        self.signals
            .iter()
            .find(|signal| signal.accessor == symbol)
            .map(|signal| signal.name.clone())
    }
}

// --- handler analysis --------------------------------------------------------------------

struct AnalyzedHandler {
    captures: Vec<Capture>,
    prelude: Vec<PreludeOp>,
    snapshot: Vec<Vec<String>>,
}

fn analyze_handler<'a>(
    classifier: &mut Classifier<'_, 'a>,
    scoping: &Scoping,
    nodes: &AstNodes<'a>,
    config: &ResumableConfig,
    component: &ComponentInfo,
    callback: &Expression<'a>,
    callback_span: Span,
) -> Result<AnalyzedHandler, Refusal> {
    // Parameters: none, or one plain identifier (the event).
    let (params, body_statements, expression_body): (
        &oxc_ast::ast::FormalParameters<'a>,
        Option<&[Statement<'a>]>,
        Option<&Expression<'a>>,
    ) = match callback {
        Expression::ArrowFunctionExpression(arrow) => (
            &arrow.params,
            match &arrow.body {
                ArrowFunctionBody::FunctionBody(body) => Some(body.statements.as_slice()),
                _ => None,
            },
            match &arrow.body {
                ArrowFunctionBody::FunctionBody(_) => None,
                body => body.as_expression(),
            },
        ),
        Expression::FunctionExpression(function) => {
            if function.generator {
                return Err(refuse(
                    "unsupported-syntax",
                    "a generator handler is not resumable in this slice",
                    function.span,
                ));
            }
            (
                &function.params,
                function.body.as_ref().map(|body| body.statements.as_slice()),
                None,
            )
        }
        _ => {
            return Err(refuse(
                "unsupported-syntax",
                "the handler is not a function expression",
                callback_span,
            ));
        }
    };
    if params.items.len() > 1 || params.rest.is_some() {
        return Err(refuse(
            "unsupported-syntax",
            "a resumable handler takes at most the event parameter",
            params.span,
        ));
    }
    let event_symbol = match params.items.first() {
        None => None,
        Some(param) => match &param.pattern {
            BindingPattern::BindingIdentifier(id) if param.initializer.is_none() => {
                id.symbol_id.get()
            }
            _ => {
                return Err(refuse(
                    "unsupported-syntax",
                    "the event parameter must be a plain identifier (no destructuring or default)",
                    param.span,
                ));
            }
        },
    };

    // Prelude: leading `event.method()` calls and `if (<guard>) return;`.
    let mut prelude = Vec::new();
    let mut prelude_calls = HashSet::new();
    let mut snapshot: Vec<Vec<String>> = Vec::new();
    if let (Some(statements), Some(event)) = (body_statements, event_symbol) {
        for statement in statements {
            match prelude_statement(classifier, statement, event) {
                Some((op, call_span)) => {
                    if let PreludeOp::Guard { path, .. } = &op {
                        push_unique(&mut snapshot, path.clone());
                    }
                    if let Some(span) = call_span {
                        prelude_calls.insert(span.start);
                    }
                    prelude.push(op);
                }
                None => break,
            }
        }
    }

    let mut walker = HandlerWalker {
        classifier,
        scoping,
        nodes,
        config,
        component,
        callback_span,
        event_symbol,
        prelude_calls,
        captures: Vec::new(),
        snapshot,
        failure: None,
        function_depth: 0,
    };
    match (body_statements, expression_body) {
        (Some(statements), _) => {
            for statement in statements {
                walker.visit_statement(statement);
            }
        }
        (None, Some(expression)) => walker.visit_expression(expression),
        (None, None) => {}
    }
    if let Some(refusal) = walker.failure {
        return Err(refusal);
    }
    let mut snapshot = walker.snapshot;
    snapshot.sort();
    Ok(AnalyzedHandler {
        captures: walker.captures,
        prelude,
        snapshot,
    })
}

fn push_unique(list: &mut Vec<Vec<String>>, path: Vec<String>) {
    if !list.contains(&path) {
        list.push(path);
    }
}

/// A prelude statement and the span of its event-method call (to skip in the
/// body walk).
fn prelude_statement<'a>(
    classifier: &mut Classifier<'_, 'a>,
    statement: &Statement<'a>,
    event: SymbolId,
) -> Option<(PreludeOp, Option<Span>)> {
    match statement {
        Statement::ExpressionStatement(expression) => {
            let Expression::CallExpression(call) = strip_ts(&expression.expression) else {
                return None;
            };
            if !call.arguments.is_empty() || call.optional {
                return None;
            }
            let (root, keys) = chain_root(&call.callee)?;
            if classifier.symbol_of(root) != Some(event) || keys.len() != 1 {
                return None;
            }
            let method = keys[0].as_str();
            if !PRELUDE_METHODS.contains(&method) {
                return None;
            }
            Some((PreludeOp::Method(method.to_string()), Some(call.span)))
        }
        Statement::IfStatement(if_statement) => {
            if if_statement.alternate.is_some() || !is_bare_return(&if_statement.consequent) {
                return None;
            }
            let (path, test) = guard_test(classifier, &if_statement.test, event)?;
            Some((PreludeOp::Guard { path, test }, None))
        }
        _ => None,
    }
}

fn is_bare_return(statement: &Statement<'_>) -> bool {
    match statement {
        Statement::ReturnStatement(ret) => ret.argument.is_none(),
        Statement::BlockStatement(block) => {
            block.body.len() == 1 && is_bare_return(&block.body[0])
        }
        _ => false,
    }
}

fn guard_test<'a>(
    classifier: &mut Classifier<'_, 'a>,
    test: &Expression<'a>,
    event: SymbolId,
) -> Option<(Vec<String>, GuardTest)> {
    let event_path = |classifier: &mut Classifier<'_, 'a>, expression: &Expression<'a>| {
        let (root, keys) = chain_root(expression)?;
        if classifier.symbol_of(root) != Some(event) {
            return None;
        }
        approved_path(&keys).then_some(keys)
    };
    match strip_ts(test) {
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::LogicalNot => {
            let path = event_path(classifier, &unary.argument)?;
            Some((path, GuardTest::Falsy))
        }
        Expression::BinaryExpression(binary) => {
            let path = event_path(classifier, &binary.left)?;
            let literal = literal_value(&binary.right)?;
            let test = match binary.operator {
                BinaryOperator::StrictEquality | BinaryOperator::Equality => GuardTest::Eq(literal),
                BinaryOperator::StrictInequality | BinaryOperator::Inequality => {
                    GuardTest::NotEq(literal)
                }
                _ => return None,
            };
            Some((path, test))
        }
        expression => {
            let path = event_path(classifier, expression)?;
            Some((path, GuardTest::Truthy))
        }
    }
}

fn literal_value(expression: &Expression<'_>) -> Option<LiteralValue> {
    match strip_ts(expression) {
        Expression::StringLiteral(literal) => Some(LiteralValue::Str(literal.value.to_string())),
        Expression::NumericLiteral(literal) => Some(LiteralValue::Num(literal.value)),
        Expression::BooleanLiteral(literal) => Some(LiteralValue::Bool(literal.value)),
        Expression::NullLiteral(_) => Some(LiteralValue::Null),
        Expression::TemplateLiteral(template) if template.expressions.is_empty() => Some(
            LiteralValue::Str(
                template
                    .quasis
                    .iter()
                    .map(|q| q.value.cooked.as_ref().map_or_else(|| q.value.raw.to_string(), |c| c.to_string()))
                    .collect::<Vec<_>>()
                    .join(""),
            ),
        ),
        _ => None,
    }
}

fn approved_path(keys: &[String]) -> bool {
    match keys {
        [field] => EVENT_SCALARS.contains(&field.as_str()),
        [node, field] => {
            EVENT_NODES.contains(&node.as_str()) && EVENT_NODE_FIELDS.contains(&field.as_str())
        }
        _ => false,
    }
}

struct HandlerWalker<'w, 'b, 'a> {
    classifier: &'w mut Classifier<'b, 'a>,
    scoping: &'w Scoping,
    nodes: &'w AstNodes<'a>,
    config: &'w ResumableConfig,
    component: &'w ComponentInfo,
    callback_span: Span,
    event_symbol: Option<SymbolId>,
    prelude_calls: HashSet<u32>,
    captures: Vec<Capture>,
    snapshot: Vec<Vec<String>>,
    failure: Option<Refusal>,
    function_depth: u32,
}

impl<'a> HandlerWalker<'_, '_, 'a> {
    fn fail(&mut self, reason: &str, message: impl Into<String>, span: Span) {
        if self.failure.is_none() {
            self.failure = Some(refuse(reason, message, span));
        }
    }

    fn is_local(&self, symbol: SymbolId) -> bool {
        let declaration = self.nodes.get_node(self.scoping.symbol_declaration(symbol));
        self.callback_span
            .contains_inclusive(declaration.kind().span())
    }

    fn record_capture(&mut self, capture: Capture) {
        let name = match &capture {
            Capture::Value { name, .. }
            | Capture::Constant { name, .. }
            | Capture::SignalSetter { name, .. }
            | Capture::SignalAccessor { name, .. } => name.clone(),
            Capture::Import { local, .. } => local.clone(),
        };
        let exists = self.captures.iter().any(|existing| match existing {
            Capture::Value { name: n, .. }
            | Capture::Constant { name: n, .. }
            | Capture::SignalSetter { name: n, .. }
            | Capture::SignalAccessor { name: n, .. } => *n == name,
            Capture::Import { local, .. } => *local == name,
        });
        if !exists {
            self.captures.push(capture);
        }
    }

    /// Classify a reference to a binding declared outside the callback.
    fn capture_reference(&mut self, reference: &oxc_ast::ast::IdentifierReference<'a>, symbol: SymbolId) {
        let name = reference.name.to_string();
        let span = reference.span;
        // Signals of the scope.
        if let Some(signal) = self
            .component
            .signals
            .iter()
            .find(|s| s.accessor == symbol)
        {
            let signal = signal.name.clone();
            self.record_capture(Capture::SignalAccessor { name, signal });
            return;
        }
        if let Some(signal) = self
            .component
            .signals
            .iter()
            .find(|s| s.setter == Some(symbol))
        {
            let signal = signal.name.clone();
            self.record_capture(Capture::SignalSetter { name, signal });
            return;
        }
        // Imports.
        if let Some((source, imported)) = self.import_of(symbol) {
            match self
                .config
                .imports
                .iter()
                .find(|fact| fact.source == source && fact.imported == imported)
            {
                Some(fact) => {
                    let fact = fact.clone();
                    self.record_capture(Capture::Import {
                        local: name,
                        source,
                        imported,
                        kind: fact.kind,
                        id: fact.id,
                    });
                }
                None => self.fail(
                    "unresolved-import",
                    format!(
                        "`{name}` is imported from `{source}` and no link fact vouches for it (a registered server action or a trusted plain value); the event module cannot import an unsummarized library"
                    ),
                    span,
                ),
            }
            return;
        }
        // Module-level literal constants; other module bindings would have
        // to be re-evaluated by the event module.
        if self.scoping.symbol_scope_id(symbol) == self.scoping.root_scope_id() {
            if let Some(value) = self.module_constant(symbol) {
                self.record_capture(Capture::Constant { name, value });
                return;
            }
            let declaration = self.nodes.get_node(self.scoping.symbol_declaration(symbol));
            match declaration.kind() {
                AstKind::Function(_) => self.fail(
                    "function-capture",
                    format!("`{name}` is a module-level function; only registered actions and the handler's own closures can run on resume (an unsummarized module function would drag its module graph into the event chunk)"),
                    span,
                ),
                AstKind::Class(_) => self.fail(
                    "function-capture",
                    format!("`{name}` is a module-level class"),
                    span,
                ),
                _ => self.fail(
                    "module-binding",
                    format!(
                        "`{name}` is a module-level binding that is not a literal `const`; the event module would have to re-evaluate its initializer, which could change evaluation order"
                    ),
                    span,
                ),
            }
            return;
        }
        // Component-local plain consts and props path aliases.
        if self.component.plain_consts.contains(&symbol) {
            self.record_capture(Capture::Value {
                name,
                reason: "component-const",
            });
            return;
        }
        let kind = self.classifier.classify(symbol, Span::new(0, 0));
        match kind {
            BindingKind::PathAlias { root, .. } => {
                let root_kind = self.classifier.classify(root, Span::new(0, 0));
                if matches!(root_kind, BindingKind::Props) {
                    self.record_capture(Capture::Value {
                        name,
                        reason: "props-path",
                    });
                } else {
                    self.fail(
                        "store-capture",
                        format!("`{name}` aliases a store path; a store is a live proxy the resumed handler cannot address without the store runtime and its owner"),
                        span,
                    );
                }
            }
            BindingKind::Accessor | BindingKind::Setter => self.fail(
                "signal-not-in-scope",
                format!("`{name}` belongs to a signal the scope cannot reconstruct (declared in another component, as a memo, or as a computed signal)"),
                span,
            ),
            BindingKind::Store | BindingKind::StoreSetter => self.fail(
                "store-capture",
                format!("`{name}` is a store capability; stores are not addressable in this slice"),
                span,
            ),
            BindingKind::Props => self.fail(
                "props-capture",
                format!("`{name}` is the props object; read the prop into a `const` at setup and capture that value"),
                span,
            ),
            BindingKind::Callback(_) => self.fail(
                "function-capture",
                format!("`{name}` is a function declared outside the handler; only registered actions and the handler's own closures can run on resume"),
                span,
            ),
            BindingKind::Factory(_) | BindingKind::Marker => self.fail(
                "runtime-factory",
                format!("`{name}` creates reactive state; a resumed handler has no creation owner"),
                span,
            ),
            BindingKind::Marked => self.fail(
                "function-capture",
                format!("`{name}` is another marked callback"),
                span,
            ),
            BindingKind::Plain => self.fail(
                "mutable-or-computed",
                format!("`{name}` is a component-local value the compiler cannot prove constant and literal-shaped (a `let`, a call result, or a parameter); read it into a literal-shaped `const`"),
                span,
            ),
            BindingKind::Opaque => self.fail(
                "opaque-capture",
                format!("`{name}` is a mutable or unclassifiable outer binding (a `let`, a class, a call result); resumed handlers cannot address it"),
                span,
            ),
        }
    }

    fn import_of(&self, symbol: SymbolId) -> Option<(String, String)> {
        let declaration = self.scoping.symbol_declaration(symbol);
        let node = self.nodes.get_node(declaration);
        let imported = match node.kind() {
            AstKind::ImportSpecifier(specifier) => specifier.imported.name().to_string(),
            AstKind::ImportDefaultSpecifier(_) => "default".to_string(),
            _ => return None,
        };
        let import = self.nodes.ancestors(declaration).find_map(|ancestor| match ancestor.kind() {
            AstKind::ImportDeclaration(import) => Some(import),
            _ => None,
        })?;
        Some((import.source.value.to_string(), imported))
    }

    fn module_constant(&self, symbol: SymbolId) -> Option<LiteralValue> {
        let declaration = self.scoping.symbol_declaration(symbol);
        let node = self.nodes.get_node(declaration);
        let AstKind::VariableDeclarator(declarator) = node.kind() else {
            return None;
        };
        let AstKind::VariableDeclaration(declaration) = self.nodes.parent_node(declaration).kind()
        else {
            return None;
        };
        if declaration.kind != VariableDeclarationKind::Const {
            return None;
        }
        literal_value(declarator.init.as_ref()?)
    }

    /// A member chain rooted at the event parameter.
    fn event_chain(&mut self, expression: &Expression<'a>) -> Option<Vec<String>> {
        let event = self.event_symbol?;
        let (root, keys) = chain_root(expression)?;
        (self.classifier.symbol_of(root) == Some(event)).then_some(keys)
    }

    fn read_event_path(&mut self, expression: &Expression<'a>, keys: Vec<String>) -> bool {
        if keys.is_empty() {
            self.fail(
                "event-escape",
                "the event object itself is used as a value; a resumed handler receives a snapshot of approved fields, not the live event",
                expression.span(),
            );
            return true;
        }
        if !approved_path(&keys) {
            self.fail(
                "event-field",
                format!(
                    "`{}` is not an approved event field for a snapshot (scalar event fields, and `value`/`checked`/`name`/`id`/`type`/`selectedIndex` of `target`/`currentTarget`)",
                    keys.join(".")
                ),
                expression.span(),
            );
            return true;
        }
        push_unique(&mut self.snapshot, keys);
        true
    }
}

impl<'a> Visit<'a> for HandlerWalker<'_, '_, 'a> {
    fn visit_expression(&mut self, it: &Expression<'a>) {
        if self.failure.is_some() {
            return;
        }
        if let Some(keys) = self.event_chain(it) {
            self.read_event_path(it, keys);
            return;
        }
        walk::walk_expression(self, it);
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if self.failure.is_some() {
            return;
        }
        if let Some(keys) = self.event_chain(&it.callee) {
            if self.prelude_calls.contains(&it.span.start) {
                return;
            }
            self.fail(
                "event-method-outside-prelude",
                format!(
                    "`{}()` is called outside the synchronous prelude (the leading `preventDefault()` / `stopPropagation()` calls and `if (...) return;` guards); a cold resumed handler runs after the native dispatch, when the call would have no effect",
                    keys.join(".")
                ),
                it.span,
            );
            return;
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &oxc_ast::ast::IdentifierReference<'a>) {
        if self.failure.is_some() {
            return;
        }
        let Some(symbol) = self.classifier.symbol_of(it) else {
            // A global: resolves the same way in the event module.
            return;
        };
        if Some(symbol) == self.event_symbol {
            self.fail(
                "event-escape",
                "the event object itself is used as a value; a resumed handler receives a snapshot of approved fields, not the live event",
                it.span,
            );
            return;
        }
        if self.is_local(symbol) {
            return;
        }
        self.capture_reference(it, symbol);
    }

    fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
        if self.failure.is_some() {
            return;
        }
        match it {
            SimpleAssignmentTarget::AssignmentTargetIdentifier(reference) => {
                if let Some(symbol) = self.classifier.symbol_of(reference)
                    && !self.is_local(symbol)
                {
                    self.fail(
                        "mutable-closure-state",
                        format!("`{}` is assigned inside the handler; a resumed handler receives serialized snapshots of its captures, not shared mutable closure state", reference.name),
                        reference.span,
                    );
                    return;
                }
            }
            SimpleAssignmentTarget::StaticMemberExpression(member)
                if self.event_chain(&member.object).is_some() =>
            {
                self.fail(
                    "event-escape",
                    "the event object is written through",
                    member.span,
                );
                return;
            }
            SimpleAssignmentTarget::ComputedMemberExpression(member)
                if self.event_chain(&member.object).is_some() =>
            {
                self.fail(
                    "event-escape",
                    "the event object is written through",
                    member.span,
                );
                return;
            }
            _ => {}
        }
        walk::walk_simple_assignment_target(self, it);
    }

    fn visit_this_expression(&mut self, it: &oxc_ast::ast::ThisExpression) {
        if self.function_depth == 0 {
            self.fail(
                "unsupported-syntax",
                "`this` has no stable meaning in a resumed handler",
                it.span,
            );
        }
    }

    fn visit_super(&mut self, it: &oxc_ast::ast::Super) {
        self.fail("unsupported-syntax", "`super` is not supported", it.span);
    }

    fn visit_class(&mut self, it: &oxc_ast::ast::Class<'a>) {
        self.fail("unsupported-syntax", "a class inside a resumed handler is not supported", it.span);
    }

    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        self.fail(
            "unsupported-syntax",
            "JSX inside a resumed handler would need the DOM runtime and an owner; not supported",
            it.span,
        );
    }

    fn visit_jsx_fragment(&mut self, it: &oxc_ast::ast::JSXFragment<'a>) {
        self.fail("unsupported-syntax", "JSX inside a resumed handler is not supported", it.span);
    }

    fn visit_yield_expression(&mut self, it: &oxc_ast::ast::YieldExpression<'a>) {
        self.fail("unsupported-syntax", "`yield` is not supported", it.span);
    }

    fn visit_import_meta(&mut self, it: &oxc_ast::ast::ImportMeta) {
        self.fail(
            "unsupported-syntax",
            "`import.meta` depends on the module that evaluates the handler",
            it.span,
        );
    }

    fn visit_new_target(&mut self, it: &oxc_ast::ast::NewTarget) {
        self.fail(
            "unsupported-syntax",
            "`new.target` is not supported in a resumed handler",
            it.span,
        );
    }

    fn visit_import_expression(&mut self, it: &oxc_ast::ast::ImportExpression<'a>) {
        self.fail(
            "unsupported-syntax",
            "a dynamic import inside a resumed handler is an unresolved module edge",
            it.span,
        );
    }

    fn visit_function(&mut self, it: &oxc_ast::ast::Function<'a>, flags: ScopeFlags) {
        self.function_depth += 1;
        walk::walk_function(self, it, flags);
        self.function_depth -= 1;
    }
}

// --- SSR rewrite -------------------------------------------------------------------------

/// Attribute the SSR transform turns into the `_$srRoot(instance)` key hole.
pub(crate) const ROOT_ATTRIBUTE: &str = "$sr";
/// Attribute the SSR transform emits as a whole-attribute hole.
pub(crate) const ELEMENT_ATTRIBUTE: &str = "$srel";

const SCOPE_HELPER: &str = "_$srScope";
const ROOT_HELPER: &str = "_$srRoot";
const ELEMENT_HELPER: &str = "_$srEl";

/// Rewrite the program for an SSR generate: instance declarations, root
/// markers and element markers, plus the helper import.
pub(crate) fn rewrite<'a>(allocator: &'a Allocator, program: &mut Program<'a>, plan: &Plan) {
    if plan.scopes.is_empty() {
        return;
    }
    let mut rewriter = Rewriter {
        allocator,
        plan,
        returns: plan
            .scopes
            .iter()
            .enumerate()
            .map(|(i, scope)| (scope.return_span.start, i))
            .collect(),
        roots: plan
            .scopes
            .iter()
            .enumerate()
            .map(|(i, scope)| (scope.root.start, i))
            .collect(),
        elements: plan
            .scopes
            .iter()
            .enumerate()
            .flat_map(|(i, scope)| {
                scope
                    .elements
                    .iter()
                    .enumerate()
                    .map(move |(j, element)| (element.opening.start, (i, j)))
            })
            .collect(),
    };
    rewriter.visit_program(program);
    let ast = AstBuilder::new(allocator);
    let span = Span::new(0, 0);
    let specifiers = ast.vec_from_array([
        ("srScope", SCOPE_HELPER),
        ("srRoot", ROOT_HELPER),
        ("srEl", ELEMENT_HELPER),
    ]
    .map(|(imported, local)| {
        ast.import_declaration_specifier_import_specifier(
            span,
            ast.module_export_name_identifier_name(span, ast.ident(imported)),
            ast.binding_identifier(span, ast.ident(local)),
            ImportOrExportKind::Value,
        )
    }));
    let import = ast.alloc_import_declaration(
        span,
        Some(specifiers),
        ast.string_literal(span, ast.str(&plan.server_module), None),
        None,
        None,
        ImportOrExportKind::Value,
    );
    program.body.insert(
        0,
        Statement::ImportDeclaration(import),
    );
}

struct Rewriter<'r, 'a> {
    allocator: &'a Allocator,
    plan: &'r Plan,
    returns: HashMap<u32, usize>,
    roots: HashMap<u32, usize>,
    elements: HashMap<u32, (usize, usize)>,
}

impl<'a> Rewriter<'_, 'a> {
    fn instance_name(index: usize) -> String {
        format!("_sr${index}")
    }

    /// `const _sr$N = _$srScope("id", () => ({ a: a, count: count() }));`
    fn instance_statement(&self, scope_index: usize) -> Statement<'a> {
        let ast = AstBuilder::new(self.allocator);
        let span = Span::new(0, 0);
        let scope = &self.plan.scopes[scope_index];
        let properties = ast.vec_from_iter(scope.values.iter().map(|(name, source)| {
            let value = match source {
                ValueSource::Binding(binding) => ast.expression_identifier(span, ast.ident(binding)),
                ValueSource::SignalRead(accessor) => ast.expression_call(
                    span,
                    ast.expression_identifier(span, ast.ident(accessor)),
                    None,
                    ast.vec(),
                    false,
                ),
            };
            ast.object_property_kind_object_property(
                span,
                PropertyKind::Init,
                ast.property_key_static_identifier(span, ast.ident(name)),
                value,
                false,
                false,
                false,
            )
        }));
        let object = ast.expression_object(span, properties);
        let params = ast.formal_parameters(
            span,
            oxc_ast::ast::FormalParameterKind::ArrowFormalParameters,
            ast.vec(),
            None,
        );
        let body = ast.function_body(
            span,
            ast.vec(),
            ast.vec1(ast.statement_expression(span, object)),
        );
        let thunk = ast.expression_arrow_function(span, true, false, None, params, None, body);
        let call = ast.expression_call(
            span,
            ast.expression_identifier(span, ast.ident(SCOPE_HELPER)),
            None,
            ast.vec_from_array([
                expression_to_argument(ast.expression_string_literal(
                    span,
                    ast.str(&scope.id),
                    None,
                )),
                expression_to_argument(thunk),
            ]),
            false,
        );
        let declarator = ast.variable_declarator(
            span,
            VariableDeclarationKind::Const,
            ast.binding_pattern_binding_identifier(span, ast.ident(&Self::instance_name(scope_index))),
            None,
            Some(call),
            false,
        );
        Statement::VariableDeclaration(ast.alloc_variable_declaration(
            span,
            VariableDeclarationKind::Const,
            ast.vec1(declarator),
            false,
        ))
    }
}

impl<'a> VisitMut<'a> for Rewriter<'_, 'a> {
    fn visit_statements(&mut self, statements: &mut oxc_allocator::Vec<'a, Statement<'a>>) {
        walk_mut::walk_statements(self, statements);
        let position = statements.iter().position(|statement| {
            matches!(statement, Statement::ReturnStatement(ret) if self.returns.contains_key(&ret.span.start))
        });
        if let Some(position) = position {
            let Statement::ReturnStatement(ret) = &statements[position] else {
                unreachable!()
            };
            let scope_index = self.returns[&ret.span.start];
            let statement = self.instance_statement(scope_index);
            statements.insert(position, statement);
        }
    }

    fn visit_jsx_element(&mut self, element: &mut JSXElement<'a>) {
        walk_mut::walk_jsx_element(self, element);
        let ast = AstBuilder::new(self.allocator);
        let span = Span::new(0, 0);
        if let Some(scope_index) = self.roots.get(&element.span.start).copied() {
            let value = ast.expression_identifier(span, ast.ident(&Self::instance_name(scope_index)));
            element
                .opening_element
                .attributes
                .push(ast.jsx_attribute_item_expression(span, ROOT_ATTRIBUTE, value));
        }
    }

    fn visit_jsx_opening_element(&mut self, opening: &mut JSXOpeningElement<'a>) {
        walk_mut::walk_jsx_opening_element(self, opening);
        let Some((scope_index, element_index)) = self.elements.get(&opening.span.start).copied()
        else {
            return;
        };
        let ast = AstBuilder::new(self.allocator);
        let span = Span::new(0, 0);
        let element = &self.plan.scopes[scope_index].elements[element_index];
        let drop: HashSet<u32> = element.attributes.iter().map(|s| s.start).collect();
        opening
            .attributes
            .retain(|attribute| !drop.contains(&attribute.span().start));
        let call = ast.expression_call(
            span,
            ast.expression_identifier(span, ast.ident(ELEMENT_HELPER)),
            None,
            ast.vec_from_array([
                expression_to_argument(
                    ast.expression_identifier(span, ast.ident(&Self::instance_name(scope_index))),
                ),
                expression_to_argument(ast.expression_numeric_literal(
                    span,
                    element_index as f64,
                    None,
                    oxc_syntax::number::NumberBase::Decimal,
                )),
            ]),
            false,
        );
        opening
            .attributes
            .push(ast.jsx_attribute_item_expression(span, ELEMENT_ATTRIBUTE, call));
    }
}

// --- event module ------------------------------------------------------------------------

/// Generate the event module from the (post-erasure, pre-JSX-lowering)
/// program: every accepted callback verbatim, wrapped in a capture-rebinding
/// factory, plus the identity record.
pub(crate) fn emit_module<'a>(
    allocator: &'a Allocator,
    program: &Program<'a>,
    plan: &Plan,
    source: &'a str,
    filename: &str,
    source_map: bool,
) -> Option<EventModule> {
    if plan.handlers.is_empty() {
        return None;
    }
    let ast = AstBuilder::new(allocator);
    let span = Span::new(0, 0);
    let mut body: oxc_allocator::Vec<'a, Statement<'a>> = ast.vec();

    // Imports the callbacks reference (link-verified).
    for (source_name, specifiers) in &plan.imports {
        let items = ast.vec_from_iter(specifiers.iter().map(|(imported, local)| {
            if imported == "default" {
                ast.import_declaration_specifier_import_default_specifier(
                    span,
                    ast.binding_identifier(span, ast.ident(local)),
                )
            } else {
                ast.import_declaration_specifier_import_specifier(
                    span,
                    ast.module_export_name_identifier_name(span, ast.ident(imported)),
                    ast.binding_identifier(span, ast.ident(local)),
                    ImportOrExportKind::Value,
                )
            }
        }));
        body.push(Statement::ImportDeclaration(ast.alloc_import_declaration(
            span,
            Some(items),
            ast.string_literal(span, ast.str(source_name), None),
            None,
            None,
            ImportOrExportKind::Value,
        )));
    }

    // export const hN = ({ captures }) => <callback>;
    for handler in &plan.handlers {
        let callback = find_callback(program, handler.callback)?;
        let cloned = callback.clone_in(allocator);
        let bound: Vec<&str> = handler
            .captures
            .iter()
            .filter_map(|capture| match capture {
                Capture::Value { name, .. }
                | Capture::Constant { name, .. }
                | Capture::SignalSetter { name, .. }
                | Capture::SignalAccessor { name, .. } => Some(name.as_str()),
                Capture::Import { .. } => None,
            })
            .collect();
        let params = if bound.is_empty() {
            ast.vec()
        } else {
            let properties = ast.vec_from_iter(bound.iter().map(|name| {
                ast.binding_property(
                    span,
                    ast.property_key_static_identifier(span, ast.ident(name)),
                    ast.binding_pattern_binding_identifier(span, ast.ident(name)),
                    true,
                    false,
                )
            }));
            ast.vec1(ast.formal_parameter(
                span,
                ast.vec(),
                ast.binding_pattern_object_pattern(span, properties, None),
                None,
                None,
                false,
                None,
                false,
                false,
            ))
        };
        let params = ast.formal_parameters(
            span,
            oxc_ast::ast::FormalParameterKind::ArrowFormalParameters,
            params,
            None,
        );
        let factory_body =
            ast.function_body(span, ast.vec(), ast.vec1(ast.statement_expression(span, cloned)));
        let factory = ast.expression_arrow_function(span, true, false, None, params, None, factory_body);
        let declarator = ast.variable_declarator(
            span,
            VariableDeclarationKind::Const,
            ast.binding_pattern_binding_identifier(span, ast.ident(&handler.export)),
            None,
            Some(factory),
            false,
        );
        let declaration = ast.alloc_variable_declaration(
            span,
            VariableDeclarationKind::Const,
            ast.vec1(declarator),
            false,
        );
        body.push(Statement::from(ModuleDeclaration::new_export_declaration(
            span,
            Declaration::VariableDeclaration(declaration),
            &oxc_ast::builder::AstBuilder::new(allocator),
        )));
    }

    // export const __sr = { schema, module, handlers: { hN: "<hash>" }, actions: { local: local.id } };
    let mut properties = ast.vec();
    properties.push(ast.object_property_kind_object_property(
        span,
        PropertyKind::Init,
        ast.property_key_static_identifier(span, ast.ident("schema")),
        ast.expression_numeric_literal(
            span,
            SCHEMA as f64,
            None,
            oxc_syntax::number::NumberBase::Decimal,
        ),
        false,
        false,
        false,
    ));
    properties.push(ast.object_property_kind_object_property(
        span,
        PropertyKind::Init,
        ast.property_key_static_identifier(span, ast.ident("module")),
        ast.expression_string_literal(span, ast.str(&plan.module), None),
        false,
        false,
        false,
    ));
    let handler_properties = ast.vec_from_iter(plan.handlers.iter().map(|handler| {
        ast.object_property_kind_object_property(
            span,
            PropertyKind::Init,
            ast.property_key_static_identifier(span, ast.ident(&handler.export)),
            ast.expression_string_literal(span, ast.str(&handler.source_hash), None),
            false,
            false,
            false,
        )
    }));
    properties.push(ast.object_property_kind_object_property(
        span,
        PropertyKind::Init,
        ast.property_key_static_identifier(span, ast.ident("handlers")),
        ast.expression_object(span, handler_properties),
        false,
        false,
        false,
    ));
    let mut action_locals: Vec<(String, String)> = Vec::new();
    for handler in &plan.handlers {
        for capture in &handler.captures {
            if let Capture::Import {
                local, kind, id: Some(id), ..
            } = capture
                && kind == "action"
                && !action_locals.iter().any(|(l, _)| l == local)
            {
                action_locals.push((local.clone(), id.clone()));
            }
        }
    }
    let action_properties = ast.vec_from_iter(action_locals.iter().map(|(local, _)| {
        let read = Expression::StaticMemberExpression(ast.alloc_static_member_expression(
            span,
            ast.expression_identifier(span, ast.ident(local)),
            ast.identifier_name(span, ast.ident("id")),
            false,
        ));
        ast.object_property_kind_object_property(
            span,
            PropertyKind::Init,
            ast.property_key_static_identifier(span, ast.ident(local)),
            read,
            false,
            false,
            false,
        )
    }));
    properties.push(ast.object_property_kind_object_property(
        span,
        PropertyKind::Init,
        ast.property_key_static_identifier(span, ast.ident("actions")),
        ast.expression_object(span, action_properties),
        false,
        false,
        false,
    ));
    let record = ast.expression_object(span, properties);
    let declarator = ast.variable_declarator(
        span,
        VariableDeclarationKind::Const,
        ast.binding_pattern_binding_identifier(span, ast.ident("__sr")),
        None,
        Some(record),
        false,
    );
    body.push(Statement::from(ModuleDeclaration::new_export_declaration(
        span,
        Declaration::VariableDeclaration(ast.alloc_variable_declaration(
            span,
            VariableDeclarationKind::Const,
            ast.vec1(declarator),
            false,
        )),
        &oxc_ast::builder::AstBuilder::new(allocator),
    )));

    let module = Program::new(
        Span::new(0, source.len() as u32),
        program.source_type,
        source,
        ast.vec(),
        None,
        ast.vec(),
        body,
        &oxc_ast::builder::AstBuilder::new(allocator),
    );
    let build = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: source_map.then(|| std::path::PathBuf::from(filename)),
            ..CodegenOptions::default()
        })
        .build(&module);
    Some(EventModule {
        name: module_name(filename),
        code: build.code,
        map: build.map.as_ref().map(|map| map.to_json_string()),
    })
}

/// `src/app.tsx` → `src/app.resume.tsx`.
fn module_name(filename: &str) -> String {
    match filename.rfind('.') {
        Some(dot) if !filename[dot..].contains('/') => {
            format!("{}.resume{}", &filename[..dot], &filename[dot..])
        }
        _ => format!("{filename}.resume.js"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CompileOptions, Generate, compile};

    fn options(generate: Generate) -> CompileOptions {
        CompileOptions {
            generate,
            hydratable: true,
            filename: Some("src/app.tsx".into()),
            resumable_events: Some(ResumableConfig {
                require: false,
                root: None,
                server_module: None,
                imports: vec![ImportFact {
                    source: "./actions".into(),
                    imported: "track".into(),
                    kind: "action".into(),
                    id: Some("track-abc".into()),
                }],
            }),
            ..CompileOptions::default()
        }
    }

    const COUNTER: &str = r#"
import { $, createSignal } from "solid-js";
export function Counter() {
  const [count, setCount] = createSignal(0);
  return <button onClick={$(() => setCount(c => c + 1))}>{count()}</button>;
}
"#;

    #[test]
    fn counter_scope_is_resumable() {
        let output = compile(COUNTER, &options(Generate::Ssr)).unwrap();
        let json = output.resumable.expect("resumable output");
        assert!(json.contains("\"status\":\"resumable\""), "{json}");
        assert!(json.contains("\"kind\":\"signal-setter\""), "{json}");
        assert!(json.contains("\"bindings\":[{\"kind\":\"text\",\"path\":[],\"hole\":null,\"signal\":\"count\"}]"), "{json}");
        assert!(output.code.contains("_$srScope("), "{}", output.code);
        assert!(output.code.contains("_$srRoot(_sr$0)"), "{}", output.code);
        assert!(output.code.contains("_$srEl(_sr$0, 0)"), "{}", output.code);
        assert!(json.contains("export const h0 = ({ setCount }) => () => setCount"), "{json}");
    }

    #[test]
    fn dom_generate_is_untouched() {
        let output = compile(COUNTER, &options(Generate::Dom)).unwrap();
        assert!(!output.code.contains("_$sr"), "{}", output.code);
        assert!(output.code.contains("$$click"), "{}", output.code);
        assert!(output.resumable.is_some());
    }

    #[test]
    fn refuses_mutable_capture() {
        let source = r#"
import { $, createSignal } from "solid-js";
export function Counter() {
  let n = 0;
  return <button onClick={$(() => { n++; })}>x</button>;
}
"#;
        let output = compile(source, &options(Generate::Ssr)).unwrap();
        let json = output.resumable.unwrap();
        assert!(json.contains("\"status\":\"hydrated\""), "{json}");
        assert!(json.contains("\"reason\":\"mutable-closure-state\""), "{json}");
        assert!(!output.code.contains("_$sr"), "{}", output.code);
    }

    #[test]
    fn require_turns_refusal_into_error() {
        let source = r#"
import { $ } from "solid-js";
export function Buy(props) {
  return <button onClick={$((e: MouseEvent) => console.log(e))}>x</button>;
}
"#;
        let mut options = options(Generate::Ssr);
        options.resumable_events.as_mut().unwrap().require = true;
        let error = compile(source, &options).unwrap_err().to_string();
        assert!(error.contains("RESUME_REFUSED"), "{error}");
        assert!(error.contains("event object itself"), "{error}");
    }

    #[test]
    fn prelude_and_snapshot() {
        let source = r#"
import { $ } from "solid-js";
import { track } from "./actions";
const STEP = 5;
export function Buy(props) {
  const sku = props.sku;
  return <a href="/buy" onClick={$((e: MouseEvent) => {
    e.preventDefault();
    if (!e.isTrusted) return;
    track(sku, STEP, e.clientX, e.currentTarget.id);
  })}>Buy</a>;
}
"#;
        let output = compile(source, &options(Generate::Ssr)).unwrap();
        let json = output.resumable.unwrap();
        assert!(json.contains("\"prelude\":[{\"op\":\"preventDefault\"},{\"op\":\"guard\",\"path\":[\"isTrusted\"],\"test\":\"falsy\"}]"), "{json}");
        assert!(json.contains("\"snapshot\":[[\"clientX\"],[\"currentTarget\",\"id\"],[\"isTrusted\"]]"), "{json}");
        assert!(json.contains("\"kind\":\"constant\",\"value\":5"), "{json}");
        assert!(json.contains("\"reason\":\"props-path\""), "{json}");
        assert!(json.contains("\"import\":\"action\",\"id\":\"track-abc\""), "{json}");
        assert!(json.contains("import { track } from \\\"./actions\\\";"), "{json}");
        assert!(json.contains("actions: { track: track.id }"), "{json}");
    }
}
