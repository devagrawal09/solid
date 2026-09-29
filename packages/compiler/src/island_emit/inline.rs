//! Inlining pre-passes: what a component's setup calls becomes part of the
//! setup the island compiler reads.
//!
//! 1. **Imported definitions** (`inline_imports`, cross-module): an import
//!    of a factory (`createTodos()`), a helper generator (`useTodos()`) or a
//!    component from a module whose source the build provides (the Vite
//!    plugin's per-module summaries name them) is replaced by a copy of the
//!    definition and the top-level declarations it needs (its closure),
//!    renamed apart; its runtime imports join the module's, its other
//!    imports are rewritten to absolute paths. The copies are what the
//!    partitioner analyses (flows, liveness, tiers) and what island chunks and
//!    string templates compile; the imported module itself is unchanged.
//! 2. **Factory calls** (`inline_calls`): in a component's setup, `const x =
//!    f(args)` / `f(args)` / `const x = yield* g(args)` of a module-level
//!    function that creates reactive state or reads through blocks (and has
//!    one exit: its final `return`) is replaced by the function's body, its
//!    locals renamed apart, its parameters bound to the arguments, its
//!    `return` bound to the pattern. In a plain component, a provider value
//!    that calls one (`<Ctx value={createTodos()}>`) is first hoisted to the
//!    body (the body and the view run once). Repeated until no call is left.
//!
//! Both are text passes over spans (like the rest of the island compiler);
//! each returns `None` when nothing changes.
use std::collections::{HashMap, HashSet};
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ArrowFunctionExpression, BindingIdentifier, BindingPattern, BindingProperty, CallExpression,
    Declaration, Expression, Function, IdentifierReference, ImportDeclarationSpecifier,
    ImportOrExportKind, JSXAttributeItem, JSXAttributeName, JSXAttributeValue, JSXElement,
    ObjectProperty, Program, PropertyKey, Statement, ThisExpression,
};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{ScopeFlags, Scoping, SemanticBuilder, SymbolId};
use oxc_span::{GetSpan, Span};

use super::jsx::{self, Tag};
use super::model::{self, FnRef, Model, RUNTIME_SOURCES};
use crate::compiler::{parse_program, source_type_for_filename};
use crate::store_scalars::splice;

/// A module whose source the build provides for cross-module inlining.
#[derive(Clone, Debug)]
pub struct ImportedModule {
    /// The specifier as the importing module writes it (`./todos`).
    pub specifier: String,
    /// Its resolved file.
    pub filename: String,
    pub code: String,
}

// --- renaming ------------------------------------------------------------------------

/// Rename symbols by span edits (references, bindings, and shorthand
/// properties / patterns expanded to `key: renamed`).
struct Renamer<'s> {
    scoping: &'s Scoping,
    map: &'s HashMap<SymbolId, String>,
    edits: Vec<(Span, String)>,
}

impl<'a> Visit<'a> for Renamer<'_> {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if let Some(s) = id
            .reference_id
            .get()
            .and_then(|r| self.scoping.get_reference(r).symbol_id())
            && let Some(n) = self.map.get(&s)
        {
            self.edits.push((id.span, n.clone()));
        }
    }
    fn visit_binding_identifier(&mut self, id: &BindingIdentifier<'a>) {
        if let Some(s) = id.symbol_id.get()
            && let Some(n) = self.map.get(&s)
        {
            self.edits.push((id.span, n.clone()));
        }
    }
    fn visit_object_property(&mut self, p: &ObjectProperty<'a>) {
        if p.shorthand
            && let Expression::Identifier(id) = &p.value
            && let Some(s) = id
                .reference_id
                .get()
                .and_then(|r| self.scoping.get_reference(r).symbol_id())
            && let Some(n) = self.map.get(&s)
        {
            self.edits.push((p.span, format!("{}: {n}", id.name)));
            return;
        }
        walk::walk_object_property(self, p);
    }
    fn visit_binding_property(&mut self, p: &BindingProperty<'a>) {
        if p.shorthand
            && let BindingPattern::BindingIdentifier(id) = &p.value
            && let Some(s) = id.symbol_id.get()
            && let Some(n) = self.map.get(&s)
        {
            let key = match &p.key {
                PropertyKey::StaticIdentifier(k) => k.name.to_string(),
                _ => id.name.to_string(),
            };
            self.edits.push((p.span, format!("{key}: {n}")));
            return;
        }
        walk::walk_binding_property(self, p);
    }
}

fn renamed_stmt(src: &str, scoping: &Scoping, map: &HashMap<SymbolId, String>, s: &Statement<'_>) -> String {
    let mut r = Renamer {
        scoping,
        map,
        edits: Vec::new(),
    };
    r.visit_statement(s);
    splice(src, s.span(), r.edits)
}

fn renamed_expr(src: &str, scoping: &Scoping, map: &HashMap<SymbolId, String>, e: &Expression<'_>) -> String {
    let mut r = Renamer {
        scoping,
        map,
        edits: Vec::new(),
    };
    r.visit_expression(e);
    splice(src, e.span(), r.edits)
}

/// Symbols referenced (not declared) anywhere in a node.
struct Refs<'s> {
    scoping: &'s Scoping,
    out: Vec<SymbolId>,
    this: bool,
}

impl<'a> Visit<'a> for Refs<'_> {
    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if let Some(s) = id
            .reference_id
            .get()
            .and_then(|r| self.scoping.get_reference(r).symbol_id())
        {
            self.out.push(s);
        } else if id.name == "arguments" {
            self.this = true;
        }
    }
    fn visit_this_expression(&mut self, _: &ThisExpression) {
        self.this = true;
    }
    // A nested ordinary function has its own `this` / `arguments`.
    fn visit_function(&mut self, f: &Function<'a>, flags: ScopeFlags) {
        let this = self.this;
        walk::walk_function(self, f, flags);
        self.this = this;
    }
}

fn parse<'a>(alloc: &'a Allocator, src: &'a str, filename: Option<&str>) -> Option<(Program<'a>,)> {
    let st = source_type_for_filename(filename).ok()?;
    let program = parse_program(alloc, src, st).ok()?;
    Some((program,))
}

// --- cross-module ----------------------------------------------------------------------

/// Top-level facts of one module: its statements, the symbols each declares,
/// and its exports by name.
struct ModuleFacts {
    /// (statement span, declared symbols, is an import)
    stmts: Vec<(Span, Vec<SymbolId>, bool)>,
    top_of: HashMap<SymbolId, usize>,
    exports: HashMap<String, SymbolId>,
}

fn module_facts(program: &Program<'_>, scoping: &Scoping) -> ModuleFacts {
    let mut f = ModuleFacts {
        stmts: Vec::new(),
        top_of: HashMap::new(),
        exports: HashMap::new(),
    };
    let mut pending: Vec<(Option<String>, SymbolId)> = Vec::new();
    let mut names: Vec<(String, String)> = Vec::new();
    for stmt in &program.body {
        let mut syms = Vec::new();
        let mut import = false;
        let mut exported = false;
        let decl = match stmt {
            Statement::ImportDeclaration(i) => {
                import = true;
                for sp in i.specifiers.iter().flatten() {
                    let local = match sp {
                        ImportDeclarationSpecifier::ImportSpecifier(s) => &s.local,
                        ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => &s.local,
                        ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => &s.local,
                    };
                    if let Some(s) = local.symbol_id.get() {
                        syms.push(s);
                    }
                }
                None
            }
            Statement::ExportDeclaration(e) => {
                exported = true;
                Some(&e.declaration)
            }
            s => s.as_declaration(),
        };
        if let Some(d) = decl {
            match d {
                Declaration::VariableDeclaration(v) => {
                    for d in &v.declarations {
                        model::binding_symbols(&d.id, &mut syms);
                    }
                }
                Declaration::FunctionDeclaration(fun) => {
                    if let Some(s) = fun.id.as_ref().and_then(|i| i.symbol_id.get()) {
                        syms.push(s);
                    }
                }
                Declaration::ClassDeclaration(c) => {
                    if let Some(s) = c.id.as_ref().and_then(|i| i.symbol_id.get()) {
                        syms.push(s);
                    }
                }
                _ => {}
            }
        }
        let i = f.stmts.len();
        for s in &syms {
            f.top_of.insert(*s, i);
        }
        if exported {
            for s in &syms {
                pending.push((None, *s));
            }
        }
        if let Statement::ExportNamedDeclaration(e) = stmt {
            for sp in &e.specifiers {
                names.push((sp.exported.name().to_string(), sp.local.name().to_string()));
            }
        }
        f.stmts.push((stmt.span(), syms, import));
    }
    for (_, s) in pending {
        f.exports.insert(scoping.symbol_name(s).to_string(), s);
    }
    for (exported, local) in names {
        if let Some(s) = f.top_of.keys().find(|s| scoping.symbol_name(**s) == local) {
            f.exports.insert(exported, *s);
        }
    }
    f
}

/// Replace imports of factories / helpers / components (named in `wanted`,
/// by imported name, or all reactive function exports when `wanted` is
/// `None`) from provided modules by renamed copies of their closures.
pub(crate) fn inline_imports(
    source: &str,
    filename: Option<&str>,
    imports: &[ImportedModule],
    components: bool,
) -> Option<String> {
    if imports.is_empty() {
        return None;
    }
    let alloc = Allocator::default();
    let (program,) = parse(&alloc, source, filename)?;
    let sem = SemanticBuilder::new().build(&program).semantic;
    let root_scoping = sem.scoping();
    // Root names (to rename imported bindings apart) and its runtime imports.
    let mut taken: HashSet<String> = root_scoping
        .symbol_ids()
        .map(|s| root_scoping.symbol_name(s).to_string())
        .collect();
    let mut root_runtime: HashMap<(String, String), String> = HashMap::new();
    let mut last_import_end = 0u32;
    for stmt in &program.body {
        if let Statement::ImportDeclaration(i) = stmt {
            last_import_end = i.span.end;
            if RUNTIME_SOURCES.contains(&i.source.value.as_str()) && i.import_kind != ImportOrExportKind::Type {
                for sp in i.specifiers.iter().flatten() {
                    if let ImportDeclarationSpecifier::ImportSpecifier(s) = sp
                        && s.import_kind != ImportOrExportKind::Type
                    {
                        root_runtime.insert(
                            (i.source.value.to_string(), s.imported.name().to_string()),
                            s.local.name.to_string(),
                        );
                    }
                }
            }
        }
    }
    let mut root_edits: Vec<(Span, String)> = Vec::new();
    let mut inlined = String::new();
    let mut k = 0usize;
    for stmt in &program.body {
        let Statement::ImportDeclaration(i) = stmt else {
            continue;
        };
        if i.import_kind == ImportOrExportKind::Type {
            continue;
        }
        let Some(module) = imports.iter().find(|m| m.specifier == i.source.value.as_str()) else {
            continue;
        };
        // The imported module.
        let alloc2 = Allocator::default();
        let Some((mprog,)) = parse(&alloc2, &module.code, Some(&module.filename)) else {
            continue;
        };
        let msem = SemanticBuilder::new().with_build_nodes(true).build(&mprog).semantic;
        let mscoping = msem.scoping();
        let mm = model::build_model(&module.code, &mprog, mscoping, Vec::new());
        let facts = module_facts(&mprog, mscoping);
        // Which specifiers to inline: (imported name → root local name).
        let mut take: Vec<(SymbolId, String, Span)> = Vec::new();
        let mut kept: Vec<Span> = Vec::new();
        let specs: Vec<&ImportDeclarationSpecifier<'_>> = i.specifiers.iter().flatten().collect();
        for sp in &specs {
            let ImportDeclarationSpecifier::ImportSpecifier(s) = sp else {
                kept.push(sp.span());
                continue;
            };
            if s.import_kind == ImportOrExportKind::Type {
                kept.push(sp.span());
                continue;
            }
            let name = s.imported.name().to_string();
            let Some(&sym) = facts.exports.get(&name) else {
                kept.push(sp.span());
                continue;
            };
            let wanted = if mm.comp_of.contains_key(&sym) {
                components
            } else {
                reactive_function(&mm, &mprog, sym)
            };
            if wanted {
                take.push((sym, s.local.name.to_string(), sp.span()));
            } else {
                kept.push(sp.span());
            }
        }
        if take.is_empty() {
            continue;
        }
        k += 1;
        // Closure over top-level statements. An exported value it reads (a
        // context, a class, shared state) keeps its identity: it is imported
        // from the module, not copied.
        let export_name: HashMap<SymbolId, &String> =
            facts.exports.iter().map(|(n, s)| (*s, n)).collect();
        let taken_syms: HashSet<SymbolId> = take.iter().map(|t| t.0).collect();
        let mut external: Vec<SymbolId> = Vec::new();
        let mut need: Vec<usize> = Vec::new();
        let mut seen: HashSet<usize> = HashSet::new();
        let mut stack: Vec<SymbolId> = take.iter().map(|t| t.0).collect();
        while let Some(s) = stack.pop() {
            let Some(&ti) = facts.top_of.get(&s) else { continue };
            if export_name.contains_key(&s)
                && !taken_syms.contains(&s)
                && function_of(&mprog, s).is_none()
                && !mm.comp_of.contains_key(&s)
            {
                if !external.contains(&s) {
                    external.push(s);
                }
                continue;
            }
            if !seen.insert(ti) {
                continue;
            }
            need.push(ti);
            if facts.stmts[ti].2 {
                continue; // an import: its specifiers are rewritten below
            }
            let stmt = &mprog.body[ti];
            let mut r = Refs {
                scoping: mscoping,
                out: Vec::new(),
                this: false,
            };
            r.visit_statement(stmt);
            stack.extend(r.out);
        }
        need.sort();
        // Names: the inlined entries take the root's local names; every other
        // closure binding is renamed apart (runtime imports reuse the root's).
        let mut map: HashMap<SymbolId, String> = HashMap::new();
        for (sym, local, _) in &take {
            map.insert(*sym, local.clone());
        }
        let mut import_lines = Vec::new();
        for s in &external {
            let name = export_name[s];
            // The root's own import of it, if any; else a new one.
            let local = specs.iter().find_map(|sp| match sp {
                ImportDeclarationSpecifier::ImportSpecifier(x)
                    if x.imported.name() == name.as_str()
                        && x.import_kind != ImportOrExportKind::Type =>
                {
                    Some(x.local.name.to_string())
                }
                _ => None,
            });
            let local = match local {
                Some(l) => l,
                None => {
                    let n = fresh(&mut taken, name, k);
                    import_lines.push(format!(
                        "import {{ {name} as {n} }} from {};",
                        super::client_js_str(i.source.value.as_str())
                    ));
                    n
                }
            };
            map.insert(*s, local);
        }
        for &ti in &need {
            let (_, syms, is_import) = &facts.stmts[ti];
            if *is_import {
                let Statement::ImportDeclaration(imp) = &mprog.body[ti] else { continue };
                let src = imp.source.value.as_str();
                let runtime = RUNTIME_SOURCES.contains(&src);
                let target = if runtime || !src.starts_with('.') {
                    src.to_string()
                } else {
                    absolute(&module.filename, src)
                };
                let mut named = Vec::new();
                for sp in imp.specifiers.iter().flatten() {
                    let is_type = matches!(sp, ImportDeclarationSpecifier::ImportSpecifier(s) if s.import_kind == ImportOrExportKind::Type);
                    let (local, imported) = match sp {
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
                    let Some(ls) = local.symbol_id.get() else { continue };
                    if !syms.contains(&ls) || !closure_uses(&mprog, &need, ti, mscoping, ls) {
                        continue;
                    }
                    let lname = local.name.to_string();
                    let new = if runtime
                        && !is_type
                        && let Some(r) = root_runtime.get(&(src.to_string(), imported.clone()))
                    {
                        map.insert(ls, r.clone());
                        continue;
                    } else if runtime && !taken.contains(&lname) {
                        lname.clone()
                    } else {
                        fresh(&mut taken, &lname, k)
                    };
                    taken.insert(new.clone());
                    map.insert(ls, new.clone());
                    if runtime && !is_type {
                        root_runtime.insert((src.to_string(), imported.clone()), new.clone());
                    }
                    let spec = match imported.as_str() {
                        "*" => format!("* as {new}"),
                        "default" => format!("default as {new}"),
                        _ if imported == new => imported.clone(),
                        _ => format!("{imported} as {new}"),
                    };
                    named.push(if is_type { format!("type {spec}") } else { spec });
                }
                if !named.is_empty() {
                    let ns = named.iter().find(|n| n.starts_with("* as "));
                    if let Some(ns) = ns {
                        import_lines.push(format!("import {ns} from {};", super::client_js_str(&target)));
                    }
                    let rest: Vec<&String> = named.iter().filter(|n| !n.starts_with("* as ")).collect();
                    if !rest.is_empty() {
                        import_lines.push(format!(
                            "import {{ {} }} from {};",
                            rest.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "),
                            super::client_js_str(&target)
                        ));
                    }
                }
            } else {
                for s in syms {
                    if !map.contains_key(s) {
                        let n = fresh(&mut taken, mscoping.symbol_name(*s), k);
                        map.insert(*s, n);
                    }
                }
            }
        }
        let mut body = String::new();
        for &ti in &need {
            if facts.stmts[ti].2 {
                continue;
            }
            let stmt = &mprog.body[ti];
            let text = renamed_stmt(&module.code, mscoping, &map, stmt);
            let text = strip_export(&text);
            body.push_str(&text);
            body.push('\n');
        }
        inlined.push_str(&format!("\n// inlined from {}\n", module.specifier));
        for l in &import_lines {
            inlined.push_str(l);
            inlined.push('\n');
        }
        inlined.push_str(&body);
        // The root's import: drop the inlined specifiers (and the statement
        // when nothing is left).
        if kept.is_empty() {
            root_edits.push((i.span, String::new()));
        } else {
            for (_, _, span) in &take {
                // Remove `spec` and its separating comma.
                let after = &source[span.end as usize..];
                let comma = after.find(',').filter(|c| after[..*c].trim().is_empty());
                let end = comma.map_or(span.end, |c| {
                    let rest = &after[c + 1..];
                    let ws = rest.len() - rest.trim_start_matches([' ', '\t']).len();
                    span.end + (c + 1 + ws) as u32
                });
                root_edits.push((Span::new(span.start, end), String::new()));
            }
        }
    }
    if inlined.is_empty() {
        return None;
    }
    root_edits.push((Span::new(last_import_end, last_import_end), inlined));
    Some(splice(source, Span::new(0, source.len() as u32), root_edits))
}

fn closure_uses(program: &Program<'_>, need: &[usize], import: usize, scoping: &Scoping, sym: SymbolId) -> bool {
    need.iter().any(|&ti| {
        if ti == import {
            return false;
        }
        let mut r = Refs {
            scoping,
            out: Vec::new(),
            this: false,
        };
        r.visit_statement(&program.body[ti]);
        r.out.contains(&sym)
    })
}

fn strip_export(text: &str) -> String {
    let t = text.trim_start();
    if let Some(rest) = t.strip_prefix("export default ") {
        return rest.to_string();
    }
    if let Some(rest) = t.strip_prefix("export ") {
        return rest.to_string();
    }
    text.to_string()
}

fn absolute(from: &str, spec: &str) -> String {
    let base = Path::new(from).parent().unwrap_or(Path::new("/"));
    let mut out: Vec<String> = base
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    for part in spec.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                out.pop();
            }
            p => out.push(p.to_string()),
        }
    }
    let joined = out.join("/");
    if joined.starts_with("//") {
        joined[1..].to_string()
    } else {
        joined
    }
}

fn fresh(taken: &mut HashSet<String>, base: &str, k: usize) -> String {
    let mut n = format!("{base}$m{k}");
    let mut i = 0;
    while taken.contains(&n) {
        i += 1;
        n = format!("{base}$m{k}_{i}");
    }
    taken.insert(n.clone());
    n
}

/// A module-level function that is not a component and creates reactive
/// state or reads through blocks: a factory or a helper generator.
fn reactive_function(m: &Model<'_>, program: &Program<'_>, sym: SymbolId) -> bool {
    let Some(f) = function_of(program, sym) else {
        return false;
    };
    if matches!(f, FnRef::Func(func) if func.generator) {
        return true;
    }
    let refs = super::graph::refs_fn(m, None, f);
    refs.syms.iter().any(|(s, _)| m.runtime.contains_key(s))
}

/// The function a top-level binding names (`function f` / `const f = …`).
fn function_of<'a>(program: &'a Program<'a>, sym: SymbolId) -> Option<FnRef<'a>> {
    for stmt in &program.body {
        let decl = match stmt {
            Statement::ExportDeclaration(e) => Some(&e.declaration),
            s => s.as_declaration(),
        };
        match decl {
            Some(Declaration::FunctionDeclaration(f))
                if f.id.as_ref().and_then(|i| i.symbol_id.get()) == Some(sym) =>
            {
                return Some(FnRef::Func(f));
            }
            Some(Declaration::VariableDeclaration(v)) => {
                for d in &v.declarations {
                    if let BindingPattern::BindingIdentifier(id) = &d.id
                        && id.symbol_id.get() == Some(sym)
                    {
                        return d.init.as_ref().and_then(FnRef::from_expr);
                    }
                }
            }
            _ => {}
        }
    }
    None
}

// --- factory calls in setups ---------------------------------------------------------------

/// Inline factory / helper calls in component setups (repeatedly).
pub(crate) fn inline_calls(source: &str, filename: Option<&str>) -> Option<String> {
    let mut cur: Option<String> = None;
    for _ in 0..6 {
        let src = cur.as_deref().unwrap_or(source);
        match inline_calls_once(src, filename) {
            Some(next) => cur = Some(next),
            None => break,
        }
    }
    cur
}

struct Candidate<'a> {
    f: FnRef<'a>,
    /// Symbols the function declares at its top level (params, body).
    own: Vec<SymbolId>,
    /// Names it references that resolve outside the function.
    free: HashSet<String>,
}

fn inline_calls_once(source: &str, filename: Option<&str>) -> Option<String> {
    let alloc = Allocator::default();
    let (program,) = parse(&alloc, source, filename)?;
    let sem = SemanticBuilder::new().with_build_nodes(true).build(&program).semantic;
    let scoping = sem.scoping();
    let m = model::build_model(source, &program, scoping, Vec::new());
    // Candidate functions.
    let mut cands: HashMap<SymbolId, Candidate<'_>> = HashMap::new();
    for t in &m.top {
        if t.import || t.comp.is_some() {
            continue;
        }
        for &sym in &t.symbols {
            let Some(f) = function_of(&program, sym) else { continue };
            if !reactive_function(&m, &program, sym) {
                continue;
            }
            if let Some(c) = candidate(&m, scoping, sym, f) {
                cands.insert(sym, c);
            }
        }
    }
    if cands.is_empty() {
        return None;
    }
    let mut edits: Vec<(Span, String)> = Vec::new();
    let mut n = 0usize;
    let mut taken: HashSet<String> = scoping
        .symbol_ids()
        .map(|s| scoping.symbol_name(s).to_string())
        .collect();
    for c in &m.comps {
        let Some(body) = c.body_fn else { continue };
        if body.is_concise() {
            continue;
        }
        let stmts = body.statements();
        // Names the setup declares (a free name of the inlined body must not
        // resolve to one of them).
        let mut declared: HashSet<String> = HashSet::new();
        for s in stmts {
            if let Statement::VariableDeclaration(v) = s {
                for d in &v.declarations {
                    let mut syms = Vec::new();
                    model::binding_symbols(&d.id, &mut syms);
                    declared.extend(syms.iter().map(|s| scoping.symbol_name(*s).to_string()));
                }
            }
        }
        let mut hoisted = Vec::new();
        for (idx, s) in stmts.iter().enumerate() {
            let last = idx + 1 == stmts.len();
            // The view (plain component: the final return's JSX): hoist a
            // provider value that calls a candidate.
            if last {
                if !c.block
                    && let Statement::ReturnStatement(r) = s
                    && let Some(arg) = &r.argument
                {
                    for (span, call) in provider_calls(&m, arg, &cands) {
                        n += 1;
                        let v = fresh_call(&mut taken, "$h", n);
                        let text = m.text(call.span).to_string();
                        hoisted.push(format!("const {v} = {text};"));
                        edits.push((span, v));
                    }
                    if !hoisted.is_empty() {
                        edits.push((Span::new(s.span().start, s.span().start), hoisted.join("\n") + "\n"));
                        hoisted.clear();
                    }
                }
                continue;
            }
            let (target, call, yielded) = match s {
                Statement::VariableDeclaration(v) if v.declarations.len() == 1 => {
                    let d = &v.declarations[0];
                    let Some(init) = &d.init else { continue };
                    let (e, y) = match model::yield_delegate(init) {
                        Some(inner) => (inner, true),
                        None => (init, false),
                    };
                    let Some(call) = model::call_of(e) else { continue };
                    (Some((v.kind.as_str(), m.text(d.id.span()))), call, y)
                }
                Statement::ExpressionStatement(es) => {
                    let (e, y) = match model::yield_delegate(&es.expression) {
                        Some(inner) => (inner, true),
                        None => (&es.expression, false),
                    };
                    let Some(call) = model::call_of(e) else { continue };
                    (None, call, y)
                }
                _ => continue,
            };
            let Some(sym) = m.symbol_of_expr(&call.callee) else { continue };
            let Some(cand) = cands.get(&sym) else { continue };
            let generator = matches!(cand.f, FnRef::Func(f) if f.generator);
            if generator != yielded {
                continue;
            }
            if cand.free.iter().any(|f| declared.contains(f)) {
                continue;
            }
            n += 1;
            let Some(text) = expand(&m, scoping, cand, call, target, &mut taken, n) else {
                continue;
            };
            edits.push((s.span(), text));
        }
    }
    if edits.is_empty() {
        return None;
    }
    Some(splice(source, Span::new(0, source.len() as u32), edits))
}

fn fresh_call(taken: &mut HashSet<String>, base: &str, n: usize) -> String {
    let mut v = format!("{base}{n}");
    let mut i = 0;
    while taken.contains(&v) {
        i += 1;
        v = format!("{base}{n}_{i}");
    }
    taken.insert(v.clone());
    v
}

/// A function with one exit (its final statement returns, or none does),
/// simple parameters, no `this` / `arguments`, not recursive.
fn candidate<'a>(m: &Model<'a>, scoping: &Scoping, sym: SymbolId, f: FnRef<'a>) -> Option<Candidate<'a>> {
    if f.is_concise() {
        return None;
    }
    let mut own = Vec::new();
    for p in &f.params().items {
        let BindingPattern::BindingIdentifier(id) = &p.pattern else {
            return None;
        };
        own.push(id.symbol_id.get()?);
    }
    if f.params().rest.is_some() {
        return None;
    }
    let stmts = f.statements();
    let mut returns = Returns(0);
    for s in stmts {
        returns.visit_statement(s);
    }
    let last_returns = matches!(stmts.last(), Some(Statement::ReturnStatement(_)));
    if returns.0 > usize::from(last_returns) {
        return None;
    }
    for s in stmts {
        match s {
            Statement::VariableDeclaration(v) => {
                for d in &v.declarations {
                    model::binding_symbols(&d.id, &mut own);
                }
            }
            Statement::FunctionDeclaration(fd) => {
                if let Some(s) = fd.id.as_ref().and_then(|i| i.symbol_id.get()) {
                    own.push(s);
                }
            }
            Statement::ClassDeclaration(_) => return None,
            _ => {}
        }
    }
    let mut r = Refs {
        scoping,
        out: Vec::new(),
        this: false,
    };
    for s in stmts {
        r.visit_statement(s);
    }
    if r.this || r.out.contains(&sym) {
        return None;
    }
    let span = f.span();
    let free = r
        .out
        .iter()
        .filter(|s| {
            let d = scoping.symbol_span(**s);
            !(span.start <= d.start && d.end <= span.end)
        })
        .map(|s| scoping.symbol_name(*s).to_string())
        .collect();
    let _ = m;
    Some(Candidate { f, own, free })
}

/// Count `return`s of the function itself (not of nested functions).
struct Returns(usize);

impl<'a> Visit<'a> for Returns {
    fn visit_return_statement(&mut self, r: &oxc_ast::ast::ReturnStatement<'a>) {
        self.0 += 1;
        walk::walk_return_statement(self, r);
    }
    fn visit_function(&mut self, _: &Function<'a>, _: ScopeFlags) {}
    fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
}

fn expand(
    m: &Model<'_>,
    scoping: &Scoping,
    cand: &Candidate<'_>,
    call: &CallExpression<'_>,
    target: Option<(&str, &str)>,
    taken: &mut HashSet<String>,
    n: usize,
) -> Option<String> {
    let mut map: HashMap<SymbolId, String> = HashMap::new();
    for s in &cand.own {
        let base = scoping.symbol_name(*s);
        let mut v = format!("{base}$f{n}");
        let mut i = 0;
        while taken.contains(&v) {
            i += 1;
            v = format!("{base}$f{n}_{i}");
        }
        taken.insert(v.clone());
        map.insert(*s, v);
    }
    let mut out = String::new();
    for (i, p) in cand.f.params().items.iter().enumerate() {
        let BindingPattern::BindingIdentifier(id) = &p.pattern else {
            return None;
        };
        let name = &map[&id.symbol_id.get()?];
        let arg = match call.arguments.get(i) {
            Some(a) => m.text(a.span()).to_string(),
            None => "undefined".into(),
        };
        out.push_str(&format!("const {name} = {arg};\n"));
    }
    if call.arguments.len() > cand.f.params().items.len()
        && call.arguments.iter().skip(cand.f.params().items.len()).any(|a| a.is_spread())
    {
        return None;
    }
    let src = m.src;
    let stmts = cand.f.statements();
    for (i, s) in stmts.iter().enumerate() {
        if i + 1 == stmts.len()
            && let Statement::ReturnStatement(r) = s
        {
            let v = match &r.argument {
                Some(e) => renamed_expr(src, scoping, &map, e),
                None => "undefined".into(),
            };
            match target {
                Some((kind, pat)) => out.push_str(&format!("{kind} {pat} = {v};\n")),
                None => out.push_str(&format!("{v};\n")),
            }
            continue;
        }
        out.push_str(&renamed_stmt(src, scoping, &map, s));
        out.push('\n');
    }
    if !matches!(stmts.last(), Some(Statement::ReturnStatement(_)))
        && let Some((kind, pat)) = target
    {
        out.push_str(&format!("{kind} {pat} = undefined;\n"));
    }
    Some(out)
}

/// `value={f(…)}` on a context provider in a view, outside render callbacks
/// and `Show` / `For` content: (the expression's span, the call).
fn provider_calls<'a>(
    m: &Model<'a>,
    view: &'a Expression<'a>,
    cands: &HashMap<SymbolId, Candidate<'_>>,
) -> Vec<(Span, &'a CallExpression<'a>)> {
    let mut out = Vec::new();
    let Some(root) = jsx::root_of(view) else {
        return out;
    };
    fn walk_el<'a>(
        m: &Model<'a>,
        el: &'a JSXElement<'a>,
        cands: &HashMap<SymbolId, Candidate<'_>>,
        out: &mut Vec<(Span, &'a CallExpression<'a>)>,
    ) {
        let tag = jsx::tag_of(m, &el.opening_element.name);
        if let Tag::Builtin(b) = &tag
            && (b == "Show" || b == "For")
        {
            return;
        }
        if let Tag::Provider(_) = tag {
            for a in &el.opening_element.attributes {
                if let JSXAttributeItem::Attribute(a) = a
                    && let JSXAttributeName::Identifier(n) = &a.name
                    && n.name == "value"
                    && let Some(JSXAttributeValue::ExpressionContainer(c)) = &a.value
                    && let Some(e) = c.expression.as_expression()
                    && let Some(call) = model::call_of(e)
                    && m.symbol_of_expr(&call.callee).is_some_and(|s| cands.contains_key(&s))
                {
                    out.push((e.span(), call));
                }
            }
        }
        for k in &el.children {
            if let oxc_ast::ast::JSXChild::Element(c) = k {
                walk_el(m, c, cands, out);
            } else if let oxc_ast::ast::JSXChild::Fragment(f) = k {
                for k2 in &f.children {
                    if let oxc_ast::ast::JSXChild::Element(c) = k2 {
                        walk_el(m, c, cands, out);
                    }
                }
            }
        }
    }
    match root {
        jsx::Root::Element(el) => walk_el(m, el, cands, &mut out),
        jsx::Root::Fragment(f) => {
            for k in &f.children {
                if let oxc_ast::ast::JSXChild::Element(c) = k {
                    walk_el(m, c, cands, &mut out);
                }
            }
        }
    }
    out
}

// --- summaries -----------------------------------------------------------------------------

/// A module's islands summary: its exports by kind and its relative imports
/// (what the bundler plugin's cross-module pass reads to decide which module
/// sources an importer's compile needs). JSON:
/// `{ exports: [{ name, kind }], imports: [{ specifier, names }] }`, `kind`
/// one of `component`, `factory` (a function creating reactive state),
/// `helper` (a generator read with `yield*`), `function`, `value`.
pub fn island_exports(source: &str, filename: Option<&str>) -> String {
    let mut w = crate::capabilities::JsonWriter::default();
    w.begin_object();
    let alloc = Allocator::default();
    let Some((program,)) = parse(&alloc, source, filename) else {
        w.key("error");
        w.string("parse error");
        w.end_object();
        return w.out;
    };
    let sem = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let scoping = sem.scoping();
    let m = model::build_model(source, &program, scoping, Vec::new());
    let facts = module_facts(&program, scoping);
    let mut exports: Vec<(&String, &SymbolId)> = facts.exports.iter().collect();
    exports.sort();
    w.key("exports");
    w.begin_array();
    for (name, sym) in exports {
        let kind = if m.comp_of.contains_key(sym) {
            "component"
        } else if let Some(f) = function_of(&program, *sym) {
            if matches!(f, FnRef::Func(func) if func.generator) {
                "helper"
            } else if reactive_function(&m, &program, *sym) {
                "factory"
            } else {
                "function"
            }
        } else {
            "value"
        };
        w.begin_object();
        w.key("name");
        w.string(name);
        w.key("kind");
        w.string(kind);
        w.end_object();
    }
    w.end_array();
    // Server functions (`"use server"` module or functions) and the ones
    // marked `@taint`: an importing module's calls of them can be frames.
    w.key("useServer");
    w.boolean(
        program
            .directives
            .iter()
            .any(|d| d.directive.as_str() == "use server"),
    );
    let mut server: Vec<(&String, bool)> = facts
        .exports
        .iter()
        .filter_map(|(name, sym)| m.server_fns.get(sym).map(|f| (name, f.tainted)))
        .collect();
    server.sort();
    w.key("serverFunctions");
    w.begin_array();
    for (n, _) in &server {
        w.string(n);
    }
    w.end_array();
    w.key("tainted");
    w.begin_array();
    for (n, t) in &server {
        if *t {
            w.string(n);
        }
    }
    w.end_array();
    w.key("imports");
    w.begin_array();
    for stmt in &program.body {
        let Statement::ImportDeclaration(i) = stmt else {
            continue;
        };
        if i.import_kind == ImportOrExportKind::Type || !i.source.value.starts_with('.') {
            continue;
        }
        w.begin_object();
        w.key("specifier");
        w.string(i.source.value.as_str());
        w.key("names");
        w.begin_array();
        for sp in i.specifiers.iter().flatten() {
            if let ImportDeclarationSpecifier::ImportSpecifier(s) = sp
                && s.import_kind != ImportOrExportKind::Type
            {
                w.string(&s.imported.name());
            }
        }
        w.end_array();
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.out
}

// --- imported contexts ---------------------------------------------------------------------

/// Contexts imported from provided modules (`export const Ctx =
/// createContext(…)` there): the model reads them as the module's own
/// contexts (providers and `yield* Ctx` reads), keeping their identity.
pub(crate) fn imported_contexts(program: &Program<'_>, imports: &[ImportedModule]) -> Vec<SymbolId> {
    let mut out = Vec::new();
    for stmt in &program.body {
        let Statement::ImportDeclaration(i) = stmt else {
            continue;
        };
        let Some(module) = imports.iter().find(|x| x.specifier == i.source.value.as_str()) else {
            continue;
        };
        let alloc = Allocator::default();
        let Some((mprog,)) = parse(&alloc, &module.code, Some(&module.filename)) else {
            continue;
        };
        let msem = SemanticBuilder::new().build(&mprog).semantic;
        let mscoping = msem.scoping();
        let mm = model::build_model(&module.code, &mprog, mscoping, Vec::new());
        let facts = module_facts(&mprog, mscoping);
        for sp in i.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(s) = sp else {
                continue;
            };
            let Some(sym) = facts.exports.get(s.imported.name().as_str()) else {
                continue;
            };
            if mm.contexts.contains_key(sym)
                && let Some(local) = s.local.symbol_id.get()
            {
                out.push(local);
            }
        }
    }
    out
}
