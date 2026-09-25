//! Track D slice 5 — server-authoritative replay elimination (proof pass).
//!
//! Today a hydrating client re-runs every `ssrSource: "server"` memo: it adopts
//! the serialized value for async computes but still traces the compute
//! (`subFetch`, with `fetch`/`Promise` mocked) to wire dependencies, and it
//! re-runs synchronous computes (sorting, formatting, projections) outright —
//! sync values are never serialized. Every consumer then links to the node.
//!
//! When the compiler can PROVE that a memo's server value is final on the
//! client — nothing on the client can ever invalidate it, and nothing on the
//! client depends on re-running it — the client can adopt the serialized value
//! as a constant: no computation node, no compute run, no dependency links for
//! any consumer, and no insert effect where it is rendered directly. This pass
//! proves that per module and marks the proven memos by appending `$sealed: 1`
//! to their options object; the server runtime then serializes their values
//! (sync ones included) and the client runtime adopts them while hydrating.
//!
//! ## Proof obligations (all intra-module, syntactic, conservative)
//!
//! A `const X = createMemo(fn, { ssrSource: "server", … })` is sealed iff:
//!
//! 1. **Explicit authority.** The options argument is an object literal with a
//!    literal `ssrSource: "server"` (the default is not enough — the author
//!    must say it), no spread, and no `transparent`. `"hybrid"` and
//!    `"client"` sources are revalidating / client-specific: rejected.
//! 2. **Client-independent inputs.** Every free variable the compute reads is
//!    one of: another sealed memo (read as `Y()`), a *frozen* signal/store
//!    (created from a literal with its setter never referenced — the
//!    setter-escape proof), a module-level primitive `const`, a same-module
//!    function proven pure, an import the cross-module summary declares
//!    `pure`/`server`, or an allowlisted pure global (`Math` minus `random`,
//!    `JSON`, `Number`, `fetch`, …). Client-specific globals (`window`,
//!    `document`, `Date`, `Intl`, `Math.random`, `isServer`, …), component
//!    props / outer parameters, and anything unknown are rejected.
//! 3. **No invalidation.** Every reference to `X` is a read (`X()`, the lowered
//!    `_$perform(X)`, or `yield* X`). Passing the accessor anywhere — to
//!    `refresh`, a prop, an argument, an export — is an escape: rejected. The
//!    compute is not a generator (live iterables are revalidating) and calls
//!    no scheduling API (`setInterval`, `setTimeout`, `EventSource`, …).
//! 4. **Immutable authority.** The adopted value is shared by reference, so no
//!    read of it (followed through member chains, local aliases, iteration
//!    callbacks, `<For>`/`<Show>` render parameters and same-module component
//!    props) may be mutated, passed to an unknown function, or stored in an
//!    escaping position. A sealed value may flow into another memo's result
//!    only if that memo is itself sealed.
//! 5. **No client-visible side effects.** The compute does not assign outside
//!    its own locals and contains no JSX.
//!
//! Sealed-ness is a fixed point: a memo reading (or flowing into) a memo that
//! fails is dropped.
//!
//! The decision is identical on both generates (it runs before JSX lowering
//! on the shared AST), so the server serializes exactly the memos the client
//! adopts. Hydratable builds only, behind the `serverAuthority` option.
use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, AssignmentTarget, BindingPattern, CallExpression,
    Expression, Function, ImportDeclarationSpecifier, ImportOrExportKind, JSXAttributeItem,
    JSXAttributeName, JSXAttributeValue, JSXChild, JSXElement, JSXElementName, JSXExpression,
    ObjectExpression, ObjectPropertyKind, Program, PropertyKey, Statement, VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, NodeId, ScopeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use crate::shared::ast_builder::AstBuilder;

/// Modules whose named exports are Solid's reactive runtime.
const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];
/// Modules whose named exports are the web runtime (client-specific markers).
const WEB_SOURCES: &[&str] = &["@solidjs/web", "solid-js/web"];
/// The property the pass appends to a proven memo's options.
pub(crate) const SEALED_KEY: &str = "$sealed";

/// What the cross-module summary interface (supplied identically to both
/// compiles by the bundler integration — the Track C linker's output in a
/// full build) declares about an import.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthorityKind {
    /// Deterministic, no side effects, no reactive reads, no client-specific
    /// inputs, does not mutate its arguments.
    Pure,
    /// A server-side fetcher: allowed inside a sealed compute (the compute
    /// never re-runs on the client), result is server-authoritative.
    Server,
    /// A component that never mutates its props (sealed values may flow in).
    ReadonlyComponent,
}

/// `(module specifier, export name, kind)` triples.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuthoritySummary {
    pub entries: Vec<(String, String, AuthorityKind)>,
}

impl AuthoritySummary {
    fn kind(&self, module: &str, export: &str) -> Option<AuthorityKind> {
        self.entries
            .iter()
            .find(|(m, e, _)| m == module && e == export)
            .map(|(_, _, kind)| *kind)
    }
}

/// The outcome for one `createMemo` call (exposed for tests and reports).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub name: String,
    pub sealed: bool,
    pub reason: Option<String>,
}

/// Prove and mark sealed memos. Returns every decision (sealed or not).
pub(crate) fn seal_server_authority<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    summary: &AuthoritySummary,
) -> Vec<Decision> {
    let (decisions, marks, hoists, accessor_holes) = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        let analysis = Analysis::new(semantic.scoping(), semantic.nodes(), program, summary);
        analysis.run()
    };
    if !marks.is_empty() || !hoists.is_empty() {
        let mut rewriter = Rewriter {
            allocator,
            marks,
            hoists,
            accessor_holes,
            frames: Vec::new(),
            counter: 0,
        };
        rewriter.visit_program(program);
    }
    decisions
}

// ---------------------------------------------------------------------------
// Symbol classification
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Runtime {
    CreateMemo,
    CreateSignal,
    CreateStore,
    Refresh,
    Perform,
    ReadStore,
    ReadPath,
    For,
    Show,
    Adapter,
    BlockScope,
    /// Any other export of the reactive runtime (a primitive).
    Other,
    /// `isServer` / `live` / other web-runtime markers.
    ClientMarker,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Frozen {
    /// `const [get] = createSignal(<literal>)` with no referenced setter.
    Getter,
    /// `const [store] = createStore(<literal>)` with no referenced setter.
    Store,
}

struct Candidate {
    symbol: SymbolId,
    name: String,
    /// The compute function node (the arrow/function, or the function inside
    /// a `$(…)` block).
    compute: NodeId,
    compute_scope: ScopeId,
    compute_span: Span,
    options_span: Span,
}

const MUTATING_METHODS: &[&str] = &[
    "push",
    "pop",
    "shift",
    "unshift",
    "splice",
    "sort",
    "reverse",
    "fill",
    "copyWithin",
    "set",
    "delete",
    "add",
    "clear",
];
/// Non-mutating methods whose callbacks receive (aliases of) the elements.
const ITERATION_METHODS: &[&str] = &[
    "map",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "some",
    "every",
    "forEach",
    "flatMap",
    "reduce",
    "reduceRight",
    "toSorted",
];
/// Non-mutating methods without element callbacks.
const READ_METHODS: &[&str] = &[
    "slice",
    "concat",
    "join",
    "includes",
    "indexOf",
    "lastIndexOf",
    "at",
    "flat",
    "toReversed",
    "toSpliced",
    "with",
    "keys",
    "values",
    "entries",
    "get",
    "has",
    "toString",
    "toFixed",
    "toPrecision",
    "toUpperCase",
    "toLowerCase",
    "trim",
    "trimStart",
    "trimEnd",
    "split",
    "replace",
    "replaceAll",
    "startsWith",
    "endsWith",
    "padStart",
    "padEnd",
    "charAt",
    "charCodeAt",
    "localeCompare",
    "substring",
    "repeat",
    "valueOf",
];
/// Pure global namespaces (members allowed unless listed in `IMPURE_MEMBERS`).
const PURE_GLOBALS: &[&str] = &[
    "Math",
    "JSON",
    "Number",
    "String",
    "Boolean",
    "Array",
    "Object",
    "Promise",
    "Error",
    "TypeError",
    "RangeError",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
    "undefined",
    "NaN",
    "Infinity",
    "console",
    // Server-side fetch: its result is serialized and never re-fetched.
    "fetch",
];
const IMPURE_MEMBERS: &[(&str, &str)] = &[("Math", "random"), ("Object", "assign")];
/// Pure global functions whose result does not alias their arguments.
const PURE_VALUE_CALLS: &[&str] = &[
    "String",
    "Number",
    "Boolean",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "encodeURIComponent",
    "decodeURIComponent",
];
const CLIENT_GLOBALS: &[&str] = &[
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "localStorage",
    "sessionStorage",
    "matchMedia",
    "innerWidth",
    "innerHeight",
    "performance",
    "crypto",
    "Date",
    "Intl",
    "self",
    "globalThis",
    "screen",
    "indexedDB",
];
const SCHEDULING_GLOBALS: &[&str] = &[
    "setInterval",
    "setTimeout",
    "requestAnimationFrame",
    "requestIdleCallback",
    "queueMicrotask",
    "EventSource",
    "WebSocket",
    "BroadcastChannel",
];

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

struct Analysis<'s, 'a> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'a>,
    summary: &'s AuthoritySummary,
    runtime: HashMap<SymbolId, Runtime>,
    imports: HashMap<SymbolId, (String, String)>,
    frozen: HashMap<SymbolId, Frozen>,
    /// Signal/store getters whose setter is referenced (can be invalidated).
    escaped_setters: HashSet<SymbolId>,
    candidates: Vec<Candidate>,
    by_symbol: HashMap<SymbolId, usize>,
    /// Memos with a literal `ssrSource` that are not candidates, and why.
    rejected_early: Vec<Decision>,
}

type Check = Result<(), String>;

/// Per-candidate facts gathered by the local checks.
#[derive(Default)]
struct Facts {
    /// Sealed memos this compute reads.
    reads: HashSet<usize>,
    /// Memos this candidate's value flows into (their result may alias it).
    flows_into: HashSet<usize>,
    /// `<For>` / keyed `<Show>` render parameters bound to (exactly) this
    /// candidate's data, with their callback's span — rendered bindings over
    /// them are constant in every mode and can be set up once.
    render_params: Vec<(SymbolId, Span)>,
    /// `{X()}` text holes (the read is the whole expression of an intrinsic
    /// element child): rewritten to `{X}` once X is sealed, so the renderer
    /// receives the (adopted, constant) accessor itself.
    accessor_holes: Vec<Span>,
}

impl<'s, 'a> Analysis<'s, 'a> {
    fn new(
        scoping: &'s Scoping,
        nodes: &'s AstNodes<'a>,
        program: &'s Program<'a>,
        summary: &'s AuthoritySummary,
    ) -> Self {
        let mut analysis = Self {
            scoping,
            nodes,
            summary,
            runtime: HashMap::new(),
            imports: HashMap::new(),
            frozen: HashMap::new(),
            escaped_setters: HashSet::new(),
            candidates: Vec::new(),
            by_symbol: HashMap::new(),
            rejected_early: Vec::new(),
        };
        analysis.collect_imports(program);
        analysis.collect_declarations();
        analysis
    }

    fn collect_imports(&mut self, program: &Program<'_>) {
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if import.import_kind == ImportOrExportKind::Type {
                continue;
            }
            let source = import.source.value.as_str();
            for specifier in import.specifiers.iter().flatten() {
                let (local, imported) = match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(s) => {
                        (&s.local, s.imported.name().to_string())
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                        (&s.local, "default".to_string())
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                        (&s.local, "*".to_string())
                    }
                };
                let Some(symbol) = local.symbol_id.get() else {
                    continue;
                };
                if RUNTIME_SOURCES.contains(&source) {
                    let kind = match imported.as_str() {
                        "createMemo" => Runtime::CreateMemo,
                        "createSignal" => Runtime::CreateSignal,
                        "createStore" => Runtime::CreateStore,
                        "refresh" => Runtime::Refresh,
                        "perform" => Runtime::Perform,
                        "readStore" => Runtime::ReadStore,
                        "readPath" | "readProp" | "readValue" => Runtime::ReadPath,
                        "For" => Runtime::For,
                        "Show" => Runtime::Show,
                        "$" => Runtime::Adapter,
                        "blockScope" => Runtime::BlockScope,
                        "isServer" => Runtime::ClientMarker,
                        _ => Runtime::Other,
                    };
                    self.runtime.insert(symbol, kind);
                } else if WEB_SOURCES.contains(&source) {
                    let kind = match imported.as_str() {
                        "For" => Runtime::For,
                        "Show" => Runtime::Show,
                        "isServer" | "live" | "clientOnly" | "getRequestEvent" => {
                            Runtime::ClientMarker
                        }
                        _ => Runtime::Other,
                    };
                    self.runtime.insert(symbol, kind);
                } else {
                    self.imports.insert(symbol, (source.to_string(), imported));
                }
            }
        }
    }

    /// Candidates (`const X = createMemo(fn, { ssrSource: "server" })`) and
    /// frozen signals/stores.
    fn collect_declarations(&mut self) {
        for node in self.nodes.iter() {
            let AstKind::VariableDeclarator(declarator) = node.kind() else {
                continue;
            };
            let Some(Expression::CallExpression(call)) = declarator.init.as_ref() else {
                continue;
            };
            let Some(callee) = self.callee_runtime(call) else {
                continue;
            };
            let is_const = matches!(
                self.nodes.parent_kind(node.id()),
                AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const
            );
            match callee {
                Runtime::CreateMemo => self.consider_memo(node.id(), declarator, call, is_const),
                Runtime::CreateSignal | Runtime::CreateStore => {
                    self.consider_frozen(declarator, call, callee, is_const)
                }
                _ => {}
            }
        }
    }

    fn consider_memo(
        &mut self,
        _node: NodeId,
        declarator: &oxc_ast::ast::VariableDeclarator<'_>,
        call: &CallExpression<'_>,
        is_const: bool,
    ) {
        let name = declarator
            .id
            .get_identifier_name()
            .map(|n| n.to_string())
            .unwrap_or_else(|| "<pattern>".into());
        let options = call.arguments.get(1).and_then(|argument| match argument {
            Argument::ObjectExpression(object) => Some(&**object),
            _ => None,
        });
        let ssr_source = options.and_then(|object| literal_property(object, "ssrSource"));
        // Only memos that declare an ssrSource are reported; the rest keep the
        // default policy silently (explicit authority is required to seal).
        let reject = |reason: &str| Decision {
            name: name.clone(),
            sealed: false,
            reason: Some(reason.to_string()),
        };
        match ssr_source.as_deref() {
            None => return,
            Some("server") => {}
            Some("hybrid") => {
                self.rejected_early
                    .push(reject("hybrid source re-runs on the client (revalidating)"));
                return;
            }
            Some("client") => {
                self.rejected_early.push(reject(
                    "client source: the server value is not authoritative",
                ));
                return;
            }
            Some(_) => {
                self.rejected_early.push(reject("unrecognized ssrSource"));
                return;
            }
        }
        let options = options.expect("ssrSource came from the options literal");
        if options.properties.iter().any(|p| {
            matches!(p, ObjectPropertyKind::SpreadProperty(_))
                || matches!(p, ObjectPropertyKind::ObjectProperty(p) if p.computed)
        }) {
            self.rejected_early.push(reject(
                "options spread / computed key: authority is not literal",
            ));
            return;
        }
        if literal_property(options, "transparent").is_some()
            || has_property(options, "transparent")
        {
            self.rejected_early
                .push(reject("transparent memo runs live during hydration"));
            return;
        }
        if has_property(options, SEALED_KEY) {
            self.rejected_early.push(reject(
                "`$sealed` is compiler-owned and cannot be hand-written",
            ));
            return;
        }
        if !is_const {
            self.rejected_early
                .push(reject("accessor binding is not a `const` identifier"));
            return;
        }
        let Some(symbol) = declarator
            .id
            .get_binding_identifier()
            .and_then(|b| b.symbol_id.get())
        else {
            self.rejected_early
                .push(reject("accessor binding is not a `const` identifier"));
            return;
        };
        let Some((compute, compute_scope, compute_span)) = self.compute_function(call) else {
            self.rejected_early.push(reject(
                "compute is not an inline function (unknown callback)",
            ));
            return;
        };
        self.by_symbol.insert(symbol, self.candidates.len());
        self.candidates.push(Candidate {
            symbol,
            name,
            compute,
            compute_scope,
            compute_span,
            options_span: options.span,
        });
    }

    /// The inline compute: an arrow/function expression, or the function
    /// inside a lowered `$(function () { … })` block.
    fn compute_function(&self, call: &CallExpression<'_>) -> Option<(NodeId, ScopeId, Span)> {
        let first = call.arguments.first()?;
        let expression = first.as_expression()?;
        let expression = match expression {
            Expression::CallExpression(inner)
                if self.callee_runtime(inner) == Some(Runtime::Adapter)
                    && inner.arguments.len() == 1 =>
            {
                inner.arguments[0].as_expression()?
            }
            other => other,
        };
        let span = expression.span();
        let (scope, _) = match expression {
            Expression::ArrowFunctionExpression(arrow) => (arrow.scope_id.get()?, ()),
            Expression::FunctionExpression(function) => (function.scope_id.get()?, ()),
            _ => return None,
        };
        let node = self.find_node(span, |kind| {
            matches!(
                kind,
                AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)
            )
        })?;
        Some((node, scope, span))
    }

    fn consider_frozen(
        &mut self,
        declarator: &oxc_ast::ast::VariableDeclarator<'_>,
        call: &CallExpression<'_>,
        kind: Runtime,
        is_const: bool,
    ) {
        if !is_const {
            return;
        }
        let BindingPattern::ArrayPattern(pattern) = &declarator.id else {
            return;
        };
        // Derived (function-form) signals/stores re-run on the client.
        let Some(initial) = call.arguments.first().and_then(|a| a.as_expression()) else {
            return;
        };
        if !is_literal_data(initial) {
            return;
        }
        let getter = pattern.elements.first().and_then(|e| e.as_ref());
        let Some(getter) = getter
            .and_then(|g| g.get_binding_identifier())
            .and_then(|b| b.symbol_id.get())
        else {
            return;
        };
        if pattern.rest.is_some() {
            return;
        }
        // The setter-escape proof: an unreferenced (or omitted) setter.
        if let Some(Some(setter)) = pattern.elements.get(1) {
            let Some(setter) = setter
                .get_binding_identifier()
                .and_then(|b| b.symbol_id.get())
            else {
                return;
            };
            if !self.scoping.get_resolved_reference_ids(setter).is_empty() {
                self.escaped_setters.insert(getter);
                return;
            }
        }
        if pattern.elements.len() > 2 {
            return;
        }
        self.frozen.insert(
            getter,
            if kind == Runtime::CreateSignal {
                Frozen::Getter
            } else {
                Frozen::Store
            },
        );
    }

    fn run(
        &self,
    ) -> (
        Vec<Decision>,
        Vec<(Span, u8)>,
        Vec<(Span, Vec<Span>)>,
        Vec<(Span, String)>,
    ) {
        let mut ok: Vec<Result<(), String>> = Vec::with_capacity(self.candidates.len());
        let mut facts: Vec<Facts> = Vec::with_capacity(self.candidates.len());
        for (index, candidate) in self.candidates.iter().enumerate() {
            let mut f = Facts::default();
            let result = self
                .check_compute(candidate, &mut f)
                .and_then(|()| self.check_uses(index, candidate, &mut f));
            ok.push(result);
            facts.push(f);
        }
        // Fixed point: drop candidates reading or flowing into dropped ones.
        loop {
            let mut changed = false;
            for index in 0..self.candidates.len() {
                if ok[index].is_err() {
                    continue;
                }
                let failed_read = facts[index].reads.iter().find(|&&dep| ok[dep].is_err());
                if let Some(&dep) = failed_read {
                    ok[index] = Err(format!(
                        "reads memo `{}`, which is not sealed",
                        self.candidates[dep].name
                    ));
                    changed = true;
                    continue;
                }
                let failed_flow = facts[index]
                    .flows_into
                    .iter()
                    .find(|&&dep| ok[dep].is_err());
                if let Some(&dep) = failed_flow {
                    ok[index] = Err(format!(
                        "value flows into memo `{}`, which is not sealed",
                        self.candidates[dep].name
                    ));
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        let hoists = self.row_binding_plans(&facts, &ok);
        let accessor_holes: Vec<(Span, String)> = self
            .candidates
            .iter()
            .zip(facts.iter().zip(&ok))
            .filter(|(_, (_, result))| result.is_ok())
            .flat_map(|(candidate, (f, _))| {
                f.accessor_holes
                    .iter()
                    .map(|span| (*span, candidate.name.clone()))
            })
            .collect();
        let sealed_computes: Vec<Span> = self
            .candidates
            .iter()
            .zip(&ok)
            .filter(|(_, result)| result.is_ok())
            .map(|(candidate, _)| candidate.compute_span)
            .collect();
        let mut decisions = self.rejected_early.clone();
        let mut marks = Vec::new();
        for (candidate, result) in self.candidates.iter().zip(ok) {
            match result {
                Ok(()) => {
                    // Compute-only: every read sits inside another sealed
                    // compute, which the client never runs — the value need
                    // not ship (`$sealed: 2`; the client falls back to a
                    // lazy memo if a reader ever does run).
                    let compute_only = self
                        .scoping
                        .get_resolved_reference_ids(candidate.symbol)
                        .iter()
                        .all(|&reference| {
                            let span = self.span(self.scoping.get_reference(reference).node_id());
                            sealed_computes.iter().any(|compute| {
                                *compute != candidate.compute_span
                                    && compute.start <= span.start
                                    && span.end <= compute.end
                            })
                        });
                    marks.push((candidate.options_span, if compute_only { 2 } else { 1 }));
                    decisions.push(Decision {
                        name: candidate.name.clone(),
                        sealed: true,
                        reason: None,
                    });
                }
                Err(reason) => decisions.push(Decision {
                    name: candidate.name.clone(),
                    sealed: false,
                    reason: Some(reason),
                }),
            }
        }
        (decisions, marks, hoists, accessor_holes)
    }

    // --- sealed row bindings -------------------------------------------------

    /// For every render callback whose parameter is exactly a sealed memo's
    /// data, the JSX expressions (in its unconditional returned JSX) that read
    /// only that parameter and constants. Such a binding is constant in every
    /// mode — the data is plain, adopted-or-computed-once, never invalidated
    /// — so it can be evaluated once when the row renders instead of getting
    /// a binding effect (and, for calls, an id scope). The rewrite hoists each
    /// into a `const` at the top of the callback, identically on both
    /// generates.
    fn row_binding_plans(
        &self,
        facts: &[Facts],
        ok: &[Result<(), String>],
    ) -> Vec<(Span, Vec<Span>)> {
        let mut by_callback: HashMap<Span, HashSet<SymbolId>> = HashMap::new();
        for (f, result) in facts.iter().zip(ok) {
            if result.is_ok() {
                for &(symbol, span) in &f.render_params {
                    by_callback.entry(span).or_default().insert(symbol);
                }
            }
        }
        let mut plans = Vec::new();
        for (span, params) in by_callback {
            let Some(node) = self.find_node(span, |kind| {
                matches!(
                    kind,
                    AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)
                )
            }) else {
                continue;
            };
            let root = match self.nodes.get_node(node).kind() {
                AstKind::ArrowFunctionExpression(arrow) => returned_jsx_arrow(arrow),
                AstKind::Function(function) => function
                    .body
                    .as_ref()
                    .and_then(|b| returned_jsx(&b.statements)),
                _ => None,
            };
            let Some(root) = root else { continue };
            let mut exprs = Vec::new();
            self.scan_row_jsx(root, &params, &mut exprs);
            if !exprs.is_empty() {
                plans.push((span, exprs));
            }
        }
        plans.sort_by_key(|(span, _)| span.start);
        plans
    }

    fn scan_row_jsx(&self, root: &Expression<'_>, params: &HashSet<SymbolId>, out: &mut Vec<Span>) {
        match root {
            Expression::JSXElement(element) => self.scan_row_element(element, params, out),
            Expression::JSXFragment(fragment) => {
                self.scan_row_children(&fragment.children, params, out)
            }
            Expression::ParenthesizedExpression(p) => self.scan_row_jsx(&p.expression, params, out),
            _ => {}
        }
    }

    fn scan_row_element(
        &self,
        element: &JSXElement<'_>,
        params: &HashSet<SymbolId>,
        out: &mut Vec<Span>,
    ) {
        // Only intrinsic elements: a component's children/props may be
        // rendered conditionally (hoisting a guarded read would evaluate it
        // unguarded) or consumed as more than a value.
        if !matches!(element.opening_element.name, JSXElementName::Identifier(_)) {
            return;
        }
        for item in &element.opening_element.attributes {
            let JSXAttributeItem::Attribute(attribute) = item else {
                continue;
            };
            let JSXAttributeName::Identifier(name) = &attribute.name else {
                continue;
            };
            let name = name.name.as_str();
            if name.starts_with("on")
                || matches!(name, "ref" | "class" | "classList" | "style" | "children")
            {
                continue;
            }
            if let Some(JSXAttributeValue::ExpressionContainer(container)) = &attribute.value
                && let Some(expression) = container.expression.as_expression()
                && self.is_row_constant(expression, params)
            {
                out.push(expression.span());
            }
        }
        self.scan_row_children(&element.children, params, out);
    }

    fn scan_row_children(
        &self,
        children: &[JSXChild<'_>],
        params: &HashSet<SymbolId>,
        out: &mut Vec<Span>,
    ) {
        for child in children {
            match child {
                JSXChild::ExpressionContainer(container) => {
                    if let Some(expression) = container.expression.as_expression()
                        && self.is_row_constant(expression, params)
                    {
                        out.push(expression.span());
                    }
                }
                JSXChild::Element(element) => self.scan_row_element(element, params, out),
                JSXChild::Fragment(fragment) => {
                    self.scan_row_children(&fragment.children, params, out)
                }
                _ => {}
            }
        }
    }

    /// Reads at least one sealed render parameter and otherwise only
    /// constants, through pure operations.
    fn is_row_constant(&self, expression: &Expression<'_>, params: &HashSet<SymbolId>) -> bool {
        let mut uses = false;
        self.const_expr(expression, params, &mut uses) && uses
    }

    fn const_expr(
        &self,
        expression: &Expression<'_>,
        params: &HashSet<SymbolId>,
        uses: &mut bool,
    ) -> bool {
        match expression {
            Expression::StringLiteral(_)
            | Expression::NumericLiteral(_)
            | Expression::BooleanLiteral(_)
            | Expression::NullLiteral(_)
            | Expression::BigIntLiteral(_) => true,
            Expression::Identifier(identifier) => {
                let symbol = identifier
                    .reference_id
                    .get()
                    .and_then(|r| self.scoping.get_reference(r).symbol_id());
                match symbol {
                    Some(symbol) if params.contains(&symbol) => {
                        *uses = true;
                        true
                    }
                    Some(symbol) => self.is_module_primitive_const(symbol),
                    None => matches!(identifier.name.as_str(), "undefined" | "NaN" | "Infinity"),
                }
            }
            Expression::TemplateLiteral(template) => template
                .expressions
                .iter()
                .all(|e| self.const_expr(e, params, uses)),
            Expression::BinaryExpression(binary) => {
                self.const_expr(&binary.left, params, uses)
                    && self.const_expr(&binary.right, params, uses)
            }
            Expression::LogicalExpression(logical) => {
                self.const_expr(&logical.left, params, uses)
                    && self.const_expr(&logical.right, params, uses)
            }
            Expression::ConditionalExpression(conditional) => {
                self.const_expr(&conditional.test, params, uses)
                    && self.const_expr(&conditional.consequent, params, uses)
                    && self.const_expr(&conditional.alternate, params, uses)
            }
            Expression::UnaryExpression(unary) => {
                unary.operator != oxc_syntax::operator::UnaryOperator::Delete
                    && self.const_expr(&unary.argument, params, uses)
            }
            Expression::ParenthesizedExpression(p) => self.const_expr(&p.expression, params, uses),
            Expression::StaticMemberExpression(member) => {
                self.const_expr(&member.object, params, uses)
            }
            Expression::ComputedMemberExpression(member) => {
                self.const_expr(&member.object, params, uses)
                    && self.const_expr(&member.expression, params, uses)
            }
            Expression::CallExpression(call) => {
                if call.optional {
                    return false;
                }
                let args_const = call.arguments.iter().all(|argument| {
                    argument
                        .as_expression()
                        .is_some_and(|e| self.const_expr(e, params, uses))
                });
                args_const && self.pure_callee(&call.callee, params, uses)
            }
            _ => false,
        }
    }

    fn pure_callee(
        &self,
        callee: &Expression<'_>,
        params: &HashSet<SymbolId>,
        uses: &mut bool,
    ) -> bool {
        match callee {
            Expression::Identifier(identifier) => {
                let symbol = identifier
                    .reference_id
                    .get()
                    .and_then(|r| self.scoping.get_reference(r).symbol_id());
                match symbol {
                    None => PURE_VALUE_CALLS.contains(&identifier.name.as_str()),
                    Some(symbol) => match self.imports.get(&symbol) {
                        Some((module, export)) => {
                            self.summary.kind(module, export) == Some(AuthorityKind::Pure)
                        }
                        None => self.is_pure_local_function(symbol, &mut HashSet::new()),
                    },
                }
            }
            Expression::StaticMemberExpression(member) => {
                let method = member.property.name.as_str();
                if let Expression::Identifier(object) = &member.object
                    && object
                        .reference_id
                        .get()
                        .and_then(|r| self.scoping.get_reference(r).symbol_id())
                        .is_none()
                {
                    let namespace = object.name.as_str();
                    return matches!(namespace, "Math" | "JSON" | "Number" | "String")
                        && !IMPURE_MEMBERS.contains(&(namespace, method));
                }
                READ_METHODS.contains(&method) && self.const_expr(&member.object, params, uses)
            }
            _ => false,
        }
    }

    // --- obligation 2 & 5: the compute's own inputs and effects ------------

    fn check_compute(&self, candidate: &Candidate, facts: &mut Facts) -> Check {
        let mut collector = ComputeCollector::default();
        match self.nodes.get_node(candidate.compute).kind() {
            AstKind::ArrowFunctionExpression(arrow) => collector.visit_arrow(arrow),
            AstKind::Function(function) => collector.visit_function_node(function),
            _ => return Err("compute is not a function".into()),
        }
        if collector.generator {
            return Err("generator compute: a live / revalidating source".into());
        }
        if collector.jsx {
            return Err("compute renders JSX (not a data value)".into());
        }
        if collector.this {
            return Err("compute reads `this`".into());
        }
        for &(reference, span) in &collector.references {
            self.check_input(candidate, reference, span, facts)?;
        }
        Ok(())
    }

    fn check_input(
        &self,
        candidate: &Candidate,
        reference: oxc_semantic::ReferenceId,
        _span: Span,
        facts: &mut Facts,
    ) -> Check {
        let reference = self.scoping.get_reference(reference);
        let node = reference.node_id();
        let name = self.reference_name(node);
        let Some(symbol) = reference.symbol_id() else {
            return self.check_global(node, &name);
        };
        if self.is_within(
            self.scoping.symbol_scope_id(symbol),
            candidate.compute_scope,
        ) {
            // A local: writes to it are the compute's own business.
            return Ok(());
        }
        if reference.is_write() {
            return Err(format!(
                "compute assigns outer variable `{name}` (side effect)"
            ));
        }
        // Member-chain writes rooted at an outer binding are side effects.
        if self.member_chain_is_written(node) {
            return Err(format!("compute mutates outer `{name}` (side effect)"));
        }
        if let Some(runtime) = self.runtime.get(&symbol) {
            return match runtime {
                Runtime::Perform | Runtime::ReadStore | Runtime::ReadPath => Ok(()),
                Runtime::ClientMarker => Err(format!("client-specific input `{name}`")),
                Runtime::Refresh => Err("compute calls `refresh` (revalidating)".into()),
                _ => Err(format!(
                    "compute creates or uses reactive primitive `{name}` (unknown callback)"
                )),
            };
        }
        if let Some(&index) = self.by_symbol.get(&symbol) {
            return if self.is_read_of_accessor(node) {
                facts.reads.insert(index);
                Ok(())
            } else {
                Err(format!("memo `{name}` is used as a value, not read"))
            };
        }
        if let Some(frozen) = self.frozen.get(&symbol) {
            return match frozen {
                Frozen::Getter if self.is_read_of_accessor(node) => Ok(()),
                Frozen::Getter => Err(format!("signal `{name}` is used as a value, not read")),
                Frozen::Store => Ok(()),
            };
        }
        if let Some((module, export)) = self.imports.get(&symbol) {
            return match self.summary.kind(module, export) {
                // A pure function is harmless anywhere (as a callback too).
                Some(AuthorityKind::Pure) => Ok(()),
                // A server fetcher runs only as the compute's own call.
                Some(AuthorityKind::Server) if self.is_callee(node) => Ok(()),
                Some(_) => Err(format!("import `{name}` is used as a value")),
                None => Err(format!(
                    "import `{name}` from \"{module}\" has no authority summary (unknown callback)"
                )),
            };
        }
        if self.is_module_primitive_const(symbol) {
            return Ok(());
        }
        if self.is_pure_local_function(symbol, &mut HashSet::new()) {
            return Ok(());
        }
        if self.escaped_setters.contains(&symbol) {
            return Err(format!(
                "`{name}`'s setter escapes: the client can invalidate it"
            ));
        }
        if self.is_parameter(symbol) {
            return Err(format!(
                "reads outer parameter `{name}` (component props / caller input: authority not proven)"
            ));
        }
        Err(format!("reads `{name}`, whose authority is unknown"))
    }

    fn check_global(&self, node: NodeId, name: &str) -> Check {
        if CLIENT_GLOBALS.contains(&name) {
            return Err(format!("client-specific input `{name}`"));
        }
        if SCHEDULING_GLOBALS.contains(&name) {
            return Err(format!("scheduling / polling API `{name}`"));
        }
        if !PURE_GLOBALS.contains(&name) {
            return Err(format!("unknown global `{name}`"));
        }
        if let Some(property) = self.member_property_of(node)
            && IMPURE_MEMBERS.contains(&(name, property.as_str()))
        {
            return Err(format!(
                "`{name}.{property}` is non-deterministic or mutating"
            ));
        }
        Ok(())
    }

    // --- obligations 3 & 4: every use of the accessor ----------------------

    fn check_uses(&self, index: usize, candidate: &Candidate, facts: &mut Facts) -> Check {
        let mut aliases = AliasWork::default();
        for &reference in self.scoping.get_resolved_reference_ids(candidate.symbol) {
            let node = self.scoping.get_reference(reference).node_id();
            if let Some(call) = self.read_of_accessor(node) {
                if let Some(span) = self.text_hole_of(call) {
                    facts.accessor_holes.push(span);
                }
                self.check_value(call, index, facts, &mut aliases)?;
            } else {
                return Err(self.escape_reason(node, &candidate.name));
            }
        }
        let result = self.drain_aliases(index, facts, &mut aliases);
        facts.render_params.append(&mut aliases.render_params);
        result
    }

    /// The read's span when it is the entire expression of a JSX child
    /// container of an intrinsic element (a plain text hole).
    fn text_hole_of(&self, read: NodeId) -> Option<Span> {
        if !matches!(self.nodes.get_node(read).kind(), AstKind::CallExpression(_)) {
            return None;
        }
        let container = self.parent(read);
        if !matches!(
            self.nodes.get_node(container).kind(),
            AstKind::JSXExpressionContainer(_)
        ) {
            return None;
        }
        match self.nodes.get_node(self.parent(container)).kind() {
            AstKind::JSXElement(element)
                if matches!(element.opening_element.name, JSXElementName::Identifier(_)) =>
            {
                Some(self.span(read))
            }
            _ => None,
        }
    }

    fn escape_reason(&self, node: NodeId, name: &str) -> String {
        let parent = self.parent(node);
        if let AstKind::CallExpression(call) = self.nodes.get_node(parent).kind()
            && self.callee_runtime(call) == Some(Runtime::Refresh)
        {
            return format!("accessor `{name}` is passed to `refresh` (revalidating)");
        }
        if matches!(
            self.nodes.get_node(parent).kind(),
            AstKind::JSXExpressionContainer(_)
        ) {
            return format!("accessor `{name}` escapes as a JSX value / prop");
        }
        if matches!(
            self.nodes.get_node(parent).kind(),
            AstKind::ExportSpecifier(_) | AstKind::ExportNamedDeclaration(_)
        ) {
            return format!("accessor `{name}` is exported");
        }
        format!("accessor `{name}` escapes (not a read)")
    }

    fn drain_aliases(&self, index: usize, facts: &mut Facts, work: &mut AliasWork) -> Check {
        loop {
            while let Some((symbol, accessor)) = work.queue.pop() {
                for &reference in self.scoping.get_resolved_reference_ids(symbol) {
                    let reference = self.scoping.get_reference(reference);
                    let node = reference.node_id();
                    if reference.is_write() {
                        // Re-binding the alias itself is harmless.
                        continue;
                    }
                    if accessor {
                        let Some(call) = self.call_of_callee(node) else {
                            return Err(format!(
                                "render parameter `{}` escapes (not a read)",
                                self.scoping.symbol_name(symbol)
                            ));
                        };
                        self.check_value(call, index, facts, work)?;
                    } else {
                        self.check_value(node, index, facts, work)?;
                    }
                }
            }
            let props = std::mem::take(&mut work.props);
            if props.is_empty() {
                return Ok(());
            }
            for (component, prop) in props {
                if work.seen_props.insert((component, prop.clone())) {
                    self.check_component_prop(component, &prop, index, facts, work)?;
                }
            }
        }
    }

    /// Follow a node that evaluates to (an alias of) the sealed value.
    ///
    /// `fresh` marks a new container holding aliases (an array/object
    /// literal, a spread copy, `slice`/`filter`/`map` results): the container
    /// itself may be mutated (`[...list()].sort()`), its elements may not.
    fn check_value(
        &self,
        start: NodeId,
        index: usize,
        facts: &mut Facts,
        work: &mut AliasWork,
    ) -> Check {
        let mut current = start;
        let mut fresh = false;
        // Set once the path merges the value with other data (a conditional
        // branch, a logical operand, a container literal): the result is no
        // longer exactly this candidate's data.
        let mut merged = false;
        loop {
            let current_span = self.span(current);
            let parent = self.parent(current);
            if parent == current {
                return Ok(());
            }
            match self.nodes.get_node(parent).kind() {
                AstKind::StaticMemberExpression(member) => {
                    if member.object.span() != current_span {
                        return Ok(());
                    }
                    if let Some(call) = self.call_of_callee(parent) {
                        let method = member.property.name.as_str();
                        if MUTATING_METHODS.contains(&method) {
                            if !fresh {
                                return Err(format!("sealed value is mutated (`.{method}()`)"));
                            }
                            if method == "sort" {
                                self.alias_callback_params(call, method, work)?;
                            }
                            // sort/reverse/fill return the same (fresh) container.
                        } else if ITERATION_METHODS.contains(&method) {
                            self.alias_callback_params(call, method, work)?;
                            fresh = matches!(method, "map" | "filter" | "flatMap" | "toSorted");
                        } else if READ_METHODS.contains(&method) {
                            fresh = matches!(
                                method,
                                "slice" | "concat" | "flat" | "toReversed" | "toSpliced" | "with"
                            );
                        } else {
                            return Err(format!("unknown method `.{method}()` on a sealed value"));
                        }
                        current = call;
                        continue;
                    }
                    if self.is_assignment_target(parent) {
                        if fresh {
                            return Ok(());
                        }
                        return Err("sealed value is mutated (assignment / update / delete)".into());
                    }
                    fresh = false;
                    current = parent;
                }
                AstKind::ComputedMemberExpression(member) => {
                    if member.object.span() != current_span {
                        // Used as a key: a read.
                        return Ok(());
                    }
                    if self.is_assignment_target(parent) {
                        if fresh {
                            return Ok(());
                        }
                        return Err("sealed value is mutated (assignment / update / delete)".into());
                    }
                    if self.call_of_callee(parent).is_some() {
                        return Err("computed method call on a sealed value".into());
                    }
                    fresh = false;
                    current = parent;
                }
                AstKind::PrivateFieldExpression(_) => {
                    return Err("private field access on a sealed value".into());
                }
                AstKind::CallExpression(call) => {
                    if call.callee.span() == current_span {
                        return Err("sealed value is called as a function".into());
                    }
                    return self.check_argument(call, current_span, index, facts, work);
                }
                AstKind::NewExpression(_) => {
                    return Err("sealed value is passed to a constructor".into());
                }
                AstKind::UpdateExpression(_) => {
                    return Err("sealed value is mutated (assignment / update / delete)".into());
                }
                AstKind::UnaryExpression(unary) => {
                    return if unary.operator == oxc_syntax::operator::UnaryOperator::Delete {
                        Err("sealed value is mutated (assignment / update / delete)".into())
                    } else {
                        Ok(())
                    };
                }
                AstKind::AssignmentExpression(assignment) => {
                    if assignment.left.span() == current_span {
                        return Err("sealed value is reassigned".into());
                    }
                    if assignment.operator != oxc_syntax::operator::AssignmentOperator::Assign {
                        return Ok(());
                    }
                    return match &assignment.left {
                        AssignmentTarget::AssignmentTargetIdentifier(target) => {
                            let symbol = target
                                .reference_id
                                .get()
                                .and_then(|r| self.scoping.get_reference(r).symbol_id());
                            match symbol {
                                Some(symbol) => {
                                    work.push(symbol, false);
                                    Ok(())
                                }
                                None => Err("sealed value is assigned to a global".into()),
                            }
                        }
                        _ => Err("sealed value is stored into an object".into()),
                    };
                }
                AstKind::VariableDeclarator(declarator) => {
                    if declarator.init.as_ref().map(|i| i.span()) != Some(current_span) {
                        return Ok(());
                    }
                    for symbol in binding_symbols(&declarator.id) {
                        work.push(symbol, false);
                    }
                    return Ok(());
                }
                AstKind::ReturnStatement(_) => match self.check_return(parent, index, facts)? {
                    Some(next) => {
                        fresh = false;
                        current = next;
                    }
                    None => return Ok(()),
                },
                // An expression-bodied arrow's body is its return value.
                AstKind::ArrowFunctionExpression(_) => {
                    match self.check_return(current, index, facts)? {
                        Some(next) => {
                            fresh = false;
                            current = next;
                        }
                        None => return Ok(()),
                    }
                }
                AstKind::ExpressionStatement(_) => return Ok(()),
                AstKind::ConditionalExpression(conditional) => {
                    if conditional.test.span() == current_span {
                        return Ok(());
                    }
                    merged = true;
                    current = parent;
                }
                AstKind::LogicalExpression(_) => {
                    merged = true;
                    current = parent;
                }
                AstKind::AwaitExpression(_)
                | AstKind::ParenthesizedExpression(_)
                | AstKind::ChainExpression(_)
                | AstKind::TSAsExpression(_)
                | AstKind::TSSatisfiesExpression(_)
                | AstKind::TSNonNullExpression(_)
                | AstKind::TSTypeAssertion(_) => current = parent,
                AstKind::ArrayExpression(_) | AstKind::ObjectExpression(_) => {
                    fresh = true;
                    merged = true;
                    current = parent;
                }
                AstKind::ObjectProperty(property) => {
                    if property.value.span() != current_span {
                        return Ok(());
                    }
                    fresh = true;
                    merged = true;
                    current = self.parent(parent);
                }
                AstKind::SpreadElement(_) => {
                    let container = self.parent(parent);
                    if let AstKind::CallExpression(call) = self.nodes.get_node(container).kind() {
                        return self.check_argument(call, current_span, index, facts, work);
                    }
                    fresh = true;
                    merged = true;
                    current = container;
                }
                AstKind::SequenceExpression(sequence) => {
                    if sequence.expressions.last().map(|e| e.span()) != Some(current_span) {
                        return Ok(());
                    }
                    merged = true;
                    current = parent;
                }
                AstKind::ForOfStatement(for_of) => {
                    if for_of.right.span() != current_span {
                        return Ok(());
                    }
                    if let oxc_ast::ast::ForStatementLeft::VariableDeclaration(declaration) =
                        &for_of.left
                    {
                        for declarator in &declaration.declarations {
                            for symbol in binding_symbols(&declarator.id) {
                                work.push(symbol, false);
                            }
                        }
                        return Ok(());
                    }
                    return Err("for-of over a sealed value into an outer target".into());
                }
                AstKind::TemplateLiteral(_)
                | AstKind::BinaryExpression(_)
                | AstKind::IfStatement(_)
                | AstKind::WhileStatement(_)
                | AstKind::DoWhileStatement(_)
                | AstKind::ForStatement(_)
                | AstKind::ForInStatement(_)
                | AstKind::SwitchStatement(_)
                | AstKind::SwitchCase(_)
                | AstKind::JSXSpreadChild(_) => return Ok(()),
                AstKind::JSXExpressionContainer(_) => {
                    return self.check_jsx_use(parent, !merged, index, facts, work);
                }
                AstKind::ThrowStatement(_) => {
                    return Err("sealed value is thrown".into());
                }
                other => {
                    return Err(format!(
                        "sealed value used in an unanalyzed position ({})",
                        other.debug_name()
                    ));
                }
            }
        }
    }

    /// A sealed value returned from a function. `Ok(Some(node))` continues
    /// following from `node` (an iteration callback's value lands in the
    /// call's result); `Ok(None)` ends the path.
    fn check_return(
        &self,
        statement: NodeId,
        index: usize,
        facts: &mut Facts,
    ) -> Result<Option<NodeId>, String> {
        let Some(function) = self.enclosing_function(statement) else {
            return Err("sealed value is returned at module level".into());
        };
        let span = self.span(function);
        // Into another memo's value: fine iff that memo is sealed too.
        if let Some(owner) = self.candidates.iter().position(|c| c.compute_span == span) {
            if owner != index {
                facts.flows_into.insert(owner);
            }
            return Ok(None);
        }
        let holder = self.parent(function);
        match self.nodes.get_node(holder).kind() {
            // `list.map(x => x.a)`: the value becomes part of the call result.
            AstKind::CallExpression(call) if call.callee.span() != span => {
                if let Expression::StaticMemberExpression(member) = &call.callee
                    && ITERATION_METHODS.contains(&member.property.name.as_str())
                {
                    return Ok(Some(holder));
                }
                Err("sealed value is returned from a callback passed to an unknown call".into())
            }
            // A render callback (`<For>{item => item.name}</For>`): rendered.
            AstKind::JSXExpressionContainer(_) => {
                if matches!(
                    self.nodes.get_node(self.parent(holder)).kind(),
                    AstKind::JSXElement(_) | AstKind::JSXFragment(_)
                ) {
                    Ok(None)
                } else {
                    Err("sealed value is returned from a callback prop".into())
                }
            }
            _ if self.function_is_component(function) => Ok(None),
            _ => Err("sealed value is returned from a function that is not a sealed memo".into()),
        }
    }

    /// A capitalized function declaration or `const Name = (…) => …`: its
    /// return value is rendered.
    fn function_is_component(&self, function: NodeId) -> bool {
        let capitalized = |name: &str| name.chars().next().is_some_and(|c| c.is_ascii_uppercase());
        match self.nodes.get_node(function).kind() {
            AstKind::Function(f) => f.id.as_ref().is_some_and(|id| capitalized(&id.name)),
            AstKind::ArrowFunctionExpression(_) => matches!(
                self.nodes.get_node(self.parent(function)).kind(),
                AstKind::VariableDeclarator(d)
                    if d.id.get_identifier_name().is_some_and(|n| capitalized(&n))
            ),
            _ => false,
        }
    }

    fn check_argument(
        &self,
        call: &CallExpression<'_>,
        argument_span: Span,
        _index: usize,
        _facts: &mut Facts,
        work: &mut AliasWork,
    ) -> Check {
        match self.callee_runtime(call) {
            Some(Runtime::Perform) | Some(Runtime::ReadStore) | Some(Runtime::ReadPath) => {
                return Ok(());
            }
            Some(_) => {
                return Err("sealed value is passed to a reactive primitive".into());
            }
            None => {}
        }
        let position = call
            .arguments
            .iter()
            .position(|argument| argument.span() == argument_span);
        match &call.callee {
            Expression::Identifier(callee) => {
                let name = callee.name.as_str();
                let symbol = callee
                    .reference_id
                    .get()
                    .and_then(|r| self.scoping.get_reference(r).symbol_id());
                match symbol {
                    None if PURE_VALUE_CALLS.contains(&name) => Ok(()),
                    None => Err(format!("sealed value is passed to global `{name}`")),
                    Some(symbol) => {
                        if let Some((module, export)) = self.imports.get(&symbol) {
                            return match self.summary.kind(module, export) {
                                Some(AuthorityKind::Pure) => Ok(()),
                                _ => Err(format!(
                                    "sealed value is passed to `{name}`, which is not summarized pure"
                                )),
                            };
                        }
                        if self.is_pure_local_function(symbol, &mut HashSet::new())
                            && let Some(position) = position
                            && let Some(params) = self.function_params(symbol)
                        {
                            if let Some(param) = params.get(position) {
                                for symbol in param {
                                    work.push(*symbol, false);
                                }
                            }
                            return Ok(());
                        }
                        Err(format!(
                            "sealed value is passed to unknown function `{name}`"
                        ))
                    }
                }
            }
            Expression::StaticMemberExpression(member) => {
                if let Expression::Identifier(object) = &member.object
                    && object
                        .reference_id
                        .get()
                        .and_then(|r| self.scoping.get_reference(r).symbol_id())
                        .is_none()
                {
                    let namespace = object.name.as_str();
                    let method = member.property.name.as_str();
                    return match (namespace, method) {
                        ("JSON", "stringify")
                        | ("Math", _)
                        | ("Array", "isArray")
                        | ("Object", "keys")
                        | ("Number", _)
                        | ("String", _) => Ok(()),
                        ("Object", "values" | "entries" | "freeze") | ("Array", "from") => {
                            // The result aliases the elements: follow it.
                            Err(
                                "sealed value copied by a helper whose result is not followed"
                                    .into(),
                            )
                        }
                        _ => Err(format!("sealed value is passed to `{namespace}.{method}`")),
                    };
                }
                Err("sealed value is passed to an unknown method".into())
            }
            _ => Err("sealed value is passed to an unknown callee".into()),
        }
    }

    /// A sealed value in a JSX expression container.
    fn check_jsx_use(
        &self,
        container: NodeId,
        exact: bool,
        _index: usize,
        _facts: &mut Facts,
        work: &mut AliasWork,
    ) -> Check {
        let parent = self.parent(container);
        match self.nodes.get_node(parent).kind() {
            // A child of an intrinsic element or fragment: rendered.
            AstKind::JSXFragment(_) => Ok(()),
            AstKind::JSXElement(element) => match &element.opening_element.name {
                JSXElementName::Identifier(_) => Ok(()),
                // A component child is its `children` prop.
                JSXElementName::IdentifierReference(tag) => {
                    self.component_consumes(tag, "children", work)
                }
                _ => Err("sealed value flows to a member-expression component".into()),
            },
            AstKind::JSXAttribute(attribute) => {
                let attribute_name = match &attribute.name {
                    JSXAttributeName::Identifier(identifier) => identifier.name.to_string(),
                    JSXAttributeName::NamespacedName(name) => {
                        format!("{}:{}", name.namespace.name, name.name.name)
                    }
                };
                let opening = self.parent(parent);
                let element = self.parent(opening);
                let AstKind::JSXElement(element) = self.nodes.get_node(element).kind() else {
                    return Err("sealed value in an unrecognized JSX position".into());
                };
                match &element.opening_element.name {
                    JSXElementName::Identifier(_) => {
                        // Intrinsic element attribute.
                        if attribute_name == "ref"
                            || attribute_name.starts_with("on")
                            || attribute_name.contains(':')
                        {
                            Err(format!(
                                "sealed value bound to `{attribute_name}` (handler / ref / directive)"
                            ))
                        } else {
                            Ok(())
                        }
                    }
                    JSXElementName::IdentifierReference(tag) => {
                        let symbol = tag
                            .reference_id
                            .get()
                            .and_then(|r| self.scoping.get_reference(r).symbol_id());
                        let Some(symbol) = symbol else {
                            return Err(format!(
                                "sealed value flows to unknown component `{}`",
                                tag.name
                            ));
                        };
                        match self.runtime.get(&symbol) {
                            Some(Runtime::For) if attribute_name == "each" => {
                                self.alias_render_param(element, keyed_for(element), exact, work)
                            }
                            Some(Runtime::Show) if attribute_name == "when" => {
                                self.alias_render_param(element, keyed_show(element), exact, work)
                            }
                            _ => self.component_consumes(tag, &attribute_name, work),
                        }
                    }
                    _ => Err("sealed value flows to a member-expression component".into()),
                }
            }
            _ => Err("sealed value in an unrecognized JSX position".into()),
        }
    }

    /// A sealed value handed to a component as prop `prop`: allowed for a
    /// same-module component whose use of the prop is itself checked, or an
    /// import the summary declares `readonly-component`.
    fn component_consumes(
        &self,
        tag: &oxc_ast::ast::IdentifierReference<'_>,
        prop: &str,
        work: &mut AliasWork,
    ) -> Check {
        let symbol = tag
            .reference_id
            .get()
            .and_then(|r| self.scoping.get_reference(r).symbol_id());
        let Some(symbol) = symbol else {
            return Err(format!(
                "sealed value flows to unknown component `{}`",
                tag.name
            ));
        };
        if self.runtime.contains_key(&symbol) {
            return Err(format!(
                "sealed value flows to runtime component `{}.{prop}`",
                tag.name
            ));
        }
        if let Some((module, export)) = self.imports.get(&symbol) {
            return match self.summary.kind(module, export) {
                Some(AuthorityKind::ReadonlyComponent) => Ok(()),
                _ => Err(format!(
                    "sealed value flows to component `{}`, which has no readonly-props summary",
                    tag.name
                )),
            };
        }
        if self.local_component(symbol).is_some() {
            work.props.push((symbol, prop.to_string()));
            Ok(())
        } else {
            Err(format!(
                "sealed value flows to unknown component `{}`",
                tag.name
            ))
        }
    }

    /// `<For each={…}>{item => …}</For>` / `<Show when={…}>{v => …}</Show>`:
    /// the render callback's first parameter aliases the value (`accessor`
    /// when it is handed as an accessor rather than the value).
    fn alias_render_param(
        &self,
        element: &JSXElement<'_>,
        data: bool,
        exact: bool,
        work: &mut AliasWork,
    ) -> Check {
        for child in &element.children {
            let JSXChild::ExpressionContainer(container) = child else {
                continue;
            };
            let (params, span) = match &container.expression {
                JSXExpression::ArrowFunctionExpression(arrow) => (&arrow.params, arrow.span),
                JSXExpression::FunctionExpression(function) => (&function.params, function.span),
                _ => continue,
            };
            if let Some(param) = params.items.first() {
                for symbol in binding_symbols(&param.pattern) {
                    work.push(symbol, !data);
                    if data && exact && !self.scoping.symbol_is_mutated(symbol) {
                        work.render_params.push((symbol, span));
                    }
                }
            }
        }
        Ok(())
    }

    fn alias_callback_params(&self, call: NodeId, method: &str, work: &mut AliasWork) -> Check {
        let AstKind::CallExpression(call) = self.nodes.get_node(call).kind() else {
            return Ok(());
        };
        // `reduce(fn(acc, item))`: the element is the second parameter, and
        // the accumulator may become an alias too — follow both.
        let element_params: &[usize] =
            if method.starts_with("reduce") || method == "sort" || method == "toSorted" {
                &[0, 1]
            } else {
                &[0]
            };
        let Some(callback) = call.arguments.first().and_then(|a| a.as_expression()) else {
            return Ok(());
        };
        let params = match callback {
            Expression::ArrowFunctionExpression(arrow) => &arrow.params,
            Expression::FunctionExpression(function) => &function.params,
            // A named callback: a summarized-pure import or a proven-pure
            // local function cannot mutate what it is handed.
            Expression::Identifier(identifier) => {
                let symbol = identifier
                    .reference_id
                    .get()
                    .and_then(|r| self.scoping.get_reference(r).symbol_id());
                let pure = symbol.is_some_and(|symbol| match self.imports.get(&symbol) {
                    Some((module, export)) => {
                        self.summary.kind(module, export) == Some(AuthorityKind::Pure)
                    }
                    None => self.is_pure_local_function(symbol, &mut HashSet::new()),
                });
                return if pure {
                    Ok(())
                } else {
                    Err(format!(
                        "`.{method}({})` with a callback that is not proven pure",
                        identifier.name
                    ))
                };
            }
            // A callback we cannot see receives the elements.
            _ => {
                return Err(format!(
                    "`.{method}()` with an opaque callback on a sealed value"
                ));
            }
        };
        for &position in element_params {
            if let Some(param) = params.items.get(position) {
                for symbol in binding_symbols(&param.pattern) {
                    work.push(symbol, false);
                }
            }
        }
        Ok(())
    }

    fn check_component_prop(
        &self,
        component: SymbolId,
        prop: &str,
        _index: usize,
        _facts: &mut Facts,
        work: &mut AliasWork,
    ) -> Check {
        let Some(params) = self.local_component(component) else {
            return Err("sealed value flows to an unanalyzable component".into());
        };
        let Some(first) = params.first() else {
            return Ok(());
        };
        match first {
            ParamShape::Identifier(props) => {
                for &reference in self.scoping.get_resolved_reference_ids(*props) {
                    let node = self.scoping.get_reference(reference).node_id();
                    let parent = self.parent(node);
                    match self.nodes.get_node(parent).kind() {
                        AstKind::StaticMemberExpression(member)
                            if member.object.span() == self.span(node) =>
                        {
                            if member.property.name == prop {
                                work.member_uses.push(parent);
                            }
                        }
                        _ => {
                            return Err(
                                "component props object escapes (spread / passed on)".into()
                            );
                        }
                    }
                }
                let uses = std::mem::take(&mut work.member_uses);
                for member in uses {
                    // `props.prop` evaluates to the sealed value.
                    self.check_value(member, _index, _facts, work)?;
                }
                Ok(())
            }
            ParamShape::Destructured(bindings) => {
                for (key, symbol) in bindings {
                    if key == prop {
                        work.push(*symbol, false);
                    }
                }
                Ok(())
            }
            ParamShape::Other => Err("component props parameter is not analyzable".into()),
        }
    }

    // --- helpers -------------------------------------------------------------

    fn callee_runtime(&self, call: &CallExpression<'_>) -> Option<Runtime> {
        let Expression::Identifier(callee) = &call.callee else {
            return None;
        };
        let symbol = callee
            .reference_id
            .get()
            .and_then(|r| self.scoping.get_reference(r).symbol_id())?;
        self.runtime.get(&symbol).copied()
    }

    fn parent(&self, node: NodeId) -> NodeId {
        self.nodes.parent_id(node)
    }

    fn span(&self, node: NodeId) -> Span {
        self.nodes.get_node(node).kind().span()
    }

    fn reference_name(&self, node: NodeId) -> String {
        match self.nodes.get_node(node).kind() {
            AstKind::IdentifierReference(identifier) => identifier.name.to_string(),
            other => other.debug_name().to_string(),
        }
    }

    fn find_node(&self, span: Span, filter: impl Fn(&AstKind<'_>) -> bool) -> Option<NodeId> {
        self.nodes
            .iter()
            .find(|node| node.kind().span() == span && filter(&node.kind()))
            .map(|node| node.id())
    }

    fn is_within(&self, scope: ScopeId, ancestor: ScopeId) -> bool {
        let mut current = Some(scope);
        while let Some(scope) = current {
            if scope == ancestor {
                return true;
            }
            current = self.scoping.scope_parent_id(scope);
        }
        false
    }

    fn is_callee(&self, node: NodeId) -> bool {
        self.call_of_callee(node).is_some()
    }

    /// The call whose callee is `node`.
    fn call_of_callee(&self, node: NodeId) -> Option<NodeId> {
        let parent = self.parent(node);
        match self.nodes.get_node(parent).kind() {
            AstKind::CallExpression(call) if call.callee.span() == self.span(node) => Some(parent),
            _ => None,
        }
    }

    fn is_read_of_accessor(&self, node: NodeId) -> bool {
        self.read_of_accessor(node).is_some()
    }

    /// The expression node evaluating to the accessor's value: `X()`,
    /// `_$perform(X)`, or `yield* X`.
    fn read_of_accessor(&self, node: NodeId) -> Option<NodeId> {
        let parent = self.parent(node);
        match self.nodes.get_node(parent).kind() {
            AstKind::CallExpression(call) => {
                if call.callee.span() == self.span(node) && call.arguments.is_empty() {
                    return Some(parent);
                }
                if self.callee_runtime(call) == Some(Runtime::Perform)
                    && call.arguments.len() == 1
                    && call.arguments[0].span() == self.span(node)
                {
                    return Some(parent);
                }
                None
            }
            AstKind::YieldExpression(y) if y.delegate => Some(parent),
            _ => None,
        }
    }

    fn member_property_of(&self, node: NodeId) -> Option<String> {
        match self.nodes.get_node(self.parent(node)).kind() {
            AstKind::StaticMemberExpression(member) if member.object.span() == self.span(node) => {
                Some(member.property.name.to_string())
            }
            _ => None,
        }
    }

    fn is_assignment_target(&self, node: NodeId) -> bool {
        let parent = self.parent(node);
        match self.nodes.get_node(parent).kind() {
            AstKind::AssignmentExpression(a) => a.left.span() == self.span(node),
            AstKind::UpdateExpression(_) => true,
            AstKind::UnaryExpression(u) => {
                u.operator == oxc_syntax::operator::UnaryOperator::Delete
            }
            AstKind::ArrayAssignmentTarget(_)
            | AstKind::ObjectAssignmentTarget(_)
            | AstKind::AssignmentTargetWithDefault(_)
            | AstKind::AssignmentTargetPropertyProperty(_)
            | AstKind::AssignmentTargetRest(_) => true,
            _ => false,
        }
    }

    /// Whether a member chain rooted at `node` is written (`x.a.b = …`).
    fn member_chain_is_written(&self, node: NodeId) -> bool {
        let mut current = node;
        loop {
            let parent = self.parent(current);
            match self.nodes.get_node(parent).kind() {
                AstKind::StaticMemberExpression(m) if m.object.span() == self.span(current) => {
                    if self.is_assignment_target(parent) {
                        return true;
                    }
                    if let Some(_call) = self.call_of_callee(parent)
                        && MUTATING_METHODS.contains(&m.property.name.as_str())
                    {
                        return true;
                    }
                    current = parent;
                }
                AstKind::ComputedMemberExpression(m) if m.object.span() == self.span(current) => {
                    if self.is_assignment_target(parent) {
                        return true;
                    }
                    current = parent;
                }
                _ => return false,
            }
        }
    }

    fn enclosing_function(&self, node: NodeId) -> Option<NodeId> {
        let mut current = node;
        loop {
            let parent = self.parent(current);
            if parent == current {
                return None;
            }
            match self.nodes.get_node(parent).kind() {
                AstKind::Function(_) | AstKind::ArrowFunctionExpression(_) => return Some(parent),
                _ => current = parent,
            }
        }
    }

    fn is_parameter(&self, symbol: SymbolId) -> bool {
        let mut node = self.scoping.symbol_declaration(symbol);
        loop {
            match self.nodes.get_node(node).kind() {
                AstKind::FormalParameter(_) | AstKind::FormalParameters(_) => return true,
                AstKind::Function(_)
                | AstKind::ArrowFunctionExpression(_)
                | AstKind::VariableDeclarator(_)
                | AstKind::Program(_) => return false,
                _ => {}
            }
            let parent = self.parent(node);
            if parent == node {
                return false;
            }
            node = parent;
        }
    }

    fn is_module_primitive_const(&self, symbol: SymbolId) -> bool {
        if self.scoping.symbol_scope_id(symbol) != self.scoping.root_scope_id() {
            return false;
        }
        let node = self.scoping.symbol_declaration(symbol);
        let AstKind::VariableDeclarator(declarator) = self.nodes.get_node(node).kind() else {
            return false;
        };
        let is_const = matches!(
            self.nodes.parent_kind(node),
            AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const
        );
        is_const
            && matches!(declarator.id, BindingPattern::BindingIdentifier(_))
            && declarator.init.as_ref().is_some_and(is_primitive_literal)
    }

    /// A same-module function proven free of side effects, reactive reads,
    /// client-specific inputs, and argument mutation (a local summary).
    fn is_pure_local_function(&self, symbol: SymbolId, visiting: &mut HashSet<SymbolId>) -> bool {
        if !visiting.insert(symbol) {
            return true; // recursion: assume, the other frames decide
        }
        let Some((node, scope)) = self.function_of_symbol(symbol) else {
            return false;
        };
        let mut collector = ComputeCollector::default();
        match self.nodes.get_node(node).kind() {
            AstKind::ArrowFunctionExpression(arrow) => collector.visit_arrow(arrow),
            AstKind::Function(function) => collector.visit_function_node(function),
            _ => return false,
        }
        if collector.generator || collector.jsx || collector.this {
            return false;
        }
        for &(reference, _) in &collector.references {
            let reference = self.scoping.get_reference(reference);
            let node = reference.node_id();
            let Some(inner) = reference.symbol_id() else {
                let name = self.reference_name(node);
                if self.check_global(node, &name).is_err() {
                    return false;
                }
                continue;
            };
            if self.is_within(self.scoping.symbol_scope_id(inner), scope) {
                // Locals and parameters: parameters must not be mutated.
                if self.is_parameter(inner) && self.member_chain_is_written(node) {
                    return false;
                }
                continue;
            }
            if reference.is_write() || self.member_chain_is_written(node) {
                return false;
            }
            if self.is_module_primitive_const(inner) {
                continue;
            }
            if let Some((module, export)) = self.imports.get(&inner) {
                match self.summary.kind(module, export) {
                    Some(AuthorityKind::Pure) => continue,
                    Some(AuthorityKind::Server) if self.is_callee(node) => continue,
                    _ => return false,
                }
            }
            if self.is_pure_local_function(inner, visiting) {
                continue;
            }
            return false;
        }
        true
    }

    fn function_of_symbol(&self, symbol: SymbolId) -> Option<(NodeId, ScopeId)> {
        let declaration = self.scoping.symbol_declaration(symbol);
        match self.nodes.get_node(declaration).kind() {
            AstKind::Function(function) => Some((declaration, function.scope_id.get()?)),
            AstKind::VariableDeclarator(declarator) => {
                let is_const = matches!(
                    self.nodes.parent_kind(declaration),
                    AstKind::VariableDeclaration(d) if d.kind == VariableDeclarationKind::Const
                );
                if !is_const {
                    return None;
                }
                let init = declarator.init.as_ref()?;
                let (span, scope) = match init {
                    Expression::ArrowFunctionExpression(arrow) => {
                        (arrow.span, arrow.scope_id.get()?)
                    }
                    Expression::FunctionExpression(function) => {
                        (function.span, function.scope_id.get()?)
                    }
                    _ => return None,
                };
                let node = self.find_node(span, |kind| {
                    matches!(
                        kind,
                        AstKind::ArrowFunctionExpression(_) | AstKind::Function(_)
                    )
                })?;
                Some((node, scope))
            }
            _ => None,
        }
    }

    fn function_params(&self, symbol: SymbolId) -> Option<Vec<Vec<SymbolId>>> {
        let (node, _) = self.function_of_symbol(symbol)?;
        let params = match self.nodes.get_node(node).kind() {
            AstKind::ArrowFunctionExpression(arrow) => &arrow.params,
            AstKind::Function(function) => &function.params,
            _ => return None,
        };
        Some(
            params
                .items
                .iter()
                .map(|param| binding_symbols(&param.pattern))
                .collect(),
        )
    }

    /// A same-module component (capitalized function) and its parameter shape.
    fn local_component(&self, symbol: SymbolId) -> Option<Vec<ParamShape>> {
        let name = self.scoping.symbol_name(symbol);
        if !name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
            return None;
        }
        let (node, _) = self.function_of_symbol(symbol)?;
        let params = match self.nodes.get_node(node).kind() {
            AstKind::ArrowFunctionExpression(arrow) => &arrow.params,
            AstKind::Function(function) => &function.params,
            _ => return None,
        };
        Some(
            params
                .items
                .iter()
                .map(|p| param_shape(&p.pattern))
                .collect(),
        )
    }
}

enum ParamShape {
    Identifier(SymbolId),
    Destructured(Vec<(String, SymbolId)>),
    Other,
}

fn param_shape(pattern: &BindingPattern<'_>) -> ParamShape {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => match identifier.symbol_id.get() {
            Some(symbol) => ParamShape::Identifier(symbol),
            None => ParamShape::Other,
        },
        BindingPattern::ObjectPattern(object) => {
            if object.rest.is_some() {
                return ParamShape::Other;
            }
            let mut bindings = Vec::new();
            for property in &object.properties {
                let key = match &property.key {
                    PropertyKey::StaticIdentifier(key) => key.name.to_string(),
                    _ => return ParamShape::Other,
                };
                for symbol in binding_symbols(&property.value) {
                    bindings.push((key.clone(), symbol));
                }
            }
            ParamShape::Destructured(bindings)
        }
        _ => ParamShape::Other,
    }
}

#[derive(Default)]
struct AliasWork {
    /// `(symbol, is_accessor)` to follow.
    queue: Vec<(SymbolId, bool)>,
    seen: HashSet<(SymbolId, bool)>,
    /// `(component, prop)` pairs the value flows into.
    props: Vec<(SymbolId, String)>,
    seen_props: HashSet<(SymbolId, String)>,
    member_uses: Vec<NodeId>,
    render_params: Vec<(SymbolId, Span)>,
}

impl AliasWork {
    fn push(&mut self, symbol: SymbolId, accessor: bool) {
        if self.seen.insert((symbol, accessor)) {
            self.queue.push((symbol, accessor));
        }
    }
}

/// Collects a function's identifier references and disqualifying features.
#[derive(Default)]
struct ComputeCollector {
    references: Vec<(oxc_semantic::ReferenceId, Span)>,
    generator: bool,
    jsx: bool,
    this: bool,
    depth: u32,
}

impl ComputeCollector {
    fn visit_arrow(&mut self, arrow: &ArrowFunctionExpression<'_>) {
        self.visit_arrow_function_body(&arrow.body);
    }
    fn visit_function_node(&mut self, function: &Function<'_>) {
        if function.generator {
            self.generator = true;
        }
        if let Some(body) = function.body.as_ref() {
            self.visit_function_body(body);
        }
    }
}

impl<'b> Visit<'b> for ComputeCollector {
    fn visit_identifier_reference(&mut self, identifier: &oxc_ast::ast::IdentifierReference<'b>) {
        if let Some(reference) = identifier.reference_id.get() {
            self.references.push((reference, identifier.span));
        }
    }
    fn visit_jsx_element(&mut self, _: &JSXElement<'b>) {
        self.jsx = true;
    }
    fn visit_jsx_fragment(&mut self, _: &oxc_ast::ast::JSXFragment<'b>) {
        self.jsx = true;
    }
    fn visit_this_expression(&mut self, _: &oxc_ast::ast::ThisExpression) {
        if self.depth == 0 {
            self.this = true;
        }
    }
    fn visit_function(&mut self, function: &Function<'b>, flags: oxc_syntax::scope::ScopeFlags) {
        // Nested functions (callbacks) are part of the compute; `this` inside
        // a nested non-arrow function is that function's own.
        if function.generator {
            self.generator = true;
        }
        self.depth += 1;
        walk::walk_function(self, function, flags);
        self.depth -= 1;
    }
    fn visit_yield_expression(&mut self, expression: &oxc_ast::ast::YieldExpression<'b>) {
        self.generator = true;
        walk::walk_yield_expression(self, expression);
    }
}

/// The JSX an arrow returns unconditionally: an expression body, or a block
/// of straight-line statements ending in `return <jsx/>`.
fn returned_jsx_arrow<'b, 'a>(
    arrow: &'b ArrowFunctionExpression<'a>,
) -> Option<&'b Expression<'a>> {
    match &arrow.body {
        oxc_ast::ast::ArrowFunctionBody::FunctionBody(body) => returned_jsx(&body.statements),
        body => {
            let expression = body.as_expression()?;
            is_jsx_root(expression).then_some(expression)
        }
    }
}

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
    let expression = ret.argument.as_ref()?;
    is_jsx_root(expression).then_some(expression)
}

fn is_jsx_root(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::JSXElement(_) | Expression::JSXFragment(_) => true,
        Expression::ParenthesizedExpression(p) => is_jsx_root(&p.expression),
        _ => false,
    }
}

fn literal_property(object: &ObjectExpression<'_>, key: &str) -> Option<String> {
    object.properties.iter().find_map(|property| {
        let ObjectPropertyKind::ObjectProperty(property) = property else {
            return None;
        };
        if property.key.static_name().as_deref() != Some(key) {
            return None;
        }
        match &property.value {
            Expression::StringLiteral(value) => Some(value.value.to_string()),
            Expression::BooleanLiteral(value) => Some(value.value.to_string()),
            _ => Some(String::from("<dynamic>")),
        }
    })
}

fn has_property(object: &ObjectExpression<'_>, key: &str) -> bool {
    object.properties.iter().any(|property| {
        matches!(property, ObjectPropertyKind::ObjectProperty(p)
            if p.key.static_name().as_deref() == Some(key))
    })
}

fn is_primitive_literal(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_)
        | Expression::BigIntLiteral(_) => true,
        Expression::TemplateLiteral(template) => template.expressions.is_empty(),
        Expression::UnaryExpression(unary) => is_primitive_literal(&unary.argument),
        _ => false,
    }
}

/// Literal data (a frozen signal/store initializer): primitives and
/// object/array literals of literal data.
fn is_literal_data(expression: &Expression<'_>) -> bool {
    match expression {
        Expression::ArrayExpression(array) => array
            .elements
            .iter()
            .all(|element| element.as_expression().is_some_and(is_literal_data)),
        Expression::ObjectExpression(object) => object.properties.iter().all(|property| {
            matches!(property, ObjectPropertyKind::ObjectProperty(p)
                if !p.computed && !p.method && is_literal_data(&p.value))
        }),
        Expression::ParenthesizedExpression(p) => is_literal_data(&p.expression),
        other => is_primitive_literal(other),
    }
}

fn binding_symbols(pattern: &BindingPattern<'_>) -> Vec<SymbolId> {
    let mut symbols = Vec::new();
    collect_bindings(pattern, &mut symbols);
    symbols
}

fn collect_bindings(pattern: &BindingPattern<'_>, out: &mut Vec<SymbolId>) {
    match pattern {
        BindingPattern::BindingIdentifier(identifier) => {
            if let Some(symbol) = identifier.symbol_id.get() {
                out.push(symbol);
            }
        }
        BindingPattern::ObjectPattern(object) => {
            for property in &object.properties {
                collect_bindings(&property.value, out);
            }
            if let Some(rest) = &object.rest {
                collect_bindings(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(array) => {
            for element in array.elements.iter().flatten() {
                collect_bindings(element, out);
            }
            if let Some(rest) = &array.rest {
                collect_bindings(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(assignment) => collect_bindings(&assignment.left, out),
    }
}

fn attribute_is_true(element: &JSXElement<'_>, name: &str) -> Option<bool> {
    element.opening_element.attributes.iter().find_map(|item| {
        let JSXAttributeItem::Attribute(attribute) = item else {
            return None;
        };
        let JSXAttributeName::Identifier(identifier) = &attribute.name else {
            return None;
        };
        if identifier.name != name {
            return None;
        }
        Some(match &attribute.value {
            None => true,
            Some(JSXAttributeValue::ExpressionContainer(container)) => !matches!(
                &container.expression,
                JSXExpression::BooleanLiteral(b) if !b.value
            ),
            Some(_) => true,
        })
    })
}

/// `<For>` hands the item as data unless `keyed={false}` (then an accessor).
fn keyed_for(element: &JSXElement<'_>) -> bool {
    attribute_is_true(element, "keyed").unwrap_or(true)
}

/// `<Show>` hands the value as data only when `keyed`.
fn keyed_show(element: &JSXElement<'_>) -> bool {
    attribute_is_true(element, "keyed").unwrap_or(false)
}

struct Rewriter<'a> {
    allocator: &'a Allocator,
    /// Options-object spans and their mark (`1` ships the value, `2` is
    /// compute-only).
    marks: Vec<(Span, u8)>,
    /// Render callbacks and the constant expressions to hoist out of them.
    hoists: Vec<(Span, Vec<Span>)>,
    /// `{X()}` text holes of sealed memos, rewritten to `{X}`.
    accessor_holes: Vec<(Span, String)>,
    /// Open callbacks: planned expression spans and the hoisted declarations.
    frames: Vec<(Vec<Span>, Vec<(String, Expression<'a>)>)>,
    counter: usize,
}

impl<'a> Rewriter<'a> {
    fn open(&mut self, span: Span) -> bool {
        match self
            .hoists
            .iter()
            .position(|(callback, _)| *callback == span)
        {
            Some(index) => {
                let (_, exprs) = self.hoists.swap_remove(index);
                self.frames.push((exprs, Vec::new()));
                true
            }
            None => false,
        }
    }

    fn declarations(&mut self, span: Span) -> Vec<Statement<'a>> {
        let (_, decls) = self.frames.pop().expect("opened frame");
        decls
            .into_iter()
            .map(|(name, init)| {
                crate::shared::ast::variable_statement(
                    self.allocator,
                    span,
                    VariableDeclarationKind::Const,
                    &name,
                    init,
                )
            })
            .collect()
    }
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_object_expression(&mut self, object: &mut ObjectExpression<'a>) {
        if let Some(&(_, mark)) = self.marks.iter().find(|(span, _)| *span == object.span) {
            let ast = AstBuilder::new(self.allocator);
            let text = if mark == 2 { "2" } else { "1" };
            let value = ast.expression_numeric_literal(
                Span::new(0, 0),
                f64::from(mark),
                Some(ast.str(text)),
                oxc_syntax::number::NumberBase::Decimal,
            );
            object.properties.push(crate::shared::ast::object_property(
                self.allocator,
                Span::new(0, 0),
                SEALED_KEY,
                value,
            ));
        }
        walk_mut::walk_object_expression(self, object);
    }

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

    fn visit_jsx_expression_container(
        &mut self,
        container: &mut oxc_ast::ast::JSXExpressionContainer<'a>,
    ) {
        if let Some(expression) = container.expression.as_expression()
            && let Some((_, name)) = self
                .accessor_holes
                .iter()
                .find(|(span, _)| *span == expression.span())
        {
            let ast = AstBuilder::new(self.allocator);
            let span = expression.span();
            container.expression =
                JSXExpression::from(ast.expression_identifier(span, ast.ident(name)));
            return;
        }
        if let Some((planned, decls)) = self.frames.last_mut()
            && let Some(expression) = container.expression.as_expression()
            && planned.contains(&expression.span())
        {
            let name = format!("_$sealed{}", self.counter);
            self.counter += 1;
            let ast = AstBuilder::new(self.allocator);
            let span = expression.span();
            let replacement =
                JSXExpression::from(ast.expression_identifier(span, ast.ident(&name)));
            let taken = std::mem::replace(&mut container.expression, replacement);
            decls.push((name, taken.into_expression()));
            return;
        }
        walk_mut::walk_jsx_expression_container(self, container);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    fn decide(source: &str, summary: &AuthoritySummary) -> Vec<Decision> {
        let allocator = Allocator::default();
        let mut program = Parser::new(&allocator, source, SourceType::tsx())
            .parse()
            .program;
        seal_server_authority(&allocator, &mut program, summary)
    }

    fn verdict(source: &str) -> HashMap<String, Result<(), String>> {
        verdict_with(source, &AuthoritySummary::default())
    }

    fn verdict_with(
        source: &str,
        summary: &AuthoritySummary,
    ) -> HashMap<String, Result<(), String>> {
        decide(source, summary)
            .into_iter()
            .map(|d| {
                (
                    d.name,
                    if d.sealed {
                        Ok(())
                    } else {
                        Err(d.reason.unwrap_or_default())
                    },
                )
            })
            .collect()
    }

    fn assert_sealed(v: &HashMap<String, Result<(), String>>, name: &str) {
        assert_eq!(v.get(name), Some(&Ok(())), "{name}: {v:?}");
    }

    fn assert_rejected(v: &HashMap<String, Result<(), String>>, name: &str, needle: &str) {
        match v.get(name) {
            Some(Err(reason)) => assert!(
                reason.contains(needle),
                "{name}: `{reason}` lacks `{needle}`"
            ),
            other => {
                panic!("{name}: expected rejection containing `{needle}`, got {other:?} ({v:?})")
            }
        }
    }

    const HEADER: &str = r#"import { createMemo, createSignal, createStore, refresh, For, Show } from "solid-js";
import { isServer } from "@solidjs/web";
import { fetchProducts } from "./api";
"#;

    fn summary() -> AuthoritySummary {
        AuthoritySummary {
            entries: vec![(
                "./api".into(),
                "fetchProducts".into(),
                AuthorityKind::Server,
            )],
        }
    }

    #[test]
    fn seals_fetch_sort_format_chain() {
        let source = format!(
            "{HEADER}
const CURRENCY = \"USD\";
function formatPrice(cents) {{ return (cents / 100).toFixed(2) + \" \" + CURRENCY; }}
function Catalog() {{
  const [category] = createSignal(\"tools\");
  const products = createMemo(() => fetchProducts(category()), {{ ssrSource: \"server\" }});
  const sorted = createMemo(() => [...products()].sort((a, b) => a.price - b.price), {{ ssrSource: \"server\" }});
  const labels = createMemo(() => sorted().map(p => p.name + \": \" + formatPrice(p.price)), {{ ssrSource: \"server\" }});
  return <ul><For each={{sorted()}}>{{p => <li title={{p.name}}>{{p.name}}</li>}}</For><p>{{labels().join(\", \")}}</p></ul>;
}}"
        );
        let v = verdict_with(&source, &summary());
        assert_sealed(&v, "products");
        assert_sealed(&v, "sorted");
        assert_sealed(&v, "labels");
    }

    #[test]
    fn marks_compute_only_memos() {
        let allocator = Allocator::default();
        let source = format!(
            "{HEADER}
function C() {{
  const base = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const count = createMemo(() => base().length, {{ ssrSource: \"server\" }});
  return <p>{{count()}}</p>;
}}"
        );
        let mut program = Parser::new(&allocator, &source, SourceType::tsx())
            .parse()
            .program;
        seal_server_authority(&allocator, &mut program, &summary());
        let out = oxc_codegen::Codegen::new().build(&program).code;
        // `base` is read only inside `count`'s compute; `count` is rendered.
        assert!(
            out.contains("fetchProducts(1), {\n\t\tssrSource: \"server\",\n\t\t$sealed: 2"),
            "{out}"
        );
        assert!(
            out.contains("base().length, {\n\t\tssrSource: \"server\",\n\t\t$sealed: 1"),
            "{out}"
        );
    }

    #[test]
    fn rejects_client_specific_inputs() {
        let source = format!(
            "{HEADER}
function C() {{
  const a = createMemo(() => window.innerWidth, {{ ssrSource: \"server\" }});
  const b = createMemo(() => new Date().getFullYear(), {{ ssrSource: \"server\" }});
  const c = createMemo(() => (isServer ? 1 : 2), {{ ssrSource: \"server\" }});
  const d = createMemo(() => Math.random(), {{ ssrSource: \"server\" }});
  return [a(), b(), c(), d()];
}}"
        );
        let v = verdict(&source);
        assert_rejected(&v, "a", "client-specific input `window`");
        assert_rejected(&v, "b", "client-specific input `Date`");
        assert_rejected(&v, "c", "client-specific input `isServer`");
        assert_rejected(&v, "d", "Math.random");
    }

    #[test]
    fn rejects_hybrid_client_and_implicit_sources() {
        let source = format!(
            "{HEADER}
function C() {{
  const h = createMemo(() => 1, {{ ssrSource: \"hybrid\" }});
  const c = createMemo(() => 1, {{ ssrSource: \"client\", loadingValue: 0 }});
  const implicit = createMemo(() => 1);
  const t = createMemo(() => 1, {{ ssrSource: \"server\", transparent: true }});
  return [h(), c(), implicit(), t()];
}}"
        );
        let v = verdict(&source);
        assert_rejected(&v, "h", "hybrid");
        assert_rejected(&v, "c", "client source");
        assert_rejected(&v, "t", "transparent");
        assert!(
            !v.contains_key("implicit"),
            "implicit default is not a candidate: {v:?}"
        );
    }

    #[test]
    fn rejects_escaped_setters_and_refresh() {
        let source = format!(
            "{HEADER}
function C() {{
  const [page, setPage] = createSignal(1);
  const rows = createMemo(() => fetchProducts(page()), {{ ssrSource: \"server\" }});
  const fixed = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const again = () => refresh(fixed);
  return <button onClick={{() => setPage(p => p + 1)}}>{{rows().length}}{{again}}</button>;
}}"
        );
        let v = verdict_with(&source, &summary());
        assert_rejected(&v, "rows", "setter escapes");
        assert_rejected(&v, "fixed", "refresh");
    }

    #[test]
    fn rejects_unknown_callbacks_and_polling() {
        let source = format!(
            "{HEADER}
import {{ load }} from \"./other\";
function C(props) {{
  const a = createMemo(() => load(), {{ ssrSource: \"server\" }});
  const b = createMemo(() => props.id, {{ ssrSource: \"server\" }});
  const c = createMemo(() => {{ setInterval(() => {{}}, 10); return 1; }}, {{ ssrSource: \"server\" }});
  const d = createMemo(async function* () {{ yield 1; }}, {{ ssrSource: \"server\" }});
  const compute = () => 1;
  const e = createMemo(compute, {{ ssrSource: \"server\" }});
  return [a(), b(), c(), d(), e()];
}}"
        );
        let v = verdict(&source);
        assert_rejected(&v, "a", "no authority summary");
        assert_rejected(&v, "b", "outer parameter `props`");
        assert_rejected(&v, "c", "setInterval");
        assert_rejected(&v, "d", "generator");
        assert_rejected(&v, "e", "not an inline function");
    }

    #[test]
    fn rejects_mutable_authority() {
        let source = format!(
            "{HEADER}
function Row(props) {{ props.item.seen = true; return <li>{{props.item.name}}</li>; }}
function C() {{
  const a = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const b = createMemo(() => fetchProducts(2), {{ ssrSource: \"server\" }});
  const c = createMemo(() => fetchProducts(3), {{ ssrSource: \"server\" }});
  const d = createMemo(() => fetchProducts(4), {{ ssrSource: \"server\" }});
  const list = b();
  a().sort();
  list[0].name = \"x\";
  return <ul><For each={{c()}}>{{item => <Row item={{item}} />}}</For>{{d().map(x => {{ x.n++; return x.name; }})}}</ul>;
}}"
        );
        let v = verdict_with(&source, &summary());
        assert_rejected(&v, "a", "`.sort()`");
        assert_rejected(&v, "b", "mutated");
        assert_rejected(&v, "c", "mutated");
        assert_rejected(&v, "d", "mutated");
    }

    #[test]
    fn dependency_and_flow_fixed_point() {
        let source = format!(
            "{HEADER}
function C() {{
  const base = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const derived = createMemo(() => base().filter(p => p.on), {{ ssrSource: \"server\" }});
  const loose = createMemo(() => base()[0], {{ ssrSource: \"server\" }});
  const top = createMemo(() => derived().length, {{ ssrSource: \"server\" }});
  refresh(loose);
  return top();
}}"
        );
        let v = verdict_with(&source, &summary());
        assert_rejected(&v, "loose", "refresh");
        // `base` flows into `loose`, which is not sealed.
        assert_rejected(&v, "base", "flows into memo `loose`");
        assert_rejected(&v, "derived", "reads memo `base`");
        assert_rejected(&v, "top", "reads memo `derived`");
    }

    #[test]
    fn marks_only_sealed_options() {
        let allocator = Allocator::default();
        let source = format!(
            "{HEADER}
function C() {{
  const a = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const b = createMemo(() => window.x, {{ ssrSource: \"server\" }});
  return [a(), b()];
}}"
        );
        let mut program = Parser::new(&allocator, &source, SourceType::tsx())
            .parse()
            .program;
        seal_server_authority(&allocator, &mut program, &summary());
        let out = oxc_codegen::Codegen::new().build(&program).code;
        assert_eq!(out.matches("$sealed: 1").count(), 1, "{out}");
        let sealed = out.find("$sealed").unwrap();
        assert!(out.find("fetchProducts(1)").unwrap() < sealed, "{out}");
        assert!(sealed < out.find("window.x").unwrap(), "{out}");
    }

    fn rewrite(source: &str) -> String {
        let allocator = Allocator::default();
        let mut program = Parser::new(&allocator, source, SourceType::tsx())
            .parse()
            .program;
        seal_server_authority(&allocator, &mut program, &summary());
        oxc_codegen::Codegen::new().build(&program).code
    }

    #[test]
    fn hoists_constant_row_bindings_over_sealed_lists() {
        let out = rewrite(&format!(
            "{HEADER}
function fmt(n) {{ return (n / 100).toFixed(2); }}
function C() {{
  const rows = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const [cart, setCart] = createSignal(0);
  return <ul><For each={{rows()}}>{{row => <li title={{row.name}}>{{row.name}} {{fmt(row.price)}}<b>{{row.tags.join(\",\")}}</b><button onClick={{() => setCart(c => c + row.id)}}>{{cart()}}</button></li>}}</For></ul>;
}}"
        ));
        assert!(out.contains("const _$sealed0 = row.name;"), "{out}");
        assert!(out.contains("const _$sealed2 = fmt(row.price);"), "{out}");
        assert!(
            out.contains("const _$sealed3 = row.tags.join(\",\");"),
            "{out}"
        );
        assert!(out.contains("title={_$sealed0}"), "{out}");
        assert!(out.contains("title={_$sealed0}"), "{out}");
        // Live bindings stay: the handler and the client signal read.
        assert!(
            out.contains("onClick={() => setCart((c) => c + row.id)}"),
            "{out}"
        );
        assert!(out.contains("{cart()}"), "{out}");
    }

    #[test]
    fn does_not_hoist_unproven_rows() {
        let out = rewrite(&format!(
            "{HEADER}
function Card(props) {{ return <div>{{props.children}}</div>; }}
function C(props) {{
  const rows = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  return <>
    <For each={{props.flag ? rows() : props.other}}>{{row => <i>{{row.name}}</i>}}</For>
    <For each={{rows()}} keyed={{false}}>{{row => <i>{{row().name}}</i>}}</For>
    <For each={{rows()}}>{{row => row.on ? <b>{{row.name}}</b> : <u>{{row.alt.name}}</u>}}</For>
    <For each={{rows()}}>{{row => <Card><s>{{row.detail.name}}</s></Card>}}</For>
    <For each={{rows()}}>{{row => {{ row = row.next; return <em>{{row.name}}</em>; }}}}</For>
  </>;
}}"
        ));
        // The memo itself is sealed; only the unproven row bindings stay live.
        assert!(out.contains("$sealed: 1"), "{out}");
        assert!(!out.contains("_$sealed0"), "{out}");
    }

    #[test]
    fn passes_sealed_accessors_to_text_holes() {
        let out = rewrite(&format!(
            "{HEADER}
function C() {{
  const title = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const [n, setN] = createSignal(0);
  return <div title={{title()}}><h2>{{title()}}</h2><p>{{n()}}</p></div>;
}}"
        ));
        assert!(out.contains("<h2>{title}</h2>"), "{out}");
        // Attributes need the value; live signals and component children keep the read.
        assert!(out.contains("title={title()}"), "{out}");
        assert!(out.contains("<p>{n()}</p>"), "{out}");
    }

    #[test]
    fn rejects_unknown_component_consumers() {
        let source = format!(
            "{HEADER}
import {{ Card }} from \"./ui\";
function C() {{
  const a = createMemo(() => fetchProducts(1), {{ ssrSource: \"server\" }});
  const b = createMemo(() => fetchProducts(2), {{ ssrSource: \"server\" }});
  const c = createMemo(() => fetchProducts(3), {{ ssrSource: \"server\" }});
  return <><Card>{{a()}}</Card><Card data={{b()}} /><Card value={{c}} /></>;
}}"
        );
        let v = verdict_with(&source, &summary());
        assert_rejected(&v, "a", "no readonly-props summary");
        assert_rejected(&v, "b", "no readonly-props summary");
        assert_rejected(&v, "c", "escapes as a JSX value");
        let mut readonly = summary();
        readonly.entries.push((
            "./ui".into(),
            "Card".into(),
            AuthorityKind::ReadonlyComponent,
        ));
        let v = verdict_with(&source, &readonly);
        assert_sealed(&v, "a");
        assert_sealed(&v, "b");
        assert_rejected(&v, "c", "escapes as a JSX value");
    }
}
