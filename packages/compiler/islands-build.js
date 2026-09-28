"use strict";
// Compiled islands: build glue around `compileIslands` (index.js).
//
// - `islandsEntry(options)`: the page's client entry — the ~0.3 KB loader
//   (delegated listeners, anchor lookup, chunk import, one ordered queue,
//   replay of the first event, `data-pd` preventDefault) for lazy islands,
//   static imports and activation at load for eager (hot) ones, and the
//   prefetch policy (app default, per-island overrides, byte budget and
//   `saveData` / slow-network downgrade);
// - `IslandsCompiler`: compiles modules once per content, assigns each
//   module a unique id prefix, follows relative imports from a root module
//   to collect every island of the page, and serves the virtual modules
//   (entry, chunks) both plugins resolve;
// - `solidIslands(options)`: the Vite plugin (client + SSR builds);
// - `esbuildIslands(options)`: the same for esbuild (the measurement harness).
//
// documentation/plans/ssr-hydration-redesign.md, "Compiler emission".

const fs = require("fs");
const path = require("path");
const { compileIslands } = require("./index.js");

const PREFETCH = ["load", "idle", "visible", "intent", "interaction"];
const ENTRY = "virtual:solid-islands";
const CHUNK = "virtual:solid-islands/chunk/";

/**
 * The client entry module for a page's islands.
 *
 * islands: [{ id, events, windowEvents, activation: "lazy"|"load", tier,
 *             anchor: "element"|"comment", preventDefault, root, size? }]
 * mode: "auto" (hot islands at load, the rest lazy) | "eager" (all at load)
 *       | "lazy" (all on interaction; hot islands still activate at load)
 * prefetch: app default, one of PREFETCH (default "interaction")
 * overrides: { [rootComponentOrId]: policy }
 * budget: bytes of lazy chunks prefetch may load (sizes from `island.size`)
 * network: downgrade prefetch to "interaction" under saveData / 2g (default true)
 * chunk: id → import specifier
 * hooks: { before, after } code run around the load-time work (timing hooks)
 */
function islandsEntry({
  islands,
  mode = "auto",
  prefetch = "interaction",
  overrides = {},
  budget,
  network = true,
  chunk = id => CHUNK + id,
  hooks = {},
  hydrate = [],
  web = "@solidjs/web",
  streams = false
} = {}) {
  const J = JSON.stringify;
  const eager = islands.filter(i => mode === "eager" || i.activation === "load");
  const lazy = islands.filter(i => !eager.includes(i));
  let s = "";
  eager.forEach((i, n) => {
    s += `import { activate as a${n}${i.tier ? `, flush as f${n}` : ""} } from ${J(chunk(i.id))};\n`;
  });
  if (eager.some(i => i.anchor === "comment"))
    s += `const $ca = id => { const out = [], w = document.createTreeWalker(document.body, 128); for (let n; (n = w.nextNode()); ) if (n.data.startsWith("i:") && n.data.slice(2).split(" ").includes(id)) out.push(n); return out; };\n`;
  // Streaming (islands-stream.js): boundary chunks land after the shell.
  // Islands they carry activate as they land (`solid-islands` on document);
  // an island whose static paths cross a boundary (`waits`) activates once no
  // boundary around its anchor is pending.
  const waits = streams && islands.some(i => i.waits);
  if (waits)
    s += `const $pd = el => { const w = document.createTreeWalker(el.parentNode || el, 128); for (let n; (n = w.nextNode()); ) if (/^l\\d/.test(n.data)) return 1; };\n`;
  let start = "";
  if (lazy.length) {
    const policy = i => {
      const p = overrides[i.root] ?? overrides[i.id] ?? i.prefetch ?? prefetch;
      if (!PREFETCH.includes(p)) throw new Error(`[solid-islands] unknown prefetch policy "${p}"`);
      return p;
    };
    const types = [...new Set(lazy.flatMap(i => i.events))];
    const wins = [...new Set(lazy.flatMap(i => i.windowEvents || []))];
    // L[id] = [import, events handled, window events]; A[id] = activated anchors.
    const table = lazy
      .map(i => {
        const row = [`() => import(${J(chunk(i.id))})`, J(i.events)];
        if (wins.length) row.push(J(i.windowEvents || []));
        if (budget != null) row.push(String(i.size || 0));
        return `${J(i.id)}: [${row.join(", ")}]`;
      })
      .join(",\n  ");
    s += `const L = {\n  ${table}\n}, Q = [];\nlet B = 0, R = 0;\n`;
    const lazyWaits = waits ? lazy.filter(i => i.waits).map(i => i.id) : [];
    if (lazyWaits.length) s += `const WT = ${J(lazyWaits)};\n`;
    s += loader({
      wins: wins.length > 0,
      nest: lazy.some(i => i.nests !== false),
      pd: lazy.some(i => i.preventDefault),
      click: types.includes("click"),
      waits: lazyWaits.length > 0
    });
    start += `for (const t of ${J(types)}) document.addEventListener(t, E, true);\n`;
    if (wins.length) start += `for (const t of ${J(wins)}) addEventListener(t, W);\n`;
    const byPolicy = {};
    for (const i of lazy) (byPolicy[policy(i)] ||= []).push(i.id);
    const uses = p => byPolicy[p] && byPolicy[p].length;
    if (PREFETCH.some(p => p !== "interaction" && uses(p))) {
      const bi = wins.length ? 3 : 2;
      let pf =
        budget != null
          ? `let $b = ${Number(budget)}; const $p = {}, pf = id => { if (!$p[id] && ($b -= L[id][${bi}]) >= 0) { $p[id] = 1; L[id][0](); } };\n`
          : `const pf = id => L[id][0]();\n`;
      if (uses("load")) pf += `for (const id of ${J(byPolicy.load)}) pf(id);\n`;
      if (uses("idle"))
        pf += `(self.requestIdleCallback || setTimeout)(() => { for (const id of ${J(byPolicy.idle)}) pf(id); });\n`;
      if (uses("visible"))
        pf += `{ const ids = ${J(byPolicy.visible)}, io = new IntersectionObserver(es => { for (const x of es) if (x.isIntersecting) { io.unobserve(x.target); for (const id of x.target.dataset.i.split(" ")) ids.includes(id) && pf(id); } }), ob = () => { for (const id of ids) for (const el of document.querySelectorAll('[data-i~="' + id + '"]')) io.observe(el); }; ob();${streams ? ` document.addEventListener("solid-islands", ob);` : ""} }\n`;
      if (uses("intent"))
        pf += `{ const ids = ${J(byPolicy.intent)}; for (const t of ["pointerover", "focusin", "touchstart"]) document.addEventListener(t, e => { const el = e.target.closest && e.target.closest("[data-i]"); if (el) for (const id of el.dataset.i.split(" ")) ids.includes(id) && pf(id); }, { capture: true, passive: true }); }\n`;
      // Network downgrade: saveData or a 2G connection prefetches nothing.
      const guard = network
        ? `const $nc = navigator.connection;\nif (!($nc && ($nc.saveData || /2g/.test($nc.effectiveType)))) {\n${pf}}\n`
        : pf;
      start += guard;
    }
  }
  // Fallback modules (not compiled to islands, e.g. tier 2: stores, async,
  // optimistic writes): today's hydration of their root component.
  if (hydrate.length) {
    s += `import { hydrate as $hydrate, createComponent as $cc } from ${J(web)};\n`;
    hydrate.forEach((h, n) => (s += `import { ${h.export} as $H${n} } from ${J(h.module)};\n`));
  }
  s += "export function start() {\n";
  if (hooks.before) s += hooks.before + "\n";
  hydrate.forEach(
    (h, n) =>
      (s += `$hydrate(() => $cc($H${n}, {}), document.querySelector(${J(h.selector || "#root")}));\n`)
  );
  if (streams && eager.length) {
    // Activate each anchor once, now and whenever a boundary chunk lands.
    const rows = eager.map(
      (i, n) =>
        `[a${n}, ${i.tier ? `f${n}` : 0}, ${J(i.id)}${i.anchor === "comment" || (waits && i.waits) ? `, ${i.anchor === "comment" ? 1 : 0}` : ""}${waits && i.waits ? ", 1" : ""}]`
    );
    s += `const $act = () => { for (const [a, f, id, c, w] of [${rows.join(", ")}]) for (const el of ${eager.some(i => i.anchor === "comment") ? `c ? $ca(id) : ` : ""}document.querySelectorAll('[data-i~="' + id + '"]')) { const s = (el.$i ||= {}); if (s[id]${waits ? " || (w && $pd(el))" : ""}) continue; s[id] = 1; a(el); f && f(); } };\n`;
    s += `$act();\ndocument.addEventListener("solid-islands", $act);\n`;
  } else {
    eager.forEach((i, n) => {
      const find =
        i.anchor === "comment"
          ? `$ca(${J(i.id)})`
          : `document.querySelectorAll('[data-i~="${i.id}"]')`;
      s += `for (const el of ${find}) a${n}(el);\n`;
    });
    eager.forEach((i, n) => {
      if (i.tier) s += `f${n}();\n`;
    });
  }
  s += start;
  if (hooks.after) s += hooks.after + "\n";
  s += "}\n";
  return s;
}

// The loader: one capturing listener per event type (and one per window
// event of a settled listener stub). The first event reaching an inactive
// island is stopped (and prevented when its element carries `data-pd`, or
// when a replayed click would toggle a checkbox again), the islands it can
// reach are imported and activated, and every event that arrived meanwhile
// is replayed in order: one queue per page.
function loader({ wins, nest, pd, click, waits }) {
  const walk = nest
    ? `for (; el; el = el.parentElement && el.parentElement.closest("[data-i]"))\n    `
    : "";
  const prevent = [
    pd && `t.closest("[data-pd]")`,
    click && `(e.type == "click" && (t.type == "checkbox" || t.type == "radio"))`
  ].filter(Boolean);
  // A `waits` island whose boundary is still streaming: its chunk loads now,
  // its activation (and the queued events) once the boundary has landed.
  const ready = waits
    ? `const ready = (el, id) => WT.includes(id) && $pd(el) ? new Promise(r => { const f = () => { if (!$pd(el)) { document.removeEventListener("solid-islands", f); r(); } }; document.addEventListener("solid-islands", f); }) : 0;
`
    : "";
  const load = waits ? `Promise.all([L[id][0](), ready(el, id)]).then(([m]) => m)` : `L[id][0]()`;
  let s = `const has = (el, id) => el.$i && el.$i[id];
${ready}const act = (el, id) => ${load}.then(m => { if (!has(el, id)) { (el.$i ||= {})[id] = 1; m.activate(el); m.flush && m.flush(); } });
const done = () => { if (!--B) { R = 1; for (const [t, e] of Q.splice(0)) t.dispatchEvent(new e.constructor(e.type, e)); R = 0; } };
const wait = (t, e, p) => { Q.push([t, e]); B++; Promise.all(p).then(done, done); };
function E(e) {
  const t = e.target, p = [];
  let el = !R && t.closest && t.closest("[data-i]");
  if (!el) return;
  ${walk}for (const id of el.dataset.i.split(" ")) L[id] && L[id][1].includes(e.type) && !has(el, id) && p.push(act(el, id));
  if (!p.length && !B) return;
  e.stopImmediatePropagation();
  ${prevent.length ? `if (${prevent.join(" || ")}) e.preventDefault();\n  ` : ""}wait(t, e, p);
}
`;
  if (wins)
    s += `function W(e) {
  if (R) return;
  const p = [];
  for (const id in L) if (L[id][2].includes(e.type)) for (const el of document.querySelectorAll('[data-i~="' + id + '"]')) has(el, id) || p.push(act(el, id));
  p.length && wait(window, e, p);
}
`;
  return s;
}

/** Compiles island modules and follows their relative imports from a root. */
class IslandsCompiler {
  constructor({
    runtimes = {},
    tier1Core = false,
    minTier = 0,
    debug = false,
    idPrefix,
    compile = compileIslands
  } = {}) {
    this.options = { runtimes, tier1Core, minTier, debug };
    this.compile = compile;
    this.cache = new Map();
    this.prefixes = new Map();
    this.idPrefix = idPrefix;
  }
  prefixFor(file) {
    let p = this.prefixes.get(file);
    if (!p) {
      const n = this.prefixes.size;
      p = (this.idPrefix ?? "i") + (n ? toBase36(n) + "_" : "");
      this.prefixes.set(file, p);
    }
    return p;
  }
  compileFile(file, code = fs.readFileSync(file, "utf8")) {
    const hit = this.cache.get(file);
    if (hit && hit.code === code) return hit.out;
    const { runtimes, tier1Core, minTier, debug } = this.options;
    const out = this.compile(code, {
      filename: file,
      idPrefix: this.prefixFor(file),
      t0Module: runtimes.t0,
      kernelModule: runtimes.kernel,
      coreModule: runtimes.core,
      tier1Core,
      minTier,
      debug
    });
    for (const c of out.chunks) c.size = Buffer.byteLength(c.code);
    this.cache.set(file, { code, out });
    return out;
  }
  /** Every island reachable from `root` through relative imports of compiled modules. */
  collect(root, filter = f => /\.[jt]sx$/.test(f)) {
    const seen = new Set();
    const islands = [];
    const chunks = new Map();
    const fallbacks = [];
    let streams = false;
    const visit = file => {
      if (seen.has(file)) return;
      seen.add(file);
      const code = fs.readFileSync(file, "utf8");
      const out = this.compileFile(file, code);
      if (out.fallback) fallbacks.push({ file, reason: out.fallback });
      if (out.manifest.streams) streams = true;
      for (const i of out.manifest.islands) {
        const c = out.chunks.find(c => c.id === i.id);
        islands.push({ ...i, file, size: c ? c.size : 0 });
        if (c) chunks.set(i.id, c.code);
      }
      for (const m of code.matchAll(/^\s*import\s[^"']*["'](\.{1,2}\/[^"']+)["']/gm)) {
        const target = resolveRelative(file, m[1]);
        if (target && filter(target)) visit(target);
      }
    };
    visit(root);
    return { islands, chunks, fallbacks, files: [...seen], streams };
  }
}

function resolveRelative(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  for (const ext of ["", ".tsx", ".jsx", ".ts", ".js", "/index.tsx", "/index.jsx"]) {
    const f = base + ext;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

function toBase36(n) {
  return n.toString(36);
}

/**
 * Vite plugin. `root`: the page's root module (islands are collected from
 * it). In SSR builds every matching module compiles to its string-template
 * server module; in client builds `virtual:solid-islands` is the entry
 * (import it from the client entry and call `start()`, or use
 * `virtual:solid-islands/auto`), and island chunks are virtual modules.
 */
function solidIslands(options = {}) {
  const {
    root,
    include = /\.[jt]sx$/,
    exclude = /node_modules/,
    mode = "auto",
    prefetch = "interaction",
    overrides,
    budget,
    network,
    runtimes = {},
    tier1Core = "auto",
    rootExport = "App",
    mount = "#root"
  } = options;
  let compiler;
  let config;
  let collected;
  const matches = id => include.test(id) && !exclude.test(id);
  return {
    name: "solid-islands",
    enforce: "pre",
    configResolved(c) {
      config = c;
    },
    buildStart() {
      compiler = new IslandsCompiler({ runtimes: resolveRuntimes(runtimes), tier1Core: false });
      // Island ids must match across the SSR and client builds: assign
      // every module's id prefix in the root's import order (a DFS), before
      // either build transforms anything in its own order.
      collected = collectWithDedupe(compiler, path.resolve(config.root, root), tier1Core);
    },
    resolveId(id) {
      if (id === ENTRY || id === ENTRY + "/auto") return "\0" + id;
      if (id.startsWith(CHUNK)) return "\0" + id + ".ts";
      return null;
    },
    async load(id) {
      if (!id.startsWith("\0virtual:solid-islands")) return null;
      const rootFile = path.resolve(config.root, root);
      collected ||= collectWithDedupe(compiler, rootFile, tier1Core);
      if (id === "\0" + ENTRY + "/auto") return `import { start } from "${ENTRY}";\nstart();\n`;
      if (id === "\0" + ENTRY) {
        if (collected.fallbacks.length) {
          const f = collected.fallbacks[0];
          this.warn(
            `[solid-islands] ${path.relative(config.root, f.file)} falls back to hydration: ${f.reason}`
          );
        }
        return islandsEntry({
          islands: collected.islands,
          mode,
          prefetch,
          overrides,
          budget,
          network,
          streams: collected.streams,
          hydrate: fallbackRoots(collected, rootFile, rootExport, mount)
        });
      }
      const chunkId = id.slice(("\0" + CHUNK).length, -3);
      const code = collected.chunks.get(chunkId);
      if (code == null) this.error(`[solid-islands] unknown island chunk ${chunkId}`);
      // Chunks are plain JavaScript (the compiler erases TypeScript).
      return code;
    },
    async transform(code, id, opts) {
      const file = id.split("?")[0];
      if (!matches(file) || file.startsWith("\0")) return null;
      const ssr = !!(opts && opts.ssr);
      const out = compiler.compileFile(file, code);
      // The module keeps its .tsx id: Vite's TypeScript transform runs after
      // this pre plugin on the (JSX-free) output.
      if (ssr) return { code: out.server, map: null };
      if (out.fallback) return { code: out.client, map: null };
      // An islands-compiled module has no client code of its own: its live
      // parts ship as the island chunks.
      return { code: "export {};\n", map: null };
    }
  };
}

/** A root module that fell back to hydration is hydrated by the entry. */
function fallbackRoots(collected, rootFile, rootExport = "App", mount = "#root") {
  return collected.fallbacks.some(f => f.file === rootFile)
    ? [{ module: rootFile, export: rootExport, selector: mount }]
    : [];
}

function collectWithDedupe(compiler, rootFile, tier1Core) {
  let collected = compiler.collect(rootFile);
  // Page dedupe (island-runtime-tiers.md recommendation 3): when a group
  // needs the core anyway, bind the page's tier-1 groups to it too.
  const needsCore = collected.islands.some(i => i.tier >= 2) || collected.fallbacks.length > 0;
  if ((tier1Core === "auto" && needsCore) || tier1Core === true) {
    compiler.options.tier1Core = true;
    compiler.cache.clear();
    collected = compiler.collect(rootFile);
  }
  return collected;
}

function resolveRuntimes(r) {
  return { t0: r.t0, kernel: r.kernel, core: r.core };
}

/** esbuild plugin (the measurement harness). */
function esbuildIslands({
  root,
  mode = "auto",
  prefetch = "interaction",
  overrides,
  budget,
  network,
  hooks,
  compiler,
  filter = /\.[jt]sx$/,
  rootExport = "App",
  mount = "#root"
} = {}) {
  compiler ||= new IslandsCompiler();
  return {
    name: "solid-islands",
    setup(b) {
      let collected;
      const get = () => (collected ||= compiler.collect(root));
      b.onResolve({ filter: /^virtual:solid-islands/ }, args => ({
        path: args.path,
        namespace: "solid-islands"
      }));
      b.onLoad({ filter: /.*/, namespace: "solid-islands" }, args => {
        const c = get();
        if (args.path === ENTRY)
          return {
            contents: islandsEntry({
              islands: c.islands,
              mode,
              prefetch,
              overrides,
              budget,
              network,
              hooks,
              streams: c.streams,
              hydrate: fallbackRoots(c, root, rootExport, mount)
            }),
            loader: "js",
            resolveDir: path.dirname(root)
          };
        const id = args.path.slice(CHUNK.length);
        return { contents: c.chunks.get(id), loader: "ts", resolveDir: path.dirname(root) };
      });
      b.onLoad({ filter }, args => {
        if (args.path.includes("node_modules")) return undefined;
        const out = compiler.compileFile(args.path);
        return { contents: out.fallback ? out.client : "export {};", loader: "ts" };
      });
    }
  };
}

module.exports = {
  islandsEntry,
  IslandsCompiler,
  solidIslands,
  esbuildIslands,
  fallbackRoots,
  PREFETCH,
  ENTRY,
  CHUNK
};
