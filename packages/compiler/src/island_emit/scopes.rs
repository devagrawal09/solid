//! Scopes: the partitioner's unit is a scope, not a component.
//!
//! Component boundaries never mattered in Solid and must not matter to the
//! island compiler: the same logic in one component or five compiles to the
//! same partition and the same output. The partitioner (`graph.rs`) and the
//! emitters work on the module's scopes — component setups, render-callback
//! blocks (a `<For>` row, a `<Show>` / `<Match>` branch, a `<Repeat>` index),
//! and `<Show>` branches that a piece of state lives in. This pre-pass makes
//! every scope that holds state a unit the analysis sees, source to source:
//!
//! 1. **Row blocks** ([`extract_rows`]). A render callback that is a block —
//!    `function* (row) { setup; return function* () { view } }`,
//!    `$(function* (row) …)`, or the name of a generator function declared
//!    in scope (a named row block, which may render itself) — becomes a
//!    module-level `$component` whose props are the callback's arguments and
//!    the bindings it captures from its enclosing scopes. The callback
//!    becomes `(row) => <Scope row={row} captured={captured} />`: one
//!    instance per row, the setup under the row, exactly the block's
//!    semantics. Innermost scopes first, so a nested scope's captures are
//!    ordinary props of its parent's.
//! 2. **Keyed stores** ([`split_keyed_stores`]). A `$store` map every read of
//!    which is `map[row.id]` inside one row scope, and every write of which
//!    sets `map[row.id]` from a handler of that row, is a cell per key: the
//!    row owns a `$signal` initialized from its key's server value.
//! 3. **Branches** ([`sink_into_branches`], analysis-guided). An island
//!    whose state and every site sit inside one `<Show>` branch over server
//!    data is rooted at that branch: the branch content becomes a scope that
//!    creates the state, and the subtrees the island does not touch are
//!    passed through as its `children` slot. A branch over server data
//!    renders at most once per instance of its scope, so the state is created
//!    exactly as often as the island's DOM exists.
//!
//! Everything else (a destructured parameter, a write to a captured binding,
//! mutual recursion between row blocks, …) is left as written and the
//! analysis reports it.
use std::collections::{BTreeSet, HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, BindingPattern, Expression, Function, FunctionType, IdentifierReference, JSXAttributeItem,
    JSXAttributeValue, JSXChild, JSXElement, JSXElementName, ObjectProperty, Program, Statement,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{ScopeFlags, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use super::graph::Analysis;
use super::jsx::{self, AttrVal, Child, Root, Tag};
use super::model::{FnRef, Item, Model, RUNTIME_SOURCES};
use crate::compiler::{parse_program, source_type_for_filename};
use crate::store_scalars::splice;

/// Flow controls whose render callback may be a block.
const FLOWS: &[&str] = &["For", "Show", "Match", "Repeat"];

// --- 1. row blocks ----------------------------------------------------------------

/// The source with every row block extracted into a component, or `None`
/// when there is none.
pub(crate) fn extract_rows(source: &str, filename: Option<&str>) -> Option<String> {
    if !source.contains("function*") {
        return None;
    }
    let mut src = source.to_string();
    let mut changed = false;
    // One scope per round (innermost first), re-reading the rewritten source.
    for _ in 0..256 {
        match extract_one(&src, filename) {
            Some(next) => {
                src = next;
                changed = true;
            }
            None => break,
        }
    }
    changed.then_some(src)
}

/// A render callback that is a block.
#[derive(Clone, Copy)]
struct Candidate<'a> {
    /// The generator function (an expression, or a declaration for a named
    /// row block).
    func: &'a Function<'a>,
    /// Named: the declaration's symbol.
    named: Option<SymbolId>,
    /// The flow control it renders under.
    flow: &'static str,
    /// Where the callback is written: the JSX expression container (child),
    /// or the attribute value container (`children={…}`).
    site: Span,
    /// The site is a child container (else an attribute value).
    child: bool,
}

struct Imports {
    flows: HashMap<SymbolId, &'static str>,
    block: HashSet<SymbolId>,
    /// The local name `$component` is imported as.
    component: Option<String>,
}

fn runtime_imports(program: &Program<'_>) -> Imports {
    let mut out = Imports {
        flows: HashMap::new(),
        block: HashSet::new(),
        component: None,
    };
    for stmt in &program.body {
        let Statement::ImportDeclaration(import) = stmt else {
            continue;
        };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str())
            || import.import_kind.is_type()
        {
            continue;
        }
        for s in import.specifiers.iter().flatten() {
            let oxc_ast::ast::ImportDeclarationSpecifier::ImportSpecifier(s) = s else {
                continue;
            };
            if s.import_kind.is_type() {
                continue;
            }
            let Some(sym) = s.local.symbol_id.get() else {
                continue;
            };
            let imported = s.imported.name();
            if let Some(f) = FLOWS.iter().find(|f| **f == imported.as_str()) {
                out.flows.insert(sym, f);
            } else if imported == "$" {
                out.block.insert(sym);
            } else if imported == "$component" {
                out.component = Some(s.local.name.to_string());
            }
        }
    }
    out
}

fn symbol_of(scoping: &Scoping, id: &IdentifierReference<'_>) -> Option<SymbolId> {
    id.reference_id
        .get()
        .and_then(|r| scoping.get_reference(r).symbol_id())
}

/// Every flow control's render callback that is a block, in source order.
struct Finder<'s, 'a> {
    scoping: &'s Scoping,
    imports: &'s Imports,
    /// Generator function declarations, by symbol.
    generators: HashMap<SymbolId, &'a Function<'a>>,
    found: Vec<Candidate<'a>>,
    /// Identifier sites naming a generator declaration: (symbol, flow, site, child).
    named_sites: Vec<(SymbolId, &'static str, Span, bool)>,
}

impl<'a> Finder<'_, 'a> {
    fn callback(&mut self, e: &'a Expression<'a>, flow: &'static str, site: Span, child: bool) {
        match e.without_parentheses() {
            Expression::FunctionExpression(f) if f.generator && !f.r#async => {
                self.found.push(Candidate {
                    func: f,
                    named: None,
                    flow,
                    site,
                    child,
                });
            }
            Expression::CallExpression(c)
                if c.arguments.len() == 1
                    && matches!(&c.callee, Expression::Identifier(id)
                        if symbol_of(self.scoping, id).is_some_and(|s| self.imports.block.contains(&s))) =>
            {
                if let Some(Argument::FunctionExpression(f)) = c.arguments.first()
                    && f.generator
                    && !f.r#async
                    && !f.params.items.is_empty()
                {
                    self.found.push(Candidate {
                        func: f,
                        named: None,
                        flow,
                        site,
                        child,
                    });
                }
            }
            Expression::Identifier(id) => {
                if let Some(s) = symbol_of(self.scoping, id) {
                    self.named_sites.push((s, flow, site, child));
                }
            }
            _ => {}
        }
    }
}

impl<'a> Visit<'a> for Finder<'_, 'a> {
    fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
        let f: &'a Function<'a> = unsafe { &*(f as *const Function<'a>) };
        if f.r#type == FunctionType::FunctionDeclaration
            && f.generator
            && !f.r#async
            && let Some(s) = f.id.as_ref().and_then(|i| i.symbol_id.get())
        {
            self.generators.insert(s, f);
        }
        walk::walk_function(self, f, flags);
    }
    fn visit_jsx_element(&mut self, el: &JSXElement<'a>) {
        let el: &'a JSXElement<'a> = unsafe { &*(el as *const JSXElement<'a>) };
        if let JSXElementName::IdentifierReference(tag) = &el.opening_element.name
            && let Some(flow) = symbol_of(self.scoping, tag).and_then(|s| self.imports.flows.get(&s).copied())
        {
            for c in &el.children {
                if let JSXChild::ExpressionContainer(j) = c
                    && let Some(e) = j.expression.as_expression()
                {
                    self.callback(e, flow, j.span, true);
                }
            }
            for a in &el.opening_element.attributes {
                if let JSXAttributeItem::Attribute(a) = a
                    && a.name.get_identifier().name == "children"
                    && let Some(JSXAttributeValue::ExpressionContainer(j)) = &a.value
                    && let Some(e) = j.expression.as_expression()
                {
                    self.callback(e, flow, j.span, false);
                }
            }
        }
        walk::walk_jsx_element(self, el);
    }
}

/// The top-level statement containing `span`.
fn host_statement<'b, 'a>(program: &'b Program<'a>, span: Span) -> Option<&'b Statement<'a>> {
    program
        .body
        .iter()
        .find(|s| s.span().start <= span.start && span.end <= s.span().end)
}

/// The name a top-level statement declares (for scope names).
fn declared_name(stmt: &Statement<'_>) -> Option<String> {
    let decl = match stmt {
        Statement::ExportDeclaration(e) => &e.declaration,
        Statement::ExportDefaultDeclaration(_) => return Some("Default".into()),
        s => s.as_declaration()?,
    };
    match decl {
        oxc_ast::ast::Declaration::VariableDeclaration(v) => v
            .declarations
            .first()
            .and_then(|d| d.id.get_binding_identifier())
            .map(|i| i.name.to_string()),
        oxc_ast::ast::Declaration::FunctionDeclaration(f) => f.id.as_ref().map(|i| i.name.to_string()),
        _ => None,
    }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_ascii_uppercase().to_string() + c.as_str(),
        None => String::new(),
    }
}

/// A fresh identifier with `base` as its prefix.
fn fresh(source: &str, base: &str, taken: &HashSet<String>) -> String {
    let mut n = 0;
    loop {
        let name = if n == 0 {
            base.to_string()
        } else {
            format!("{base}{n}")
        };
        if !source.contains(name.as_str()) && !taken.contains(&name) {
            return name;
        }
        n += 1;
    }
}

fn extract_one(source: &str, filename: Option<&str>) -> Option<String> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename).ok()?;
    let program = parse_program(&allocator, source, source_type).ok()?;
    let semantic = SemanticBuilder::new().build(&program).semantic;
    let scoping = semantic.scoping();
    let imports = runtime_imports(&program);
    if imports.flows.is_empty() {
        return None;
    }
    let mut finder = Finder {
        scoping,
        imports: &imports,
        generators: HashMap::new(),
        found: Vec::new(),
        named_sites: Vec::new(),
    };
    finder.visit_program(&program);
    // Named row blocks: generator declarations every reference to which is a
    // render callback site.
    let mut named: Vec<Candidate<'_>> = Vec::new();
    let mut sites_of: HashMap<SymbolId, Vec<(Span, bool)>> = HashMap::new();
    for (s, flow, site, child) in &finder.named_sites {
        let Some(f) = finder.generators.get(s) else {
            continue;
        };
        sites_of.entry(*s).or_default().push((*site, *child));
        if !named.iter().any(|c| c.named == Some(*s)) {
            named.push(Candidate {
                func: f,
                named: Some(*s),
                flow,
                site: *site,
                child: *child,
            });
        }
    }
    named.retain(|c| {
        let s = c.named.expect("named");
        let sites = &sites_of[&s];
        // Every reference is a render callback site (the declaration's own
        // name is not a reference).
        scoping.get_resolved_references(s).count() == sites.len()
    });
    let mut all: Vec<Candidate<'_>> = finder.found.clone();
    all.extend(named.iter().copied());
    // Innermost first: a candidate whose function contains no other
    // candidate (a named block's own recursive sites do not count).
    let inside = |outer: &Candidate<'_>, inner: &Candidate<'_>| -> bool {
        let span = outer.func.span;
        match inner.named {
            Some(s) => {
                if Some(s) == outer.named {
                    return false;
                }
                // A named block is inside when its declaration or a site is.
                std::iter::once(inner.func.span)
                    .chain(sites_of[&s].iter().map(|(sp, _)| *sp))
                    .any(|sp| span.start <= sp.start && sp.end <= span.end && sp != span)
            }
            None => span.start <= inner.site.start && inner.site.end <= span.end,
        }
    };
    let pick = all.iter().find(|c| !all.iter().any(|o| !std::ptr::eq(o, *c) && inside(c, o)))?;
    let named_sites = pick.named.and_then(|s| sites_of.get(&s));
    extract(source, &program, scoping, &imports, pick, named_sites)
}

/// One reference edit in the moved body: `x` → `$p.x`.
fn extract(
    source: &str,
    program: &Program<'_>,
    scoping: &Scoping,
    imports: &Imports,
    c: &Candidate<'_>,
    named_sites: Option<&Vec<(Span, bool)>>,
) -> Option<String> {
    let f = c.func;
    let body = f.body.as_ref()?;
    // Parameters: plain identifiers only.
    if f.params.rest.is_some() {
        return None;
    }
    let mut params: Vec<(SymbolId, String)> = Vec::new();
    for p in &f.params.items {
        let BindingPattern::BindingIdentifier(id) = &p.pattern else {
            return None;
        };
        params.push((id.symbol_id.get()?, id.name.to_string()));
    }
    // References inside the function.
    struct Refs<'s> {
        scoping: &'s Scoping,
        ids: Vec<(Span, SymbolId, bool)>,
        shorthand: Vec<(Span, SymbolId)>,
        tags: Vec<SymbolId>,
        this: bool,
    }
    impl<'b> Visit<'b> for Refs<'_> {
        fn visit_identifier_reference(&mut self, id: &IdentifierReference<'b>) {
            if let Some(r) = id.reference_id.get() {
                let reference = self.scoping.get_reference(r);
                if let Some(s) = reference.symbol_id() {
                    self.ids.push((id.span, s, reference.is_write()));
                }
            }
        }
        fn visit_object_property(&mut self, p: &ObjectProperty<'b>) {
            if p.shorthand
                && let Expression::Identifier(id) = &p.value
                && let Some(s) = id
                    .reference_id
                    .get()
                    .and_then(|r| self.scoping.get_reference(r).symbol_id())
            {
                self.shorthand.push((p.span, s));
            }
            walk::walk_object_property(self, p);
        }
        fn visit_jsx_element_name(&mut self, n: &JSXElementName<'b>) {
            match n {
                JSXElementName::IdentifierReference(id) => {
                    if let Some(s) = id
                        .reference_id
                        .get()
                        .and_then(|r| self.scoping.get_reference(r).symbol_id())
                    {
                        self.tags.push(s);
                    }
                }
                _ => walk::walk_jsx_element_name(self, n),
            }
        }
        fn visit_this_expression(&mut self, _: &oxc_ast::ast::ThisExpression) {
            self.this = true;
        }
    }
    let mut refs = Refs {
        scoping,
        ids: Vec::new(),
        shorthand: Vec::new(),
        tags: Vec::new(),
        this: false,
    };
    refs.visit_function_body(body);
    if refs.this || source[body.span.start as usize..body.span.end as usize].contains("arguments") {
        return None;
    }
    let root = scoping.root_scope_id();
    let fspan = f.span;
    let within = |sp: Span| fspan.start <= sp.start && sp.end <= fspan.end;
    let param_syms: HashSet<SymbolId> = params.iter().map(|(s, _)| *s).collect();
    // Captures: bindings of enclosing function scopes.
    let mut captures: Vec<(SymbolId, String)> = Vec::new();
    for (_, s, write) in &refs.ids {
        if Some(*s) == c.named {
            continue;
        }
        let declared = scoping.symbol_span(*s);
        let inner = within(declared);
        if inner && !param_syms.contains(s) {
            continue;
        }
        if !inner && scoping.symbol_scope_id(*s) == root {
            continue;
        }
        if *write {
            return None;
        }
        if !inner && !captures.iter().any(|(x, _)| x == s) {
            captures.push((*s, scoping.symbol_name(*s).to_string()));
        }
    }
    for t in &refs.tags {
        if captures.iter().any(|(x, _)| x == t) || param_syms.contains(t) {
            return None;
        }
        if !within(scoping.symbol_span(*t)) && scoping.symbol_scope_id(*t) != root {
            // A component bound in an enclosing function, used as a tag.
            return None;
        }
    }
    // Names.
    let host = host_statement(program, match c.named {
        Some(_) => f.span,
        None => c.site,
    })?;
    let host_name = declared_name(host).unwrap_or_else(|| "Scope".into());
    let taken: HashSet<String> = HashSet::new();
    let base = match (c.named, &f.id) {
        (Some(_), Some(id)) => format!("{}${}", capitalize(&host_name), id.name),
        _ => format!("{}${}", capitalize(&host_name), c.flow),
    };
    let name = fresh(source, &base, &taken);
    let pname = fresh(source, "$p", &taken);
    // The moved body: parameters and captures read from the props.
    let subst: HashMap<SymbolId, String> = params
        .iter()
        .chain(captures.iter())
        .map(|(s, n)| (*s, n.clone()))
        .collect();
    let shorthand_spans: HashSet<Span> = refs.shorthand.iter().map(|(sp, _)| *sp).collect();
    let mut edits: Vec<(Span, String)> = Vec::new();
    for (sp, s) in &refs.shorthand {
        if let Some(n) = subst.get(s) {
            edits.push((*sp, format!("{n}: {pname}.{n}")));
        }
    }
    for (sp, s, _) in &refs.ids {
        if shorthand_spans.contains(sp) {
            continue;
        }
        if let Some(n) = subst.get(s) {
            edits.push((*sp, format!("{pname}.{n}")));
        }
    }
    let capture_names: Vec<String> = captures.iter().map(|(_, n)| n.clone()).collect();
    let param_names: Vec<String> = params.iter().map(|(_, n)| n.clone()).collect();
    // The recursive sites of a named block, inside its own body.
    if let Some(sites) = named_sites {
        for (sp, child) in sites {
            if within(*sp) {
                let prefix = format!("{pname}.");
                edits.push((
                    *sp,
                    call_site(&name, &param_names, &capture_names, &prefix, c.flow, *child),
                ));
            }
        }
    }
    let body_text = splice(source, body.span, edits);
    let component = match &imports.component {
        Some(local) => local.clone(),
        None => "_$scopeComponent".to_string(),
    };
    let decl = format!("const {name} = {component}(function* ({pname}) {body_text});\n");
    // Outer edits: the declaration goes before the host statement; the
    // callback (or every site of a named block) becomes the instance.
    let mut outer: Vec<(Span, String)> = Vec::new();
    match c.named {
        None => {
            outer.push((
                c.site,
                call_site(&name, &param_names, &capture_names, "", c.flow, c.child),
            ));
        }
        Some(_) => {
            // The declaration statement is removed.
            outer.push((f.span, String::new()));
            for (sp, child) in named_sites? {
                if !within(*sp) {
                    outer.push((
                        *sp,
                        call_site(&name, &param_names, &capture_names, "", c.flow, *child),
                    ));
                }
            }
        }
    }
    if c.named.is_some() && host.span() == f.span {
        // A module-level named block: the component takes its place.
        outer.retain(|(sp, _)| *sp != f.span);
        outer.push((f.span, decl));
    } else {
        let at = host.span().start;
        outer.push((Span::new(at, at), decl));
    }
    let mut out = splice(source, Span::new(0, source.len() as u32), outer);
    if imports.component.is_none() {
        out = format!("import {{ $component as _$scopeComponent }} from \"solid-js\";\n{out}");
    }
    Some(out)
}

/// A render callback site rendering scope `name`: `{(row) => <Name row={row}
/// captured={captured} />}` (a `<Show>` / `<Match>` branch with no argument
/// renders the element itself). `prefix` reads the captures from a scope's
/// own props (a recursive site).
fn call_site(
    name: &str,
    params: &[String],
    captures: &[String],
    prefix: &str,
    flow: &str,
    child: bool,
) -> String {
    let mut attrs = String::new();
    for p in params {
        attrs.push_str(&format!(" {p}={{{p}}}"));
    }
    for c in captures {
        attrs.push_str(&format!(" {c}={{{prefix}{c}}}"));
    }
    let element = format!("<{name}{attrs} />");
    if params.is_empty() && matches!(flow, "Show" | "Match") {
        return if child {
            element
        } else {
            format!("{{{element}}}")
        };
    }
    format!("{{({}) => {element}}}", params.join(", "))
}


// --- 3. branches ------------------------------------------------------------------

/// The source with every island whose state and sites sit in one `<Show>`
/// branch over server data rooted at that branch, or `None`.
pub(crate) fn sink_into_branches(
    source: &str,
    filename: Option<&str>,
    probe_hosts: &[(String, String)],
) -> Option<String> {
    let mut src = source.to_string();
    let mut changed = false;
    for _ in 0..64 {
        match sink_one(&src, filename, probe_hosts) {
            Some(next) => {
                src = next;
                changed = true;
            }
            None => break,
        }
    }
    changed.then_some(src)
}

fn contains(outer: Span, inner: Span) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

/// The span a JSX element's children cover (first to last child).
fn children_span(el: &JSXElement<'_>) -> Option<Span> {
    let first = el.children.first()?.span();
    let last = el.children.last()?.span();
    Some(Span::new(first.start, last.end))
}

/// The deepest `<Show>` of `comp`'s view, reached through intrinsic elements,
/// fragments and other such `<Show>`s only (so it renders at most once per
/// instance), whose children contain every span in `spans` and whose `when`
/// is not live (a branch over server data never re-activates).
fn find_branch<'a>(
    m: &Model<'a>,
    a: &Analysis<'a>,
    comp: usize,
    view: &'a Expression<'a>,
    spans: &[Span],
) -> Option<&'a JSXElement<'a>> {
    let covers = |sp: Span| spans.iter().all(|s| contains(sp, *s));
    let mut best = None;
    let mut kids: Vec<Child<'a>> = match jsx::root_of(view)? {
        Root::Element(el) => {
            if !covers(el.span) {
                return None;
            }
            vec![Child::Element(el)]
        }
        Root::Fragment(f) => jsx::children(&f.children).ok()?,
    };
    loop {
        let Some(next) = kids.iter().find(|k| covers(k.span())).copied() else {
            return best;
        };
        match next {
            Child::Fragment(f) => kids = jsx::children(&f.children).ok()?,
            Child::Element(el) => match jsx::tag_of(m, &el.opening_element.name) {
                Tag::Intrinsic(_) => kids = jsx::children(&el.children).ok()?,
                Tag::Builtin(b) if b == "Show" => {
                    let attrs = jsx::attrs(el).ok()?;
                    let Some(AttrVal::Expr(when)) = jsx::attr(&attrs, "when").map(|x| &x.value) else {
                        return best;
                    };
                    let children = jsx::children(&el.children).ok()?;
                    // A render callback re-renders with its value: not a
                    // fixed branch.
                    if a.is_live_site(comp, when.span().start)
                        || children
                            .iter()
                            .any(|c| matches!(c, Child::Expr(e) if FnRef::from_expr(e).is_some()))
                    {
                        return best;
                    }
                    let Some(cs) = children_span(el) else {
                        return best;
                    };
                    if !covers(cs) {
                        return best;
                    }
                    best = Some(el);
                    kids = children;
                }
                _ => return best,
            },
            _ => return best,
        }
    }
}

/// References inside a region, for the moved code.
struct RegionRefs<'s> {
    scoping: &'s Scoping,
    /// The enclosing component's props binding.
    props: Option<SymbolId>,
    ids: Vec<(Span, SymbolId, bool)>,
    shorthand: Vec<(Span, SymbolId)>,
    /// `props.name` (span, name).
    members: Vec<(Span, String)>,
    tags: Vec<SymbolId>,
}

impl<'b> Visit<'b> for RegionRefs<'_> {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'b>) {
        if let Some(r) = id.reference_id.get() {
            let reference = self.scoping.get_reference(r);
            if let Some(s) = reference.symbol_id() {
                self.ids.push((id.span, s, reference.is_write()));
            }
        }
    }
    fn visit_static_member_expression(&mut self, e: &oxc_ast::ast::StaticMemberExpression<'b>) {
        if let Expression::Identifier(id) = &e.object
            && self.props.is_some()
            && symbol_of(self.scoping, id) == self.props
        {
            self.members.push((e.span, e.property.name.to_string()));
        }
        walk::walk_static_member_expression(self, e);
    }
    fn visit_object_property(&mut self, p: &ObjectProperty<'b>) {
        if p.shorthand
            && let Expression::Identifier(id) = &p.value
            && let Some(s) = symbol_of(self.scoping, id)
        {
            self.shorthand.push((p.span, s));
        }
        walk::walk_object_property(self, p);
    }
    fn visit_jsx_element_name(&mut self, n: &JSXElementName<'b>) {
        match n {
            JSXElementName::IdentifierReference(id) => {
                if let Some(s) = symbol_of(self.scoping, id) {
                    self.tags.push(s);
                }
            }
            _ => walk::walk_jsx_element_name(self, n),
        }
    }
}

/// Maximal subtrees of the branch content that the island does not touch
/// but that render components or control flow (a nested scope, a list): the
/// candidates for the branch scope's `children` slot, rendered by the
/// enclosing scope as the original Toggle renders `props.children`.
fn slot_candidates<'a>(
    m: &Model<'a>,
    kids: &[Child<'a>],
    touched: &dyn Fn(Span) -> bool,
    out: &mut Vec<Span>,
) {
    for k in kids {
        let span = k.span();
        match k {
            Child::Text(_) => {}
            _ if !touched(span) => {
                if heavy(m, k) {
                    out.push(span);
                }
            }
            Child::Element(el) => {
                if let Tag::Intrinsic(_) = jsx::tag_of(m, &el.opening_element.name)
                    && let Ok(ks) = jsx::children(&el.children)
                {
                    slot_candidates(m, &ks, touched, out);
                }
            }
            Child::Fragment(f) => {
                if let Ok(ks) = jsx::children(&f.children) {
                    slot_candidates(m, &ks, touched, out);
                }
            }
            Child::Expr(_) => {}
        }
    }
}

/// Renders a component, a control-flow builtin, or JSX from an expression.
fn heavy<'a>(m: &Model<'a>, k: &Child<'a>) -> bool {
    match k {
        Child::Text(_) => false,
        Child::Expr(e) => super::graph::refs_expr(m, None, e).has_jsx,
        Child::Fragment(f) => jsx::children(&f.children).is_ok_and(|ks| ks.iter().any(|k| heavy(m, k))),
        Child::Element(el) => match jsx::tag_of(m, &el.opening_element.name) {
            Tag::Intrinsic(_) => jsx::children(&el.children).is_ok_and(|ks| ks.iter().any(|k| heavy(m, k))),
            _ => true,
        },
    }
}

fn sink_one(source: &str, filename: Option<&str>, probe_hosts: &[(String, String)]) -> Option<String> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename).ok()?;
    let program = parse_program(&allocator, source, source_type).ok()?;
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(&program).semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let m = super::model::build_model(source, &program, scoping, probe_hosts.to_vec());
    let a = super::graph::analyze(&m, "i");
    let imports = runtime_imports(&program);
    'groups: for g in &a.groups {
        let k = g.root;
        if g.members != [k] || g.keys.is_empty() {
            continue;
        }
        let comp = &m.comps[k];
        if !comp.block {
            continue;
        }
        let Some(view) = comp.view else { continue };
        let spans: Vec<Span> = g.sites.iter().map(|(c, s)| a.facts[*c].sites[*s].span).collect();
        if g.sites.iter().any(|(c, _)| *c != k) {
            continue;
        }
        let Some(branch) = find_branch(&m, &a, k, view, &spans) else {
            continue;
        };
        let content = children_span(branch)?;
        // --- the state moved into the branch --------------------------------------
        let mut moved: BTreeSet<usize> = g.keys.iter().map(|key| key.1).collect();
        let declared = |set: &BTreeSet<usize>| -> HashSet<SymbolId> {
            set.iter().flat_map(|i| comp.setup[*i].declares()).collect()
        };
        loop {
            let decl = declared(&moved);
            let mut grew = false;
            for (i, item) in comp.setup.iter().enumerate() {
                if moved.contains(&i) {
                    continue;
                }
                if !a.facts[k].item_refs[i].syms.iter().any(|(s, _)| decl.contains(s)) {
                    continue;
                }
                match item {
                    Item::Cell { .. } | Item::Memo { .. } | Item::Event { .. } | Item::Local { .. } => {
                        moved.insert(i);
                        grew = true;
                    }
                    // Setup work that runs with the component (an effect, a
                    // cleanup, a statement) keeps the state where it is.
                    _ => continue 'groups,
                }
            }
            if !grew {
                break;
            }
        }
        let decl = declared(&moved);
        let item_spans: Vec<Span> = moved.iter().map(|i| comp.setup[*i].span()).collect();
        // One declaration per moved statement (a multi-declarator statement
        // stays whole or not at all).
        for (i, item) in comp.setup.iter().enumerate() {
            if !moved.contains(&i) && item_spans.contains(&item.span()) {
                continue 'groups;
            }
        }
        let in_moved = |sp: Span| content.start <= sp.start && sp.end <= content.end
            || item_spans.iter().any(|it| contains(*it, sp));
        // Every use of the moved state is inside the branch or the moved code.
        for s in &decl {
            for r in scoping.get_resolved_references(*s) {
                let sp = nodes.get_node(r.node_id()).kind().span();
                if !in_moved(sp) {
                    continue 'groups;
                }
            }
        }
        // --- the slot --------------------------------------------------------------
        let branch_kids = jsx::children(&branch.children).ok()?;
        let decl_ref_spans: Vec<Span> = decl
            .iter()
            .flat_map(|s| scoping.get_resolved_references(*s))
            .map(|r| nodes.get_node(r.node_id()).kind().span())
            .collect();
        let touched = |sp: Span| {
            spans.iter().any(|s| contains(sp, *s)) || decl_ref_spans.iter().any(|s| contains(sp, *s))
        };
        let mut slots = Vec::new();
        slot_candidates(&m, &branch_kids, &touched, &mut slots);
        let slot = match slots.as_slice() {
            [one] => Some(*one),
            _ => None,
        };
        // --- references of the moved code: captures ----------------------------------
        let props = comp.props;
        let mut refs = RegionRefs {
            scoping,
            props,
            ids: Vec::new(),
            shorthand: Vec::new(),
            members: Vec::new(),
            tags: Vec::new(),
        };
        let stmts: Vec<&Statement<'_>> = comp
            .body_fn
            .map(|f| f.statements().iter().collect())
            .unwrap_or_default();
        for st in &stmts {
            if item_spans.contains(&st.span()) {
                refs.visit_statement(st);
            }
        }
        for kid in &branch.children {
            if slot.is_some_and(|s| contains(s, kid.span())) {
                continue;
            }
            refs.visit_jsx_child(kid);
        }
        let slot_span = slot.unwrap_or(Span::new(u32::MAX, u32::MAX));
        let outside_slot = |sp: Span| !contains(slot_span, sp);
        let root = scoping.root_scope_id();
        let mut captures: Vec<(String, String)> = Vec::new(); // (prop name, caller expression)
        let mut edits: Vec<(Span, String)> = Vec::new();
        let taken: HashSet<String> = HashSet::new();
        let bname = fresh(source, "$b", &taken);
        for (sp, name) in &refs.members {
            if !outside_slot(*sp) {
                continue;
            }
            let caller = format!("{}.{name}", scoping.symbol_name(props?));
            if !captures.iter().any(|(n, _)| n == name) {
                captures.push((name.clone(), caller));
            }
            edits.push((*sp, format!("{bname}.{name}")));
        }
        let shorthand: HashSet<Span> = refs.shorthand.iter().map(|(sp, _)| *sp).collect();
        let capture_sym = |s: SymbolId, captures: &mut Vec<(String, String)>| -> Option<String> {
            if decl.contains(&s) || scoping.symbol_scope_id(s) == root {
                return None;
            }
            let declared_at = scoping.symbol_span(s);
            if item_spans.iter().any(|it| contains(*it, declared_at)) || contains(content, declared_at) {
                return None;
            }
            let n = scoping.symbol_name(s).to_string();
            if !captures.iter().any(|(x, _)| *x == n) {
                captures.push((n.clone(), n.clone()));
            }
            Some(n)
        };
        for (sp, s) in &refs.shorthand {
            if outside_slot(*sp)
                && let Some(n) = capture_sym(*s, &mut captures)
            {
                edits.push((*sp, format!("{n}: {bname}.{n}")));
            }
        }
        let member_spans: Vec<Span> = refs.members.iter().map(|(sp, _)| *sp).collect();
        for (sp, s, write) in &refs.ids {
            if shorthand.contains(sp)
                || !outside_slot(*sp)
                || member_spans.iter().any(|m| contains(*m, *sp))
            {
                continue;
            }
            if let Some(n) = capture_sym(*s, &mut captures) {
                if *write {
                    continue 'groups;
                }
                edits.push((*sp, format!("{bname}.{n}")));
            }
        }
        for t in &refs.tags {
            if !decl.contains(t) && scoping.symbol_scope_id(*t) != root {
                continue 'groups;
            }
        }
        // --- the branch scope -----------------------------------------------------------
        let name = fresh(source, &format!("{}$Show", comp.name), &taken);
        let mut setup = String::new();
        for st in &stmts {
            if item_spans.contains(&st.span()) {
                setup.push_str("  ");
                setup.push_str(&reindent(
                    &splice(source, st.span(), within_span(&edits, st.span())),
                    column(source, st.span().start),
                    "  ",
                ));
                setup.push('\n');
            }
        }
        let mut view_edits = edits.clone();
        if let Some(s) = slot {
            view_edits.push((s, format!("{{{bname}.children}}")));
        }
        let view_text = splice(source, content, within_span(&view_edits, content));
        let view_text = if branch_kids.len() == 1 && matches!(branch_kids[0], Child::Element(_)) {
            view_text.trim().to_string()
        } else {
            format!("<>{view_text}</>")
        };
        let component = match &imports.component {
            Some(local) => local.clone(),
            None => "_$scopeComponent".to_string(),
        };
        let decl_text = format!(
            "const {name} = {component}(function* ({bname}) {{\n{setup}  return function* () {{\n    return ({view_text});\n  }};\n}});\n"
        );
        // --- the enclosing scope: the branch renders the scope ------------------------------
        let mut attrs = String::new();
        for (n, caller) in &captures {
            attrs.push_str(&format!(" {n}={{{caller}}}"));
        }
        let instance = match slot {
            Some(s) => format!("<{name}{attrs}>{}</{name}>", &source[s.start as usize..s.end as usize]),
            None => format!("<{name}{attrs} />"),
        };
        let host = host_statement(&program, view.span())?;
        let mut outer: Vec<(Span, String)> = vec![(content, instance)];
        for sp in &item_spans {
            outer.push((*sp, String::new()));
        }
        let at = host.span().start;
        outer.push((Span::new(at, at), decl_text));
        let mut out = splice(source, Span::new(0, source.len() as u32), outer);
        if imports.component.is_none() {
            out = format!("import {{ $component as _$scopeComponent }} from \"solid-js\";\n{out}");
        }
        return Some(out);
    }
    None
}

/// The edits that fall inside `span` (splice takes the edits of one region).
fn within_span(edits: &[(Span, String)], span: Span) -> Vec<(Span, String)> {
    edits
        .iter()
        .filter(|(sp, _)| contains(span, *sp))
        .cloned()
        .collect()
}

/// The column (in characters) `at` sits at on its line.
fn column(source: &str, at: u32) -> usize {
    let before = &source[..at as usize];
    before.rsplit('\n').next().map_or(0, |line| line.chars().count())
}

/// A statement's text moved to a new place: continuation lines lose the
/// indentation of its original column and take `indent` instead.
fn reindent(text: &str, from: usize, indent: &str) -> String {
    let mut out = String::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
            let strip = line.chars().take(from).take_while(|c| *c == ' ').count();
            out.push_str(indent);
            out.push_str(&line[strip..]);
        } else {
            out.push_str(line);
        }
    }
    out
}

// --- 2. keyed stores ----------------------------------------------------------------

/// The source with every row-keyed store map split into a cell per row, or
/// `None`.
pub(crate) fn split_keyed_stores(source: &str, filename: Option<&str>) -> Option<String> {
    if !source.contains("$store") && !source.contains("createStore") {
        return None;
    }
    let mut src = source.to_string();
    let mut changed = false;
    for _ in 0..16 {
        match split_one(&src, filename) {
            Some(next) => {
                src = next;
                changed = true;
            }
            None => break,
        }
    }
    changed.then_some(src)
}

/// A JSX attribute whose value container holds exactly the node `node`:
/// (attribute span, attribute name, the element's span, the element's tag
/// component).
fn attribute_of(
    nodes: &oxc_semantic::AstNodes<'_>,
    m: &Model<'_>,
    node: oxc_semantic::NodeId,
) -> Option<(Span, String, Span, Option<usize>)> {
    use oxc_ast::AstKind;
    let span = nodes.get_node(node).kind().span();
    let container = nodes.parent_id(node);
    let AstKind::JSXExpressionContainer(c) = nodes.get_node(container).kind() else {
        return None;
    };
    if c.expression.span() != span {
        return None;
    }
    let attr = nodes.parent_id(container);
    let AstKind::JSXAttribute(a) = nodes.get_node(attr).kind() else {
        return None;
    };
    let mut up = nodes.parent_id(attr);
    for _ in 0..3 {
        if let AstKind::JSXElement(el) = nodes.get_node(up).kind() {
            let tag = match jsx::tag_of(m, &el.opening_element.name) {
                Tag::Comp(k) => Some(k),
                _ => None,
            };
            return Some((a.span, a.name.get_identifier().name.to_string(), el.span, tag));
        }
        up = nodes.parent_id(up);
    }
    None
}

/// A row element's render callback: the element is the whole body of an
/// arrow `(x) => <R …/>` that is a `<For>` child. Returns the arrow's
/// parameter symbol.
fn row_callback(
    nodes: &oxc_semantic::AstNodes<'_>,
    m: &Model<'_>,
    program_el: Span,
    el_node: oxc_semantic::NodeId,
) -> Option<SymbolId> {
    use oxc_ast::AstKind;
    let mut up = nodes.parent_id(el_node);
    for _ in 0..4 {
        if let AstKind::ArrowFunctionExpression(f) = nodes.get_node(up).kind() {
            let concise = f
                .body
                .as_expression()
                .is_some_and(|e| e.span().start <= program_el.start && program_el.end <= e.span().end);
            if !concise || f.params.items.len() != 1 {
                return None;
            }
            let BindingPattern::BindingIdentifier(id) = &f.params.items[0].pattern else {
                return None;
            };
            // The arrow is a `<For>` child.
            let container = nodes.parent_id(up);
            let AstKind::JSXExpressionContainer(_) = nodes.get_node(container).kind() else {
                return None;
            };
            let AstKind::JSXElement(flow) = nodes.get_node(nodes.parent_id(container)).kind() else {
                return None;
            };
            if !matches!(jsx::tag_of(m, &flow.opening_element.name), Tag::Builtin(b) if b == "For") {
                return None;
            }
            return id.symbol_id.get();
        }
        up = nodes.parent_id(up);
    }
    None
}

fn split_one(source: &str, filename: Option<&str>) -> Option<String> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename).ok()?;
    let program = parse_program(&allocator, source, source_type).ok()?;
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(&program).semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    let m = super::model::build_model(source, &program, scoping, Vec::new());
    let signal_local = program.body.iter().find_map(|st| {
        let Statement::ImportDeclaration(import) = st else {
            return None;
        };
        if !RUNTIME_SOURCES.contains(&import.source.value.as_str()) {
            return None;
        }
        import.specifiers.iter().flatten().find_map(|s| match s {
            oxc_ast::ast::ImportDeclarationSpecifier::ImportSpecifier(s)
                if s.imported.name() == "$signal" && !s.import_kind.is_type() =>
            {
                Some(s.local.name.to_string())
            }
            _ => None,
        })
    });
    for comp in &m.comps {
        for item in &comp.setup {
            let Item::Cell {
                get,
                set,
                host: super::model::CellHost::Store,
                init,
                ..
            } = item
            else {
                continue;
            };
            if init.is_some_and(|e| FnRef::from_expr(e).is_some()) {
                continue;
            }
            // Every use of the map and its setter is a prop of one row
            // component, rendered by a `<For>` callback.
            let mut row_comp: Option<usize> = None;
            let mut store_attr: Option<String> = None;
            let mut setter_attr: Option<String> = None;
            let mut item_attr: Option<String> = None;
            let mut remove: Vec<Span> = Vec::new();
            let mut ok = true;
            let mut sites = 0usize;
            let uses = |s: SymbolId| scoping.get_resolved_references(s).map(|r| r.node_id()).collect::<Vec<_>>();
            let targets: Vec<(SymbolId, bool)> = std::iter::once((*get, false))
                .chain(set.iter().map(|s| (*s, true)))
                .collect();
            for (sym, is_setter) in targets {
                for node in uses(sym) {
                    let Some((attr_span, name, el_span, Some(r))) = attribute_of(nodes, &m, node) else {
                        ok = false;
                        break;
                    };
                    if row_comp.is_some_and(|x| x != r) {
                        ok = false;
                        break;
                    }
                    row_comp = Some(r);
                    let slot = if is_setter { &mut setter_attr } else { &mut store_attr };
                    if slot.as_ref().is_some_and(|x| *x != name) {
                        ok = false;
                        break;
                    }
                    *slot = Some(name);
                    if is_setter {
                        remove.push(attr_span);
                    } else {
                        sites += 1;
                    }
                    // The row prop: the attribute bound to the callback's
                    // parameter.
                    let mut el_node = nodes.parent_id(node);
                    for _ in 0..6 {
                        if let oxc_ast::AstKind::JSXElement(_) = nodes.get_node(el_node).kind() {
                            break;
                        }
                        el_node = nodes.parent_id(el_node);
                    }
                    let Some(param) = row_callback(nodes, &m, el_span, el_node) else {
                        ok = false;
                        break;
                    };
                    let oxc_ast::AstKind::JSXElement(el) = nodes.get_node(el_node).kind() else {
                        ok = false;
                        break;
                    };
                    let row = jsx::attrs(el).ok().and_then(|attrs| {
                        attrs.iter().find_map(|a| match &a.value {
                            AttrVal::Expr(e) if m.symbol_of_expr(e) == Some(param) => Some(a.name.clone()),
                            _ => None,
                        })
                    });
                    match (row, &item_attr) {
                        (Some(r), None) => item_attr = Some(r),
                        (Some(r), Some(x)) if r == *x => {}
                        _ => {
                            ok = false;
                            break;
                        }
                    }
                }
                if !ok {
                    break;
                }
            }
            let (true, Some(r), Some(store_prop), Some(row_prop)) = (ok, row_comp, store_attr, item_attr) else {
                continue;
            };
            if sites == 0 {
                continue;
            }
            let rc = &m.comps[r];
            if !rc.block {
                continue;
            }
            let Some(keyed) = super::store_paths::row_keyed_uses(
                &m,
                rc,
                &store_prop,
                setter_attr.as_deref(),
                &row_prop,
            ) else {
                continue;
            };
            let Some(props) = rc.props else { continue };
            let pname = scoping.symbol_name(props);
            let Some(body) = rc.body_fn else { continue };
            // --- the rewrite ----------------------------------------------------------
            let taken: HashSet<String> = HashSet::new();
            let cell = fresh(source, &format!("{store_prop}$key"), &taken);
            let setter = fresh(source, &format!("set{}$key", capitalize(&store_prop)), &taken);
            let signal = signal_local.clone().unwrap_or_else(|| "_$scopeSignal".into());
            let mut edits: Vec<(Span, String)> = Vec::new();
            // The row's cell, initialized from its key's value in the map.
            let at = body.body_span().start + 1;
            edits.push((
                Span::new(at, at),
                format!(
                    "\n  const [{cell}, {setter}] = yield* {signal}({pname}.{store_prop}[{pname}.{row_prop}{}]);",
                    keyed.suffix
                ),
            ));
            for sp in &keyed.reads {
                edits.push((*sp, cell.clone()));
            }
            for (call, cb, hits) in &keyed.writes {
                let Some(f) = find_fn(&program, *cb) else {
                    continue;
                };
                let body_span = f.body_span();
                let d_edits: Vec<(Span, String)> = hits.iter().map(|h| (*h, "$d".to_string())).collect();
                let text = splice(source, body_span, d_edits);
                let inner = if f.is_concise() {
                    format!("{{ let $d = $v; ({text}); return $d; }}")
                } else {
                    let t = text.trim();
                    let t = t.strip_prefix('{').and_then(|x| x.strip_suffix('}')).unwrap_or(t);
                    format!("{{ let $d = $v;{t} return $d; }}")
                };
                edits.push((*call, format!("{setter}(($v) => {inner})")));
            }
            // A recursive row forwards the map, never the setter.
            for sp in &keyed.forwarded {
                let text = &source[sp.start as usize..sp.end as usize];
                if setter_attr.as_ref().is_some_and(|s| text.ends_with(&format!(".{s}"))) {
                    // Remove the whole attribute: `name={…}`.
                    let before = &source[..sp.start as usize];
                    if let Some(i) = before.rfind(&format!(" {}={{", setter_attr.as_ref().unwrap())) {
                        edits.push((Span::new(i as u32, sp.end + 1), String::new()));
                    }
                }
            }
            for sp in &remove {
                edits.push((Span::new(sp.start.saturating_sub(1), sp.end), String::new()));
            }
            let mut out = splice(source, Span::new(0, source.len() as u32), edits);
            if signal_local.is_none() {
                out = format!("import {{ $signal as _$scopeSignal }} from \"solid-js\";\n{out}");
            }
            return Some(out);
        }
    }
    None
}

/// The function (arrow or expression) at `span`.
fn find_fn<'a>(program: &'a Program<'a>, span: Span) -> Option<FnRef<'a>> {
    struct F<'a> {
        span: Span,
        found: Option<FnRef<'a>>,
    }
    impl<'a> Visit<'a> for F<'a> {
        fn visit_expression(&mut self, e: &Expression<'a>) {
            if self.found.is_none() && e.span() == self.span {
                let e: &'a Expression<'a> = unsafe { &*(e as *const Expression<'a>) };
                self.found = FnRef::from_expr(e);
                return;
            }
            walk::walk_expression(self, e);
        }
    }
    let mut f = F { span, found: None };
    f.visit_program(program);
    f.found
}

// --- helper generators --------------------------------------------------------------

/// Helper generators declared in a setup, the natural way to name a read in
/// one component (`function* label() { return (yield* first) + " " + (yield*
/// last); }`), inlined at their `yield* helper(args)` sites when the helper
/// is one `return` of an expression and every argument is a plain value
/// (a name, a literal, a member chain): the site reads exactly what the
/// helper reads. Anything else stays and is reported (precisely) by the model.
pub(crate) fn inline_helpers(source: &str, filename: Option<&str>) -> Option<String> {
    if !source.contains("function*") {
        return None;
    }
    let mut src = source.to_string();
    let mut changed = false;
    for _ in 0..32 {
        match inline_one_helper(&src, filename) {
            Some(next) => {
                src = next;
                changed = true;
            }
            None => break,
        }
    }
    changed.then_some(src)
}

fn plain_argument(e: &Expression<'_>) -> bool {
    match e.without_parentheses() {
        Expression::Identifier(_)
        | Expression::StringLiteral(_)
        | Expression::NumericLiteral(_)
        | Expression::BooleanLiteral(_)
        | Expression::NullLiteral(_) => true,
        Expression::StaticMemberExpression(s) => !s.optional && plain_argument(&s.object),
        _ => false,
    }
}

fn inline_one_helper(source: &str, filename: Option<&str>) -> Option<String> {
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(filename).ok()?;
    let program = parse_program(&allocator, source, source_type).ok()?;
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(&program).semantic;
    let scoping = semantic.scoping();
    let nodes = semantic.nodes();
    struct G<'a> {
        found: Vec<&'a Function<'a>>,
        depth: u32,
    }
    impl<'a> Visit<'a> for G<'a> {
        fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
            let f: &'a Function<'a> = unsafe { &*(f as *const Function<'a>) };
            if self.depth > 0 && f.r#type == FunctionType::FunctionDeclaration && f.generator && !f.r#async {
                self.found.push(f);
            }
            self.depth += 1;
            walk::walk_function(self, f, flags);
            self.depth -= 1;
        }
    }
    let mut g = G {
        found: Vec::new(),
        depth: 0,
    };
    g.visit_program(&program);
    'helpers: for f in g.found {
        let Some(sym) = f.id.as_ref().and_then(|i| i.symbol_id.get()) else {
            continue;
        };
        let Some(body) = f.body.as_ref() else { continue };
        let [Statement::ReturnStatement(ret)] = body.statements.as_slice() else {
            continue;
        };
        let Some(expr) = &ret.argument else { continue };
        if f.params.rest.is_some() {
            continue;
        }
        let mut params: Vec<SymbolId> = Vec::new();
        for p in &f.params.items {
            let BindingPattern::BindingIdentifier(id) = &p.pattern else {
                continue 'helpers;
            };
            let Some(s) = id.symbol_id.get() else { continue 'helpers };
            params.push(s);
        }
        // Every reference is `yield* helper(plain args…)`.
        let mut sites: Vec<(Span, Vec<Span>)> = Vec::new();
        for r in scoping.get_resolved_references(sym) {
            use oxc_ast::AstKind;
            let call_node = nodes.parent_id(r.node_id());
            let AstKind::CallExpression(call) = nodes.get_node(call_node).kind() else {
                continue 'helpers;
            };
            if call.callee.span() != nodes.get_node(r.node_id()).kind().span()
                || call.arguments.len() != params.len()
                || !call
                    .arguments
                    .iter()
                    .all(|a| a.as_expression().is_some_and(plain_argument))
            {
                continue 'helpers;
            }
            let AstKind::YieldExpression(y) = nodes.get_node(nodes.parent_id(call_node)).kind() else {
                continue 'helpers;
            };
            if !y.delegate {
                continue 'helpers;
            }
            sites.push((y.span, call.arguments.iter().map(|a| a.span()).collect()));
        }
        if sites.is_empty() {
            continue;
        }
        // The expression's references: parameters are substituted; other
        // bindings must mean the same thing at every site (unique names).
        struct Refs<'s> {
            scoping: &'s Scoping,
            ids: Vec<(Span, SymbolId, bool)>,
            this: bool,
        }
        impl<'b> Visit<'b> for Refs<'_> {
            fn visit_identifier_reference(&mut self, id: &IdentifierReference<'b>) {
                if let Some(r) = id.reference_id.get() {
                    let reference = self.scoping.get_reference(r);
                    if let Some(s) = reference.symbol_id() {
                        self.ids.push((id.span, s, reference.is_write()));
                    }
                }
            }
            fn visit_this_expression(&mut self, _: &oxc_ast::ast::ThisExpression) {
                self.this = true;
            }
        }
        let mut refs = Refs {
            scoping,
            ids: Vec::new(),
            this: false,
        };
        refs.visit_expression(expr);
        if refs.this || source[expr.span().start as usize..expr.span().end as usize].contains("arguments") {
            continue;
        }
        for (_, s, write) in &refs.ids {
            if *write || *s == sym {
                continue 'helpers;
            }
            if params.contains(s) {
                continue;
            }
            let name = scoping.symbol_name(*s);
            if scoping.symbol_ids().filter(|x| scoping.symbol_name(*x) == name).count() != 1 {
                continue 'helpers;
            }
        }
        let mut edits: Vec<(Span, String)> = vec![(f.span, String::new())];
        for (site, args) in &sites {
            let arg_text: Vec<&str> = args
                .iter()
                .map(|a| &source[a.start as usize..a.end as usize])
                .collect();
            let inner: Vec<(Span, String)> = refs
                .ids
                .iter()
                .filter_map(|(sp, s, _)| {
                    params
                        .iter()
                        .position(|p| p == s)
                        .map(|i| (*sp, format!("({})", arg_text[i])))
                })
                .collect();
            let text = splice(source, expr.span(), inner);
            edits.push((*site, format!("({text})")));
        }
        return Some(splice(source, Span::new(0, source.len() as u32), edits));
    }
    None
}
