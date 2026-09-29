"use strict";
// Track A, stage 2 — the capability linker.
//
// Proves a complete client or server module graph async-free and, only
// then, points every `@solidjs/signals` import in that graph (the app's and
// the libraries') at the async-free runtime (`@solidjs/signals/sync`, see
// packages/signals/src/index.sync.ts).
//
// The proof joins three kinds of facts:
//
// 1. Compiler summaries (`summarizeCapabilities`, one per application
//    module): import / re-export / dynamic-import edges, every reactive host
//    compute with its local synchrony proof, and the props passed to library
//    components.
// 2. Typed summaries (`solid-tsc --capabilities`, optional): TypeScript's
//    verdict on each compute's result type and each library-component prop's
//    value type, keyed by the same UTF-16 position — the precision local
//    proofs lack (`createMemo(() => todos().filter(…))` is a `Todo[]`).
// 3. Library manifests (`<package>/capabilities.json`): trusted declarations
//    of which exports are async capabilities and which component props feed
//    an async-aware internal computation. A package without a manifest is
//    unknown.
//
// A graph is async-free when every module is summarized or covered by a
// manifest, no module imports an async capability, every host compute and
// every manifest-listed component prop is proven synchronous (locally or by
// type), and no dynamic import is unclassified. Anything missing is a reason,
// and any reason keeps the full runtime — the linker never guesses.
//
// The walk runs in `buildStart`, before any module is loaded, through the
// bundler's own resolver (aliases, conditions and `resolve.*` all apply), so
// the entry is fixed before the first `@solidjs/signals` import resolves.
// Server and client builds each run it over their own graph.
//
// The plugin also guards against a module the Solid compiler did not
// transform in an otherwise compiled app (blocks-v2-performance.md §11): a
// generator body handed to `createMemo` / `createEffect` / `onSettled` runs
// on the block driver, which only a block constructor installs — a fully
// compiled bundle has none, so the body would run as a plain callback
// (dev builds throw `[GENERATOR_BODY]`). Every application module's final
// output is checked (`summarizeCompiled`'s `hookBodies`); a module with such
// a body imports and calls `installBlockDriver` first, and the build warns,
// naming the module. Modules without one are untouched, so a driver-free
// bundle stays driver-free.

const fs = require("fs");
const path = require("path");
const { summarizeCapabilities, summarizeCompiled } = require("./index.js");

const RUNTIME_PACKAGE = "@solidjs/signals";
const SOURCE_RE = /\.[cm]?[jt]sx?$/;
// Modules with no reactive code: stylesheets, data, media.
const ASSET_RE =
  /\.(css|scss|sass|less|styl|pcss|json|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|txt|md|wasm)$/;

function stripQuery(id) {
  const q = id.search(/[?#]/);
  return q === -1 ? id : id.slice(0, q);
}

/** A module the bundler makes up: `\0`-prefixed, or not a file on disk. */
function isVirtual(id) {
  if (id.startsWith("\0")) return true;
  const file = stripQuery(id);
  return !path.isAbsolute(file) || !fs.existsSync(file);
}

/** How a module is named in reports: root-relative files, virtual ids as is. */
function displayId(root, id) {
  return isVirtual(id) ? id.replace(/^\0/, "") : path.relative(root, id);
}

/** A parser-friendly filename for a virtual module's summary. */
function virtualFilename(id) {
  const clean = stripQuery(id).replace(/^\0/, "");
  return SOURCE_RE.test(clean) ? clean : `${clean}.js`;
}

/** The module's own dialect: transformed code is usually plain ES, which
 * every dialect parses (`summarizeCompiled` falls back to plain ES). */
function compiledFilename(id) {
  return virtualFilename(id);
}

const packageCache = new Map();
/** The nearest package.json above `file`, with its capability manifest.
 * A manifest without a `name` and without a capability manifest is a
 * subpath manifest inside a package (`@solidjs/web/frames/package.json`
 * carries only `main` / `types`, upstream #3627), not the package root: the
 * walk goes on to the named manifest above it, and falls back to the
 * nameless one only when there is none. */
function packageOf(file) {
  let dir = path.dirname(file);
  const seen = [];
  let nameless = null;
  const settle = hit => {
    for (const d of seen) packageCache.set(d, hit);
    return hit;
  };
  for (;;) {
    if (packageCache.has(dir)) {
      const cached = packageCache.get(dir);
      return settle(cached ?? nameless);
    }
    seen.push(dir);
    const manifestPath = path.join(dir, "package.json");
    if (fs.existsSync(manifestPath)) {
      const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const capabilitiesPath = path.join(dir, "capabilities.json");
      const manifest = fs.existsSync(capabilitiesPath)
        ? JSON.parse(fs.readFileSync(capabilitiesPath, "utf8"))
        : null;
      const hit = { dir, name: pkg.name, manifest };
      if (pkg.name !== undefined || manifest) return settle(hit);
      nameless ??= hit;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return settle(nameless);
    dir = parent;
  }
}

/** `<script type="module" src>` entries of an HTML input. */
function htmlEntries(file, root) {
  const html = fs.readFileSync(file, "utf8");
  const out = [];
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/type\s*=\s*["']module["']/.test(tag)) continue;
    const src = /src\s*=\s*["']([^"']+)["']/.exec(tag)?.[1];
    if (!src || /^[a-z]+:\/\//i.test(src)) continue;
    out.push(src.startsWith("/") ? path.join(root, src) : path.resolve(path.dirname(file), src));
  }
  return out;
}

function typedVerdict(typedSummary, file, kind, start) {
  return typedSummary?.files?.[file]?.[kind]?.[String(start)];
}

/**
 * Prove a module graph async-free.
 *
 * @param {object} options
 * @param {string[]} options.entries absolute entry module paths
 * @param {(source: string, importer: string) => Promise<string | null>} options.resolve
 * @param {(file: string) => string} [options.readFile]
 * @param {object} [options.typedSummary] `solid-tsc --capabilities` output
 * @param {string} options.root project root (application modules live under it)
 * @param {(id: string) => Promise<string | null>} [options.load] the bundler's
 *   transformed code of a module (Rollup's `this.load`). With it, modules
 *   that are not files (virtual entries) are summarized from their code, and
 *   the feature proof reads every application module's COMPILED output
 *   (`summarizeCompiled`) instead of its authored imports.
 * @returns {Promise<object>} the report: `asyncFree`, `entry`, `reasons`, and
 *   the retained graph (`modules`, `libraries`, counts)
 */
async function proveGraph({
  entries,
  resolve,
  readFile = f => fs.readFileSync(f, "utf8"),
  typedSummary,
  root,
  compiledSeams = true,
  load
}) {
  const reasons = [];
  // `kind`: "async" — a fact about the graph's async use; "graph" — the graph
  // is not fully known (a module without a summary or manifest, an
  // unresolved or non-literal import). The feature proof (proveFeatures)
  // needs a fully known graph; async facts don't matter to it.
  const reason = (file, line, message, kind = "async") =>
    reasons.push({
      file: file ? path.relative(root, file) : null,
      line: line ?? null,
      reason: message,
      kind
    });
  const gap = (file, line, message) => reason(file, line, message, "graph");
  const libraries = new Map(); // package name → { manifest, names: Set }
  const app = [];
  const counts = {
    computes: 0,
    computesLocal: 0,
    computesTyped: 0,
    props: 0,
    propsChecked: 0,
    assets: 0,
    dynamicImports: 0
  };
  const seen = new Set();
  const queue = [...entries];
  const yieldStar = [];
  // Per application module: its id, the library names its authored source
  // imports, and whether it has a `yield*` (the feature proof's fallback for
  // a module without compiled facts).
  const appModules = new Map();

  const useLibrary = (pkg, names, file, line) => {
    let entry = libraries.get(pkg.name);
    if (!entry) libraries.set(pkg.name, (entry = { manifest: pkg.manifest, names: new Set() }));
    const own = appModules.get(file)?.libraries;
    if (own) {
      if (!own.has(pkg.name)) own.set(pkg.name, { manifest: pkg.manifest, names: new Set() });
      for (const name of names) own.get(pkg.name).names.add(name);
    }
    for (const name of names) {
      entry.names.add(name);
      if (name === "*" && pkg.manifest.asyncExports.length)
        reason(file, line, `namespace import of ${pkg.name} (includes async capabilities)`);
      else if (pkg.manifest.asyncExports.includes(name))
        reason(file, line, `imports async capability \`${name}\` from ${pkg.name}`);
    }
  };

  // Edge from an application module to `source`: follow it, or record the
  // library names it uses.
  const edge = async (file, source, names, line) => {
    const resolved = await resolve(source, file);
    if (!resolved) {
      gap(file, line, `unresolved import \`${source}\``);
      return;
    }
    if (isVirtual(resolved)) {
      // A module the bundler makes up (a generated entry, a helper): with the
      // bundler's loader it is summarized from its code like any app module.
      if (load) {
        if (!seen.has(resolved)) queue.push(resolved);
      } else gap(file, line, `virtual module \`${source}\` has no summary`);
      return;
    }
    const id = stripQuery(resolved);
    if (ASSET_RE.test(id)) {
      counts.assets++;
      return;
    }
    const pkg = packageOf(id);
    const inApp =
      !path.relative(root, id).startsWith("..") &&
      !id.includes(`${path.sep}node_modules${path.sep}`);
    if (pkg?.manifest && !(inApp && pkg.dir === root)) {
      useLibrary(pkg, names, file, line);
      return;
    }
    if (!inApp) {
      gap(file, line, `\`${source}\` (${pkg?.name ?? id}) has no capability manifest`);
      return;
    }
    if (!seen.has(id)) queue.push(id);
  };

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const virtual = isVirtual(file);
    if (virtual && !load) {
      // An entry the bundler generates; only its loader has its code.
      gap(file, null, `virtual module \`${displayId(root, file)}\` has no summary`);
      continue;
    }
    if (!virtual && !SOURCE_RE.test(file)) {
      if (ASSET_RE.test(file)) counts.assets++;
      else gap(file, null, "not a JavaScript / TypeScript module");
      continue;
    }
    const rel = displayId(root, file);
    app.push(rel);
    const record = { id: file, rel, libraries: new Map(), yieldStar: false };
    appModules.set(file, record);
    let summary;
    try {
      const source = virtual ? await load(file) : readFile(file);
      if (source == null) throw new Error("the bundler has no code for it");
      // A hand-written `yield*` may iterate an accessor (AccessorIterable)
      // without importing any block API: the ITERABLE switch stays on.
      if (/yield\s*\*/.test(source)) {
        yieldStar.push(rel);
        record.yieldStar = true;
      }
      summary = summarizeCapabilities(source, { filename: virtualFilename(file) });
    } catch (error) {
      gap(file, null, `no summary: ${String(error.message ?? error).split("\n")[0]}`);
      continue;
    }
    for (const imp of summary.imports) {
      if (imp.typeOnly) continue;
      await edge(file, imp.source, imp.names, null);
    }
    for (const exp of summary.reexports) {
      if (exp.typeOnly) continue;
      await edge(file, exp.source, exp.names, null);
    }
    for (const dyn of summary.dynamicImports) {
      counts.dynamicImports++;
      // A literal dynamic import is part of this graph (a lazy chunk), not an
      // async capability by itself: a Promise only becomes reactive async by
      // flowing into a compute, which the compute proofs catch.
      if (dyn.source == null) gap(file, dyn.line, "unclassified dynamic import (non-literal)");
      else await edge(file, dyn.source, ["*"], dyn.line);
    }
    for (const compute of summary.computes) {
      counts.computes++;
      if (compute.proof === "sync") {
        counts.computesLocal++;
        continue;
      }
      if (compute.proof === "async") {
        reason(file, compute.line, `\`${compute.host}\` compute is async (${compute.reason})`);
        continue;
      }
      const typed = typedVerdict(typedSummary, file, "computes", compute.start);
      if (typed === "sync") {
        counts.computesTyped++;
        continue;
      }
      reason(
        file,
        compute.line,
        `\`${compute.host}\` compute not proven synchronous (${compute.reason}${typed ? `; typed: ${typed}` : "; no typed summary"})`
      );
    }
    for (const prop of summary.componentProps) {
      counts.props++;
      // Only props a library manifest names as feeding an async-aware
      // internal computation matter (spreads can carry any of them).
      const resolved = await resolve(prop.source, file);
      const pkg = resolved && packageOf(stripQuery(resolved));
      const computeProps = pkg?.manifest?.componentComputeProps?.[prop.component];
      if (!computeProps) continue;
      if (prop.prop !== "*" && !computeProps.includes(prop.prop)) continue;
      counts.propsChecked++;
      if (prop.proof === "sync") continue;
      const typed = typedVerdict(typedSummary, file, "props", prop.start);
      if (typed === "sync") continue;
      reason(
        file,
        prop.line,
        `<${prop.component} ${prop.prop}> not proven synchronous${typed ? ` (typed: ${typed})` : ""}`
      );
    }
  }

  const runtime = libraries.get(RUNTIME_PACKAGE);
  const runtimeManifest =
    runtime?.manifest ??
    (() => {
      // The runtime is reached through solid-js even when the app never
      // imports it directly: read its manifest from its package.
      try {
        const pkgJson = require.resolve(`${RUNTIME_PACKAGE}/package.json`, { paths: [root] });
        return JSON.parse(
          fs.readFileSync(path.join(path.dirname(pkgJson), "capabilities.json"), "utf8")
        );
      } catch {
        return null;
      }
    })();
  if (!runtimeManifest?.asyncFreeEntry)
    reason(null, null, `${RUNTIME_PACKAGE} ships no async-free entry`);

  // Compiled facts: what each application module's output — the code the
  // bundle includes — references, creates and leaves to the driver.
  let facts = null;
  const factGaps = [];
  if (load) {
    facts = {
      modules: 0,
      withFacts: 0,
      residualGenerators: [],
      delegations: 0,
      seams: [],
      creates: {},
      storeReads: 0
    };
    for (const record of appModules.values()) {
      facts.modules++;
      let compiled;
      try {
        const code = await load(record.id);
        if (code == null) continue;
        compiled = summarizeCompiled(code, { filename: compiledFilename(record.id) });
      } catch {
        continue;
      }
      const used = new Map();
      for (const use of compiled.uses) {
        const resolved = await resolve(use.source, record.id);
        if (!resolved) {
          factGaps.push(`${record.rel}: compiled output imports unresolved \`${use.source}\``);
          continue;
        }
        if (isVirtual(resolved) || ASSET_RE.test(stripQuery(resolved))) continue;
        const id = stripQuery(resolved);
        const pkg = packageOf(id);
        const inApp =
          !path.relative(root, id).startsWith("..") &&
          !id.includes(`${path.sep}node_modules${path.sep}`);
        if (pkg?.manifest && !(inApp && pkg.dir === root)) {
          if (!used.has(pkg.name)) used.set(pkg.name, { manifest: pkg.manifest, names: new Set() });
          for (const name of use.names) used.get(pkg.name).names.add(name);
        } else if (!inApp) {
          factGaps.push(
            `${record.rel}: compiled output imports \`${use.source}\` (${pkg?.name ?? id}), which has no capability manifest`
          );
        }
      }
      record.facts = {
        libraries: used,
        delegations: compiled.delegations,
        residualGenerators: compiled.residualGenerators,
        seams: compiled.seams
      };
      facts.withFacts++;
      facts.delegations += compiled.delegations;
      facts.storeReads += compiled.storeReads;
      for (const g of compiled.residualGenerators)
        facts.residualGenerators.push({ file: record.rel, ...g });
      for (const seam of compiled.seams) if (!facts.seams.includes(seam)) facts.seams.push(seam);
      for (const [kind, n] of Object.entries(compiled.creates))
        facts.creates[kind] = (facts.creates[kind] ?? 0) + n;
    }
  }

  const features = proveFeatures({
    libraries,
    complete: !reasons.some(r => r.kind === "graph") && factGaps.length === 0,
    compiledSeams,
    yieldStar,
    modules: load ? [...appModules.values()] : undefined
  });
  if (factGaps.length)
    for (const f of FEATURE_SWITCHES)
      if (features[f].because.length < 8) features[f].because.push(factGaps[0]);

  return {
    asyncFree: reasons.length === 0,
    entry: reasons.length === 0 ? runtimeManifest.asyncFreeEntry : null,
    reasons,
    features,
    facts,
    modules: app,
    libraries: Object.fromEntries(
      [...libraries].map(([name, { names }]) => [name, [...names].sort()])
    ),
    counts
  };
}

// ---------------------------------------------------------------------------
// Core runtime slicing (documentation/plans/core-runtime-slicing.md): the
// link-time feature switches of @solidjs/signals (src/core/features.ts).
//
// A switch may be turned off for a graph only when the graph is fully known
// (every module summarized or covered by a manifest, no unclassified dynamic
// import) and no library name the graph imports is listed under that feature
// in its package's manifest (`featureExports`; `"*"` — a namespace import —
// uses every feature the package lists). OPTIMISTIC additionally requires
// VERDICTS off: the verdict layer's companions are optimistic nodes.
// COMPILED_SEAMS is decided by the compiler configuration, not by imports:
// compiled output requests the seams (`noThrow`, effect `equals`,
// `statusFree`) that the authored source never names, so it stays on unless
// the build says its compiler passes emit none (`compiledSeams: false`).
// A module of a published @solidjs/signals tree (the trees
// scripts/inline-features.mjs inlines the switches into).
const RUNTIME_TREE_RE = /[\\/]dist[\\/](prod|observe|sync)[\\/].*\.js$/;

const FEATURE_SWITCHES = [
  "OPTIMISTIC",
  "VERDICTS",
  "STORES",
  "SNAPSHOTS",
  "ITERABLE",
  "COMPILED_SEAMS"
];

// The store / path readers the compiler emits for lowered path reads
// (`yield* props.todo.title` → `readPath2(props, "todo", "title")`): they
// read through whatever they are given, and a store read needs a store that
// some module created — a creation is what keeps STORES on. Exempt only when
// the module's compiled output is known.
const STORE_READERS = new Set([
  "readStore",
  "readSelected",
  "readPath",
  "readPath1",
  "readPath2",
  "readPath3",
  "readPath4",
  "readPathN",
  "readHandle1",
  "readHandle2",
  "readHandle3",
  "readHandle4",
  "readHandleN",
  "readHandleChild",
  "readBorrowed",
  "markHandle"
]);

/**
 * @param {object} options
 * @param {Map} options.libraries library names the graph's authored sources import
 * @param {boolean} options.complete the graph is fully known
 * @param {boolean} options.compiledSeams the build may emit compiled seams
 *   (the fallback when a module's compiled output is unknown)
 * @param {string[]} [options.yieldStar] app modules whose source has `yield*`
 * @param {object[]} [options.modules] per application module: `rel`,
 *   `libraries` (authored imports), `yieldStar`, and `facts` (from its
 *   compiled output: `libraries`, `delegations`, `residualGenerators`,
 *   `seams`) when known. With it, a module with facts is judged by its
 *   compiled output — ITERABLE by residual `yield*`, COMPILED_SEAMS by the
 *   seams it requests, the import-decided switches by the names it
 *   references — and one without by its authored imports, as before.
 * @returns {Record<string, { on: boolean, because: string[] }>}
 */
function proveFeatures({ libraries, complete, compiledSeams, yieldStar = [], modules }) {
  const out = {};
  for (const feature of FEATURE_SWITCHES) out[feature] = { on: false, because: [] };
  const use = (feature, why) => {
    out[feature].on = true;
    if (out[feature].because.length < 8) out[feature].because.push(why);
  };
  if (!complete) for (const f of FEATURE_SWITCHES) use(f, "module graph not fully known");
  const useLibraries = (libs, { compiled, where = "" }) => {
    for (const [pkg, { manifest, names }] of libs) {
      const featureExports = manifest?.featureExports;
      if (!featureExports) {
        // A manifest without feature facts says nothing about features.
        for (const f of FEATURE_SWITCHES) use(f, `${pkg} declares no featureExports`);
        continue;
      }
      for (const [feature, exportsOf] of Object.entries(featureExports)) {
        if (!out[feature]) continue;
        // Compiled output answers ITERABLE by its residual `yield*`, not by
        // the block API names lowering leaves behind.
        if (compiled && feature === "ITERABLE") continue;
        for (const name of names) {
          if (compiled && feature === "STORES" && STORE_READERS.has(name)) continue;
          if (name === "*" ? exportsOf.length > 0 : exportsOf.includes(name))
            use(
              feature,
              name === "*" ? `namespace import of ${pkg}${where}` : `${pkg}: ${name}${where}`
            );
        }
      }
    }
  };
  if (!modules) {
    useLibraries(libraries, { compiled: false });
    for (const file of yieldStar) use("ITERABLE", `${file} uses yield*`);
    if (compiledSeams)
      use("COMPILED_SEAMS", "compiler passes may emit noThrow / equals / statusFree");
  } else {
    let unknownOutput = false;
    for (const m of modules) {
      if (m.facts) {
        useLibraries(m.facts.libraries, { compiled: true, where: ` (${m.rel})` });
        if (m.facts.delegations > 0) {
          const at = m.facts.residualGenerators.find(g => g.delegations > 0);
          use(
            "ITERABLE",
            `${m.rel}${at ? `:${at.line}` : ""}: ${m.facts.delegations} yield* left in compiled output`
          );
        }
        for (const seam of m.facts.seams)
          use("COMPILED_SEAMS", `${m.rel}: compiled output requests ${seam}`);
      } else {
        unknownOutput = true;
        useLibraries(m.libraries, { compiled: false, where: ` (${m.rel})` });
        if (m.yieldStar) use("ITERABLE", `${m.rel} uses yield*`);
      }
    }
    if (unknownOutput && compiledSeams)
      use(
        "COMPILED_SEAMS",
        "a module's compiled output is unknown; compiler passes may emit seams"
      );
  }
  if (out.VERDICTS.on) use("OPTIMISTIC", "VERDICTS (companions are optimistic nodes)");
  return out;
}

/** The features module a tier of @solidjs/signals ships, with the switches
 * the proof turned off. `sync` is the async-free tree (OPTIMISTIC and VERDICTS
 * are off there by construction). */
function featuresModuleSource(features, tier) {
  return FEATURE_SWITCHES.map(name => {
    const on =
      features[name].on && !(tier === "sync" && (name === "OPTIMISTIC" || name === "VERDICTS"));
    return `export const ${name} = ${on};`;
  }).join("\n");
}

// The marker scripts/inline-features.mjs (packages/signals) leaves on every
// inlined switch test in the published trees: `/* @solid-feature STORES */ true`.
// Keep the spelling in sync with that script.
const FEATURE_MARKER = "@solid-feature";
const FEATURE_LITERAL_RE = /\/\* @solid-feature ([A-Z_]+) \*\/ true\b/g;

/** A runtime tree module with the marked literals of every switch the proof
 * turned off rewritten to `false`, or null when nothing changes. */
function sliceFeatureLiterals(code, features) {
  if (!code.includes(FEATURE_MARKER)) return null;
  let changed = false;
  const out = code.replace(FEATURE_LITERAL_RE, (literal, name) => {
    if (!features[name] || features[name].on) return literal;
    changed = true;
    return `/* ${FEATURE_MARKER} ${name} */ false`;
  });
  return changed ? out : null;
}

/**
 * A module's final output that hands a generator body to a generator-hook
 * host: the output with the block driver installed first, and the bodies
 * (`{ line, host, source }`), or null when it has none.
 */
function installDriverFor(code, id) {
  if (!/function\s*\*/.test(code)) return null;
  let compiled;
  try {
    compiled = summarizeCompiled(code, { filename: compiledFilename(id) });
  } catch {
    return null;
  }
  const bodies = compiled.hookBodies ?? [];
  if (!bodies.length) return null;
  const source = bodies.find(b => b.source)?.source ?? "solid-js";
  // One line, so the module's own lines keep their numbers.
  const prefix = `import { installBlockDriver as __solidInstallBlockDriver } from ${JSON.stringify(source)}; __solidInstallBlockDriver();`;
  return { code: `${prefix}${code.startsWith("\n") ? "" : " "}${code}`, bodies };
}

// ---------------------------------------------------------------------------
// Frames client switches (documentation/plans/core-runtime-slicing.md,
// "Frames client switches"): the link-time switches of @solidjs/web/frames'
// client (frames/src/features.ts), proven from the application's COMPILED
// SERVER OUTPUT — what the server can put on the wire is what the client
// must be able to apply.
//
// Every rule is conservative (a name or shape that MAY produce the feature
// keeps it on) and judged per application module of the server graph:
//
//   FRAGMENTS        a `Loading` / `Reveal` boundary anywhere on the server
//                    (a frame inside, or a boundary inside a frame, streams
//                    fragments; late document boundaries ride the same
//                    ledger)
//   ASSETS           a server-component module importing CSS or using `lazy`
//                    (styles / module preloads ride the frame)
//   SLOT_DATA        a server-component module whose components take props
//   LIVE_PROPS         (a props-taking server component may be handed slots:
//   HYDRATION_CLAIMS   their records, live updates and claims)
//   ASYNC_ARGS       `asyncArg`
//   CONTAINERS       a server-component module creating a store / projection
//   SINGLE_FLIGHT    the frames flight transform (`frameTransformFlightResult`)
//                    or a `collectFlightData` hook
//   FULL_CODEC       any of SLOT_DATA / ASYNC_ARGS / CONTAINERS (the data
//                    table only ever carries their records)
//
// A server-component module is one whose output has a `"use server"`
// directive and renders markup. An unknown module (no output) keeps every
// switch on.
const FRAMES_SWITCHES = [
  "FRAGMENTS",
  "ASSETS",
  "SLOT_DATA",
  "ASYNC_ARGS",
  "CONTAINERS",
  "LIVE_PROPS",
  "SINGLE_FLIGHT",
  "FULL_CODEC",
  "HYDRATION_CLAIMS"
];

const USE_SERVER_RE = /(^|[{;\n]\s*)["']use server["']/;
const MARKUP_RE =
  /\b(ssr|_\$ssr|escape|_\$escape|ssrElement|createComponent|_\$createComponent)\s*\(|<[a-z][\w-]*[\s>]/;

/**
 * @param {object} options
 * @param {{ rel: string, code: string | null }[]} options.modules the server
 *   graph's application modules and their compiled output
 * @param {boolean} [options.complete] the server graph is fully known
 * @returns {Record<string, { on: boolean, because: string[] }>}
 */
function proveFramesFeatures({ modules, complete = true }) {
  const out = {};
  for (const f of FRAMES_SWITCHES) out[f] = { on: false, because: [] };
  const use = (f, why) => {
    out[f].on = true;
    if (out[f].because.length < 8) out[f].because.push(why);
  };
  if (!complete) for (const f of FRAMES_SWITCHES) use(f, "server graph not fully known");
  for (const { rel, code } of modules) {
    if (code == null) {
      for (const f of FRAMES_SWITCHES) use(f, `${rel}: compiled server output unknown`);
      continue;
    }
    const at = re => {
      const m = re.exec(code);
      return m ? `${rel}:${code.slice(0, m.index).split("\n").length}` : null;
    };
    let w;
    if ((w = at(/\b(Loading|Reveal)\b/))) use("FRAGMENTS", `${w}: Loading / Reveal boundary`);
    if ((w = at(/\basyncArg\b/))) use("ASYNC_ARGS", `${w}: asyncArg`);
    if ((w = at(/\b(frameTransformFlightResult|collectFlightData)\b/)))
      use("SINGLE_FLIGHT", `${w}: single-flight transform`);
    const serverComponents = USE_SERVER_RE.test(code) && MARKUP_RE.test(code);
    if (!serverComponents) continue;
    if (
      (w = at(
        /import\s*(?:[^;]*?from\s*)?["'][^"']+\.(css|scss|sass|less|styl)(\?[^"']*)?["']|\blazy\s*\(/
      ))
    )
      use("ASSETS", `${w}: server component with CSS / lazy`);
    if ((w = at(/\b(createStore|createProjection|createOptimisticStore|createMutable)\b/)))
      use("CONTAINERS", `${w}: server component creates a store / projection`);
    if ((w = at(/\bprops\b/)))
      for (const f of ["SLOT_DATA", "LIVE_PROPS", "HYDRATION_CLAIMS"])
        use(f, `${w}: server component takes props (slots possible)`);
  }
  for (const f of ["SLOT_DATA", "ASYNC_ARGS", "CONTAINERS"])
    if (out[f].on) use("FULL_CODEC", `${f} (data records)`);
  return out;
}

/** The frames client's features module with the proven switches. */
function framesFeaturesModuleSource(features) {
  return (
    FRAMES_SWITCHES.map(name => `export const ${name} = ${features[name].on};`).join("\n") +
    `
export function featureExcluded(name) {
  throw new Error(
    "[FEATURE_EXCLUDED] the frames client was linked without " + name +
      ", but this page uses it (the capability linker's proof missed a use: report the construct)."
  );
}
export function markFeature() {}
`
  );
}

/**
 * Vite / Rollup plugin. Runs `proveGraph` over the build's entries in
 * `buildStart` and, when the graph is async-free, resolves every
 * `@solidjs/signals` import to the async-free entry.
 *
 * @param {object} [options]
 * @param {string[]} [options.entries] entry modules (relative to the root)
 *   used when the build input names none (vitest)
 * @param {string | object} [options.typedSummary] `solid-tsc --capabilities`
 *   output (a path relative to the root, or the parsed object)
 * @param {string} [options.report] write the linker report (JSON) here
 * @param {boolean} [options.features] slice the runtime's link-time feature
 *   switches (default true): every switch the graph is proven not to use is
 *   turned off in the @solidjs/signals tree the build resolves
 * @param {boolean} [options.compiledSeams] whether the compiler passes of
 *   this build may emit status-free / effect-equals seams (default true; pass
 *   false only when blockProofs, host fusion and memo fusion are all off).
 *   Only consulted for a module whose compiled output is unknown.
 * @param {boolean} [options.compiledFacts] prove the feature switches from
 *   each application module's compiled output (build only; default true):
 *   ITERABLE by residual `yield*`, COMPILED_SEAMS by the seams the output
 *   requests, the other switches by the runtime names it references. Off:
 *   the authored imports decide, as before.
 */
function solidCapabilities(options = {}) {
  let config;
  let decision = null;
  // Modules whose output needed the block driver installed (see the header).
  const driverInstalls = [];
  // The proof inputs, fixed in buildStart and reused by the feature proof.
  let proofInputs = null;
  // The feature proof over compiled output (build only), run once per build
  // when the runtime's features module is first resolved.
  let featureDecision = null;
  const featureSlicing = options.features !== false;
  const FEATURES_ID = "\0solid-features:";
  // Frames client switches: the server build records its application
  // modules' compiled output and writes the proof (framesProof); the client
  // build substitutes the frames client's features module from it.
  const FRAMES_ID = "\0solid-frames-features";
  const framesSlicing = options.frames !== false;
  const framesModules = new Map();
  let framesDecision = null;
  const framesProofFile = root =>
    path.resolve(root, options.framesProof ?? "node_modules/.cache/solid/frames-features.json");
  let isBuild = false;
  const writeReport = root => {
    if (!options.report || !decision) return;
    const file = path.resolve(root, options.report);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(decision, null, 2));
  };
  const logFeatures = () => {
    if (!featureSlicing || !decision?.features) return;
    const off = FEATURE_SWITCHES.filter(f => !decision.features[f].on);
    const facts = decision.facts
      ? ` (compiled facts for ${decision.facts.withFacts}/${decision.facts.modules} modules)`
      : "";
    config?.logger?.info?.(
      `[solid:capabilities] ${decision.graph} runtime slice${facts}: ${off.length ? `switched off ${off.join(", ")}` : "every feature switch stays on"}`
    );
  };
  // Build: prove the switches from every application module's compiled
  // output (the code this bundle includes), once per build. Awaited only
  // from runtime modules (the features module and the runtime tree), which
  // application code imports but never the reverse, so waiting on the
  // application modules' transforms cannot wait on itself.
  const refineFeatures = async ctx => {
    if (!isBuild || options.compiledFacts === false || !proofInputs?.entries.length) return;
    featureDecision ??= (async () => {
      const refined = await proveGraph({
        ...proofInputs,
        compiledSeams: options.compiledSeams !== false,
        resolve: resolverOf(ctx),
        load: async id => (await ctx.load({ id }))?.code ?? null
      });
      decision.features = refined.features;
      decision.facts = refined.facts;
      // What kept the graph from being fully known for the feature
      // proof (the async reasons above are the buildStart proof's).
      decision.featureGaps = refined.reasons.filter(r => r.kind === "graph");
      writeReport(proofInputs.root);
      logFeatures();
    })();
    await featureDecision;
  };
  // Resolution for the proof: skip this plugin (its own resolveId awaits
  // the proof).
  const resolverOf = ctx => async (source, importer) => {
    const resolved = await ctx.resolve(source, importer, { skipSelf: true });
    return resolved && !resolved.external ? resolved.id : null;
  };
  return {
    name: "solid:capabilities",
    enforce: "pre",
    // Production builds and test runs; the dev server's graph changes under
    // HMR, so it keeps the full runtime.
    apply(_config, env) {
      return env.command === "build" || !!process.env.VITEST;
    },
    configResolved(resolved) {
      config = resolved;
      isBuild = resolved.command === "build" && !process.env.VITEST;
    },
    async buildStart(input) {
      featureDecision = null;
      framesModules.clear();
      framesDecision = null;
      driverInstalls.length = 0;
      const root = config?.root ?? process.cwd();
      // The build input when it names entries (client HTML / JS inputs, an
      // SSR entry); `options.entries` when it does not (vitest).
      const named =
        typeof input?.input === "string"
          ? [input.input]
          : Array.isArray(input?.input)
            ? input.input
            : Object.values(input?.input ?? {});
      const inputs = named.length ? named : (options.entries ?? []);
      const entries = [];
      for (const entry of inputs) {
        const file = path.resolve(root, entry);
        if (/\.html?$/.test(file)) entries.push(...htmlEntries(file, root));
        else if (fs.existsSync(file)) entries.push(file);
        else {
          // A generated entry (`virtual:…`): its resolved id. The async
          // proof reports it as unsummarized; the feature proof (build)
          // loads it through the bundler.
          const resolved = await this.resolve(entry, undefined, { skipSelf: true });
          entries.push(resolved && !resolved.external ? resolved.id : file);
        }
      }
      let typedSummary = options.typedSummary;
      if (typeof typedSummary === "string") {
        const file = path.resolve(root, typedSummary);
        typedSummary = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
      }
      proofInputs = { entries, root, typedSummary };
      if (!entries.length) {
        decision = { asyncFree: false, entry: null, reasons: [{ reason: "no entry modules" }] };
      } else {
        decision = await proveGraph({
          entries,
          root,
          typedSummary,
          compiledSeams: options.compiledSeams !== false,
          resolve: resolverOf(this)
        });
      }
      decision.graph =
        this.environment?.config?.consumer === "server" || config?.build?.ssr ? "server" : "client";
      decision.driverInstalls = driverInstalls;
      writeReport(root);
      const summary = decision.asyncFree
        ? `async-free ${decision.graph} graph (${decision.modules.length} modules): ${RUNTIME_PACKAGE} → ${decision.entry}`
        : `${decision.graph} graph keeps the full runtime (${decision.reasons.length} reason${decision.reasons.length === 1 ? "" : "s"}; first: ${decision.reasons[0]?.reason})`;
      config?.logger?.info?.(`[solid:capabilities] ${summary}`);
      // Test runs and builds with compiled facts disabled keep the proof
      // from authored imports; a build refines it from compiled output when
      // the runtime's features module is first resolved.
      if (!isBuild || options.compiledFacts === false) logFeatures();
    },
    async resolveId(source, importer, resolveOptions) {
      // The frames client's features module (frames/dist/client.features.js
      // of @solidjs/web): the switches the server build proved.
      if (
        framesSlicing &&
        isBuild &&
        decision?.graph === "client" &&
        importer &&
        /(^|\/)client\.features\.js$/.test(source)
      ) {
        const resolved = await this.resolve(source, importer, {
          ...resolveOptions,
          skipSelf: true
        });
        if (
          !resolved ||
          !/[\\/]frames[\\/]dist[\\/]client\.features\.js$/.test(resolved.id) ||
          !/^@solidjs\/web(\/frames)?$/.test(packageOf(resolved.id)?.name ?? "")
        )
          return null;
        const file = framesProofFile(config?.root ?? process.cwd());
        if (!fs.existsSync(file)) return null;
        framesDecision = JSON.parse(fs.readFileSync(file, "utf8"));
        const off = FRAMES_SWITCHES.filter(
          f => framesDecision.features[f] && !framesDecision.features[f].on
        );
        config?.logger?.info?.(
          `[solid:capabilities] frames client: ${off.length ? `switched off ${off.join(", ")}` : "every switch stays on"} (proof: ${path.relative(config?.root ?? process.cwd(), file)})`
        );
        return off.length ? FRAMES_ID : null;
      }
      if (source === RUNTIME_PACKAGE) {
        if (!decision?.asyncFree) return null;
        return this.resolve(decision.entry, importer, { ...resolveOptions, skipSelf: true });
      }
      // The runtime's own features module (core/features.js in each
      // published tree): substitute the proven switches.
      if (
        !featureSlicing ||
        !decision?.features ||
        !importer ||
        !/(^|\/)features\.js$/.test(source)
      )
        return null;
      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      const tier =
        resolved &&
        /[\\/]dist[\\/](prod|observe|sync)[\\/]core[\\/]features\.js$/.exec(resolved.id);
      if (!tier || packageOf(resolved.id)?.name !== RUNTIME_PACKAGE) return null;
      await refineFeatures(this);
      if (FEATURE_SWITCHES.every(f => decision.features[f].on)) return null;
      return FEATURES_ID + tier[1];
    },
    // Residual generator bodies in application modules: install the block
    // driver there (see the header). After every other transform, so the
    // Solid compiler's output is what is checked.
    transform: {
      order: "post",
      handler(code, id) {
        const file = stripQuery(id);
        // Server graph: record the application modules' compiled output
        // for the frames proof (virtual entries included — a generated
        // server entry installs the flight transform).
        if (
          framesSlicing &&
          isBuild &&
          decision?.graph === "server" &&
          !file.includes(`${path.sep}node_modules${path.sep}`) &&
          (id.startsWith("\0") || id.startsWith("virtual:") || SOURCE_RE.test(file))
        )
          framesModules.set(displayId(config?.root ?? process.cwd(), file), code);
        if (
          id.startsWith("\0") ||
          !SOURCE_RE.test(file) ||
          file.includes(`${path.sep}node_modules${path.sep}`)
        )
          return null;
        const installed = installDriverFor(code, id);
        if (!installed) return null;
        const root = config?.root ?? process.cwd();
        const rel = displayId(root, file);
        // Lines of the authored module when its own source shows the same
        // bodies (the output's lines move under other transforms).
        let bodies = installed.bodies;
        try {
          const authored = summarizeCompiled(fs.readFileSync(file, "utf8"), {
            filename: compiledFilename(id)
          }).hookBodies;
          if (authored?.length === bodies.length) bodies = authored;
        } catch {}
        for (const body of bodies) {
          const where = `${rel}:${body.line}`;
          driverInstalls.push({ file: rel, line: body.line, host: body.host });
          const message = `${where}: a generator body handed to \`${body.host}\` was left uncompiled, so the bundle installs the block driver for it. Compile this module with the Solid compiler (add its extension to the Solid plugin's \`extensions\`) to keep the bundle driver-free.`;
          if (typeof this?.warn === "function") this.warn(message);
          else config?.logger?.warn?.(`[solid:capabilities] ${message}`);
        }
        if (decision) {
          decision.driverInstalls = driverInstalls;
          writeReport(root);
        }
        return { code: installed.code, map: null };
      }
    },
    generateBundle() {
      if (!framesSlicing || !isBuild || decision?.graph !== "server") return;
      const root = config?.root ?? process.cwd();
      const modules = [...framesModules].map(([rel, code]) => ({ rel, code }));
      const features = proveFramesFeatures({ modules });
      const file = framesProofFile(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ modules: modules.map(m => m.rel).sort(), features }, null, 2)
      );
    },
    async load(id) {
      if (id === FRAMES_ID) return framesFeaturesModuleSource(framesDecision.features);
      if (id.startsWith(FEATURES_ID))
        return featuresModuleSource(decision.features, id.slice(FEATURES_ID.length));
      // The runtime tree's own modules carry the switches inlined as marked
      // literals (scripts/inline-features.mjs): rewrite the ones the proof
      // turned off. In `load`, ahead of any plugin that could re-print the
      // module and drop the marker comments.
      if (!featureSlicing || !decision?.features || id.startsWith("\0")) return null;
      if (stripQuery(id) !== id || !RUNTIME_TREE_RE.test(id)) return null;
      if (packageOf(id)?.name !== RUNTIME_PACKAGE) return null;
      await refineFeatures(this);
      if (FEATURE_SWITCHES.every(f => decision.features[f].on)) return null;
      let code;
      try {
        code = fs.readFileSync(id, "utf8");
      } catch {
        return null;
      }
      const sliced = sliceFeatureLiterals(code, decision.features);
      return sliced === null ? null : { code: sliced, map: null };
    }
  };
}

module.exports = {
  installDriverFor,
  proveGraph,
  proveFeatures,
  proveFramesFeatures,
  framesFeaturesModuleSource,
  FRAMES_SWITCHES,
  solidCapabilities,
  packageOf,
  htmlEntries,
  FEATURE_SWITCHES,
  sliceFeatureLiterals
};
