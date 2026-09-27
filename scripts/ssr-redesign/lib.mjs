// Shared plumbing for the SSR / hydration redesign measurements
// (documentation/plans/ssr-hydration-redesign.md).
//
// - compile: the real Rust compiler (packages/compiler) as an esbuild plugin,
//   run on .tsx/.jsx with the requested generate / hydratable options;
// - runtime aliases for client (prod dists) and server builds;
// - counters: exact-once textual patches of the prod dists that count the
//   hydration work (computations, recomputes, signals, owners, claims, trace
//   re-runs of serialized computes, the _hk gather) into globalThis.__c;
// - oracles: exact-once patches that model a runtime change a prototype needs
//   (named, documented next to each patch);
// - page anatomy: byte split of a server-rendered page.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const HERE = dirname(fileURLToPath(import.meta.url));
const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);

export const DIST = {
  signals: join(ROOT, "packages/signals/dist/prod/index.js"),
  solid: join(ROOT, "packages/solid/dist/solid.js"),
  web: join(ROOT, "packages/web/dist/web.js"),
  solidServer: join(ROOT, "packages/solid/dist/server.js"),
  webServer: join(ROOT, "packages/web/dist/server.js")
};

export const gz = s => gzipSync(Buffer.from(s), { level: 9 }).length;
export const br = s =>
  brotliCompressSync(Buffer.from(s), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
export const kb = n => (n / 1024).toFixed(1);

/** Replace `from` exactly once in `src`; a miss or a double hit is an error. */
export function once(src, from, to, what = "patch") {
  const i = src.indexOf(from);
  if (i < 0) throw new Error(`${what}: anchor not found: ${from.slice(0, 80)}`);
  if (src.indexOf(from, i + 1) >= 0) throw new Error(`${what}: anchor not unique: ${from.slice(0, 80)}`);
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// --- counters -----------------------------------------------------------------
const C = "(globalThis.__c||(globalThis.__c={}))";
const inc = k => `${C}.${k}=(${C}.${k}||0)+1;`;
const COUNTERS = [
  [/signals\/dist\/prod\/core\/core\.js$/, "function computed(e, t) {", `function computed(e, t) {${inc("computed")}`],
  [/signals\/dist\/prod\/core\/core\.js$/, "function recompute(e, t = false) {", `function recompute(e, t = false) {${inc("recompute")}`],
  [/signals\/dist\/prod\/core\/core\.js$/, "function signal(e, t, n = null) {", `function signal(e, t, n = null) {${inc("signal")}`],
  [/signals\/dist\/prod\/core\/owner\.js$/, "function createOwner(e) {", `function createOwner(e) {${inc("owner")}`],
  [/solid\/dist\/solid\.js$/, "function subFetch(fn, prev) {", `function subFetch(fn, prev) {${inc("traceRerun")}`],
  [/solid\/dist\/solid\.js$/, "function readHydratedValue(initP, refresh, options) {", `function readHydratedValue(initP, refresh, options) {${inc("adopted")}`],
  [/web\/dist\/web\.js$/, "function getNextElement(template) {", `function getNextElement(template) {${inc("claim")}`],
  // A key miss while hydrating: the walk found no server node for its key and
  // cloned the template instead (a silent mismatch in prod builds).
  [
    /web\/dist\/web\.js$/,
    "    if (!template) {\n      throw new Error(`Hydration Mismatch. Unable to find DOM nodes for hydration key: ${key}`);\n    }\n    return template(true);",
    `    if (hydrating) {${inc("keyMiss")}(${C}.missed||(${C}.missed=[])).length<5&&${C}.missed.push(key);}\n    if (!template) {\n      throw new Error(\`Hydration Mismatch. Unable to find DOM nodes for hydration key: \${key}\`);\n    }\n    return template(true);`
  ],
  [
    /web\/dist\/web\.js$/,
    "function gatherHydratable(element, root) {",
    `function gatherHydratable(element, root) {const __t0=performance.now();try{return __gather(element, root)}finally{${C}.gatherMs=(${C}.gatherMs||0)+performance.now()-__t0}}\nfunction __gather(element, root) {`
  ]
];

// --- oracles ------------------------------------------------------------------
/**
 * `adopt`: server-authoritative adoption. Today every serialized computation
 * re-runs its compute once during hydration (subFetch: fetch and Promise are
 * mocked, the result is discarded) only to learn its dependencies. When the
 * compiler knows a block's read set statically (generator blocks v2 / a
 * compute whose reads are all visible), the re-run can be skipped: adopt the
 * serialized value and subscribe to the known sources. The oracle skips the
 * re-run for nodes whose options carry `adopt: true` (emitted by the
 * prototype's source rewrite only where the read set is proven empty).
 */
const ORACLES = {
  adopt: [
    [
      /solid\/dist\/solid\.js$/,
      "function readHydratedValue(initP, refresh, options) {\n  refresh();",
      "function readHydratedValue(initP, refresh, options) {\n  if (!(options && options.adopt)) refresh();"
    ]
  ]
};

// (`yield* Ctx` in a `$component` setup used to throw NoOwnerError during
// SSR — todos-blocks rendered its <Errored> fallback. Fixed in the runtime on
// this branch: the server provider installs a context reader.)
function patchPlugin({ count = false, oracles = [] } = {}) {
  const patches = [...oracles.flatMap(o => ORACLES[o]), ...(count ? COUNTERS : [])];
  return {
    name: "ssr-redesign-patches",
    setup(b) {
      if (!patches.length) return;
      b.onLoad({ filter: /packages\/(signals|solid|web)\/dist\/.*\.js$/ }, args => {
        const mine = patches.filter(([re]) => re.test(args.path));
        if (!mine.length) return undefined;
        let src = readFileSync(args.path, "utf8");
        for (const [, from, to] of mine) src = once(src, from, to, relative(ROOT, args.path));
        return { contents: src, loader: "js" };
      });
    }
  };
}

/** Compile .tsx/.jsx through the Rust compiler; `rewrites` model compiler output a prototype would emit. */
function compilerPlugin({ generate, hydratable, rewrites = {}, options = {}, swaps = {} }) {
  return {
    name: "solid-compiler",
    setup(b) {
      b.onLoad({ filter: /\.(tsx|jsx)$/ }, args => {
        if (args.path.includes("node_modules")) return undefined;
        const rel0 = relative(ROOT, args.path);
        // A swap stands in the prototype's compiled output for one module.
        const path = swaps[rel0] ? join(ROOT, swaps[rel0]) : args.path;
        let src = readFileSync(path, "utf8");
        const rel = relative(ROOT, path);
        if (path !== args.path) {
          const out = transform(src, { filename: path, generate, hydratable, ...options });
          return { contents: out.code, loader: "ts", resolveDir: dirname(path) };
        }
        for (const [from, to] of rewrites[rel] || []) src = once(src, from, to, rel);
        const out = transform(src, { filename: args.path, generate, hydratable, ...options });
        return { contents: out.code, loader: "ts", resolveDir: dirname(args.path) };
      });
      // Rewrites on plain .ts modules (no JSX) are applied without compiling.
      b.onLoad({ filter: /\.ts$/ }, args => {
        const rel = relative(ROOT, args.path);
        if (!rewrites[rel]) return undefined;
        let src = readFileSync(args.path, "utf8");
        for (const [from, to] of rewrites[rel]) src = once(src, from, to, rel);
        return { contents: src, loader: "ts" };
      });
    }
  };
}

const TILDE = /^~\//;
function tildePlugin(tildeRoot) {
  return {
    name: "tilde",
    setup(b) {
      if (!tildeRoot) return;
      b.onResolve({ filter: TILDE }, async args => {
        const r = await b.resolve("./" + args.path.slice(2), { resolveDir: tildeRoot, kind: args.kind });
        return r;
      });
    }
  };
}

/**
 * Bundle a client entry. Returns { code, bytes, gzip, groups } where groups
 * split the minified output by origin (signals / solid / web / app / other).
 */
export async function bundleClient(entry, { hydratable = true, count = false, oracles = [], rewrites, swaps, tildeRoot, options, minify = true, splitting = false, dev = false, aliases = {} } = {}) {
  const res = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    minify,
    write: false,
    metafile: true,
    splitting,
    outdir: "/out",
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    // `aliases` re-binds a module for one variant: the island tiers bind the
    // same activation code to the tier-1 kernel instead of the core.
    alias: dev
      ? { "solid-js": DIST.solid.replace("solid.js", "solid.dev.js"), "@solidjs/web": DIST.web.replace("web.js", "web.dev.js"), "@solidjs/signals": DIST.signals.replace("prod/index.js", "dev.js"), ...aliases }
      : { "solid-js": DIST.solid, "@solidjs/web": DIST.web, "@solidjs/signals": DIST.signals, ...aliases },
    plugins: [tildePlugin(tildeRoot), patchPlugin({ count, oracles }), compilerPlugin({ generate: "dom", hydratable, rewrites, options, swaps })]
  });
  // Output files by published name; `initial` = the entry and its static
  // imports (what a page loads eagerly), `lazy` = dynamic-import chunks.
  const base = p => p.split("/").pop();
  const files = Object.fromEntries(res.outputFiles.filter(f => f.path.endsWith(".js")).map(f => [base(f.path), f.text]));
  const outs = Object.fromEntries(Object.entries(res.metafile.outputs).filter(([k]) => k.endsWith(".js")).map(([k, v]) => [base(k), v]));
  const entryName = Object.keys(outs).find(k => outs[k].entryPoint);
  const initial = new Set();
  const visit = n => {
    if (initial.has(n)) return;
    initial.add(n);
    for (const imp of outs[n].imports) if (imp.kind === "import-statement") visit(base(imp.path));
  };
  visit(entryName);
  const groupsOf = names => {
    const g = { signals: 0, solid: 0, web: 0, app: 0, other: 0 };
    for (const n of names) for (const [input, { bytesInOutput }] of Object.entries(outs[n].inputs)) g[originOf(input)] += bytesInOutput;
    return g;
  };
  const lazy = Object.keys(files).filter(n => !initial.has(n));
  const sum = (names, f) => names.reduce((s, n) => s + f(files[n]), 0);
  const init = [...initial];
  return {
    entry: entryName,
    files,
    code: files[entryName],
    bytes: sum(init, c => Buffer.byteLength(c)),
    gzip: sum(init, gz),
    groups: groupsOf(init),
    lazy: { names: lazy, bytes: sum(lazy, c => Buffer.byteLength(c)), gzip: sum(lazy, gz), groups: groupsOf(lazy) }
  };
}

function originOf(input) {
  if (input.includes("packages/signals/")) return "signals";
  if (input.includes("packages/solid/")) return "solid";
  if (input.includes("packages/web/")) return "web";
  if (input.includes("node_modules")) return "other";
  return "app";
}

/** Bundle and import a server entry (node, ESM). */
export async function loadServer(entry, outfile, { rewrites, swaps, tildeRoot, options } = {}) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "error",
    loader: { ".json": "json" },
    alias: { "solid-js": DIST.solidServer, "@solidjs/web": DIST.webServer, "@solidjs/signals": DIST.signals },
    plugins: [tildePlugin(tildeRoot), compilerPlugin({ generate: "ssr", hydratable: true, rewrites, options, swaps })]
  });
  return import(pathToFileURL(outfile).href + `?${Date.now()}`);
}

/**
 * Byte anatomy of a server-rendered HTML page. Parts are measured raw and as
 * their marginal gzip cost (gzip(page) − gzip(page without the part)), so the
 * parts sum approximately to the page's gzip size.
 */
export function anatomy(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map(m => m[0]);
  const dataScripts = scripts.filter(s => /_\$HY\.r|\$R\[|\$df\(|_\$HY\.set|self\.\$R/.test(s));
  const otherScripts = scripts.filter(s => !dataScripts.includes(s));
  const noData = dataScripts.reduce((h, s) => h.replace(s, ""), html);
  const noScripts = otherScripts.reduce((h, s) => h.replace(s, ""), noData);
  const hk = [...html.matchAll(/ _hk=("[^"]*"|[^\s>]*)/g)];
  const noHk = html.replace(/ _hk=("[^"]*"|[^\s>]*)/g, "");
  const markers = [...html.matchAll(/<!--(\$|\/|!\$|\$\$)-->|<!(\$|\/)>/g)];
  const noMarkers = html.replace(/<!--(\$|\/|!\$|\$\$)-->|<!(\$|\/)>/g, "");
  const total = gz(html);
  return {
    bytes: Buffer.byteLength(html),
    gzip: total,
    data: { bytes: dataScripts.reduce((n, s) => n + Buffer.byteLength(s), 0), gzip: total - gz(noData) },
    bootstrap: { bytes: otherScripts.reduce((n, s) => n + Buffer.byteLength(s), 0), gzip: gz(noData) - gz(noScripts) },
    hk: { count: hk.length, bytes: hk.reduce((n, m) => n + Buffer.byteLength(m[0]), 0), gzip: total - gz(noHk) },
    markers: { count: markers.length, bytes: markers.reduce((n, m) => n + Buffer.byteLength(m[0]), 0), gzip: total - gz(noMarkers) }
  };
}

export async function launchChromium() {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
  }
  return chromium.launch();
}

export const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
