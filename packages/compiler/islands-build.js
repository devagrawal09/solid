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
const { compileIslands, islandExports } = require("./index.js");

const PREFETCH = ["load", "idle", "visible", "intent", "interaction"];
const ENTRY = "virtual:solid-islands";
const CHUNK = "virtual:solid-islands/chunk/";
const HOST = "virtual:solid-islands/host";
// Frames (compiler-derived server components): the navigation module (the
// route table, loaded on the first client navigation) and each route
// module's argument functions (`<file>?solid-frames-args`).
const NAV = "virtual:solid-frames/nav";
const ARGS = "?solid-frames-args";
const FRAMES_CLIENT = "@solidjs/compiler/frames-client";

/**
 * The page-flush host module (island-runtime-tiers.md, "Cross-runtime
 * flush"): installs the core as the page's flush host, with the core's own
 * exports (named, so the bundle keeps only these five).
 */
function hostModule({ core = "@solidjs/signals", host = "@solidjs/signals/host" } = {}) {
  const J = JSON.stringify;
  return (
    `import { host } from ${J(host)};\n` +
    `import { createRoot, createSignal, createRenderEffect, createEffect, flush } from ${J(core)};\n` +
    `host({ createRoot, createSignal, createRenderEffect, createEffect, flush });\n`
  );
}

/**
 * The client entry module for a page's islands.
 *
 * islands: [{ id, events, windowEvents, activation: "lazy"|"load", tier,
 *             anchor: "element"|"comment", preventDefault, root, size? }]
 * mode: "auto" (hot islands at load, the rest lazy) | "eager" (all at load)
 *       | "lazy" (all on interaction; hot islands still activate at load)
 * prefetch: app default, one of PREFETCH (default "intent": pointerover /
 *   focusin / touchstart on an island fetches its chunk)
 * overrides: { [rootComponentOrId]: policy }
 * budget: bytes of lazy chunks prefetch may load (sizes from `sizeOf(island)`
 *   — a JS expression; default `island.size`, the chunk's source bytes; the
 *   Vite plugin passes placeholders it replaces with bundled output bytes)
 * network: downgrade prefetch to "interaction" under saveData / 2g (default true)
 * chunk: id → import specifier
 * hooks: { before, after } code run around the load-time work (timing hooks)
 * core: the core's module specifier (default "@solidjs/signals"): an island
 *   whose manifest `runtime` is it (tier 2, or tier 1 under `tier1Core`) runs
 *   on the core
 * host: the page-flush host module to import when the page mixes the core
 *   with the lower tiers (default HOST, the virtual module `hostModule()`
 *   serves): it makes the core run the t0 / kernel flushes inside its own, so
 *   every runtime on the page flushes as one batch. Imported statically when
 *   a core island activates at load (or a module hydrates), else loaded with
 *   the first lazy core island's chunk.
 */
function islandsEntry({
  islands,
  mode = "auto",
  prefetch = "intent",
  overrides = {},
  budget,
  network = true,
  chunk = id => CHUNK + id,
  hooks = {},
  hydrate = [],
  web = "@solidjs/web",
  streams = false,
  sizeOf = i => String(i.size || 0),
  verify = false,
  core = "@solidjs/signals",
  host = HOST,
  frames = null
} = {}) {
  const J = JSON.stringify;
  const eager = islands.filter(i => mode === "eager" || i.activation === "load");
  const lazy = islands.filter(i => !eager.includes(i));
  // Cross-runtime flush (island-runtime-tiers.md): a page mixing the core
  // with t0 / kernel islands hands the page flush to the core.
  const onCore = i => i.tier >= 2 || i.runtime === core;
  const mixed = (hydrate.length > 0 || islands.some(onCore)) && islands.some(i => !onCore(i));
  const hostEager = mixed && (hydrate.length > 0 || eager.some(onCore));
  let s = hostEager ? `import ${J(host)};\n` : "";
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
        const load = `import(${J(chunk(i.id))})`;
        const row = [
          mixed && !hostEager && onCore(i)
            ? `() => Promise.all([${load}, import(${J(host)})]).then(m => m[0])`
            : `() => ${load}`,
          J(i.events)
        ];
        if (wins.length) row.push(J(i.windowEvents || []));
        if (budget != null) row.push(sizeOf(i));
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
  if (frames) s += framesEntry(islands, eager, chunk, frames);
  if ((streams || frames) && eager.length) {
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
  if (frames && frames.nav) s += navStart(frames);
  if (verify) s += verifier(islands, chunk, streams);
  if (hooks.after) s += hooks.after + "\n";
  s += "}\n";
  return s;
}

// Frames: the activator the applier uses to hand a keyed island's state to
// its new anchor after a refetch (`self.$SI.act`), for every island of the
// page (lazy ones load their chunk; eager ones are already imported).
function framesEntry(islands, eager, chunk, frames) {
  const J = JSON.stringify;
  const rows = islands.map(i => {
    const n = eager.indexOf(i);
    const load =
      n >= 0
        ? `() => Promise.resolve({ activate: a${n}${i.tier ? `, flush: f${n}` : ""} })`
        : `() => import(${J(chunk(i.id))})`;
    return `${J(i.id)}: ${load}`;
  });
  let s = `const $SL = {\n  ${rows.join(",\n  ")}\n};\n`;
  s += `self.$SI = { act: (el, id, st) => $SL[id] && $SL[id]().then(m => { (el.$i ||= {})[id] = 1; m.activate(el, st); m.flush && m.flush(); })${frames.nav ? ", links: $links" : ""} };\n`;
  if (frames.nav) {
    s += `const $nav = () => import(${J(frames.navModule || NAV)});\n`;
    // @solidjs/router's link state: aria-current="page" on same-origin
    // links to the location, data-active on those to it or a parent path —
    // at load and after every navigation.
    s += `const $cp = p => ("/" + p.split(/[?#]/, 1)[0].replace(/^\\/+/, "")).toLowerCase().replace(/\\/$/, "");\n`;
    s += `function $links() { const l = decodeURI($cp(location.pathname)); for (const a of document.querySelectorAll("a[href]")) { if (a.target || a.hasAttribute("download") || (a.getAttribute("rel") || "").split(/\\s+/).includes("external")) continue; let u; try { u = new URL(a.getAttribute("href"), document.baseURI); } catch { continue; } if (u.origin !== location.origin) continue; const p = $cp(u.pathname), x = l === p; x || (p !== "" && l.startsWith(p + "/")) ? a.setAttribute("data-active", "") : a.removeAttribute("data-active"); x ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"); } }\n`;
  }
  return s;
}

// Client navigation (inside \`start()\`): same-origin link clicks and history
// traversal load the navigation module (route table + applier) and land the
// route's frame in the outlet; with \`prefetch\`, link intent loads the frame
// ahead (the routes' \`preload\`).
function navStart(frames) {
  let s = `$links();\ndocument.addEventListener("click", e => { if (e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; const a = e.target.closest && e.target.closest("a[href]"); if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.origin !== location.origin || (a.pathname === location.pathname && a.search === location.search && a.hash)) return; e.preventDefault(); $nav().then(m => m.go(a.href)); });\n`;
  s += `addEventListener("popstate", () => $nav().then(m => m.back()));\n`;
  if (frames.prefetch)
    s += `for (const t of ["pointerover", "focusin"]) document.addEventListener(t, e => { const a = e.target.closest && e.target.closest("a[href]"); if (a && a.origin === location.origin && !a.target) $nav().then(m => m.pre(a.href)); }, { capture: true, passive: true });\n`;
  return s;
}

/**
 * The navigation module: the route table (paths, the route frame's id, its
 * argument function from the route module's \`framesClient\`) and the
 * applier's navigation. Routes without a frame navigate with a full load.
 */
function navModule(routes, { client = FRAMES_CLIENT, args = f => f + ARGS } = {}) {
  const J = JSON.stringify;
  const files = [...new Set(routes.filter(r => r.frame && r.argsFile).map(r => r.argsFile))];
  let s = `import { navigate, prefetch } from ${J(client)};\n`;
  files.forEach((f, n) => (s += `import { $$routeArgs as r${n} } from ${J(args(f))};\n`));
  const rows = routes.map(r => {
    const n = files.indexOf(r.argsFile);
    return r.frame && n >= 0
      ? `[${J(r.paths)}, ${J(r.frame)}, r${n}[${J(r.frame)}]]`
      : `[${J(r.paths)}, null, null]`;
  });
  s += `const R = [\n  ${rows.join(",\n  ")}\n];\n`;
  s += `export const go = h => navigate(R, h);\nexport const back = () => navigate(R, null, { push: false });\nexport const pre = h => prefetch(R, h);\n`;
  return s;
}

/**
 * The page's frames report (\`.vite/solid-frames.json\`): every derived
 * frame with its arguments, server functions and the islands its HTML
 * carries (with how each is keyed), the candidates that are not frames and
 * why, and the route table. Paths are relative to \`root\` and entries
 * sorted, so the report is stable for CI diffing.
 */
function framesReport(collected, root) {
  const rel = f => (f ? path.relative(root, f).split(path.sep).join("/") : null);
  const byName = name => collected.islands.filter(i => i.root === name);
  const frames = collected.frames
    .map(f => {
      const islands = [
        ...f.islands.map(i => ({ ...i, module: rel(f.file) })),
        ...(f.renders || []).flatMap(r =>
          byName(r.component).map(i => ({
            id: i.id,
            root: i.root,
            module: rel(i.file),
            key: r.key,
            transplant: !!i.transplant,
            serialized: i.serialized
          }))
        )
      ].sort((x, y) => (x.id < y.id ? -1 : 1));
      return {
        id: f.id,
        module: rel(f.file),
        root: f.root,
        memo: f.memo,
        region: f.region,
        driver: f.driver,
        arguments: f.arguments,
        argumentsFrom: f.argumentsFrom,
        serverFunctions: f.serverFunctions,
        tainted: f.tainted,
        islands,
        public: f.public,
        guard: f.guard
      };
    })
    .sort((x, y) => (x.id < y.id ? -1 : 1));
  return {
    version: 1,
    frames,
    candidates: (collected.candidates || [])
      .map(c => ({ ...c, module: rel(c.module) }))
      .sort((x, y) => (x.module + x.root + x.memo < y.module + y.root + y.memo ? -1 : 1)),
    routes: routeTable(collected).map(r => ({
      paths: r.paths,
      component: r.component,
      module: rel(r.file),
      frame: r.frame,
      preload: r.preload,
      guard: null
    }))
  };
}

/** The page's route table from the collected manifests. */
function routeTable(collected) {
  const out = [];
  for (const { file, router } of collected.routers)
    for (const r of router.routes) {
      const target = r.module ? resolveRelative(file, r.module) : null;
      const frame = target && collected.frames.find(f => f.file === target && f.driver === "route");
      out.push({
        paths: r.paths,
        component: r.component,
        file: target,
        frame: frame ? frame.id : null,
        argsFile: frame && collected.framesClient.has(target) ? target : null,
        preload: r.preload
      });
    }
  return out;
}

// The dev verifier (dev builds): every island's chunk (compiled with
// `verify`) walks its static addresses on each anchor of the server markup
// and reports every node that is not what its code expects, with the
// component and source line; anchors naming an island this build does not
// know are reported too (server and client built from different sources).
// Streamed boundaries are verified as they land. Nothing is activated.
function verifier(islands, chunk, streams) {
  const J = JSON.stringify;
  const rows = islands
    .map(i => `[${J(i.id)}, ${J(i.root)}, () => import(${J(chunk(i.id))}), ${i.waits ? 1 : 0}]`)
    .join(", ");
  let s = `{ const V = [${rows}], known = new Set(V.map(v => v[0])), check = () => {\n`;
  s += `for (const el of document.querySelectorAll("[data-i]")) for (const id of el.dataset.i.split(" ")) if (!known.has(id) && !(el.$vu ||= {})[id]) { el.$vu[id] = 1; console.error("[solid-islands] anchor names unknown island " + id + " (the server markup and the client build disagree)", el); }\n`;
  // A waiting island is verified once no boundary around it is pending.
  s += `const pend = el => { const w = document.createTreeWalker(el.parentNode || el, 128); for (let n; (n = w.nextNode()); ) if (/^l\\d/.test(n.data)) return 1; };\n`;
  s += `for (const [id, root, load, waits] of V) load().then(m => { if (!m.verify) return; for (const el of document.querySelectorAll('[data-i~="' + id + '"]')) { if ((el.$v ||= {})[id] || (waits && pend(el))) continue; el.$v[id] = 1; const e = m.verify(el); if (e.length) console.error("[solid-islands] island " + id + " (" + root + ") does not match the server markup:\\n  " + e.join("\\n  "), el); } });\n`;
  s += `}; check();${streams ? ` document.addEventListener("solid-islands", check);` : ""} }\n`;
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
    compile = compileIslands,
    crossModule = true,
    verify = false,
    keyedState = false,
    framesModule = FRAMES_CLIENT,
    serverFunctionsModule
  } = {}) {
    this.options = {
      runtimes,
      tier1Core,
      minTier,
      debug,
      verify,
      keyedState,
      framesModule,
      serverFunctionsModule
    };
    this.compile = compile;
    this.cache = new Map();
    this.summaries = new Map();
    this.prefixes = new Map();
    this.idPrefix = idPrefix;
    this.crossModule = crossModule;
  }
  /** A module's `islandExports` summary, cached by content (pass one). */
  summary(file, code = fs.readFileSync(file, "utf8")) {
    const hit = this.summaries.get(file);
    if (hit && hit.code === code) return hit.summary;
    const summary = islandExports(code, { filename: file });
    this.summaries.set(file, { code, summary });
    return summary;
  }
  /**
   * Pass two's inputs: the relatively imported modules whose factories,
   * helper generators or components this module uses (their summaries say
   * which), with their sources, for the compiler's cross-module inlining.
   */
  importsFor(file, code) {
    if (!this.crossModule) return [];
    const out = [];
    for (const imp of this.summary(file, code).imports || []) {
      const target = resolveRelative(file, imp.specifier);
      if (!target) continue;
      const tcode = fs.readFileSync(target, "utf8");
      const kinds = new Map(this.summary(target, tcode).exports.map(e => [e.name, e.kind]));
      if (imp.names.some(n => ["factory", "helper", "component"].includes(kinds.get(n))))
        out.push({ specifier: imp.specifier, filename: target, code: tcode });
    }
    return out;
  }
  /**
   * Relative imports naming `"use server"` modules (their summaries say so):
   * a server call over client inputs in this module can be a frame.
   */
  serverImportsFor(file, code) {
    const out = [];
    for (const imp of this.summary(file, code).imports || []) {
      const target = resolveRelative(file, imp.specifier);
      if (!target) continue;
      const s = this.summary(target, fs.readFileSync(target, "utf8"));
      if (!s.useServer && !(s.serverFunctions || []).length) continue;
      out.push({
        specifier: imp.specifier,
        ...(s.useServer ? {} : { names: s.serverFunctions }),
        tainted: s.tainted || []
      });
    }
    return out;
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
    const imports = this.importsFor(file, code);
    const hit = this.cache.get(file);
    if (
      hit &&
      hit.code === code &&
      hit.imports.length === imports.length &&
      hit.imports.every((m, i) => m.filename === imports[i].filename && m.code === imports[i].code)
    )
      return hit.out;
    const {
      runtimes,
      tier1Core,
      minTier,
      debug,
      verify,
      keyedState,
      framesModule,
      serverFunctionsModule
    } = this.options;
    const out = this.compile(code, {
      imports,
      serverImports: this.serverImportsFor(file, code),
      keyedState,
      framesModule,
      ...(serverFunctionsModule ? { serverFunctionsModule } : {}),
      verify,
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
    out.deps = imports.map(m => m.filename);
    this.cache.set(file, { code, imports, out });
    return out;
  }
  /** Every island reachable from `root` through relative imports of compiled modules. */
  collect(root, filter = f => /\.[jt]sx$/.test(f)) {
    const seen = new Set();
    const islands = [];
    const chunks = new Map();
    const fallbacks = [];
    const frames = [];
    const candidates = [];
    const framesClient = new Map();
    const routers = [];
    let streams = false;
    const visit = file => {
      if (seen.has(file)) return;
      seen.add(file);
      const code = fs.readFileSync(file, "utf8");
      const out = this.compileFile(file, code);
      if (out.fallback) fallbacks.push({ file, reason: out.fallback });
      if (out.manifest.streams) streams = true;
      for (const f of out.manifest.frames || []) frames.push({ ...f, file });
      for (const c of out.manifest.frameCandidates || []) candidates.push({ ...c, module: file });
      if (out.framesClient) framesClient.set(file, out.framesClient);
      if (out.manifest.router) routers.push({ file, router: out.manifest.router });
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
    return {
      islands,
      chunks,
      fallbacks,
      files: [...seen],
      streams,
      frames,
      candidates,
      framesClient,
      routers
    };
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
// A lazy chunk's size in the entry, before bundling: replaced in
// `generateBundle` with the bundled output bytes (the chunk and the static
// imports it adds to what the entry already loads).
const SIZE = "__SOLID_ISLAND_SIZE__";
const sizePlaceholder = i => SIZE + i.id.replace(/\W/g, "_");

/** Bytes each lazy island chunk adds to a page, from the bundle (Vite's manifest data). */
function bundledIslandSizes(bundle) {
  const chunks = Object.values(bundle).filter(c => c.type === "chunk");
  const byFile = new Map(chunks.map(c => [c.fileName, c]));
  const closure = (c, out = new Set()) => {
    if (!c || out.has(c.fileName)) return out;
    out.add(c.fileName);
    for (const f of c.imports) closure(byFile.get(f), out);
    return out;
  };
  const sizes = {};
  for (const entry of chunks.filter(c => c.code.includes(SIZE))) {
    const loaded = closure(entry);
    for (const c of chunks) {
      const m =
        c.facadeModuleId && /virtual:solid-islands\/chunk\/(.+)\.ts$/.exec(c.facadeModuleId);
      if (!m) continue;
      let bytes = 0,
        gzip = 0;
      for (const f of closure(c)) {
        if (loaded.has(f)) continue;
        const code = byFile.get(f).code;
        bytes += Buffer.byteLength(code);
        gzip += require("zlib").gzipSync(code).length;
      }
      sizes[m[1]] = { bytes, gzip, file: c.fileName };
    }
    entry.code = entry.code.replace(new RegExp(SIZE + "([\\w$]+)", "g"), (_, id) => {
      const hit = Object.entries(sizes).find(([k]) => k.replace(/\W/g, "_") === id);
      return String(hit ? hit[1].bytes : 0);
    });
  }
  return sizes;
}

function solidIslands(options = {}) {
  const {
    root,
    include = /\.[jt]sx$/,
    exclude = /node_modules/,
    mode = "auto",
    prefetch = "intent",
    overrides,
    budget,
    network,
    runtimes = {},
    tier1Core = "auto",
    rootExport = "App",
    mount = "#root",
    // The dev verifier: on by default in the dev server.
    verify
  } = options;
  const verifying = () => verify ?? config.command === "serve";
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
      compiler = new IslandsCompiler({
        runtimes: resolveRuntimes(runtimes),
        tier1Core: false,
        verify: verifying()
      });
      // Island ids must match across the SSR and client builds: assign
      // every module's id prefix in the root's import order (a DFS), before
      // either build transforms anything in its own order.
      collected = collectWithDedupe(compiler, path.resolve(config.root, root), tier1Core);
    },
    resolveId(id) {
      if (id === ENTRY || id === ENTRY + "/auto" || id === HOST || id === NAV) return "\0" + id;
      if (id.startsWith(CHUNK)) return "\0" + id + ".ts";
      if (id.endsWith(ARGS)) return id;
      return null;
    },
    async load(id) {
      if (id.endsWith(ARGS)) {
        const rootFile = path.resolve(config.root, root);
        collected ||= collectWithDedupe(compiler, rootFile, tier1Core);
        return (
          collected.framesClient.get(id.slice(0, -ARGS.length)) ??
          "export const $$routeArgs = {};\n"
        );
      }
      if (id === "\0" + NAV) {
        const rootFile = path.resolve(config.root, root);
        collected ||= collectWithDedupe(compiler, rootFile, tier1Core);
        return navModule(routeTable(collected));
      }
      if (!id.startsWith("\0virtual:solid-islands")) return null;
      const rootFile = path.resolve(config.root, root);
      collected ||= collectWithDedupe(compiler, rootFile, tier1Core);
      if (id === "\0" + ENTRY + "/auto") return `import { start } from "${ENTRY}";\nstart();\n`;
      if (id === "\0" + HOST) return hostModule(pageRuntimes(runtimes));
      if (id === "\0" + ENTRY) {
        // Every construct that falls back is named (whole-module tier-2
        // hydration instead of fine-grained islands).
        for (const f of collected.fallbacks)
          this.warn(
            `[solid-islands] ${path.relative(config.root, f.file)} falls back to hydration: ${f.reason}`
          );
        return islandsEntry({
          islands: collected.islands,
          mode,
          prefetch,
          overrides,
          budget,
          network,
          streams: collected.streams,
          // Builds count bundled output bytes (see generateBundle); the dev
          // server, the chunks' source bytes.
          sizeOf: config.command === "build" ? sizePlaceholder : undefined,
          verify: verifying(),
          hydrate: fallbackRoots(collected, rootFile, rootExport, mount),
          core: pageRuntimes(runtimes).core,
          frames: framesOption(collected)
        });
      }
      const chunkId = id.slice(("\0" + CHUNK).length, -3);
      const code = collected.chunks.get(chunkId);
      if (code == null) this.error(`[solid-islands] unknown island chunk ${chunkId}`);
      // Chunks are plain JavaScript (the compiler erases TypeScript).
      return code;
    },
    generateBundle(_, bundle) {
      if (collected && (collected.frames.length || collected.candidates.length))
        this.emitFile({
          type: "asset",
          fileName: ".vite/solid-frames.json",
          source: JSON.stringify(framesReport(collected, config.root), null, 2) + "\n"
        });
      if (budget == null) return;
      const sizes = bundledIslandSizes(bundle);
      // Next to Vite's manifest: what each lazy island adds to the page.
      this.emitFile({
        type: "asset",
        fileName: ".vite/solid-islands.json",
        source: JSON.stringify({ budget, islands: sizes }, null, 2)
      });
    },
    async transform(code, id, opts) {
      if (id.endsWith(ARGS)) return null;
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

/** The entry's frames options from what the page's modules hold. */
function framesOption(collected) {
  if (!collected.frames.length && !collected.routers.length) return null;
  const routes = routeTable(collected);
  return {
    nav: routes.length > 0,
    prefetch: routes.some(r => r.preload && r.frame)
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
  // Frames: a page with frames compiles its chunks with keyed state (a
  // keyed island keeps its state across a refetch of its frame).
  if (collected.frames.length && !compiler.options.keyedState) {
    compiler.options.keyedState = true;
    compiler.cache.clear();
    collected = compiler.collect(rootFile);
  }
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
  return { t0: r.t0, kernel: r.kernel, core: r.core, host: r.host };
}

/** The core and host specifiers the entry and the host module use (compiler defaults). */
function pageRuntimes(r = {}) {
  return { core: r.core || "@solidjs/signals", host: r.host || "@solidjs/signals/host" };
}

/** esbuild plugin (the measurement harness). */
function esbuildIslands({
  root,
  mode = "auto",
  prefetch = "intent",
  overrides,
  budget,
  network,
  hooks,
  compiler,
  filter = /\.[jt]sx$/,
  rootExport = "App",
  mount = "#root",
  framesClient
} = {}) {
  compiler ||= new IslandsCompiler();
  return {
    name: "solid-islands",
    setup(b) {
      let collected;
      const get = () => (collected ||= collectWithDedupe(compiler, root, false));
      b.onResolve({ filter: /^virtual:solid-islands/ }, args => ({
        path: args.path,
        namespace: "solid-islands"
      }));
      b.onResolve({ filter: /^virtual:solid-frames\/nav$/ }, args => ({
        path: args.path,
        namespace: "solid-islands"
      }));
      b.onResolve({ filter: /\?solid-frames-args$/ }, args => ({
        path: args.path,
        namespace: "solid-frames-args"
      }));
      b.onLoad({ filter: /.*/, namespace: "solid-frames-args" }, args => {
        const file = args.path.slice(0, -ARGS.length);
        return {
          contents: get().framesClient.get(file) ?? "export const $$routeArgs = {};\n",
          loader: "js",
          resolveDir: path.dirname(file)
        };
      });
      b.onLoad({ filter: /.*/, namespace: "solid-islands" }, args => {
        const c = get();
        if (args.path === NAV)
          return {
            contents: navModule(routeTable(c), { client: framesClient || FRAMES_CLIENT }),
            loader: "js",
            resolveDir: path.dirname(root)
          };
        if (args.path === HOST)
          return {
            contents: hostModule(pageRuntimes(compiler.options.runtimes)),
            loader: "js",
            resolveDir: path.dirname(root)
          };
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
              hydrate: fallbackRoots(c, root, rootExport, mount),
              core: pageRuntimes(compiler.options.runtimes).core,
              frames: framesOption(c)
            }),
            loader: "js",
            resolveDir: path.dirname(root),
            warnings: c.fallbacks.map(f => ({
              text: `[solid-islands] ${path.relative(process.cwd(), f.file)} falls back to hydration: ${f.reason}`
            }))
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
  navModule,
  routeTable,
  framesReport,
  NAV,
  ARGS,
  hostModule,
  IslandsCompiler,
  solidIslands,
  esbuildIslands,
  fallbackRoots,
  bundledIslandSizes,
  PREFETCH,
  ENTRY,
  CHUNK,
  HOST
};
