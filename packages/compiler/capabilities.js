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

const fs = require("fs");
const path = require("path");
const { summarizeCapabilities } = require("./index.js");

const RUNTIME_PACKAGE = "@solidjs/signals";
const SOURCE_RE = /\.[cm]?[jt]sx?$/;
// Modules with no reactive code: stylesheets, data, media.
const ASSET_RE =
  /\.(css|scss|sass|less|styl|pcss|json|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|txt|md|wasm)$/;

function stripQuery(id) {
  const q = id.search(/[?#]/);
  return q === -1 ? id : id.slice(0, q);
}

const packageCache = new Map();
/** The nearest package.json above `file`, with its capability manifest. */
function packageOf(file) {
  let dir = path.dirname(file);
  const seen = [];
  for (;;) {
    if (packageCache.has(dir)) {
      const hit = packageCache.get(dir);
      for (const d of seen) packageCache.set(d, hit);
      return hit;
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
      for (const d of seen) packageCache.set(d, hit);
      return hit;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      for (const d of seen) packageCache.set(d, null);
      return null;
    }
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
 * @returns {Promise<object>} the report: `asyncFree`, `entry`, `reasons`, and
 *   the retained graph (`modules`, `libraries`, counts)
 */
async function proveGraph({
  entries,
  resolve,
  readFile = f => fs.readFileSync(f, "utf8"),
  typedSummary,
  root,
  compiledSeams = true
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

  const useLibrary = (pkg, names, file, line) => {
    let entry = libraries.get(pkg.name);
    if (!entry) libraries.set(pkg.name, (entry = { manifest: pkg.manifest, names: new Set() }));
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
    if (resolved.startsWith("\0")) {
      gap(file, line, `virtual module \`${source}\` has no summary`);
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
    if (!SOURCE_RE.test(file)) {
      if (ASSET_RE.test(file)) counts.assets++;
      else gap(file, null, "not a JavaScript / TypeScript module");
      continue;
    }
    app.push(path.relative(root, file));
    let summary;
    try {
      const source = readFile(file);
      // A hand-written `yield*` may iterate an accessor (AccessorIterable)
      // without importing any block API: the ITERABLE switch stays on.
      if (/yield\s*\*/.test(source)) yieldStar.push(path.relative(root, file));
      summary = summarizeCapabilities(source, { filename: file });
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

  const features = proveFeatures({
    libraries,
    complete: !reasons.some(r => r.kind === "graph"),
    compiledSeams,
    yieldStar
  });

  return {
    asyncFree: reasons.length === 0,
    entry: reasons.length === 0 ? runtimeManifest.asyncFreeEntry : null,
    reasons,
    features,
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
const FEATURE_SWITCHES = [
  "OPTIMISTIC",
  "VERDICTS",
  "STORES",
  "SNAPSHOTS",
  "ITERABLE",
  "COMPILED_SEAMS"
];

/**
 * @returns {Record<string, { on: boolean, because: string[] }>}
 */
function proveFeatures({ libraries, complete, compiledSeams, yieldStar = [] }) {
  const out = {};
  for (const feature of FEATURE_SWITCHES) out[feature] = { on: false, because: [] };
  const use = (feature, why) => {
    out[feature].on = true;
    if (out[feature].because.length < 8) out[feature].because.push(why);
  };
  if (!complete) for (const f of FEATURE_SWITCHES) use(f, "module graph not fully known");
  for (const [pkg, { manifest, names }] of libraries) {
    const featureExports = manifest?.featureExports;
    if (!featureExports) {
      // A manifest without feature facts says nothing about features.
      for (const f of FEATURE_SWITCHES) use(f, `${pkg} declares no featureExports`);
      continue;
    }
    for (const [feature, exportsOf] of Object.entries(featureExports)) {
      if (!out[feature]) continue;
      for (const name of names)
        if (name === "*" ? exportsOf.length > 0 : exportsOf.includes(name))
          use(feature, name === "*" ? `namespace import of ${pkg}` : `${pkg}: ${name}`);
    }
  }
  for (const file of yieldStar) use("ITERABLE", `${file} uses yield*`);
  if (compiledSeams)
    use("COMPILED_SEAMS", "compiler passes may emit noThrow / equals / statusFree");
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
 *   false only when blockProofs, host fusion and memo fusion are all off)
 */
function solidCapabilities(options = {}) {
  let config;
  let decision = null;
  const featureSlicing = options.features !== false;
  const FEATURES_ID = "\0solid-features:";
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
    },
    async buildStart(input) {
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
      const entries = inputs
        .map(entry => path.resolve(root, entry))
        .flatMap(entry => (/\.html?$/.test(entry) ? htmlEntries(entry, root) : [entry]));
      let typedSummary = options.typedSummary;
      if (typeof typedSummary === "string") {
        const file = path.resolve(root, typedSummary);
        typedSummary = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
      }
      if (!entries.length) {
        decision = { asyncFree: false, entry: null, reasons: [{ reason: "no entry modules" }] };
      } else {
        decision = await proveGraph({
          entries,
          root,
          typedSummary,
          compiledSeams: options.compiledSeams !== false,
          resolve: async (source, importer) => {
            const resolved = await this.resolve(source, importer, { skipSelf: true });
            return resolved && !resolved.external ? resolved.id : null;
          }
        });
      }
      decision.graph = config?.build?.ssr ? "server" : "client";
      if (options.report) {
        const file = path.resolve(root, options.report);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(decision, null, 2));
      }
      const summary = decision.asyncFree
        ? `async-free ${decision.graph} graph (${decision.modules.length} modules): ${RUNTIME_PACKAGE} → ${decision.entry}`
        : `${decision.graph} graph keeps the full runtime (${decision.reasons.length} reason${decision.reasons.length === 1 ? "" : "s"}; first: ${decision.reasons[0]?.reason})`;
      config?.logger?.info?.(`[solid:capabilities] ${summary}`);
      if (featureSlicing && decision.features) {
        const off = FEATURE_SWITCHES.filter(f => !decision.features[f].on);
        config?.logger?.info?.(
          `[solid:capabilities] ${decision.graph} runtime slice: ${off.length ? `switched off ${off.join(", ")}` : "every feature switch stays on"}`
        );
      }
    },
    async resolveId(source, importer, resolveOptions) {
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
        !/(^|\/)features\.js$/.test(source) ||
        FEATURE_SWITCHES.every(f => decision.features[f].on)
      )
        return null;
      const resolved = await this.resolve(source, importer, { ...resolveOptions, skipSelf: true });
      const tier =
        resolved &&
        /[\\/]dist[\\/](prod|observe|sync)[\\/]core[\\/]features\.js$/.exec(resolved.id);
      if (!tier || packageOf(resolved.id)?.name !== RUNTIME_PACKAGE) return null;
      return FEATURES_ID + tier[1];
    },
    load(id) {
      if (!id.startsWith(FEATURES_ID)) return null;
      return featuresModuleSource(decision.features, id.slice(FEATURES_ID.length));
    }
  };
}

module.exports = {
  proveGraph,
  proveFeatures,
  solidCapabilities,
  packageOf,
  htmlEntries,
  FEATURE_SWITCHES
};
