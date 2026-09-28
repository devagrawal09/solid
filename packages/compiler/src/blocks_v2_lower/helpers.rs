//! Helper generators (section 5 of the module doc; generalized in section 11
//! of `documentation/plans/blocks-v2-performance.md`).
//!
//! A helper is a module-level `function*` declaration that v2 bodies delegate
//! to: `const x = yield* useThing(a)`, lowered by the generator pass to
//! `_$perform(useThing(a))`. `perform` steps the helper's generator in call
//! form (`stepSync`): each operation it yields is performed, under the
//! caller's host, and the `yield*` evaluates to what the generator returned.
//! The helper lowers to a plain function when every `yield` in it (at its own
//! depth) is a `yield*` of something the lowering turns into a host-free call
//! that does exactly what `perform` does with that operation:
//!
//! | in the helper | becomes | hosts admitting it |
//! | --- | --- | --- |
//! | `yield* Ctx` (proven context) | `_$readContext(Ctx)` | setup |
//! | `yield* acc` (proven accessor) | `_$readAccessor(acc)` | view, memo, effect, event |
//! | `yield* $signal(v)` / `$store(v)` | `_$createSignal(v)` / `_$createPlainStore(v)`, in `_$withReceipts(…)` unless the setter stays plain | setup |
//! | `yield* $memo(_$$(…))` / `$effect` / `$settled` | `_$createMemo(…)` / `_$effectBlock(…)` / `_$settledBlock(…)` | setup |
//! | `yield* $cleanup(fn)` | `_$blockCleanup(fn)` | setup, effect |
//! | `yield* raise(e);` (a statement) | `throw e;` | memo, effect, event |
//! | `yield* other(…)` (a lowered helper) | `other(…)` / its lowered twin | the callee's |
//!
//! The host check `perform` makes for each operation is decided at compile
//! time instead: a helper admits the intersection of what its yields admit,
//! and a call site is lowered only when its body's kind is admitted. The
//! lowered forms run no host-dependent code, so a caller body the erasure
//! then turns into a plain function (a setup, a memo, an event) keeps its
//! meaning. A `perform` of a helper whose generator is created and stepped at
//! once is the plain call: arguments are bound at the call either way,
//! nothing runs between the call and the `perform`, and the body runs to
//! completion (`stepSync` never calls `return()` on it).
//!
//! Call sites: `_$perform(h(…))` directly in a lowered, synchronous v2 body
//! (the first function around it; async bodies may be restored to their
//! generator), and `yield* h(…)` directly in another lowered helper.
//!
//! How a helper lowers:
//! - **in place** (`function*` → `function`) when it is not exported and
//!   every reference is a call site that lowers;
//! - **as a twin** (`function h$lowered(…)`, exported when `h` is) next to
//!   the untouched generator otherwise: exported helpers, and helpers some of
//!   whose references stay generators. Call sites that lower call the twin;
//!   the rest keep the generator (a bundler drops whichever is unused).
//!
//! Exported twins are listed in the module's helper summary
//! (`CompileOutput::helper_summary`: export name → twin name and admitted
//! hosts). A module importing a helper whose summary the build supplies
//! (`CompileOptions::helper_summaries`) lowers its call sites to the twin
//! the same way, importing it from the same module.
use std::collections::{HashMap, HashSet};

use oxc_allocator::{Allocator, CloneIn};
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, BindingPattern, Declaration, Expression, Function,
    ImportDeclarationSpecifier, ImportOrExportKind, ModuleExportName, Program, Statement,
    VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::ScopeFlags;

use super::{
    Imports, Names, callee_symbol, context_symbols, contexts_source, lowered, reference_symbol,
};
use crate::blocks_v2::{V2Bodies, V2Kind};
use crate::generators::{FusionContext, Origin, collect_fusion_symbols};
use crate::shared::ast::{argument_to_expression, expression_to_argument};
use crate::shared::ast_builder::AstBuilder;

pub(crate) const SETUP: u8 = 1;
pub(crate) const VIEW: u8 = 2;
pub(crate) const MEMO: u8 = 4;
pub(crate) const EFFECT: u8 = 8;
pub(crate) const EVENT: u8 = 16;
const ALL: u8 = SETUP | VIEW | MEMO | EFFECT | EVENT;
const READS: u8 = VIEW | MEMO | EFFECT | EVENT;
const HOST_NAMES: [(u8, &str); 5] = [
    (SETUP, "setup"),
    (VIEW, "view"),
    (MEMO, "memo"),
    (EFFECT, "effect"),
    (EVENT, "event"),
];

fn bit(kind: V2Kind) -> u8 {
    match kind {
        V2Kind::Setup => SETUP,
        V2Kind::View => VIEW,
        V2Kind::Memo => MEMO,
        V2Kind::Effect => EFFECT,
        V2Kind::Event => EVENT,
    }
}

/// Host names of a kind set (the summary's `hosts`).
pub(crate) fn host_names(bits: u8) -> Vec<&'static str> {
    HOST_NAMES
        .iter()
        .filter(|(b, _)| bits & b != 0)
        .map(|(_, name)| *name)
        .collect()
}

/// Kind bits from host names (unknown names are ignored).
pub(crate) fn host_bits<'n>(names: impl IntoIterator<Item = &'n str>) -> u8 {
    names.into_iter().fold(0, |bits, name| {
        bits | HOST_NAMES
            .iter()
            .find(|(_, n)| *n == name)
            .map_or(0, |(b, _)| *b)
    })
}

/// One exported helper's lowered twin (the module's helper summary).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ExportedHelper {
    pub(crate) name: String,
    pub(crate) lowered: String,
    pub(crate) hosts: u8,
}

/// An imported helper's summary entry, as the build supplied it: the import
/// source (as written, or the imported module's path), the export, its twin
/// and the hosts the twin admits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ImportedHelper {
    pub(crate) source: String,
    pub(crate) export: String,
    pub(crate) lowered: String,
    pub(crate) hosts: u8,
}

/// Parse the flattened `source\0export\0lowered\0hosts` strings.
pub(crate) fn parse_imported(facts: &[String]) -> Vec<ImportedHelper> {
    facts
        .iter()
        .filter_map(|fact| {
            let mut parts = fact.split('\0');
            let source = parts.next()?.to_string();
            let export = parts.next()?.to_string();
            let lowered = parts.next()?.to_string();
            let hosts = host_bits(parts.next()?.split(','));
            Some(ImportedHelper {
                source,
                export,
                lowered,
                hosts,
            })
        })
        .collect()
}

/// The summary JSON: `{ "<export>": { "lowered": "<twin>", "hosts": [...] } }`.
pub(crate) fn summary_json(helpers: &[ExportedHelper]) -> String {
    let mut out = String::from("{");
    for (i, helper) in helpers.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let hosts = host_names(helper.hosts)
            .iter()
            .map(|h| format!("\"{h}\""))
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&format!(
            "\"{}\":{{\"lowered\":\"{}\",\"hosts\":[{}]}}",
            helper.name, helper.lowered, hosts
        ));
    }
    out.push('}');
    out
}

/// Normalize a path: `/`-separated, `.` and `..` segments resolved.
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split(['/', '\\']) {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if absolute { format!("/{joined}") } else { joined }
}

/// Does the summary key `key` name the module `source` imports from (as
/// written, or resolved against the importer's `filename` with the usual
/// extensions)?
fn source_matches(key: &str, source: &str, filename: Option<&str>) -> bool {
    if key == source {
        return true;
    }
    let (Some(filename), true) = (filename, source.starts_with("./") || source.starts_with("../"))
    else {
        return false;
    };
    let dir = match filename.rfind(['/', '\\']) {
        Some(i) => &filename[..i],
        None => "",
    };
    let base = normalize(&format!("{dir}/{source}"));
    let key = normalize(key);
    if key == base {
        return true;
    }
    const EXTENSIONS: [&str; 6] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"];
    EXTENSIONS.iter().any(|ext| {
        key == format!("{base}{ext}") || key == format!("{base}/index{ext}")
    }) || key
        .strip_prefix(&base)
        .is_some_and(|rest| rest.starts_with('.') && !rest[1..].contains(['/', '.']))
}

// --- analysis ------------------------------------------------------------------------

/// What one `yield*` in a helper becomes.
#[derive(Clone, Debug)]
enum Yield {
    /// `yield* Ctx` → `_$readContext(Ctx)`.
    Context,
    /// `yield* acc` → `_$readAccessor(acc)`.
    Accessor,
    /// `yield* OP(args)` → `LOCAL(args)` (`receipts`: in `withReceipts`).
    Create {
        imported: &'static str,
        source: String,
        receipts: bool,
    },
    /// `yield* h(args)` of a local helper.
    Local(SymbolId),
    /// `yield* h(args)` of an imported helper with a twin.
    Imported(SymbolId),
}

struct Candidate {
    symbol: SymbolId,
    name: String,
    /// The function declaration's span (and the statement holding it).
    function: Span,
    statement: usize,
    /// Exported (`export function*`, or an `export { h as name }`): the
    /// export names.
    exports: Vec<String>,
    /// `None`: a yield the lowering cannot take.
    yields: Option<Vec<(Span, Yield)>>,
    /// `yield* raise(e);` statements.
    throws: Vec<Span>,
    /// Hosts its own yields admit (before callees).
    own: u8,
    /// Call sites and other references.
    sites: Vec<Site>,
}

#[derive(Clone, Copy, Debug)]
enum Site {
    /// `_$perform(h(…))` directly in a lowered synchronous v2 body.
    Perform { span: Span, kind: V2Kind },
    /// `yield* h(…)` directly in the helper `in` (a candidate).
    Helper { in_helper: SymbolId },
    /// Anything else (an export specifier counts as an export, not here).
    Other,
}

/// The plan: rewrites by span, twins to emit, imports to add.
#[derive(Default)]
pub(super) struct HelperPlan {
    /// In-place helpers (function spans).
    in_place: HashSet<Span>,
    /// Twins: (statement index, function span, twin name, exported).
    twins: Vec<(usize, Span, String, bool)>,
    /// `yield*` rewrites inside lowered helpers.
    yields: HashMap<Span, Rewrite>,
    /// `yield* raise(e);` statements → `throw e;`.
    throws: HashSet<Span>,
    /// `_$perform(h(args))` → `h(args)` (`None`) or `NAME(args)`.
    performs: HashMap<Span, Option<String>>,
    /// Import specifiers to add: (source, imported, local).
    imports: Vec<(String, String, String)>,
    /// The module's exported twins.
    pub(super) exported: Vec<ExportedHelper>,
}

#[derive(Clone, Debug)]
enum Rewrite {
    /// `yield* X` → `LOCAL(X)`.
    Wrap(String),
    /// `yield* OP(args)` → `LOCAL(args)` / `WRAP(LOCAL(args))`.
    Callee(String, Option<String>),
    /// `yield* h(args)` → `h(args)` (`None`) / `NAME(args)`.
    Call(Option<String>),
}

struct Analysis<'s> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'s>,
    names: &'s Names,
    context: &'s FusionContext<'s>,
    contexts: &'s HashSet<SymbolId>,
    v2: &'s V2Bodies,
    candidates: HashMap<SymbolId, usize>,
    /// Imported helpers with a twin: local symbol → (entry, import source).
    imported: HashMap<SymbolId, (ImportedHelper, String)>,
}

impl<'s> Analysis<'s> {
    /// The first function around `node`: a lowered, synchronous v2 body
    /// (its kind), a candidate helper (its symbol), or neither.
    fn enclosing(&self, node: NodeId) -> Option<Result<V2Kind, SymbolId>> {
        let mut current = node;
        loop {
            let next = self.nodes.parent_id(current);
            if next == current {
                return None;
            }
            current = next;
            match self.nodes.get_node(current).kind() {
                AstKind::Function(function) => {
                    let parent = self.nodes.parent_id(current);
                    if let AstKind::CallExpression(block) = self.nodes.get_node(parent).kind()
                        && self.names.is(self.scoping, block, "$")
                        && lowered(function)
                        && !function.r#async
                        && let Some(kind) = self.v2.kind_of(block.span)
                    {
                        return Some(Ok(kind));
                    }
                    let symbol = function.id.as_ref().and_then(|id| id.symbol_id.get())?;
                    return self
                        .candidates
                        .contains_key(&symbol)
                        .then_some(Err(symbol));
                }
                AstKind::ArrowFunctionExpression(_) | AstKind::Class(_) => return None,
                _ => {}
            }
        }
    }

    /// Classify every reference of `symbol` (a candidate or an imported
    /// helper). Export specifiers are returned as export names.
    fn sites(&self, symbol: SymbolId) -> (Vec<Site>, Vec<String>) {
        let mut sites = Vec::new();
        let mut exports = Vec::new();
        for reference in self.scoping.get_resolved_references(symbol) {
            let node = reference.node_id();
            let span = self.nodes.get_node(node).kind().span();
            let parent = self.nodes.parent_id(node);
            match self.nodes.get_node(parent).kind() {
                AstKind::ExportSpecifier(specifier) => {
                    exports.push(specifier.exported.name().to_string());
                    continue;
                }
                AstKind::CallExpression(call)
                    if call.callee.span() == span
                        && !call
                            .arguments
                            .iter()
                            .any(|a| matches!(a, Argument::SpreadElement(_))) =>
                {
                    let outer = self.nodes.parent_id(parent);
                    let site = match self.nodes.get_node(outer).kind() {
                        AstKind::CallExpression(perform)
                            if perform.arguments.len() == 1
                                && perform.arguments[0].span() == call.span
                                && self.names.is(self.scoping, perform, "perform") =>
                        {
                            match self.enclosing(outer) {
                                Some(Ok(kind)) => Site::Perform {
                                    span: perform.span,
                                    kind,
                                },
                                _ => Site::Other,
                            }
                        }
                        AstKind::YieldExpression(it)
                            if it.delegate
                                && it.argument.as_ref().map(GetSpan::span) == Some(call.span) =>
                        {
                            match self.enclosing(outer) {
                                Some(Err(helper)) => Site::Helper { in_helper: helper },
                                _ => Site::Other,
                            }
                        }
                        _ => Site::Other,
                    };
                    sites.push(site);
                }
                _ => sites.push(Site::Other),
            }
        }
        (sites, exports)
    }

    /// Classify the yields of a helper body: (yields or `None`, throws, own
    /// admitted hosts).
    fn classify(&self, function: &Function<'_>) -> (Option<Vec<(Span, Yield)>>, Vec<Span>, u8) {
        let Some(body) = function.body.as_ref() else {
            return (None, Vec::new(), 0);
        };
        let mut classify = Classify {
            analysis: self,
            yields: Vec::new(),
            throws: Vec::new(),
            receipts: HashMap::new(),
            admitted: ALL,
            ok: true,
        };
        classify.visit_function_body(body);
        let Classify {
            yields,
            throws,
            admitted,
            ok,
            ..
        } = classify;
        (ok.then_some(yields), throws, admitted)
    }

    /// `const [get, set] = <yield>`: does `set` stay plain (every reference
    /// the callee of a call whose result is discarded)?
    fn setter_plain(&self, pattern: &oxc_ast::ast::ArrayPattern<'_>) -> bool {
        if pattern.rest.is_some() || pattern.elements.len() > 2 {
            return false;
        }
        if !matches!(
            pattern.elements.first(),
            None | Some(None) | Some(Some(BindingPattern::BindingIdentifier(_)))
        ) {
            return false;
        }
        let setter = match pattern.elements.get(1) {
            None | Some(None) => return true,
            Some(Some(BindingPattern::BindingIdentifier(id))) => id.symbol_id.get(),
            Some(Some(_)) => return false,
        };
        let Some(setter) = setter else {
            return false;
        };
        self.scoping.get_resolved_references(setter).all(|reference| {
            let node = reference.node_id();
            let span = self.nodes.get_node(node).kind().span();
            let parent = self.nodes.parent_id(node);
            let AstKind::CallExpression(call) = self.nodes.get_node(parent).kind() else {
                return false;
            };
            if call.callee.span() != span {
                return false;
            }
            let statement = self.nodes.parent_id(parent);
            if !matches!(
                self.nodes.get_node(statement).kind(),
                AstKind::ExpressionStatement(_)
            ) {
                return false;
            }
            // Not a concise arrow's body (`() => set(x)` returns the receipt).
            let body = self.nodes.parent_id(statement);
            if !matches!(self.nodes.get_node(body).kind(), AstKind::FunctionBody(_)) {
                return true;
            }
            let function = self.nodes.parent_id(body);
            !matches!(self.nodes.get_node(function).kind(),
                AstKind::ArrowFunctionExpression(arrow) if arrow.get_expression().is_some())
        })
    }
}

struct Classify<'x, 's> {
    analysis: &'x Analysis<'s>,
    yields: Vec<(Span, Yield)>,
    throws: Vec<Span>,
    /// `$signal` / `$store` yields that initialize a plain-setter pattern.
    receipts: HashMap<Span, bool>,
    admitted: u8,
    ok: bool,
}

impl<'b> Visit<'b> for Classify<'_, '_> {
    fn visit_function(&mut self, _: &Function<'b>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &oxc_ast::ast::ArrowFunctionExpression<'b>) {}
    fn visit_class(&mut self, _: &oxc_ast::ast::Class<'b>) {}

    fn visit_variable_declaration(&mut self, it: &oxc_ast::ast::VariableDeclaration<'b>) {
        if it.kind == VariableDeclarationKind::Const {
            for declarator in &it.declarations {
                if let (BindingPattern::ArrayPattern(pattern), Some(Expression::YieldExpression(y))) =
                    (&declarator.id, declarator.init.as_ref())
                {
                    self.receipts
                        .insert(y.span, !self.analysis.setter_plain(pattern));
                }
            }
        }
        walk::walk_variable_declaration(self, it);
    }

    fn visit_expression_statement(&mut self, it: &oxc_ast::ast::ExpressionStatement<'b>) {
        // `yield* raise(e);` → `throw e;`.
        if let Expression::YieldExpression(y) = &it.expression
            && y.delegate
            && let Some(Expression::CallExpression(call)) = y.argument.as_ref()
            && call.arguments.len() == 1
            && !matches!(call.arguments[0], Argument::SpreadElement(_))
            && self.analysis.names.is(self.analysis.scoping, call, "raise")
        {
            self.throws.push(it.span);
            self.admitted &= MEMO | EFFECT | EVENT;
            self.visit_argument(&call.arguments[0]);
            return;
        }
        walk::walk_expression_statement(self, it);
    }

    fn visit_yield_expression(&mut self, it: &oxc_ast::ast::YieldExpression<'b>) {
        let analysis = self.analysis;
        let scoping = analysis.scoping;
        let classified = match (it.delegate, it.argument.as_ref()) {
            (true, Some(Expression::Identifier(reference))) => {
                match reference_symbol(scoping, reference) {
                    Some(symbol) if analysis.contexts.contains(&symbol) => {
                        self.admitted &= SETUP;
                        Some(Yield::Context)
                    }
                    Some(symbol) if analysis.context.binding_origin(symbol) == Origin::Accessor => {
                        self.admitted &= READS;
                        Some(Yield::Accessor)
                    }
                    _ => None,
                }
            }
            (true, Some(Expression::CallExpression(call)))
                if !call
                    .arguments
                    .iter()
                    .any(|a| matches!(a, Argument::SpreadElement(_))) =>
            {
                let prebuilt = matches!(call.arguments.first(),
                    Some(Argument::CallExpression(block)) if analysis.names.is(scoping, block, "$"));
                match analysis.names.of(scoping, call) {
                    Some((name @ ("$signal" | "$store"), source)) => {
                        self.admitted &= SETUP;
                        Some(Yield::Create {
                            imported: if name == "$signal" {
                                "createSignal"
                            } else {
                                "createPlainStore"
                            },
                            source: source.to_string(),
                            receipts: self.receipts.get(&it.span).copied().unwrap_or(true),
                        })
                    }
                    Some((name @ ("$memo" | "$effect" | "$settled"), source)) if prebuilt => {
                        self.admitted &= SETUP;
                        Some(Yield::Create {
                            imported: match name {
                                "$memo" => "createMemo",
                                "$effect" => "effectBlock",
                                _ => "settledBlock",
                            },
                            source: source.to_string(),
                            receipts: false,
                        })
                    }
                    Some(("$cleanup", source)) if call.arguments.len() == 1 => {
                        self.admitted &= SETUP | EFFECT;
                        Some(Yield::Create {
                            imported: "blockCleanup",
                            source: source.to_string(),
                            receipts: false,
                        })
                    }
                    Some(_) => None,
                    None => match callee_symbol(scoping, call) {
                        Some(symbol) if analysis.candidates.contains_key(&symbol) => {
                            Some(Yield::Local(symbol))
                        }
                        Some(symbol) if analysis.imported.contains_key(&symbol) => {
                            self.admitted &= analysis.imported[&symbol].0.hosts;
                            Some(Yield::Imported(symbol))
                        }
                        _ => None,
                    },
                }
            }
            _ => None,
        };
        match classified {
            Some(y) => self.yields.push((it.span, y)),
            None => self.ok = false,
        }
        // Nested yields in the operand's arguments run first, in order.
        if let Some(Expression::CallExpression(call)) = it.argument.as_ref() {
            for argument in &call.arguments {
                self.visit_argument(argument);
            }
        }
    }
}

/// Analyze the module's helpers and plan their lowering.
pub(super) fn plan_helpers(
    program: &Program<'_>,
    v2: &V2Bodies,
    imports: &mut Imports,
    imported_facts: &[ImportedHelper],
    filename: Option<&str>,
) -> HelperPlan {
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(program)
        .semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let names = Names::new(program);
    let contexts = context_symbols(program, scoping, &names);
    let context = FusionContext {
        scoping,
        nodes,
        symbols: collect_fusion_symbols(program),
    };

    // Candidates: module-level generator declarations (exported or not).
    let mut list: Vec<Candidate> = Vec::new();
    for (index, statement) in program.body.iter().enumerate() {
        let (function, exported) = match statement {
            Statement::FunctionDeclaration(function) => (function, false),
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::FunctionDeclaration(function) => (function, true),
                _ => continue,
            },
            _ => continue,
        };
        if !function.generator || function.r#async || function.body.is_none() {
            continue;
        }
        let Some(id) = function.id.as_ref() else {
            continue;
        };
        let Some(symbol) = id.symbol_id.get() else {
            continue;
        };
        list.push(Candidate {
            symbol,
            name: id.name.to_string(),
            function: function.span,
            statement: index,
            exports: if exported {
                vec![id.name.to_string()]
            } else {
                Vec::new()
            },
            yields: None,
            throws: Vec::new(),
            own: 0,
            sites: Vec::new(),
        });
    }

    // Imported helpers the build summarized.
    let mut imported = HashMap::new();
    if !imported_facts.is_empty() {
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if import.import_kind == ImportOrExportKind::Type {
                continue;
            }
            let source = import.source.value.as_str();
            for specifier in import.specifiers.iter().flatten() {
                let ImportDeclarationSpecifier::ImportSpecifier(specifier) = specifier else {
                    continue;
                };
                if specifier.import_kind == ImportOrExportKind::Type {
                    continue;
                }
                let export = match &specifier.imported {
                    ModuleExportName::IdentifierName(name) => name.name.as_str(),
                    ModuleExportName::IdentifierReference(name) => name.name.as_str(),
                    ModuleExportName::StringLiteral(name) => name.value.as_str(),
                };
                if let Some(fact) = imported_facts.iter().find(|fact| {
                    fact.export == export && source_matches(&fact.source, source, filename)
                }) && let Some(symbol) = specifier.local.symbol_id.get()
                {
                    imported.insert(symbol, (fact.clone(), source.to_string()));
                }
            }
        }
    }
    if list.is_empty() && imported.is_empty() {
        return HelperPlan::default();
    }

    let mut analysis = Analysis {
        scoping,
        nodes,
        names: &names,
        context: &context,
        contexts: &contexts,
        v2,
        candidates: HashMap::new(),
        imported,
    };
    analysis.candidates = list
        .iter()
        .enumerate()
        .map(|(i, c)| (c.symbol, i))
        .collect();
    for statement in &program.body {
        let function = match statement {
            Statement::FunctionDeclaration(function) => function,
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::FunctionDeclaration(function) => function,
                _ => continue,
            },
            _ => continue,
        };
        let Some(&index) = function
            .id
            .as_ref()
            .and_then(|id| id.symbol_id.get())
            .and_then(|symbol| analysis.candidates.get(&symbol))
        else {
            continue;
        };
        let (yields, throws, own) = analysis.classify(function);
        let (sites, exports) = analysis.sites(list[index].symbol);
        let candidate = &mut list[index];
        candidate.yields = yields;
        candidate.throws = throws;
        candidate.own = own;
        candidate.sites = sites;
        candidate.exports.extend(exports);
    }

    // Admitted hosts: own ∩ callees', to a fixpoint (decreasing).
    let mut admitted: Vec<u8> = list
        .iter()
        .map(|c| if c.yields.is_some() { c.own } else { 0 })
        .collect();
    loop {
        let mut changed = false;
        for i in 0..list.len() {
            let Some(yields) = list[i].yields.as_ref() else {
                continue;
            };
            let mut bits = admitted[i];
            for (_, y) in yields {
                if let Yield::Local(callee) = y {
                    bits &= admitted[analysis.candidates[callee]];
                }
            }
            if bits != admitted[i] {
                admitted[i] = bits;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // Lowered helpers: in place (not exported, every reference a site that
    // lowers, every helper site in an in-place helper) or a twin (exported,
    // a site that lowers, or a lowered helper calling it). Fixpoints.
    let n = list.len();
    let mut in_place: Vec<bool> = (0..n)
        .map(|i| {
            admitted[i] != 0
                && list[i].exports.is_empty()
                && !list[i].sites.is_empty()
                && list[i].sites.iter().all(|site| match site {
                    Site::Perform { kind, .. } => admitted[i] & bit(*kind) != 0,
                    Site::Helper { .. } => true,
                    Site::Other => false,
                })
        })
        .collect();
    loop {
        let mut changed = false;
        for i in 0..n {
            if in_place[i]
                && list[i].sites.iter().any(|site| matches!(site,
                    Site::Helper { in_helper } if !in_place[analysis.candidates[in_helper]]))
            {
                in_place[i] = false;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let mut lowered_any: Vec<bool> = (0..n)
        .map(|i| {
            admitted[i] != 0
                && (in_place[i]
                    // (An exported generator with no operation at all is
                    // not a block helper: no twin.)
                    || (!list[i].exports.is_empty()
                        && list[i].yields.as_ref().is_some_and(|y| !y.is_empty()))
                    || list[i].sites.iter().any(|site| matches!(site,
                        Site::Perform { kind, .. } if admitted[i] & bit(*kind) != 0)))
        })
        .collect();
    loop {
        let mut changed = false;
        for i in 0..n {
            if lowered_any[i] {
                continue;
            }
            if admitted[i] != 0
                && list[i].sites.iter().any(|site| matches!(site,
                    Site::Helper { in_helper } if lowered_any[analysis.candidates[in_helper]]))
            {
                lowered_any[i] = true;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // Names: twins get `NAME$lowered` (suffixed when taken).
    let taken: HashSet<&str> = scoping.symbol_names().collect();
    let mut target: Vec<Option<String>> = vec![None; n];
    let mut plan = HelperPlan::default();
    for i in 0..n {
        if !lowered_any[i] || in_place[i] {
            continue;
        }
        let base = format!("{}$lowered", list[i].name);
        let mut name = base.clone();
        let mut k = 2;
        while taken.contains(name.as_str()) || target.iter().flatten().any(|t| *t == name) {
            name = format!("{base}{k}");
            k += 1;
        }
        target[i] = Some(name);
    }
    for i in 0..n {
        if !lowered_any[i] {
            continue;
        }
        if in_place[i] {
            plan.in_place.insert(list[i].function);
        } else {
            let twin = target[i].clone().expect("named above");
            plan.twins.push((
                list[i].statement,
                list[i].function,
                twin.clone(),
                !list[i].exports.is_empty(),
            ));
            for export in &list[i].exports {
                plan.exported.push(ExportedHelper {
                    name: export.clone(),
                    lowered: twin.clone(),
                    hosts: admitted[i],
                });
            }
        }
    }
    // Imported twins: the local each module import gets.
    let mut imported_locals: HashMap<SymbolId, String> = HashMap::new();
    let mut imported_local = |symbol: SymbolId, plan: &mut HelperPlan| -> String {
        if let Some(local) = imported_locals.get(&symbol) {
            return local.clone();
        }
        let (fact, source) = &analysis.imported[&symbol];
        let base = format!("_${}", fact.lowered);
        let mut local = base.clone();
        let mut k = 2;
        while taken.contains(local.as_str()) || plan.imports.iter().any(|(_, _, l)| *l == local)
        {
            local = format!("{base}{k}");
            k += 1;
        }
        plan.imports
            .push((source.clone(), fact.lowered.clone(), local.clone()));
        imported_locals.insert(symbol, local.clone());
        local
    };
    // Yields of lowered helpers.
    let source = contexts_source(program, &names, &contexts);
    for i in 0..n {
        if !lowered_any[i] {
            continue;
        }
        plan.throws.extend(list[i].throws.iter().copied());
        for (span, y) in list[i].yields.as_ref().expect("lowered: classified") {
            let rewrite = match y {
                Yield::Context => Rewrite::Wrap(imports.local(&source, "readContext")),
                Yield::Accessor => Rewrite::Wrap(imports.local(&source, "readAccessor")),
                Yield::Create {
                    imported,
                    source,
                    receipts,
                } => Rewrite::Callee(
                    imports.local(source, imported),
                    receipts.then(|| imports.local(source, "withReceipts")),
                ),
                Yield::Local(callee) => {
                    Rewrite::Call(target[analysis.candidates[callee]].clone())
                }
                Yield::Imported(callee) => Rewrite::Call(Some(imported_local(*callee, &mut plan))),
            };
            plan.yields.insert(*span, rewrite);
        }
    }
    // Perform sites that lower.
    for i in 0..n {
        if !lowered_any[i] {
            continue;
        }
        for site in &list[i].sites {
            if let Site::Perform { span, kind } = site
                && admitted[i] & bit(*kind) != 0
            {
                plan.performs.insert(*span, target[i].clone());
            }
        }
    }
    let imported_symbols: Vec<SymbolId> = analysis.imported.keys().copied().collect();
    for symbol in imported_symbols {
        let hosts = analysis.imported[&symbol].0.hosts;
        let (sites, _) = analysis.sites(symbol);
        for site in sites {
            if let Site::Perform { span, kind } = site
                && hosts & bit(kind) != 0
            {
                let local = imported_local(symbol, &mut plan);
                plan.performs.insert(span, Some(local));
            }
        }
    }
    plan
}

impl HelperPlan {
    pub(super) fn is_empty(&self) -> bool {
        self.in_place.is_empty()
            && self.twins.is_empty()
            && self.performs.is_empty()
            && self.yields.is_empty()
    }

    /// Apply the plan: twins first (cloned from the untouched generators),
    /// then in-place helpers, perform sites and imports.
    pub(super) fn apply<'a>(mut self, allocator: &'a Allocator, program: &mut Program<'a>) {
        let ast = AstBuilder::new(allocator);
        // Twins, inserted after their generator (from the last, so indices hold).
        let mut twins = std::mem::take(&mut self.twins);
        twins.sort_by_key(|(index, ..)| std::cmp::Reverse(*index));
        for (index, span, name, exported) in twins {
            let function = match &program.body[index] {
                Statement::FunctionDeclaration(function) => function,
                Statement::ExportDeclaration(export) => match &export.declaration {
                    Declaration::FunctionDeclaration(function) => function,
                    _ => continue,
                },
                _ => continue,
            };
            debug_assert_eq!(function.span, span);
            let mut twin = function.clone_in(allocator);
            if let Some(id) = twin.id.as_mut() {
                id.name = ast.ident(&name).into();
                id.symbol_id = std::cell::Cell::new(None);
            }
            self.lower_function(allocator, &mut twin);
            let statement = if exported {
                Statement::new_export_declaration(
                    Span::new(0, 0),
                    Declaration::FunctionDeclaration(twin),
                    &oxc_ast::builder::AstBuilder::new(allocator),
                )
            } else {
                Statement::FunctionDeclaration(twin)
            };
            program.body.insert(index + 1, statement);
        }
        // In-place helpers and perform sites.
        let mut rewriter = SiteRewriter {
            allocator,
            plan: &mut self,
        };
        rewriter.visit_program(program);
        // Imported twins.
        for (source, imported, local) in std::mem::take(&mut self.imports) {
            for statement in program.body.iter_mut() {
                let Statement::ImportDeclaration(import) = statement else {
                    continue;
                };
                if import.source.value.as_str() != source
                    || import.import_kind == ImportOrExportKind::Type
                {
                    continue;
                }
                let span = Span::new(0, 0);
                let specifier = ast.import_declaration_specifier_import_specifier(
                    span,
                    ast.module_export_name_identifier_name(span, ast.ident(&imported)),
                    ast.binding_identifier(span, ast.ident(&local)),
                    ImportOrExportKind::Value,
                );
                match import.specifiers.as_mut() {
                    Some(specifiers) => specifiers.push(specifier),
                    None => import.specifiers = Some(ast.vec1(specifier)),
                }
                break;
            }
        }
    }

    /// Make `function` (a helper, or its twin) the lowered helper.
    fn lower_function<'a>(&self, allocator: &'a Allocator, function: &mut Function<'a>) {
        function.generator = false;
        function.return_type = None;
        let mut rewriter = YieldRewriter {
            allocator,
            plan: self,
        };
        if let Some(body) = function.body.as_mut() {
            rewriter.visit_function_body(body);
        }
    }
}

struct SiteRewriter<'a, 'p> {
    allocator: &'a Allocator,
    plan: &'p mut HelperPlan,
}

impl<'a> VisitMut<'a> for SiteRewriter<'a, '_> {
    fn visit_function(&mut self, it: &mut Function<'a>, flags: ScopeFlags) {
        if it.generator && self.plan.in_place.remove(&it.span) {
            self.plan.lower_function(self.allocator, it);
            return;
        }
        walk_mut::walk_function(self, it, flags);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        if let Expression::CallExpression(call) = expression
            && let Some(target) = self.plan.performs.remove(&call.span)
        {
            // `_$perform(h(args))` → `h(args)` / `TARGET(args)`.
            let argument = call.arguments.pop().expect("planned: one argument");
            let mut inner = argument_to_expression(argument).expect("planned: a call");
            if let (Some(name), Expression::CallExpression(inner)) = (target, &mut inner) {
                let ast = AstBuilder::new(self.allocator);
                inner.callee = ast.expression_identifier(inner.callee.span(), ast.ident(&name));
            }
            *expression = inner;
        }
        walk_mut::walk_expression(self, expression);
    }
}

struct YieldRewriter<'a, 'p> {
    allocator: &'a Allocator,
    plan: &'p HelperPlan,
}

impl<'a> VisitMut<'a> for YieldRewriter<'a, '_> {
    fn visit_function(&mut self, _: &mut Function<'a>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(
        &mut self,
        _: &mut oxc_ast::ast::ArrowFunctionExpression<'a>,
    ) {
    }
    fn visit_class(&mut self, _: &mut oxc_ast::ast::Class<'a>) {}

    fn visit_statement(&mut self, statement: &mut Statement<'a>) {
        // `yield* raise(e);` → `throw e;`.
        let span = statement.span();
        if let Statement::ExpressionStatement(it) = statement
            && self.plan.throws.contains(&span)
            && let Expression::YieldExpression(y) = &mut it.expression
            && let Some(Expression::CallExpression(raise)) = y.argument.as_mut()
        {
            let error = raise.arguments.pop().expect("planned: one argument");
            let mut error = argument_to_expression(error).expect("planned: no spread");
            self.visit_expression(&mut error);
            *statement = Statement::new_throw_statement(
                span,
                error,
                &oxc_ast::builder::AstBuilder::new(self.allocator),
            );
            return;
        }
        walk_mut::walk_statement(self, statement);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let rewrite = match expression {
            Expression::YieldExpression(it) => self.plan.yields.get(&it.span).cloned(),
            _ => None,
        };
        if let Some(rewrite) = rewrite {
            let Expression::YieldExpression(it) = expression else {
                unreachable!("matched above");
            };
            let span = it.span;
            let mut operand = it.argument.take().expect("planned: `yield* X`");
            // The operand's own arguments first (nested yields).
            if let Expression::CallExpression(call) = &mut operand {
                for argument in call.arguments.iter_mut() {
                    self.visit_argument(argument);
                }
            }
            let ast = AstBuilder::new(self.allocator);
            let synth = Span::new(0, 0);
            *expression = match rewrite {
                Rewrite::Wrap(local) => ast.expression_call(
                    span,
                    ast.expression_identifier(synth, ast.ident(&local)),
                    None,
                    ast.vec1(expression_to_argument(operand)),
                    false,
                ),
                Rewrite::Callee(local, wrap) => {
                    if let Expression::CallExpression(call) = &mut operand {
                        call.callee = ast.expression_identifier(call.callee.span(), ast.ident(&local));
                    }
                    match wrap {
                        Some(wrap) => ast.expression_call(
                            span,
                            ast.expression_identifier(synth, ast.ident(&wrap)),
                            None,
                            ast.vec1(expression_to_argument(operand)),
                            false,
                        ),
                        None => operand,
                    }
                }
                Rewrite::Call(name) => {
                    if let (Some(name), Expression::CallExpression(call)) = (name, &mut operand) {
                        call.callee = ast.expression_identifier(call.callee.span(), ast.ident(&name));
                    }
                    operand
                }
            };
            return;
        }
        walk_mut::walk_expression(self, expression);
    }
}

/// Does the module declare a module-level helper generator (a module with
/// no v2 body may still export helpers, or call imported ones only from
/// such helpers)?
pub(crate) fn has_candidates(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| match statement {
        Statement::FunctionDeclaration(function) => function.generator && !function.r#async,
        Statement::ExportDeclaration(export) => matches!(&export.declaration,
            Declaration::FunctionDeclaration(function) if function.generator && !function.r#async),
        _ => false,
    })
}
