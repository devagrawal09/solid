//! The block model the island compiler reads: every `$component` (and plain
//! view-only function component) of a module, with its setup split into
//! typed items (cells, memos, events, effects, context reads, locals) and
//! its view JSX. Pure extraction: nothing here decides liveness.
use std::collections::HashMap;

use oxc_ast::ast::{
    Argument, ArrowFunctionExpression, BindingPattern, CallExpression, Declaration,
    ExportDefaultDeclarationKind, Expression, FormalParameters, Function, IdentifierReference,
    ImportDeclarationSpecifier, ImportOrExportKind, Program, Statement, VariableDeclarator,
};
use oxc_semantic::{Scoping, SymbolId};
use oxc_span::{GetSpan, Span};

/// Runtime modules whose exports the island compiler recognizes.
pub(crate) const RUNTIME_SOURCES: &[&str] = &["solid-js", "@solidjs/signals", "@solidjs/web"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CellHost {
    /// `$signal` / `createSignal` / an instrumented probe host.
    Signal,
    /// `$store` / `createStore` (tier 2: the kernel has no stores).
    Store,
    /// `createOptimistic*` / `createProjection` (tier 2: async / optimistic).
    Optimistic,
}

/// A function-like block body: a (generator) function or an arrow.
#[derive(Clone, Copy)]
pub(crate) enum FnRef<'a> {
    Func(&'a Function<'a>),
    Arrow(&'a ArrowFunctionExpression<'a>),
}

impl<'a> FnRef<'a> {
    pub(crate) fn span(&self) -> Span {
        match self {
            FnRef::Func(f) => f.span,
            FnRef::Arrow(a) => a.span,
        }
    }
    pub(crate) fn params(&self) -> &'a FormalParameters<'a> {
        match self {
            FnRef::Func(f) => &f.params,
            FnRef::Arrow(a) => &a.params,
        }
    }
    /// The body's span (a block `{…}` or a concise expression).
    pub(crate) fn body_span(&self) -> Span {
        match self {
            FnRef::Func(f) => f.body.as_ref().map_or(f.span, |b| b.span),
            FnRef::Arrow(a) => a.body.span(),
        }
    }
    pub(crate) fn is_concise(&self) -> bool {
        self.concise().is_some()
    }
    /// A concise arrow's expression body.
    pub(crate) fn concise(&self) -> Option<&'a Expression<'a>> {
        match self {
            FnRef::Arrow(a) => a.body.as_expression(),
            FnRef::Func(_) => None,
        }
    }
    pub(crate) fn statements(&self) -> &'a [Statement<'a>] {
        match self {
            FnRef::Func(f) => f.body.as_ref().map_or(&[][..], |b| &b.statements[..]),
            FnRef::Arrow(a) => a
                .body
                .as_function_body()
                .map_or(&[][..], |b| &b.statements[..]),
        }
    }
    pub(crate) fn from_expr(e: &'a Expression<'a>) -> Option<FnRef<'a>> {
        match e.without_parentheses() {
            Expression::FunctionExpression(f) => Some(FnRef::Func(f)),
            Expression::ArrowFunctionExpression(a) => Some(FnRef::Arrow(a)),
            _ => None,
        }
    }
}

// Item spans locate diagnostics; not every kind's is read yet.
#[allow(dead_code)]
pub(crate) enum Item<'a> {
    Cell {
        get: SymbolId,
        set: Option<SymbolId>,
        init: Option<&'a Expression<'a>>,
        host: CellHost,
        /// The runtime constructor (`createSignal`, `createOptimisticStore`,
        /// `$store`, …; the probe host's method for probe cells).
        ctor: String,
        /// Arguments after the initializer (a projection's seed, options).
        rest: Vec<&'a Expression<'a>>,
        /// A probe host's literal label (`h.signal("open", …)`), passed to
        /// tier-0 cells so instrumented builds can trace them.
        label: Option<String>,
        name: String,
        span: Span,
    },
    Memo {
        sym: SymbolId,
        body: FnRef<'a>,
        is_async: bool,
        name: String,
        span: Span,
    },
    Event {
        sym: SymbolId,
        body: FnRef<'a>,
        span: Span,
    },
    /// `$effect` / `createEffect` (settled: false) or `$settled` / `onSettled`.
    Effect {
        body: FnRef<'a>,
        settled: bool,
        span: Span,
    },
    /// `const PATTERN = yield* Ctx`.
    Context {
        pattern: &'a BindingPattern<'a>,
        ctx: SymbolId,
        symbols: Vec<SymbolId>,
        span: Span,
    },
    /// Any other `const` / `function` in the setup.
    Local {
        decl: LocalDecl<'a>,
        symbols: Vec<SymbolId>,
        span: Span,
    },
    /// `yield* $cleanup(fn)` in the setup.
    Cleanup { arg: &'a Expression<'a>, span: Span },
    /// Any other expression statement (runs where the setup runs: on the
    /// server, and in the activation of an island that inlines the component).
    Stmt { stmt: &'a Statement<'a>, span: Span },
}

#[derive(Clone, Copy)]
pub(crate) enum LocalDecl<'a> {
    Var(&'a VariableDeclarator<'a>),
    Func(&'a Function<'a>),
}

impl<'a> Item<'a> {
    /// A store-shaped cell: its getter is the store (a proxy), not an
    /// accessor.
    pub(crate) fn store_like(&self) -> bool {
        match self {
            Item::Cell { host: CellHost::Store, .. } => true,
            Item::Cell { ctor, .. } => matches!(
                ctor.as_str(),
                "createOptimisticStore" | "createProjection" | "createStore" | "createPlainStore"
            ),
            _ => false,
        }
    }
    /// A cell computed by a function (a projection, a derived signal).
    pub(crate) fn derived(&self) -> bool {
        matches!(self, Item::Cell { init: Some(e), .. } if FnRef::from_expr(e).is_some())
    }
    #[allow(dead_code)]
    pub(crate) fn span(&self) -> Span {
        match self {
            Item::Cell { span, .. }
            | Item::Memo { span, .. }
            | Item::Event { span, .. }
            | Item::Effect { span, .. }
            | Item::Context { span, .. }
            | Item::Local { span, .. }
            | Item::Cleanup { span, .. }
            | Item::Stmt { span, .. } => *span,
        }
    }
    /// Symbols the item declares.
    pub(crate) fn declares(&self) -> Vec<SymbolId> {
        match self {
            Item::Cell { get, set, .. } => {
                let mut v = vec![*get];
                v.extend(set.iter().copied());
                v
            }
            Item::Memo { sym, .. } | Item::Event { sym, .. } => vec![*sym],
            Item::Context { symbols, .. } | Item::Local { symbols, .. } => symbols.clone(),
            Item::Effect { .. } | Item::Cleanup { .. } | Item::Stmt { .. } => vec![],
        }
    }
}

pub(crate) struct Comp<'a> {
    pub name: String,
    pub sym: Option<SymbolId>,
    pub exported: bool,
    /// `$component(…)` block component (true) or a plain function component.
    pub block: bool,
    /// The span replaced by the server function (the `$component(…)` call or
    /// the function).
    pub replace: Span,
    pub props: Option<SymbolId>,
    pub setup: Vec<Item<'a>>,
    /// Statements in the view before its `return` (reads the whole view depends on).
    pub view_stmts: Vec<&'a Statement<'a>>,
    pub view: Option<&'a Expression<'a>>,
    pub issues: Vec<String>,
    /// Per-island prefetch override from a `// @island-prefetch <policy>`
    /// pragma in the component's leading comments.
    pub prefetch: Option<String>,
}

pub(crate) struct Top<'a> {
    pub stmt: &'a Statement<'a>,
    pub symbols: Vec<SymbolId>,
    pub import: bool,
    /// An import from a runtime module (never copied into client chunks).
    pub runtime_import: bool,
    /// Index of the component this statement declares, if any.
    pub comp: Option<usize>,
}

pub(crate) struct Model<'a> {
    pub src: &'a str,
    pub scoping: &'a Scoping,
    pub runtime: HashMap<SymbolId, String>,
    pub comps: Vec<Comp<'a>>,
    pub comp_of: HashMap<SymbolId, usize>,
    /// `const Ctx = createContext(default?)` → the default value.
    pub contexts: HashMap<SymbolId, Option<&'a Expression<'a>>>,
    pub top: Vec<Top<'a>>,
    pub top_of: HashMap<SymbolId, usize>,
    /// Probe cell hosts (`object.method`), e.g. `h.signal`.
    pub probe_hosts: Vec<(String, String)>,
    pub issues: Vec<String>,
}

impl<'a> Model<'a> {
    pub(crate) fn text(&self, span: Span) -> &'a str {
        &self.src[span.start as usize..span.end as usize]
    }
    pub(crate) fn symbol_of(&self, id: &IdentifierReference<'_>) -> Option<SymbolId> {
        id.reference_id
            .get()
            .and_then(|r| self.scoping.get_reference(r).symbol_id())
    }
    pub(crate) fn symbol_of_expr(&self, e: &Expression<'_>) -> Option<SymbolId> {
        match e.without_parentheses() {
            Expression::Identifier(id) => self.symbol_of(id),
            _ => None,
        }
    }
    /// The runtime export an identifier callee names (`$signal`, `For`, …).
    pub(crate) fn runtime_name(&self, e: &Expression<'_>) -> Option<&str> {
        self.symbol_of_expr(e)
            .and_then(|s| self.runtime.get(&s))
            .map(String::as_str)
    }
    pub(crate) fn sym_name(&self, s: SymbolId) -> &str {
        self.scoping.symbol_name(s)
    }
    fn probe_label(&self, call: &CallExpression<'a>) -> Option<Option<String>> {
        let Expression::StaticMemberExpression(m) = call.callee.without_parentheses() else {
            return None;
        };
        let Expression::Identifier(obj) = &m.object else {
            return None;
        };
        if !self
            .probe_hosts
            .iter()
            .any(|(o, p)| o == obj.name.as_str() && p == m.property.name.as_str())
        {
            return None;
        }
        Some(match call.arguments.first() {
            Some(Argument::StringLiteral(s)) => Some(s.value.to_string()),
            _ => None,
        })
    }
}

pub(crate) fn binding_symbols(p: &BindingPattern<'_>, out: &mut Vec<SymbolId>) {
    match p {
        BindingPattern::BindingIdentifier(id) => {
            if let Some(s) = id.symbol_id.get() {
                out.push(s);
            }
        }
        BindingPattern::ObjectPattern(o) => {
            for prop in &o.properties {
                binding_symbols(&prop.value, out);
            }
            if let Some(rest) = &o.rest {
                binding_symbols(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(a) => {
            for el in a.elements.iter().flatten() {
                binding_symbols(el, out);
            }
            if let Some(rest) = &a.rest {
                binding_symbols(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(a) => binding_symbols(&a.left, out),
    }
}

fn single_id(p: &BindingPattern<'_>) -> Option<SymbolId> {
    match p {
        BindingPattern::BindingIdentifier(id) => id.symbol_id.get(),
        _ => None,
    }
}

fn pair_ids(p: &BindingPattern<'_>) -> Option<(SymbolId, Option<SymbolId>)> {
    let BindingPattern::ArrayPattern(a) = p else {
        return None;
    };
    if a.rest.is_some() || a.elements.is_empty() || a.elements.len() > 2 {
        return None;
    }
    let get = single_id(a.elements[0].as_ref()?)?;
    let set = match a.elements.get(1) {
        Some(Some(p)) => Some(single_id(p)?),
        _ => None,
    };
    Some((get, set))
}

/// `yield* X` → X.
pub(crate) fn yield_delegate<'b, 'a>(e: &'b Expression<'a>) -> Option<&'b Expression<'a>> {
    match e.without_parentheses() {
        Expression::YieldExpression(y) if y.delegate => y.argument.as_ref(),
        _ => None,
    }
}

pub(crate) fn call_of<'b, 'a>(e: &'b Expression<'a>) -> Option<&'b CallExpression<'a>> {
    match e.without_parentheses() {
        Expression::CallExpression(c) => Some(c),
        _ => None,
    }
}

pub(crate) fn arg_expr<'b, 'a>(c: &'b CallExpression<'a>, i: usize) -> Option<&'b Expression<'a>> {
    c.arguments.get(i).and_then(|a| a.as_expression())
}

fn fn_arg<'a>(c: &'a CallExpression<'a>, i: usize) -> Option<FnRef<'a>> {
    arg_expr(c, i).and_then(FnRef::from_expr)
}

/// Does a (block) body contain an `attempt(…)` call (async-capable)?
fn contains_attempt(m: &Model<'_>, span: Span) -> bool {
    // A textual check over the body is enough to classify; the tier rules
    // re-check `attempt` syntactically through the ref walk.
    let text = m.text(span);
    text.contains("attempt(") && m.runtime.values().any(|v| v == "attempt")
}

pub(crate) fn build_model<'a>(
    src: &'a str,
    program: &'a Program<'a>,
    scoping: &'a Scoping,
    probe_hosts: Vec<(String, String)>,
) -> Model<'a> {
    let mut m = Model {
        src,
        scoping,
        runtime: HashMap::new(),
        comps: Vec::new(),
        comp_of: HashMap::new(),
        contexts: HashMap::new(),
        top: Vec::new(),
        top_of: HashMap::new(),
        probe_hosts,
        issues: Vec::new(),
    };
    // Imports first, so runtime names resolve while components are read.
    for stmt in &program.body {
        let Statement::ImportDeclaration(import) = stmt else {
            continue;
        };
        if import.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let runtime = RUNTIME_SOURCES.contains(&import.source.value.as_str());
        let mut syms = Vec::new();
        for s in import.specifiers.iter().flatten() {
            let (name, local) = match s {
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
            let Some(sym) = local.symbol_id.get() else {
                continue;
            };
            if runtime {
                m.runtime.insert(sym, name);
            }
            syms.push(sym);
        }
        let i = m.top.len();
        for s in &syms {
            m.top_of.insert(*s, i);
        }
        m.top.push(Top {
            stmt,
            symbols: syms,
            import: true,
            runtime_import: runtime,
            comp: None,
        });
    }
    let mut prev_end = 0u32;
    for stmt in &program.body {
        if matches!(stmt, Statement::ImportDeclaration(_)) {
            prev_end = stmt.span().end;
            continue;
        }
        let (decl_stmt, exported): (Option<&'a Declaration<'a>>, bool) = match stmt {
            Statement::ExportDeclaration(e) => (Some(&e.declaration), true),
            _ => (stmt.as_declaration(), false),
        };
        let mut symbols = Vec::new();
        let mut comp = None;
        match (stmt, decl_stmt) {
            (Statement::ExportDefaultDeclaration(d), _) => match &d.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(f) => {
                    let name =
                        f.id.as_ref()
                            .map_or("default".to_string(), |i| i.name.to_string());
                    if let Some(id) = f.id.as_ref().and_then(|i| i.symbol_id.get()) {
                        symbols.push(id);
                    }
                    if is_component_name(&name) {
                        comp = read_plain_component(
                            &mut m,
                            name,
                            symbols.first().copied(),
                            true,
                            FnRef::Func(f),
                        );
                    }
                }
                kind => {
                    if let Some(e) = kind.as_expression()
                        && let Some(c) =
                            read_component_expr(&mut m, "default".into(), None, true, e)
                    {
                        comp = Some(c);
                    }
                }
            },
            (_, Some(Declaration::VariableDeclaration(v))) => {
                for d in &v.declarations {
                    binding_symbols(&d.id, &mut symbols);
                    let Some(init) = &d.init else { continue };
                    if let Some(sym) = single_id(&d.id) {
                        let name = m.sym_name(sym).to_string();
                        if let Some(c) = call_of(init)
                            && m.runtime_name(&c.callee) == Some("createContext")
                        {
                            m.contexts.insert(sym, arg_expr(c, 0));
                            continue;
                        }
                        if let Some(c) =
                            read_component_expr(&mut m, name.clone(), Some(sym), exported, init)
                        {
                            comp = Some(c);
                            continue;
                        }
                        if is_component_name(&name)
                            && let Some(f) = FnRef::from_expr(init)
                            && !matches!(f, FnRef::Func(func) if func.generator)
                            && returns_jsx(&f)
                        {
                            comp = read_plain_component(&mut m, name, Some(sym), exported, f);
                            continue;
                        }
                        if let Some(c) = call_of(init)
                            && let Some(n) = m.runtime_name(&c.callee)
                            && matches!(
                                n,
                                "createSignal"
                                    | "createStore"
                                    | "createMemo"
                                    | "createOptimistic"
                                    | "createOptimisticStore"
                                    | "createProjection"
                                    | "createEffect"
                                    | "createRoot"
                            )
                        {
                            m.issues
                                .push(format!("module-level reactive state `{name}` ({n})"));
                        }
                    }
                }
            }
            (_, Some(Declaration::FunctionDeclaration(f))) => {
                let name = f.id.as_ref().map_or(String::new(), |i| i.name.to_string());
                if let Some(id) = f.id.as_ref().and_then(|i| i.symbol_id.get()) {
                    symbols.push(id);
                }
                if is_component_name(&name) && !f.generator && returns_jsx(&FnRef::Func(f)) {
                    comp = read_plain_component(
                        &mut m,
                        name,
                        symbols.first().copied(),
                        exported,
                        FnRef::Func(f),
                    );
                }
            }
            (_, Some(Declaration::ClassDeclaration(c))) => {
                if let Some(id) = c.id.as_ref().and_then(|i| i.symbol_id.get()) {
                    symbols.push(id);
                }
            }
            _ => {}
        }
        let i = m.top.len();
        for s in &symbols {
            m.top_of.insert(*s, i);
        }
        if let Some(ci) = comp {
            let lead = &src[prev_end as usize..stmt.span().start as usize];
            m.comps[ci].prefetch = prefetch_pragma(lead);
        }
        prev_end = stmt.span().end;
        m.top.push(Top {
            stmt,
            symbols,
            import: false,
            runtime_import: false,
            comp,
        });
    }
    m
}

/// `@island-prefetch <policy>` in a component's leading comments.
fn prefetch_pragma(lead: &str) -> Option<String> {
    let i = lead.rfind("@island-prefetch")?;
    let word: String = lead[i + "@island-prefetch".len()..]
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect();
    matches!(
        word.as_str(),
        "load" | "idle" | "visible" | "intent" | "interaction"
    )
    .then_some(word)
}

pub(crate) fn is_component_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

fn returns_jsx(f: &FnRef<'_>) -> bool {
    if f.is_concise() {
        if let Some(e) = f.concise() {
            return is_jsx(e);
        }
        return false;
    }
    f.statements().iter().any(
        |s| matches!(s, Statement::ReturnStatement(r) if r.argument.as_ref().is_some_and(is_jsx)),
    )
}

pub(crate) fn is_jsx(e: &Expression<'_>) -> bool {
    matches!(
        e.without_parentheses(),
        Expression::JSXElement(_) | Expression::JSXFragment(_)
    )
}

/// `$component(function* …)` / `$component<P>()(function* …)`.
fn read_component_expr<'a>(
    m: &mut Model<'a>,
    name: String,
    sym: Option<SymbolId>,
    exported: bool,
    e: &'a Expression<'a>,
) -> Option<usize> {
    let call = call_of(e)?;
    let is_component = match m.runtime_name(&call.callee) {
        Some("$component") => true,
        _ => {
            matches!(call_of(&call.callee), Some(inner) if m.runtime_name(&inner.callee) == Some("$component"))
        }
    };
    if !is_component {
        return None;
    }
    let Some(FnRef::Func(f)) = fn_arg(call, 0) else {
        m.issues
            .push(format!("`{name}`: $component without a generator setup"));
        return None;
    };
    let mut comp = Comp {
        name,
        sym,
        exported,
        block: true,
        replace: call.span,
        props: f.params.items.first().and_then(|p| single_id(&p.pattern)),
        setup: Vec::new(),
        view_stmts: Vec::new(),
        view: None,
        issues: Vec::new(),
        prefetch: None,
    };
    if f.params.items.len() > 1
        || f.params
            .items
            .first()
            .is_some_and(|p| single_id(&p.pattern).is_none())
    {
        comp.issues
            .push("setup parameters other than a single `props` binding".into());
    }
    let stmts = FnRef::Func(f).statements();
    for (i, stmt) in stmts.iter().enumerate() {
        if i + 1 == stmts.len()
            && let Statement::ReturnStatement(r) = stmt
        {
            match r.argument.as_ref().map(|a| a.without_parentheses()) {
                Some(Expression::FunctionExpression(view)) if view.generator => {
                    read_view(m, &mut comp, FnRef::Func(view));
                }
                Some(Expression::ArrowFunctionExpression(view)) => {
                    read_view(m, &mut comp, FnRef::Arrow(view))
                }
                _ => comp
                    .issues
                    .push("the setup does not return a view generator".into()),
            }
            continue;
        }
        read_setup_statement(m, &mut comp, stmt);
    }
    let idx = m.comps.len();
    if let Some(s) = sym {
        m.comp_of.insert(s, idx);
    }
    m.comps.push(comp);
    Some(idx)
}

fn read_view<'a>(m: &Model<'a>, comp: &mut Comp<'a>, view: FnRef<'a>) {
    if view.is_concise() {
        if let Some(e) = view.concise() {
            comp.view = Some(e);
        }
        return;
    }
    let stmts = view.statements();
    for (i, s) in stmts.iter().enumerate() {
        if i + 1 == stmts.len()
            && let Statement::ReturnStatement(r) = s
            && let Some(arg) = &r.argument
        {
            comp.view = Some(arg);
        } else {
            comp.view_stmts.push(s);
        }
    }
    if comp.view.is_none() {
        comp.issues
            .push(format!("`{}`: the view has no final `return`", comp.name));
    }
    let _ = m;
}

/// A plain function component: allowed when its body is locals plus a
/// final `return <jsx/>` (no reactive creations).
fn read_plain_component<'a>(
    m: &mut Model<'a>,
    name: String,
    sym: Option<SymbolId>,
    exported: bool,
    f: FnRef<'a>,
) -> Option<usize> {
    let mut comp = Comp {
        name,
        sym,
        exported,
        block: false,
        replace: f.span(),
        props: f.params().items.first().and_then(|p| single_id(&p.pattern)),
        setup: Vec::new(),
        view_stmts: Vec::new(),
        view: None,
        issues: Vec::new(),
        prefetch: None,
    };
    if f.is_concise() {
        if let Some(e) = f.concise() {
            comp.view = Some(e);
        }
    } else {
        let stmts = f.statements();
        for (i, s) in stmts.iter().enumerate() {
            if i + 1 == stmts.len()
                && let Statement::ReturnStatement(r) = s
                && let Some(arg) = &r.argument
            {
                comp.view = Some(arg);
                continue;
            }
            // Setup-like statements of a plain component: locals only.
            read_setup_statement(m, &mut comp, s);
        }
    }
    // A plain component's body runs once, like a setup: it may create
    // reactive state (directly, or through an inlined factory call).
    let idx = m.comps.len();
    if let Some(s) = sym {
        m.comp_of.insert(s, idx);
    }
    m.comps.push(comp);
    Some(idx)
}

fn read_setup_statement<'a>(m: &Model<'a>, comp: &mut Comp<'a>, stmt: &'a Statement<'a>) {
    match stmt {
        Statement::VariableDeclaration(v) => {
            for d in &v.declarations {
                read_declarator(m, comp, d, stmt.span());
            }
        }
        Statement::FunctionDeclaration(f) => {
            let mut symbols = Vec::new();
            if let Some(id) = f.id.as_ref().and_then(|i| i.symbol_id.get()) {
                symbols.push(id);
            }
            if f.generator {
                comp.issues.push(
                    "generator function declared in a setup (helper generators are not inlined)"
                        .into(),
                );
            }
            comp.setup.push(Item::Local {
                decl: LocalDecl::Func(f),
                symbols,
                span: f.span,
            });
        }
        Statement::ExpressionStatement(e) => {
            let expr = &e.expression;
            let (call, yielded) = match yield_delegate(expr) {
                Some(inner) => (call_of(inner), true),
                None => (call_of(expr), false),
            };
            if let Some(call) = call {
                let name = m.runtime_name(&call.callee).map(str::to_string);
                match (name.as_deref(), yielded) {
                    (Some("$effect"), true) | (Some("createEffect"), false) => {
                        if let Some(body) = fn_arg(call, 0) {
                            if call.arguments.len() > 1 {
                                comp.issues
                                    .push("two-argument createEffect in a setup".into());
                            }
                            comp.setup.push(Item::Effect {
                                body,
                                settled: false,
                                span: stmt.span(),
                            });
                            return;
                        }
                    }
                    (Some("$settled"), true) | (Some("onSettled"), false) => {
                        if let Some(body) = fn_arg(call, 0) {
                            comp.setup.push(Item::Effect {
                                body,
                                settled: true,
                                span: stmt.span(),
                            });
                            return;
                        }
                    }
                    (Some("$cleanup"), true) | (Some("onCleanup"), false) => {
                        if let Some(arg) = arg_expr(call, 0) {
                            comp.setup.push(Item::Cleanup {
                                arg,
                                span: stmt.span(),
                            });
                            return;
                        }
                    }
                    _ => {}
                }
            }
            if yielded {
                comp.issues
                    .push(format!("setup statement `{}`", short(m.text(stmt.span()))));
            } else {
                comp.setup.push(Item::Stmt {
                    stmt,
                    span: stmt.span(),
                });
            }
        }
        // `if (!v) throw …`, loops, blocks: side-effect statements that run
        // where the setup runs. A read in one (`yield*`) is not compiled.
        _ if !has_yield(stmt) => comp.setup.push(Item::Stmt {
            stmt,
            span: stmt.span(),
        }),
        _ => comp
            .issues
            .push(format!("setup statement `{}`", short(m.text(stmt.span())))),
    }
}

/// A `yield` of the statement's own function (not of a nested one).
fn has_yield(s: &Statement<'_>) -> bool {
    use oxc_ast_visit::{Visit, walk};
    struct Y(bool);
    impl<'a> Visit<'a> for Y {
        fn visit_yield_expression(&mut self, y: &oxc_ast::ast::YieldExpression<'a>) {
            self.0 = true;
            walk::walk_yield_expression(self, y);
        }
        fn visit_function(&mut self, _: &Function<'a>, _: oxc_semantic::ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
    }
    let mut y = Y(false);
    y.visit_statement(s);
    y.0
}

pub(crate) fn short(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > 60 {
        format!("{}…", one.chars().take(60).collect::<String>())
    } else {
        one
    }
}

fn read_declarator<'a>(
    m: &Model<'a>,
    comp: &mut Comp<'a>,
    d: &'a VariableDeclarator<'a>,
    span: Span,
) {
    let mut symbols = Vec::new();
    binding_symbols(&d.id, &mut symbols);
    let Some(init) = &d.init else {
        comp.setup.push(Item::Local {
            decl: LocalDecl::Var(d),
            symbols,
            span,
        });
        return;
    };
    let yielded = yield_delegate(init);
    // `yield* Ctx`
    if let Some(inner) = yielded
        && let Some(sym) = m.symbol_of_expr(inner)
        && m.contexts.contains_key(&sym)
    {
        comp.setup.push(Item::Context {
            pattern: &d.id,
            ctx: sym,
            symbols,
            span,
        });
        return;
    }
    let call = yielded.map_or_else(|| call_of(init), call_of);
    if let Some(call) = call {
        let host = m.runtime_name(&call.callee).map(str::to_string);
        let probe = if yielded.is_none() {
            m.probe_label(call)
        } else {
            None
        };
        let cell = match (host.as_deref(), yielded.is_some()) {
            (Some("$signal"), true) | (Some("createSignal"), false) => Some((CellHost::Signal, 0)),
            (Some("$store"), true) | (Some("createStore" | "createPlainStore"), false) => {
                Some((CellHost::Store, 0))
            }
            (Some("createOptimistic" | "createOptimisticStore" | "createProjection"), false) => {
                Some((CellHost::Optimistic, 0))
            }
            _ if probe.is_some() => Some((CellHost::Signal, 1)),
            _ => None,
        };
        if let Some((host_kind, init_arg)) = cell {
            let Some((get, set)) = pair_ids(&d.id) else {
                comp.issues.push(format!(
                    "cell `{}` not destructured as `[get, set]`",
                    short(m.text(d.id.span()))
                ));
                return;
            };
            // A function initializer of createSignal is a derived signal
            // (tier 2 here: its writable-memo semantics are not compiled).
            let init_expr = arg_expr(call, init_arg);
            // A function initializer of `createStore` is a projection.
            let host_kind = if host_kind != CellHost::Optimistic
                && init_expr.is_some_and(|e| FnRef::from_expr(e).is_some())
            {
                CellHost::Optimistic
            } else {
                host_kind
            };
            let ctor = match &host {
                Some(h) => h.clone(),
                None => "probe".into(),
            };
            comp.setup.push(Item::Cell {
                get,
                set,
                init: init_expr,
                host: host_kind,
                ctor,
                rest: call
                    .arguments
                    .iter()
                    .skip(init_arg + 1)
                    .filter_map(|a| a.as_expression())
                    .collect(),
                label: probe.flatten(),
                name: m.sym_name(get).to_string(),
                span,
            });
            return;
        }
        match (host.as_deref(), yielded.is_some()) {
            (Some("$memo"), true) | (Some("createMemo"), false) => {
                if let (Some(sym), Some(body)) = (single_id(&d.id), fn_arg(call, 0)) {
                    let is_async = contains_attempt(m, body.body_span())
                        || matches!(body, FnRef::Func(f) if f.r#async)
                        || matches!(body, FnRef::Arrow(a) if a.r#async);
                    comp.setup.push(Item::Memo {
                        sym,
                        body,
                        is_async,
                        name: m.sym_name(sym).to_string(),
                        span,
                    });
                    return;
                }
            }
            (Some("$event"), false) => {
                if let (Some(sym), Some(body)) = (single_id(&d.id), fn_arg(call, 0)) {
                    comp.setup.push(Item::Event { sym, body, span });
                    return;
                }
            }
            (Some(other), true) => {
                comp.issues
                    .push(format!("setup operation `yield* {other}(…)`"));
                return;
            }
            _ => {}
        }
    }
    if yielded.is_some() {
        comp.issues.push(format!(
            "setup read `{}` (helper generators and reads are not compiled)",
            short(m.text(init.span()))
        ));
        return;
    }
    comp.setup.push(Item::Local {
        decl: LocalDecl::Var(d),
        symbols,
        span,
    });
}
