//! Compiled islands over the v2 block graph
//! (documentation/plans/ssr-hydration-redesign.md §3, "Compiler emission").
//!
//! One pass over a module produces both halves of the page and the
//! manifest that ties them together:
//!
//! - **partition** (`graph.rs`): the live parts of the block graph become
//!   islands — cells some handler or effect writes, the holes that read them,
//!   the handlers — joined across components through props and context;
//!   everything else is inert HTML;
//! - **tiers** (`graph.rs`): each island group gets the smallest runtime its
//!   graph allows (island-runtime-tiers.md §1);
//! - **server** (`server.rs`): string-template functions, anchors and the
//!   islands' serialized values only;
//! - **client** (`client.rs`): one activation chunk per island group, lowered
//!   to tier 0 (the t0 helper), or the kernel's API (bound to the kernel at
//!   tier 1, the core at tier 2).
//!
//! A module the compiler cannot compile to islands (an unsupported construct
//! anywhere, or a group that needs tier 2: stores, async, optimistic writes,
//! actions, boundaries in live regions) falls back as a whole to today's
//! hydration: the server and client outputs are the ordinary hydratable
//! compiles, and the manifest says why.
mod callforms;
mod client;
mod graph;
mod inline;
mod jsx;
mod model;
mod server;
mod store_paths;
mod tx;

pub use inline::{ImportedModule, island_exports};
use oxc_allocator::Allocator;
use oxc_semantic::SemanticBuilder;

use crate::capabilities::JsonWriter;
use crate::compiler::{CompileOptions, Generate, compile, parse_program, source_type_for_filename};
use crate::error::CompileError;

fn json_str(s: &str) -> String {
    let mut w = JsonWriter::default();
    w.string(s);
    w.out
}

pub(crate) fn client_js_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Options of [`compile_islands`].
#[derive(Clone, Debug)]
pub struct IslandOptions {
    pub filename: Option<String>,
    /// Prefix of this module's island ids (unique per app; the bundler plugin
    /// assigns one per module).
    pub id_prefix: String,
    /// Module specifiers the activation chunks import per tier.
    pub t0_module: String,
    pub kernel_module: String,
    pub core_module: String,
    /// Bind tier-1 groups to the core (a page that already loads it).
    pub tier1_core: bool,
    /// Raise every group to at least this tier (measurements: 1 runs tier-0
    /// groups on the kernel, 2 on the core).
    pub min_tier: u8,
    /// Instrumented output (labels on tier-0 cells, reads through `get`).
    pub debug: bool,
    /// Dev builds: chunks export `verify(anchor)` (the dev verifier).
    pub verify: bool,
    /// Probe cell hosts, `object.method` (the conformance harness's `h.signal`).
    pub probe_hosts: Vec<String>,
    /// Module name for the fallback compiles.
    pub module_name: String,
    /// Sources of relatively imported modules (cross-module inlining of
    /// factories, helper generators and components; the bundler plugin
    /// provides those its per-module summaries name).
    pub imports: Vec<ImportedModule>,
}

impl Default for IslandOptions {
    fn default() -> Self {
        Self {
            filename: None,
            id_prefix: "i".into(),
            t0_module: "@solidjs/signals/t0".into(),
            kernel_module: "@solidjs/signals/kernel".into(),
            core_module: "@solidjs/signals".into(),
            tier1_core: false,
            min_tier: 0,
            debug: false,
            verify: false,
            probe_hosts: Vec::new(),
            module_name: crate::compiler::DEFAULT_MODULE_NAME.into(),
            imports: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct IslandChunk {
    pub id: String,
    pub code: String,
}

#[derive(Clone, Debug)]
pub struct IslandsOutput {
    /// The server module (string templates), or the hydratable SSR compile
    /// on fallback.
    pub server: String,
    /// On fallback only: the hydratable DOM compile of the module.
    pub client: Option<String>,
    pub chunks: Vec<IslandChunk>,
    /// JSON: `{ version, fallback, islands: [...], components: [...] }`.
    pub manifest: String,
    pub fallback: Option<String>,
}

pub fn compile_islands(
    original: &str,
    opts: &IslandOptions,
) -> Result<IslandsOutput, CompileError> {
    let first = compile_pass(original, opts, false)?;
    // Imported components the module renders with live state (or inside an
    // island's DOM) are compiled as part of it: inline them and retry.
    if let Some(reason) = &first.fallback
        && !opts.imports.is_empty()
        && [
            "outside the module",
            "variable-size region",
            "no fixed path",
        ]
        .iter()
        .any(|k| reason.contains(k))
    {
        let second = compile_pass(original, opts, true)?;
        match &second.fallback {
            None => return Ok(second),
            Some(r2) if r2 != reason => {
                let why = format!("{reason} (with its imported components inlined: {r2})");
                return Ok(IslandsOutput {
                    manifest: first.manifest.replacen(
                        &format!("\"fallback\":{}", json_str(reason)),
                        &format!("\"fallback\":{}", json_str(&why)),
                        1,
                    ),
                    fallback: Some(why),
                    ..first
                });
            }
            _ => {}
        }
    }
    Ok(first)
}

/// The source the partitioner reads: imported definitions inlined (with
/// components when `components`), call forms as JSX, factory calls in
/// setups inlined.
fn prepare(original: &str, opts: &IslandOptions, components: bool) -> Option<String> {
    let f = opts.filename.as_deref();
    let a = inline::inline_imports(original, f, &opts.imports, components);
    let s1 = a.as_deref().unwrap_or(original);
    let b = callforms::rewrite(s1, f);
    let s2 = b.as_deref().unwrap_or(s1);
    let c = inline::inline_calls(s2, f);
    c.or(b).or(a)
}

fn compile_pass(
    original: &str,
    opts: &IslandOptions,
    components: bool,
) -> Result<IslandsOutput, CompileError> {
    let rewritten = prepare(original, opts, components);
    let source = rewritten.as_deref().unwrap_or(original);
    let allocator = Allocator::default();
    let source_type = source_type_for_filename(opts.filename.as_deref())?;
    let program = parse_program(&allocator, source, source_type)?;
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&program)
        .semantic;
    let scoping = semantic.scoping();
    let probe_hosts = opts
        .probe_hosts
        .iter()
        .filter_map(|h| {
            h.split_once('.')
                .map(|(a, b)| (a.to_string(), b.to_string()))
        })
        .collect();
    let contexts = inline::imported_contexts(&program, &opts.imports);
    let m = model::build_model_with(source, &program, scoping, probe_hosts, &contexts);
    let a = graph::analyze(&m, &opts.id_prefix);
    match emit(&m, &a, opts) {
        Ok((server, chunks, manifest)) => Ok(IslandsOutput {
            server,
            client: None,
            chunks,
            manifest,
            fallback: None,
        }),
        // The fallback compiles the module as written.
        Err(reason) => fallback(original, opts, &m, &a, reason),
    }
}

type Emitted = (String, Vec<IslandChunk>, String);

fn emit(
    m: &model::Model<'_>,
    a: &graph::Analysis<'_>,
    opts: &IslandOptions,
) -> Result<Emitted, String> {
    if let Some(i) = a.issues.first() {
        return Err(i.clone());
    }
    if m.comps.is_empty() {
        return Err("no components".into());
    }
    // Any construct the compiler does not model, in any component (inert
    // ones included: their server output must equal today's).
    for (ci, f) in a.facts.iter().enumerate() {
        if let Some(i) = f.issues.first() {
            return Err(format!("`{}`: {i}", m.comps[ci].name));
        }
    }
    let copts = client::ClientOpts {
        t0: opts.t0_module.clone(),
        kernel: opts.kernel_module.clone(),
        core: opts.core_module.clone(),
        tier1_core: opts.tier1_core,
        debug: opts.debug,
        verify: opts.verify,
    };
    let mut codes = Vec::new();
    let mut notes: Vec<Vec<String>> = Vec::new();
    for (gi, g) in a.groups.iter().enumerate() {
        if let Some(u) = g.unsupported.first() {
            return Err(format!("island `{}` ({}): {u}", g.id, m.comps[g.root].name));
        }
        let want = g.tier.max(opts.min_tier);
        let mut note = Vec::new();
        let code = match client::emit_group(m, a, gi, want.min(1), &copts, want >= 2) {
            Ok(c) => c,
            Err(e) if want == 0 => {
                note.push(format!("tier 0 emission failed ({e}); emitted at tier 1"));
                client::emit_group(m, a, gi, 1, &copts, want >= 2)
                    .map_err(|e| format!("island `{}`: {e}", g.id))?
            }
            Err(e) => return Err(format!("island `{}` ({}): {e}", g.id, m.comps[g.root].name)),
        };
        // Tier 2 (min_tier / dedupe): the same code bound to the core.
        let code = if want >= 2 && code.tier == 1 {
            client::GroupCode {
                code: code.code.replace(
                    &client_js_str(&opts.kernel_module),
                    &client_js_str(&opts.core_module),
                ),
                tier: 2,
                runtime: opts.core_module.clone(),
                ..code
            }
        } else {
            code
        };
        notes.push(note);
        codes.push((gi, code));
    }
    // A module-level `let` / `var` copied into two chunks would be two
    // variables: refuse (the state must live in one island).
    let mut owners: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    for (_, c) in &codes {
        for t in &c.mutable_top {
            *owners.entry(*t).or_default() += 1;
        }
    }
    if owners.values().any(|n| *n > 1) {
        return Err("module-level mutable state referenced by two islands".into());
    }
    let (server, streams) = server::emit_server(m, a, &codes)?;
    let chunks = codes
        .iter()
        .map(|(gi, c)| IslandChunk {
            id: a.groups[*gi].id.clone(),
            code: c.code.clone(),
        })
        .collect();
    let manifest = manifest(m, a, &codes, &notes, None, opts, &streams);
    Ok((server, chunks, manifest))
}

fn manifest(
    m: &model::Model<'_>,
    a: &graph::Analysis<'_>,
    codes: &[(usize, client::GroupCode)],
    notes: &[Vec<String>],
    fallback: Option<&str>,
    opts: &IslandOptions,
    streams: &[bool],
) -> String {
    let mut w = JsonWriter::default();
    w.begin_object();
    w.key("version");
    w.number(1);
    // A `<Loading>` over server data streams its content as a chunk.
    w.key("streams");
    w.boolean(streams.iter().any(|s| *s));
    w.key("module");
    match &opts.filename {
        Some(f) => w.string(f),
        None => w.null(),
    }
    w.key("fallback");
    match fallback {
        Some(r) => w.string(r),
        None => w.null(),
    }
    w.key("islands");
    w.begin_array();
    for (i, (gi, code)) in codes.iter().enumerate() {
        let g = &a.groups[*gi];
        w.begin_object();
        w.key("id");
        w.string(&g.id);
        w.key("root");
        w.string(&m.comps[g.root].name);
        w.key("members");
        w.begin_array();
        for c in &g.members {
            w.string(&m.comps[*c].name);
        }
        w.end_array();
        w.key("tier");
        w.number(code.tier as u64);
        w.key("analysisTier");
        w.number(g.tier as u64);
        w.key("ownTiers");
        w.begin_object();
        for (c, t) in &g.own_tiers {
            w.key(&m.comps[*c].name);
            w.number(*t as u64);
        }
        w.end_object();
        w.key("why");
        w.begin_array();
        for x in &g.why {
            w.string(x);
        }
        w.end_array();
        w.key("runtime");
        w.string(&code.runtime);
        w.key("cells");
        w.begin_array();
        for k in &g.keys {
            if let model::Item::Cell { name, .. } | model::Item::Memo { name, .. } =
                &m.comps[k.0].setup[k.1]
            {
                w.string(&format!("{}.{name}", m.comps[k.0].name));
            }
        }
        w.end_array();
        w.key("events");
        w.begin_array();
        for e in &g.events {
            w.string(e);
        }
        w.end_array();
        w.key("windowEvents");
        w.begin_array();
        for e in &g.window_events {
            w.string(e);
        }
        w.end_array();
        w.key("anchor");
        w.string(if code.element_anchor {
            "element"
        } else {
            "comment"
        });
        w.key("nests");
        w.boolean(code.nests);
        w.key("prefetch");
        match &m.comps[g.root].prefetch {
            Some(p) => w.string(p),
            None => w.null(),
        }
        w.key("activation");
        w.string(if code.lazy_ok { "lazy" } else { "load" });
        w.key("preventDefault");
        w.boolean(g.prevent_default);
        // Its static paths may cross a streamed boundary: activate once no
        // boundary around its DOM is pending.
        w.key("waits");
        w.boolean(waits(a, g.root, streams));
        w.key("serialized");
        w.begin_array();
        for s in &code.serial {
            match s {
                client::Serial::Prop(p) => w.string(&format!("props.{p}")),
                client::Serial::Cell(ii) => match &m.comps[g.root].setup[*ii] {
                    model::Item::Cell { name, .. } => w.string(&format!("cell {name}")),
                    model::Item::Memo { name, .. } => w.string(&format!("memo {name}")),
                    _ => {}
                },
            }
        }
        w.end_array();
        w.key("notes");
        w.begin_array();
        for n in notes.get(i).into_iter().flatten() {
            w.string(n);
        }
        w.end_array();
        w.end_object();
    }
    w.end_array();
    w.key("components");
    w.begin_array();
    for (ci, c) in m.comps.iter().enumerate() {
        w.begin_object();
        w.key("name");
        w.string(&c.name);
        let groups: Vec<&str> = a
            .groups
            .iter()
            .filter(|g| g.members.contains(&ci))
            .map(|g| g.id.as_str())
            .collect();
        w.key("class");
        w.string(if groups.is_empty() {
            "inert"
        } else if a.root_of.contains_key(&ci) {
            "island-root"
        } else {
            "island-member"
        });
        w.key("islands");
        w.begin_array();
        for g in groups {
            w.string(g);
        }
        w.end_array();
        w.end_object();
    }
    w.end_array();
    w.end_object();
    w.out
}

/// A streamed boundary in the island root's render tree.
fn waits(a: &graph::Analysis<'_>, root: usize, streams: &[bool]) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(c) = stack.pop() {
        if !seen.insert(c) {
            continue;
        }
        if streams.get(c).copied().unwrap_or(false) {
            return true;
        }
        for call in &a.facts[c].calls {
            if let jsx::Tag::Comp(k) = call.tag {
                stack.push(k);
            }
        }
    }
    false
}

fn fallback(
    source: &str,
    opts: &IslandOptions,
    m: &model::Model<'_>,
    a: &graph::Analysis<'_>,
    reason: String,
) -> Result<IslandsOutput, CompileError> {
    let base = CompileOptions {
        filename: opts.filename.clone(),
        module_name: opts.module_name.clone(),
        hydratable: true,
        ..CompileOptions::default()
    };
    let server = compile(
        source,
        &CompileOptions {
            generate: Generate::Ssr,
            ..base.clone()
        },
    )?;
    let client = compile(
        source,
        &CompileOptions {
            generate: Generate::Dom,
            ..base
        },
    )?;
    let manifest = manifest(m, a, &[], &[], Some(&reason), opts, &[]);
    Ok(IslandsOutput {
        server: server.code,
        client: Some(client.code),
        chunks: vec![],
        manifest,
        fallback: Some(reason),
    })
}

#[cfg(test)]
mod tests;
