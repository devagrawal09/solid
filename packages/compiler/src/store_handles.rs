//! Store handles (experimental, `storeHandles`): Track B, slice 2, stage 2.
//!
//! Runs after `generators::transform_generators` (direct paths are already
//! lowered to `_$readPathK(root, …)` handle reads) and before JSX lowering.
//! Two things happen, both conservative — anything not proven is left
//! exactly as the stage-1 lowering emitted it:
//!
//! 1. **Handle stores.** A store created in this module as
//!    `const [s, set] = createStore({…} | […], options?)` whose value is read
//!    through lowered paths is created as a HANDLE instead
//!    (`_$createStoreHandle`): its path reads become `_$readHandleK(s, …)`
//!    (no Proxy [[Get]], no proxy ever created by a read), and EVERY other
//!    reference to `s` becomes `_$storeProxy(s)` — the lazy compatibility
//!    proxy, materialized at that escape (the same proxy each time). A
//!    store handed to a verified `Borrowed` prop of a compiled component
//!    stays a handle across that boundary (`<Row todo={s.rows[i]} />` →
//!    `_$readHandleChild(s, ["rows", i])`).
//! 2. **Borrowed props.** A component whose props parameter is annotated
//!    with `x: Borrowed<T>` (the typed escape contract) is VERIFIED when
//!    every use of `props.x` is a lowered path read or a forward to another
//!    verified `Borrowed` prop. Its reads become `_$readBorrowed(props,
//!    ["x", …])`, which walk a handle when a compiled caller passed one and
//!    anything else exactly as before — so uncompiled callers stay correct.
//!    A violated contract deoptimizes (ordinary readers, callers pass
//!    proxies) and is reported.
//!
//! Refusals (the store keeps `createStore` and the stage-1 readers): an
//! exported binding or an `export { s }`; a non-literal first argument
//! (`createStore(fn, seed)` is the derived form; an identifier could hold a
//! function); `let`/`var`; any pattern but `[s]` / `[s, set]`; a reference in
//! a position that cannot hold a call (`export { s }`, `<s.X />`, an
//! assignment target, a computed property key, …); a store with no lowered
//! read (nothing to gain).
//!
//! Cross-module: callers hand handles to IMPORTED components only when the
//! linker supplies the callee's verified contract (`storeLinkFacts`); without
//! it they pass the proxy. Every module emits a JSON store summary — the
//! contract Track C's linker consumes (see
//! documentation/plans/track-b-slice-2-proxy-free-stores.md).

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{
    Argument, ArrayExpressionElement, BindingPattern, CallExpression, Expression,
    ImportDeclarationSpecifier, ImportOrExportKind, JSXAttributeName, JSXElementName,
    ObjectProperty, Program, PropertyKey, Statement, TSSignature, TSType, TSTypeName,
    VariableDeclarationKind,
};
use oxc_ast_visit::{Visit, VisitMut, walk, walk_mut};
use oxc_semantic::{AstNodes, NodeId, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use crate::generators::{member_chain_keys, member_chain_root};
use crate::shared::ast::expression_to_argument;
use crate::shared::ast_builder::AstBuilder;

const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals"];

/// Linker facts: `(import source, exported component, verified Borrowed prop)`.
pub type LinkFact = (String, String, String);

/// Run the pass. Returns the module's store summary (JSON).
pub(crate) fn transform_store_handles<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &'a str,
    filename: Option<&str>,
    facts: &[LinkFact],
) -> Result<String, String> {
    if !mentions_store_contracts(program) {
        return Ok(format!(
            "{{\"version\":1,\"module\":{},\"stores\":[],\"components\":[],\"requires\":[]}}",
            {
                let mut name = String::new();
                json_string(&mut name, filename.unwrap_or(""));
                name
            }
        ));
    }
    let plan = {
        let semantic = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(program)
            .semantic;
        Analyzer::new(semantic.scoping(), semantic.nodes(), source, facts).analyze(program)
    };
    let summary = plan.summary(filename);
    if !plan.rewrites.is_empty() {
        let expected = plan.rewrites.len();
        let mut rewriter = Rewriter {
            allocator,
            plan,
            done: 0,
            hoisted: Vec::new(),
            hoisted_by_keys: HashMap::new(),
        };
        rewriter.visit_program(program);
        if rewriter.done != expected {
            return Err(format!(
                "[STORE_HANDLES_INTERNAL] planned {expected} rewrites, applied {}",
                rewriter.done
            ));
        }
    }
    Ok(summary)
}

/// Cheap syntactic gate: does the module import `createStore` or `Borrowed`
/// from a runtime source? Everything else has nothing for the pass to do.
fn mentions_store_contracts(program: &Program<'_>) -> bool {
    program.body.iter().any(|statement| {
        let Statement::ImportDeclaration(import) = statement else {
            return false;
        };
        RUNTIME_SOURCES.contains(&import.source.value.as_str())
            && import.specifiers.iter().flatten().any(|specifier| {
                matches!(
                    specifier,
                    ImportDeclarationSpecifier::ImportSpecifier(specifier)
                        if matches!(specifier.imported.name().as_str(), "createStore" | "Borrowed")
                )
            })
    })
}

// ---------------------------------------------------------------------------
// analysis

#[derive(Default)]
struct RuntimeImports {
    create_store: Vec<SymbolId>,
    /// `readPath1..4` (1..4) and `readPathN` (0).
    readers: HashMap<SymbolId, usize>,
    borrowed: Vec<SymbolId>,
    /// Declaration span of the first runtime value import (receives specifiers).
    import_span: Option<Span>,
}

/// Every import binding: local symbol → (source, imported name).
type ImportMap = HashMap<SymbolId, (String, String)>;

struct Component {
    name: String,
    symbol: SymbolId,
    exported: bool,
    props: Option<SymbolId>,
    /// Declared `Borrowed` props, in declaration order.
    declared: Vec<String>,
}

#[derive(Clone)]
struct Escape {
    kind: &'static str,
    loc: (usize, usize),
    detail: String,
}

struct StoreInfo {
    binding: String,
    loc: (usize, usize),
    symbol: SymbolId,
    refused: Option<String>,
    reads: usize,
    handoffs: Vec<(String, String, String)>, // (component, prop, via)
    escapes: Vec<Escape>,
    setter_used: bool,
    handle: bool,
    create_span: Span,
    read_calls: Vec<(Span, usize)>,
    escape_spans: Vec<Span>,
    child_handoffs: Vec<Span>,
}

struct BorrowedProp {
    component: usize,
    prop: String,
    reads: Vec<(Span, usize)>,
    violations: Vec<Escape>,
    /// Forwards to (component symbol or import, prop).
    forwards: Vec<(Target, String)>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Target {
    Local(SymbolId),
    Import(String, String),
}

/// What the rewriter does at a span.
#[derive(Clone)]
enum Rewrite {
    /// `createStore(…)` callee → `_$createStoreHandle`.
    CreateHandle,
    /// `_$readPathK(s, …)` → `_$readHandleK(s, …)`.
    ReadHandle(usize),
    /// `s` → `_$storeProxy(s)`.
    Escape,
    /// `s.a[b]` → `_$readHandleChild(s, ["a", b])`.
    Child,
    /// `_$readPathK(props, "x", …)` / `_$readPathN(props, [...])` →
    /// `_$readBorrowed(props, ["x", …])`.
    Borrowed(usize),
}

struct Plan {
    stores: Vec<StoreInfo>,
    components: Vec<Component>,
    borrowed: Vec<BorrowedProp>,
    verified: HashSet<(usize, String)>,
    requires: Vec<(String, String, String, &'static str)>,
    rewrites: HashMap<Span, Rewrite>,
    needed: Vec<&'static str>,
    import_span: Option<Span>,
    source: String,
}

struct Analyzer<'s, 'a> {
    scoping: &'s Scoping,
    nodes: &'s AstNodes<'a>,
    source: &'a str,
    facts: &'s [LinkFact],
    /// Byte offset of each line start (for summary locations).
    lines: Vec<usize>,
}

impl<'s, 'a> Analyzer<'s, 'a> {
    fn new(
        scoping: &'s Scoping,
        nodes: &'s AstNodes<'a>,
        source: &'a str,
        facts: &'s [LinkFact],
    ) -> Self {
        let mut lines = vec![0];
        lines.extend(source.match_indices('\n').map(|(i, _)| i + 1));
        Self {
            scoping,
            nodes,
            source,
            facts,
            lines,
        }
    }

    fn loc(&self, span: Span) -> (usize, usize) {
        let offset = (span.start as usize).min(self.source.len());
        let line = self.lines.partition_point(|&start| start <= offset);
        let start = self.lines[line - 1];
        let column = self.source[start..offset].chars().count() + 1;
        (line, column)
    }

    fn symbol_of_reference(
        &self,
        reference_id: Option<oxc_syntax::reference::ReferenceId>,
    ) -> Option<SymbolId> {
        reference_id.and_then(|id| self.scoping.get_reference(id).symbol_id())
    }

    fn callee_symbol(&self, call: &CallExpression<'_>) -> Option<SymbolId> {
        let Expression::Identifier(callee) = &call.callee else {
            return None;
        };
        self.symbol_of_reference(callee.reference_id.get())
    }

    fn parent(&self, id: NodeId) -> Option<NodeId> {
        let parent = self.nodes.parent_id(id);
        (parent != id).then_some(parent)
    }

    fn analyze(&self, program: &Program<'a>) -> Plan {
        let (runtime, imports) = self.collect_imports(program);
        let components = self.collect_components(program, &runtime);
        let mut plan = Plan {
            stores: Vec::new(),
            components,
            borrowed: Vec::new(),
            verified: HashSet::new(),
            requires: Vec::new(),
            rewrites: HashMap::new(),
            needed: Vec::new(),
            import_span: runtime.import_span,
            source: self.source.to_string(),
        };
        self.verify_borrowed(&mut plan, &runtime, &imports);
        self.analyze_stores(program, &mut plan, &runtime, &imports);
        plan
    }

    fn collect_imports(&self, program: &Program<'a>) -> (RuntimeImports, ImportMap) {
        let mut runtime = RuntimeImports::default();
        let mut imports = ImportMap::new();
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            let source = import.source.value.as_str();
            let is_runtime = RUNTIME_SOURCES.contains(&source);
            if is_runtime && import.import_kind == ImportOrExportKind::Value {
                runtime.import_span.get_or_insert(import.span);
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
                imports.insert(symbol, (source.to_string(), name.to_string()));
                if !is_runtime {
                    continue;
                }
                let type_only = import.import_kind == ImportOrExportKind::Type
                    || specifier.import_kind == ImportOrExportKind::Type;
                match name {
                    "Borrowed" => runtime.borrowed.push(symbol),
                    _ if type_only => {}
                    "createStore" => runtime.create_store.push(symbol),
                    "readPathN" => {
                        runtime.readers.insert(symbol, 0);
                    }
                    "readPath1" | "readPath2" | "readPath3" | "readPath4" => {
                        runtime
                            .readers
                            .insert(symbol, (name.as_bytes()[8] - b'0') as usize);
                    }
                    _ => {}
                }
            }
        }
        (runtime, imports)
    }

    // --- components and Borrowed contracts ---------------------------------

    fn collect_components(
        &self,
        program: &Program<'a>,
        runtime: &RuntimeImports,
    ) -> Vec<Component> {
        let mut components = Vec::new();
        for statement in &program.body {
            let (function, variables, exported) = match statement {
                Statement::ExportDeclaration(export) => match &export.declaration {
                    oxc_ast::ast::Declaration::FunctionDeclaration(f) => (Some(&**f), None, true),
                    oxc_ast::ast::Declaration::VariableDeclaration(v) => (None, Some(&**v), true),
                    _ => continue,
                },
                Statement::ExportDefaultDeclaration(export) => {
                    if let oxc_ast::ast::ExportDefaultDeclarationKind::FunctionDeclaration(f) =
                        &export.declaration
                    {
                        (Some(&**f), None, true)
                    } else {
                        continue;
                    }
                }
                Statement::FunctionDeclaration(f) => (Some(&**f), None, false),
                Statement::VariableDeclaration(v) => (None, Some(&**v), false),
                _ => continue,
            };
            if let Some(f) = function {
                if let Some(c) = self.function_component(f, exported, runtime) {
                    components.push(c);
                }
            }
            match variables {
                Some(declaration) => {
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
                            Some(Expression::ArrowFunctionExpression(arrow)) => &arrow.params,
                            Some(Expression::FunctionExpression(function)) => &function.params,
                            _ => continue,
                        };
                        let (props, declared) = self.props_contract(params, runtime);
                        components.push(Component {
                            name: id.name.to_string(),
                            symbol,
                            exported,
                            props,
                            declared,
                        });
                    }
                }
                None => {}
            }
        }
        components
    }

    fn function_component(
        &self,
        function: &oxc_ast::ast::Function<'a>,
        exported: bool,
        runtime: &RuntimeImports,
    ) -> Option<Component> {
        let id = function.id.as_ref()?;
        if !starts_uppercase(&id.name) {
            return None;
        }
        let (props, declared) = self.props_contract(&function.params, runtime);
        Some(Component {
            name: id.name.to_string(),
            symbol: id.symbol_id.get()?,
            exported,
            props,
            declared,
        })
    }

    /// The props binding and its declared `Borrowed` props.
    fn props_contract(
        &self,
        params: &oxc_ast::ast::FormalParameters<'a>,
        runtime: &RuntimeImports,
    ) -> (Option<SymbolId>, Vec<String>) {
        let Some(param) = params.items.first() else {
            return (None, Vec::new());
        };
        let BindingPattern::BindingIdentifier(id) = &param.pattern else {
            return (None, Vec::new());
        };
        let mut declared = Vec::new();
        if let Some(annotation) = &param.type_annotation {
            self.borrowed_members(&annotation.type_annotation, runtime, &mut declared, 0);
        }
        (id.symbol_id.get(), declared)
    }

    fn borrowed_members(
        &self,
        ty: &TSType<'a>,
        runtime: &RuntimeImports,
        out: &mut Vec<String>,
        depth: usize,
    ) {
        if depth > 4 {
            return;
        }
        match ty {
            TSType::TSTypeLiteral(literal) => {
                self.signature_members(&literal.members, runtime, out)
            }
            TSType::TSIntersectionType(intersection) => {
                for ty in &intersection.types {
                    self.borrowed_members(ty, runtime, out, depth + 1);
                }
            }
            TSType::TSParenthesizedType(inner) => {
                self.borrowed_members(&inner.type_annotation, runtime, out, depth + 1)
            }
            TSType::TSTypeReference(reference) => {
                // A same-module interface or object type alias.
                let TSTypeName::IdentifierReference(name) = &reference.type_name else {
                    return;
                };
                let Some(symbol) = self.symbol_of_reference(name.reference_id.get()) else {
                    return;
                };
                let declaration = self.scoping.symbol_declaration(symbol);
                match self.nodes.get_node(declaration).kind() {
                    AstKind::TSInterfaceDeclaration(interface) if interface.extends.is_empty() => {
                        self.signature_members(&interface.body.body, runtime, out)
                    }
                    AstKind::TSTypeAliasDeclaration(alias) => {
                        self.borrowed_members(&alias.type_annotation, runtime, out, depth + 1)
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    fn signature_members(
        &self,
        members: &[TSSignature<'a>],
        runtime: &RuntimeImports,
        out: &mut Vec<String>,
    ) {
        for member in members {
            let TSSignature::TSPropertySignature(signature) = member else {
                continue;
            };
            if signature.computed {
                continue;
            }
            let name = match &signature.key {
                PropertyKey::StaticIdentifier(id) => id.name.to_string(),
                PropertyKey::StringLiteral(literal) => literal.value.to_string(),
                _ => continue,
            };
            let Some(annotation) = &signature.type_annotation else {
                continue;
            };
            if self.is_borrowed(&annotation.type_annotation, runtime) {
                out.push(name);
            }
        }
    }

    fn is_borrowed(&self, ty: &TSType<'a>, runtime: &RuntimeImports) -> bool {
        let TSType::TSTypeReference(reference) = ty else {
            return false;
        };
        let TSTypeName::IdentifierReference(name) = &reference.type_name else {
            return false;
        };
        self.symbol_of_reference(name.reference_id.get())
            .is_some_and(|symbol| runtime.borrowed.contains(&symbol))
    }

    /// Verify every declared `Borrowed` prop (greatest fixed point over
    /// forwards between borrowed props).
    fn verify_borrowed(&self, plan: &mut Plan, runtime: &RuntimeImports, imports: &ImportMap) {
        for (index, component) in plan.components.iter().enumerate() {
            if component.declared.is_empty() {
                continue;
            }
            let Some(props) = component.props else {
                continue;
            };
            let mut entries: Vec<BorrowedProp> = component
                .declared
                .iter()
                .map(|prop| BorrowedProp {
                    component: index,
                    prop: prop.clone(),
                    reads: Vec::new(),
                    violations: Vec::new(),
                    forwards: Vec::new(),
                })
                .collect();
            let mut wholesale: Vec<Escape> = Vec::new();
            for reference in self.scoping.get_resolved_references(props) {
                if !reference.flags().is_value() {
                    continue;
                }
                let node = reference.node_id();
                let span = self.nodes.get_node(node).kind().span();
                let Some(parent) = self.parent(node) else {
                    continue;
                };
                match self.nodes.get_node(parent).kind() {
                    AstKind::CallExpression(call)
                        if call.arguments.first().is_some_and(|a| a.span() == span) =>
                    {
                        let reader = self
                            .callee_symbol(call)
                            .and_then(|symbol| runtime.readers.get(&symbol).copied());
                        match (reader, first_key(call, reader)) {
                            (Some(reader), Some(key)) => {
                                if let Some(entry) = entries.iter_mut().find(|e| e.prop == key) {
                                    entry.reads.push((call.span, reader));
                                }
                            }
                            (Some(_), None) => wholesale.push(Escape {
                                kind: "dynamic-prop-read",
                                loc: self.loc(span),
                                detail: String::new(),
                            }),
                            (None, _) => wholesale.push(Escape {
                                kind: "call-arg",
                                loc: self.loc(span),
                                detail: callee_text(call, self.source),
                            }),
                        }
                    }
                    AstKind::StaticMemberExpression(member) if member.object.span() == span => {
                        let key = member.property.name.to_string();
                        self.prop_member_use(
                            parent,
                            &key,
                            &mut entries,
                            runtime,
                            imports,
                            &plan.components,
                        );
                    }
                    AstKind::ComputedMemberExpression(member)
                        if member.object.span() == span
                            && matches!(member.expression, Expression::StringLiteral(_)) =>
                    {
                        let Expression::StringLiteral(key) = &member.expression else {
                            unreachable!()
                        };
                        let key = key.value.to_string();
                        self.prop_member_use(
                            parent,
                            &key,
                            &mut entries,
                            runtime,
                            imports,
                            &plan.components,
                        );
                    }
                    kind => wholesale.push(Escape {
                        kind: "props-escape",
                        loc: self.loc(span),
                        detail: kind_name(&kind).to_string(),
                    }),
                }
            }
            for entry in &mut entries {
                entry.violations.extend(wholesale.iter().cloned());
            }
            plan.borrowed.extend(entries);
        }
        // Greatest fixed point: a borrowed prop is verified when it has no
        // violation and every forward lands on a verified prop (or on an
        // imported component the linker vouched for).
        let mut verified: HashSet<(usize, String)> = plan
            .borrowed
            .iter()
            .filter(|b| b.violations.is_empty())
            .map(|b| (b.component, b.prop.clone()))
            .collect();
        loop {
            let mut changed = false;
            for b in &plan.borrowed {
                let key = (b.component, b.prop.clone());
                if !verified.contains(&key) {
                    continue;
                }
                let ok = b.forwards.iter().all(|(target, prop)| match target {
                    Target::Local(symbol) => plan
                        .components
                        .iter()
                        .position(|c| c.symbol == *symbol)
                        .is_some_and(|i| verified.contains(&(i, prop.clone()))),
                    Target::Import(source, name) => self.linked(source, name, prop),
                });
                if !ok {
                    verified.remove(&key);
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        for b in &mut plan.borrowed {
            if !verified.contains(&(b.component, b.prop.clone())) && b.violations.is_empty() {
                b.violations.push(Escape {
                    kind: "forward-to-unverified",
                    loc: (0, 0),
                    detail: String::new(),
                });
            }
        }
        let reads: Vec<(Span, usize)> = plan
            .borrowed
            .iter()
            .filter(|b| verified.contains(&(b.component, b.prop.clone())))
            .flat_map(|b| b.reads.iter().copied())
            .collect();
        for &(span, reader) in &reads {
            plan.rewrites.insert(span, Rewrite::Borrowed(reader));
        }
        if !reads.is_empty() {
            plan.need("readBorrowed");
        }
        plan.verified = verified;
    }

    /// `props.key` outside a lowered read: a forward in a JSX attribute to a
    /// borrowed prop, or a violation of `key`'s contract.
    fn prop_member_use(
        &self,
        member_node: NodeId,
        key: &str,
        entries: &mut [BorrowedProp],
        runtime: &RuntimeImports,
        imports: &ImportMap,
        components: &[Component],
    ) {
        let Some(entry) = entries.iter_mut().find(|e| e.prop == key) else {
            return;
        };
        let span = self.nodes.get_node(member_node).kind().span();
        if let Some((target, prop)) =
            self.jsx_attribute_target(member_node, span, runtime, imports, components)
        {
            entry.forwards.push((target, prop));
            return;
        }
        entry.violations.push(Escape {
            kind: "prop-escape",
            loc: self.loc(span),
            detail: self
                .parent(member_node)
                .map(|p| kind_name(&self.nodes.get_node(p).kind()).to_string())
                .unwrap_or_default(),
        });
    }

    /// When the expression at `node` is the whole value of a JSX attribute of
    /// a component element, the component and the attribute name.
    fn jsx_attribute_target(
        &self,
        node: NodeId,
        span: Span,
        _runtime: &RuntimeImports,
        imports: &ImportMap,
        components: &[Component],
    ) -> Option<(Target, String)> {
        let container = self.parent(node)?;
        let AstKind::JSXExpressionContainer(c) = self.nodes.get_node(container).kind() else {
            return None;
        };
        if c.expression.span() != span {
            return None;
        }
        let attribute = self.parent(container)?;
        let AstKind::JSXAttribute(attribute) = self.nodes.get_node(attribute).kind() else {
            return None;
        };
        let JSXAttributeName::Identifier(name) = &attribute.name else {
            return None;
        };
        let opening = self.parent(self.parent(container)?)?;
        let AstKind::JSXOpeningElement(element) = self.nodes.get_node(opening).kind() else {
            return None;
        };
        let JSXElementName::IdentifierReference(tag) = &element.name else {
            return None;
        };
        let symbol = self.symbol_of_reference(tag.reference_id.get())?;
        let target = if components.iter().any(|c| c.symbol == symbol) {
            Target::Local(symbol)
        } else if let Some((source, imported)) = imports.get(&symbol) {
            Target::Import(source.clone(), imported.clone())
        } else {
            return None;
        };
        Some((target, name.name.to_string()))
    }

    fn linked(&self, source: &str, export: &str, prop: &str) -> bool {
        self.facts
            .iter()
            .any(|(s, e, p)| s == source && e == export && p == prop)
    }

    // --- stores ---------------------------------------------------------------

    fn analyze_stores(
        &self,
        program: &Program<'a>,
        plan: &mut Plan,
        runtime: &RuntimeImports,
        imports: &ImportMap,
    ) {
        if runtime.create_store.is_empty() {
            return;
        }
        struct Finder<'x, 'y, 'a> {
            analyzer: &'x Analyzer<'y, 'a>,
            runtime: &'x RuntimeImports,
            found: Vec<StoreInfo>,
        }
        impl<'b> Visit<'b> for Finder<'_, '_, '_> {
            fn visit_variable_declaration(&mut self, it: &oxc_ast::ast::VariableDeclaration<'b>) {
                for declarator in &it.declarations {
                    let Some(Expression::CallExpression(call)) = &declarator.init else {
                        continue;
                    };
                    let Some(callee) = self.analyzer.callee_symbol(call) else {
                        continue;
                    };
                    if !self.runtime.create_store.contains(&callee) {
                        continue;
                    }
                    let BindingPattern::ArrayPattern(pattern) = &declarator.id else {
                        continue;
                    };
                    let Some(Some(BindingPattern::BindingIdentifier(id))) =
                        pattern.elements.first()
                    else {
                        continue;
                    };
                    let Some(symbol) = id.symbol_id.get() else {
                        continue;
                    };
                    let mut refused = None;
                    if it.kind != VariableDeclarationKind::Const {
                        refused = Some("not-const".to_string());
                    } else if pattern.rest.is_some()
                        || pattern.elements.len() > 2
                        || pattern.elements.get(1).is_some_and(|e| {
                            !matches!(e, Some(BindingPattern::BindingIdentifier(_)) | None)
                        })
                    {
                        refused = Some("pattern".to_string());
                    } else if !matches!(
                        call.arguments.first(),
                        Some(Argument::ObjectExpression(_) | Argument::ArrayExpression(_))
                    ) {
                        refused = Some(
                            if matches!(
                                call.arguments.first(),
                                Some(
                                    Argument::ArrowFunctionExpression(_)
                                        | Argument::FunctionExpression(_)
                                )
                            ) {
                                "derived-form".to_string()
                            } else {
                                "non-literal-initial".to_string()
                            },
                        );
                    } else if call.arguments.len() > 2
                        || call
                            .arguments
                            .iter()
                            .any(|a| matches!(a, Argument::SpreadElement(_)))
                    {
                        refused = Some("arguments".to_string());
                    } else if self.analyzer.is_exported_declaration(it) {
                        refused = Some("exported".to_string());
                    }
                    let setter_used = match pattern.elements.get(1) {
                        Some(Some(BindingPattern::BindingIdentifier(set))) => {
                            set.symbol_id.get().is_some_and(|s| {
                                self.analyzer
                                    .scoping
                                    .get_resolved_references(s)
                                    .next()
                                    .is_some()
                            })
                        }
                        _ => false,
                    };
                    self.found.push(StoreInfo {
                        binding: id.name.to_string(),
                        loc: self.analyzer.loc(id.span),
                        symbol,
                        refused,
                        reads: 0,
                        handoffs: Vec::new(),
                        escapes: Vec::new(),
                        setter_used,
                        handle: false,
                        create_span: call.callee.span(),
                        read_calls: Vec::new(),
                        escape_spans: Vec::new(),
                        child_handoffs: Vec::new(),
                    });
                }
                walk::walk_variable_declaration(self, it);
            }
        }
        let mut finder = Finder {
            analyzer: self,
            runtime,
            found: Vec::new(),
        };
        finder.visit_program(program);
        let mut stores = finder.found;
        for store in &mut stores {
            if store.refused.is_none() {
                self.classify_store(store, plan, runtime, imports);
            }
            store.handle = store.refused.is_none() && (store.reads + store.handoffs.len()) > 0;
            if store.refused.is_none() && !store.handle {
                store.refused = Some("no-lowered-reads".to_string());
            }
            if store.handle {
                plan.rewrites
                    .insert(store.create_span, Rewrite::CreateHandle);
                plan.need("createStoreHandle");
                for &(span, reader) in &store.read_calls {
                    plan.rewrites.insert(span, Rewrite::ReadHandle(reader));
                    plan.need(HANDLE_READERS[reader]);
                }
                for &span in &store.escape_spans {
                    plan.rewrites.insert(span, Rewrite::Escape);
                    plan.need("storeProxy");
                }
                for &span in &store.child_handoffs {
                    plan.rewrites.insert(span, Rewrite::Child);
                    plan.need("readHandleChild");
                }
            }
        }
        plan.stores = stores;
    }

    fn is_exported_declaration(&self, declaration: &oxc_ast::ast::VariableDeclaration<'_>) -> bool {
        let node = declaration.node_id.get();
        self.parent(node).is_some_and(|parent| {
            matches!(
                self.nodes.get_node(parent).kind(),
                AstKind::ExportDeclaration(_)
            )
        })
    }

    fn classify_store(
        &self,
        store: &mut StoreInfo,
        plan: &mut Plan,
        runtime: &RuntimeImports,
        imports: &ImportMap,
    ) {
        for reference in self.scoping.get_resolved_references(store.symbol) {
            if !reference.flags().is_value() {
                continue;
            }
            let node = reference.node_id();
            let span = self.nodes.get_node(node).kind().span();
            let Some(parent) = self.parent(node) else {
                continue;
            };
            let parent_kind = self.nodes.get_node(parent).kind();
            // A lowered path read rooted at the store.
            if let AstKind::CallExpression(call) = &parent_kind
                && call.arguments.first().is_some_and(|a| a.span() == span)
                && let Some(&reader) = self
                    .callee_symbol(call)
                    .and_then(|symbol| runtime.readers.get(&symbol))
            {
                store.reads += 1;
                store.read_calls.push((call.span, reader));
                continue;
            }
            // Handed to a borrowed prop, whole or as a member chain.
            if let Some((top, top_span)) = self.chain_top(node, span) {
                if let Some((target, prop)) =
                    self.jsx_attribute_target(top, top_span, runtime, imports, &plan.components)
                {
                    let via = match &target {
                        Target::Local(symbol) => {
                            let index = plan.components.iter().position(|c| c.symbol == *symbol);
                            index
                                .filter(|i| plan.verified.contains(&(*i, prop.clone())))
                                .map(|i| (plan.components[i].name.clone(), "local".to_string()))
                        }
                        Target::Import(source, name) => {
                            let linked = self.linked(source, name, &prop);
                            plan.requires.push((
                                source.clone(),
                                name.clone(),
                                prop.clone(),
                                if linked { "linked" } else { "unknown" },
                            ));
                            linked.then(|| (name.clone(), format!("import:{source}")))
                        }
                    };
                    if let Some((component, via)) = via {
                        store.handoffs.push((component, prop, via));
                        if top_span != span {
                            store.child_handoffs.push(top_span);
                        }
                        continue;
                    }
                }
            }
            // Anything else is an escape: wrapped in `_$storeProxy(s)` where
            // the position holds an expression, else the store is refused.
            match escape_kind(&parent_kind, span) {
                Some(kind) => {
                    store.escapes.push(Escape {
                        kind,
                        loc: self.loc(span),
                        detail: match &parent_kind {
                            AstKind::CallExpression(call) => callee_text(call, self.source),
                            _ => String::new(),
                        },
                    });
                    store.escape_spans.push(span);
                }
                None => {
                    store.refused = Some(format!(
                        "unsupported-reference:{}@{}:{}",
                        kind_name(&parent_kind),
                        self.loc(span).0,
                        self.loc(span).1
                    ));
                    return;
                }
            }
        }
    }

    /// The top of a lowerable member chain rooted at the identifier at
    /// `node` (the identifier itself when it is not a member object), with
    /// its span; None when the chain has unsupported links.
    fn chain_top(&self, node: NodeId, span: Span) -> Option<(NodeId, Span)> {
        let mut current = node;
        let mut current_span = span;
        loop {
            let parent = self.parent(current)?;
            match self.nodes.get_node(parent).kind() {
                AstKind::StaticMemberExpression(member)
                    if member.object.span() == current_span && !member.optional =>
                {
                    current = parent;
                    current_span = member.span;
                }
                AstKind::ComputedMemberExpression(member)
                    if member.object.span() == current_span && !member.optional =>
                {
                    if !matches!(
                        member.expression,
                        Expression::StringLiteral(_)
                            | Expression::NumericLiteral(_)
                            | Expression::Identifier(_)
                    ) {
                        return None;
                    }
                    current = parent;
                    current_span = member.span;
                }
                _ => return Some((current, current_span)),
            }
        }
    }
}

const HANDLE_READERS: [&str; 5] = [
    "readHandleN",
    "readHandle1",
    "readHandle2",
    "readHandle3",
    "readHandle4",
];

impl Plan {
    fn need(&mut self, name: &'static str) {
        if !self.needed.contains(&name) {
            self.needed.push(name);
        }
    }

    fn summary(&self, filename: Option<&str>) -> String {
        let mut out = String::from("{\"version\":1,\"module\":");
        json_string(&mut out, filename.unwrap_or(""));
        out.push_str(",\"stores\":[");
        for (i, store) in self.stores.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"binding\":");
            json_string(&mut out, &store.binding);
            out.push_str(&format!(
                ",\"loc\":\"{}:{}\",\"handle\":{},\"refused\":",
                store.loc.0, store.loc.1, store.handle
            ));
            match &store.refused {
                Some(reason) => json_string(&mut out, reason),
                None => out.push_str("null"),
            }
            out.push_str(&format!(
                ",\"reads\":{},\"setter\":{},\"proxyFree\":{},\"handoffs\":[",
                store.reads,
                store.setter_used,
                store.handle && store.escapes.is_empty() && !store.setter_used
            ));
            for (j, (component, prop, via)) in store.handoffs.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                out.push_str("{\"component\":");
                json_string(&mut out, component);
                out.push_str(",\"prop\":");
                json_string(&mut out, prop);
                out.push_str(",\"via\":");
                json_string(&mut out, via);
                out.push('}');
            }
            out.push_str("],\"escapes\":");
            escapes_json(&mut out, &store.escapes);
            out.push('}');
        }
        out.push_str("],\"components\":[");
        let mut first = true;
        for (index, component) in self.components.iter().enumerate() {
            if component.declared.is_empty() {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str("{\"name\":");
            json_string(&mut out, &component.name);
            out.push_str(&format!(
                ",\"exported\":{},\"borrowed\":[",
                component.exported
            ));
            let mut first_prop = true;
            for b in self.borrowed.iter().filter(|b| b.component == index) {
                if !first_prop {
                    out.push(',');
                }
                first_prop = false;
                out.push_str("{\"prop\":");
                json_string(&mut out, &b.prop);
                out.push_str(&format!(
                    ",\"verified\":{},\"reads\":{},\"violations\":",
                    self.verified.contains(&(index, b.prop.clone())),
                    b.reads.len()
                ));
                escapes_json(&mut out, &b.violations);
                out.push('}');
            }
            out.push_str("]}");
        }
        out.push_str("],\"requires\":[");
        for (i, (source, export, prop, status)) in self.requires.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str("{\"source\":");
            json_string(&mut out, source);
            out.push_str(",\"export\":");
            json_string(&mut out, export);
            out.push_str(",\"prop\":");
            json_string(&mut out, prop);
            out.push_str(&format!(",\"status\":\"{status}\"}}"));
        }
        out.push_str("]}");
        let _ = &self.source;
        out
    }
}

fn escapes_json(out: &mut String, escapes: &[Escape]) {
    out.push('[');
    for (i, escape) in escapes.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"kind\":");
        json_string(out, escape.kind);
        out.push_str(&format!(
            ",\"loc\":\"{}:{}\",\"detail\":",
            escape.loc.0, escape.loc.1
        ));
        json_string(out, &escape.detail);
        out.push('}');
    }
    out.push(']');
}

fn json_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
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

/// The first key of a lowered read (`readPathK(root, "x", …)` /
/// `readPathN(root, ["x", …])`) when it is a string literal.
fn first_key(call: &CallExpression<'_>, reader: Option<usize>) -> Option<String> {
    match (reader?, call.arguments.get(1)?) {
        (0, Argument::ArrayExpression(array)) => match array.elements.first()? {
            ArrayExpressionElement::StringLiteral(s) => Some(s.value.to_string()),
            _ => None,
        },
        (_, Argument::StringLiteral(s)) => Some(s.value.to_string()),
        _ => None,
    }
}

fn callee_text(call: &CallExpression<'_>, source: &str) -> String {
    let span = call.callee.span();
    source
        .get(span.start as usize..span.end as usize)
        .unwrap_or("")
        .chars()
        .take(60)
        .collect()
}

/// The escape kind of an identifier whose parent is `parent`, when the
/// position holds an Expression the rewriter can wrap; None otherwise.
fn escape_kind(parent: &AstKind<'_>, span: Span) -> Option<&'static str> {
    Some(match parent {
        AstKind::CallExpression(call) => {
            if call.callee.span() == span {
                "callee"
            } else {
                "call-arg"
            }
        }
        AstKind::NewExpression(_) => "new-arg",
        AstKind::StaticMemberExpression(m) if m.object.span() == span => "member",
        AstKind::ComputedMemberExpression(m) if m.object.span() == span => "member",
        AstKind::ComputedMemberExpression(_) => "computed-key",
        AstKind::ArrayExpression(_) => "array",
        AstKind::ObjectProperty(p) if p.value.span() == span && !p.computed => "object-value",
        AstKind::SpreadElement(_) => "spread",
        AstKind::JSXSpreadAttribute(_) => "jsx-spread",
        AstKind::JSXExpressionContainer(_) => "jsx",
        AstKind::ReturnStatement(_) => "return",
        AstKind::VariableDeclarator(d) if d.init.as_ref().is_some_and(|i| i.span() == span) => {
            "alias"
        }
        AstKind::AssignmentExpression(a) if a.right.span() == span => "assignment",
        AstKind::BinaryExpression(_) => "binary",
        AstKind::LogicalExpression(_) => "logical",
        AstKind::ConditionalExpression(_) => "conditional",
        AstKind::UnaryExpression(u)
            if u.operator != oxc_syntax::operator::UnaryOperator::Delete =>
        {
            "unary"
        }
        AstKind::SequenceExpression(_) => "sequence",
        AstKind::ParenthesizedExpression(_) => "parenthesized",
        AstKind::AwaitExpression(_) => "await",
        AstKind::TemplateLiteral(_) => "template",
        AstKind::ExpressionStatement(_) => "statement",
        AstKind::ForOfStatement(f) if f.right.span() == span => "for-of",
        AstKind::ForInStatement(f) if f.right.span() == span => "for-in",
        AstKind::TSAsExpression(_) => "ts-as",
        AstKind::TSSatisfiesExpression(_) => "ts-satisfies",
        AstKind::TSNonNullExpression(_) => "ts-non-null",
        _ => return None,
    })
}

fn kind_name(kind: &AstKind<'_>) -> &'static str {
    match kind {
        AstKind::CallExpression(_) => "CallExpression",
        AstKind::StaticMemberExpression(_) => "StaticMemberExpression",
        AstKind::ComputedMemberExpression(_) => "ComputedMemberExpression",
        AstKind::ExportSpecifier(_) => "ExportSpecifier",
        AstKind::ExportDefaultDeclaration(_) => "ExportDefaultDeclaration",
        AstKind::JSXMemberExpression(_) => "JSXMemberExpression",
        AstKind::JSXOpeningElement(_) => "JSXOpeningElement",
        AstKind::AssignmentExpression(_) => "AssignmentExpression",
        AstKind::UpdateExpression(_) => "UpdateExpression",
        AstKind::ObjectProperty(_) => "ObjectProperty",
        AstKind::SpreadElement(_) => "SpreadElement",
        AstKind::JSXSpreadAttribute(_) => "JSXSpreadAttribute",
        AstKind::JSXExpressionContainer(_) => "JSXExpressionContainer",
        AstKind::VariableDeclarator(_) => "VariableDeclarator",
        AstKind::ArrayExpression(_) => "ArrayExpression",
        AstKind::ReturnStatement(_) => "ReturnStatement",
        AstKind::ForInStatement(_) => "ForInStatement",
        AstKind::ForOfStatement(_) => "ForOfStatement",
        AstKind::TSTypeQuery(_) => "TSTypeQuery",
        _ => "other",
    }
}

fn starts_uppercase(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

// ---------------------------------------------------------------------------
// rewriting

struct Rewriter<'a> {
    allocator: &'a Allocator,
    plan: Plan,
    done: usize,
    /// All-literal key arrays hoisted to module constants (a read allocates
    /// nothing): `(local name, array)`, one constant per distinct key list.
    hoisted: Vec<(String, Expression<'a>)>,
    hoisted_by_keys: HashMap<String, String>,
}

impl<'a> Rewriter<'a> {
    /// An all-literal key array becomes a module constant; any other stays inline.
    fn hoist(&mut self, array: Expression<'a>) -> Expression<'a> {
        let Expression::ArrayExpression(elements) = &array else {
            return array;
        };
        if !elements.elements.iter().all(|e| {
            matches!(
                e,
                ArrayExpressionElement::StringLiteral(_)
                    | ArrayExpressionElement::NumericLiteral(_)
            )
        }) {
            return array;
        }
        // Identical key lists share one constant.
        let signature: String = elements
            .elements
            .iter()
            .map(|e| match e {
                ArrayExpressionElement::StringLiteral(s) => format!("s{}\u{0}", s.value),
                ArrayExpressionElement::NumericLiteral(n) => format!("n{}\u{0}", n.value),
                _ => unreachable!(),
            })
            .collect();
        let ast = AstBuilder::new(self.allocator);
        if let Some(name) = self.hoisted_by_keys.get(&signature) {
            return ast.expression_identifier(Span::new(0, 0), ast.ident(name));
        }
        let name = format!("_$keys{}", self.hoisted.len() + 1);
        self.hoisted.push((name.clone(), array));
        self.hoisted_by_keys.insert(signature, name.clone());
        ast.expression_identifier(Span::new(0, 0), ast.ident(&name))
    }

    fn call(
        &self,
        name: &str,
        span: Span,
        args: oxc_allocator::Vec<'a, Argument<'a>>,
    ) -> Expression<'a> {
        let ast = AstBuilder::new(self.allocator);
        ast.expression_call(
            span,
            ast.expression_identifier(Span::new(0, 0), ast.ident(&format!("_${name}"))),
            None,
            args,
            false,
        )
    }
}

impl<'a> VisitMut<'a> for Rewriter<'a> {
    fn visit_program(&mut self, program: &mut Program<'a>) {
        walk_mut::walk_program(self, program);
        let ast = AstBuilder::new(self.allocator);
        if !self.hoisted.is_empty() {
            // `const _$keys1 = ["todo", "title"];` after the imports.
            let at = program
                .body
                .iter()
                .rposition(|statement| matches!(statement, Statement::ImportDeclaration(_)))
                .map_or(0, |index| index + 1);
            let synth = Span::new(0, 0);
            for (offset, (name, array)) in self.hoisted.drain(..).enumerate() {
                let declarator = ast.variable_declarator(
                    synth,
                    VariableDeclarationKind::Const,
                    ast.binding_pattern_binding_identifier(synth, ast.ident(&name)),
                    None,
                    Some(array),
                    false,
                );
                let declaration = ast.alloc_variable_declaration(
                    synth,
                    VariableDeclarationKind::Const,
                    ast.vec1(declarator),
                    false,
                );
                program
                    .body
                    .insert(at + offset, Statement::VariableDeclaration(declaration));
            }
        }
        let Some(import_span) = self.plan.import_span else {
            return;
        };
        for statement in program.body.iter_mut() {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if import.span != import_span {
                continue;
            }
            let span = Span::new(0, 0);
            for name in &self.plan.needed {
                let local = format!("_${name}");
                let specifier = ast.import_declaration_specifier_import_specifier(
                    span,
                    ast.module_export_name_identifier_name(span, ast.ident(name)),
                    ast.binding_identifier(span, ast.ident(&local)),
                    ImportOrExportKind::Value,
                );
                match import.specifiers.as_mut() {
                    Some(specifiers) => specifiers.push(specifier),
                    None => import.specifiers = Some(ast.vec1(specifier)),
                }
            }
            return;
        }
    }

    fn visit_object_property(&mut self, it: &mut ObjectProperty<'a>) {
        // `{ s }` → `{ s: _$storeProxy(s) }`: the value is rewritten below.
        if it.shorthand
            && matches!(
                self.plan.rewrites.get(&it.value.span()),
                Some(Rewrite::Escape)
            )
        {
            it.shorthand = false;
        }
        walk_mut::walk_object_property(self, it);
    }

    fn visit_expression(&mut self, expression: &mut Expression<'a>) {
        let span = expression.span();
        let rewrite = match expression {
            Expression::Identifier(_)
            | Expression::StaticMemberExpression(_)
            | Expression::ComputedMemberExpression(_)
            | Expression::CallExpression(_) => self.plan.rewrites.get(&span).cloned(),
            _ => None,
        };
        let ast = AstBuilder::new(self.allocator);
        match (rewrite, &mut *expression) {
            (Some(Rewrite::CreateHandle), Expression::Identifier(id)) => {
                id.name = ast.ident("_$createStoreHandle");
                self.done += 1;
            }
            (Some(Rewrite::Escape), Expression::Identifier(_)) => {
                let placeholder = ast.expression_null_literal(Span::new(0, 0));
                let identifier = std::mem::replace(expression, placeholder);
                *expression = self.call(
                    "storeProxy",
                    span,
                    ast.vec1(expression_to_argument(identifier)),
                );
                self.done += 1;
                return;
            }
            (Some(Rewrite::ReadHandle(reader)), Expression::CallExpression(call)) => {
                if let Expression::Identifier(callee) = &mut call.callee {
                    callee.name = ast.ident(&format!("_${}", HANDLE_READERS[reader]));
                    self.done += 1;
                }
            }
            (Some(Rewrite::Borrowed(reader)), Expression::CallExpression(call)) => {
                if let Expression::Identifier(callee) = &mut call.callee {
                    callee.name = ast.ident("_$readBorrowed");
                }
                if reader != 0 {
                    // `(props, "x", k1, …)` → `(props, ["x", k1, …])`.
                    let mut args = std::mem::replace(&mut call.arguments, ast.vec());
                    let keys: Vec<Argument<'a>> = args.drain(1..).collect();
                    let elements = ast.vec_from_iter(keys.into_iter().map(|key| {
                        let expression = crate::shared::ast::argument_to_expression(key)
                            .expect("lowered keys are expressions");
                        ArrayExpressionElement::from(expression)
                    }));
                    let array = ast.expression_array(Span::new(0, 0), elements);
                    args.push(expression_to_argument(self.hoist(array)));
                    call.arguments = args;
                }
                self.done += 1;
            }
            (Some(Rewrite::Child), _) => {
                let root = member_chain_root(expression).map(|r| r.name);
                let keys = member_chain_keys(expression, &self.plan.source);
                if let Some(root) = root {
                    let synth = Span::new(0, 0);
                    let elements = ast.vec_from_iter(keys.iter().map(|key| {
                        let expression = if let Some(text) =
                            key.strip_prefix('"').and_then(|k| k.strip_suffix('"'))
                        {
                            ast.expression_string_literal(synth, ast.str(text), None)
                        } else if let Ok(number) = key.parse::<f64>() {
                            ast.expression_numeric_literal(
                                synth,
                                number,
                                Some(ast.str(key)),
                                oxc_syntax::number::NumberBase::Decimal,
                            )
                        } else if key.starts_with('\'') {
                            ast.expression_string_literal(
                                synth,
                                ast.str(&key[1..key.len() - 1]),
                                None,
                            )
                        } else {
                            ast.expression_identifier(synth, ast.ident(key))
                        };
                        ArrayExpressionElement::from(expression)
                    }));
                    let mut args = ast.vec1(expression_to_argument(
                        ast.expression_identifier(synth, root),
                    ));
                    let array = ast.expression_array(synth, elements);
                    args.push(expression_to_argument(self.hoist(array)));
                    *expression = self.call("readHandleChild", span, args);
                    self.done += 1;
                    return;
                }
            }
            _ => {}
        }
        walk_mut::walk_expression(self, expression);
    }
}
