#!/usr/bin/env node
// Challenge 2: is resumability worth it? (documentation/plans/resumability.md)
//
// app.jsx (four islands over shared state) is rendered on the server by the
// real compiler's SSR output, one renderToString per island (renderId = the
// island). Each strategy in strategies.mjs gets its own page: the same
// server-rendered markup plus that strategy's payload —
//   hydration strategies  a JSON data blob (labels, + footer items when the
//                         footer is ever hydrated) and the hydration keys
//   resumable (B, C)      the markup without hydration keys, `data-q` refs on
//                         bound elements, and a JSON state/binding/subscriber
//                         table (C: live closure only; B: every binding)
//
// 1. Gate (n = 50, m = 20): load, then a scripted session; after load and
//    after every step the islands' normalized HTML must equal strategy A's.
//    E-naive must FAIL (hydrate-before-write violated). F-linked (stage 3)
//    runs the analyzable twin app-islands.jsx with the linker's map and the
//    shipped late-island hydration; its server markup is asserted equal.
// 2. Timing (Chromium, fresh page per rep): bundle eval, init, first
//    interaction, rest of the session — at CPU throttle 1x and 4x.
// 3. Bytes: page HTML and JS bundle, raw / gzip / brotli.
//
//   node scripts/heuristics/resume/bench.mjs [--n 1000] [--m 0,1000,5000] [--reps 7] [--only A,C] [--out file] [--check]
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { parseArgs, ROOT, RUNTIMES, snapshotRuntimes } from "../common.mjs";
import { COMPILED_RESUME_DATA, compiledResumeEntry, hydrationEntry, LINKED_DATA, linkedEntry, resumeEntry } from "./strategies.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 1000);
const MS = String(args.m ?? "0,1000,5000").split(",").map(Number);
const REPS = Number(args.reps ?? 7);
const STRATEGIES = ["A", "D", "E-lazy", "E-naive", "F", "F-linked", "F-csr", "B", "C", "C-compiled", "C-broken"];
// Cost bounds: timed, not gated (they re-create DOM by design).
const BOUNDS = new Set(["F-csr"]);
const UNSAFE = new Set(["E-naive", "C-broken"]);
const SESSION = [
  ["select", 3],
  ["rename"],
  ["select", 7],
  ["rename"],
  ["rename"],
  ["select", 42],
  ["rename"]
];

snapshotRuntimes();
const dir = join(ROOT, "node_modules/.cache/heuristics/resume");
mkdirSync(dir, { recursive: true });
const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const src = readFileSync(join(here, "app.jsx"), "utf8");
const compile = generate => transform(src, { filename: "app.jsx", generate, hydratable: true }).code;

// --- server ------------------------------------------------------------------
const ssrEntry = join(dir, "ssr-entry.mjs");
writeFileSync(
  ssrEntry,
  `${compile("ssr")}
import { renderToString, createComponent } from "@solidjs/web";
export function ssr(n, m) {
  const data = makeData(n, m);
  const st = makeState(data);
  const R = makeRegions(st, data);
  const html = {};
  for (const k of ["table", "detail", "header", "footer"])
    html[k] = renderToString(() => createComponent(R[k], {}), { renderId: k });
  return { data, html };
}
`
);
await build({
  entryPoints: [ssrEntry],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(dir, "ssr.bundle.mjs"),
  logLevel: "error",
  alias: {
    "solid-js": join(ROOT, "packages/solid/dist/server.js"),
    "@solidjs/web": join(ROOT, "packages/web/dist/server.js"),
    "@solidjs/signals": RUNTIMES.prod
  }
});
const { ssr } = await import(pathToFileURL(join(dir, "ssr.bundle.mjs")).href + `?${Date.now()}`);

// F-linked: the analyzable twin (app-islands.jsx). Its server markup must equal
// app.jsx's (same components → same hydration keys); its map comes from the
// island linker.
const islandsSrc = readFileSync(join(here, "app-islands.jsx"), "utf8");
const compileIslands = generate => transform(islandsSrc, { filename: "app-islands.jsx", generate, hydratable: true }).code;
writeFileSync(
  join(dir, "ssr-islands-entry.mjs"),
  `${compileIslands("ssr")}
import { renderToString, createComponent } from "@solidjs/web";
const R = { table: Table, detail: Detail, header: Header, footer: Footer };
export function render() {
  const html = {};
  for (const k of ["table", "detail", "header", "footer"])
    html[k] = renderToString(() => createComponent(R[k], {}), { renderId: k });
  return html;
}
`
);
await build({
  entryPoints: [join(dir, "ssr-islands-entry.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(dir, "ssr-islands.bundle.mjs"),
  logLevel: "error",
  alias: {
    "solid-js": join(ROOT, "packages/solid/dist/server.js"),
    "@solidjs/web": join(ROOT, "packages/web/dist/server.js"),
    "@solidjs/signals": RUNTIMES.prod
  }
});
let islandsImport = 0;
async function assertIslandsMarkup(rendered) {
  // A fresh module instance per data set (the twin reads its data at import).
  globalThis.__islandData = rendered.data;
  const { render } = await import(pathToFileURL(join(dir, "ssr-islands.bundle.mjs")).href + `?${++islandsImport}`);
  const html = render();
  for (const k of ["table", "detail", "header", "footer"])
    if (html[k] !== rendered.html[k]) throw new Error(`F-linked: app-islands.jsx server markup differs from app.jsx for ${k}`);
}
const { summarizeIslands } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const { linkIslands } = await import(pathToFileURL(join(ROOT, "packages/compiler/islands.js")).href);
const linked = linkIslands({
  modules: { "app-islands.jsx": summarizeIslands(islandsSrc, { filename: "app-islands.jsx" }) },
  resolve: () => null,
  islands: Object.fromEntries(
    ["Table", "Detail", "Header", "Footer"].map(e => [e.toLowerCase(), { module: "app-islands.jsx", export: e }])
  )
});
const LINKED_MAP = {
  select: linked.exports["app-islands.jsx#select"].islands,
  rename: linked.exports["app-islands.jsx#rename"].islands
};
console.log(`F-linked map (island linker): ${JSON.stringify(LINKED_MAP)}`);

// C-compiled: compileResumable(app-islands.jsx) → a resumable server module
// (data-q markers + __qState, compiled for SSR here) and a component-free
// client (bundled below).
const { compileResumable } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const compiled = compileResumable(islandsSrc, {
  filename: "app-islands.jsx",
  islands: ["Table", "Detail", "Header", "Footer"]
});
if (!compiled.resumable) throw new Error(`C-compiled: not resumable: ${compiled.reasons.join("; ")}`);
console.log(
  `C-compiled: live cells ${compiled.liveCells.join(", ")}; serialized ${compiled.serializedCells.join(", ")}; ${compiled.sites} live sites`
);
writeFileSync(
  join(dir, "ssr-resumable-entry.mjs"),
  `${transform(compiled.server, { filename: "app-islands.resumable.jsx", generate: "ssr" }).code}
import { renderToString, createComponent } from "@solidjs/web";
const R = { table: Table, detail: Detail, header: Header, footer: Footer };
export function render() {
  const html = {};
  for (const k of ["table", "detail", "header", "footer"]) html[k] = renderToString(() => createComponent(R[k], {}));
  return { html, state: __qState() };
}
`
);
await build({
  entryPoints: [join(dir, "ssr-resumable-entry.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: join(dir, "ssr-resumable.bundle.mjs"),
  logLevel: "error",
  alias: {
    "solid-js": join(ROOT, "packages/solid/dist/server.js"),
    "@solidjs/web": join(ROOT, "packages/web/dist/server.js"),
    "@solidjs/signals": RUNTIMES.prod
  }
});
let resumableImport = 0;
const compiledPages = new Map();
async function renderCompiled(rendered) {
  globalThis.__islandData = rendered.data;
  const { render } = await import(pathToFileURL(join(dir, "ssr-resumable.bundle.mjs")).href + `?${++resumableImport}`);
  const out = render();
  compiledPages.set(rendered, out);
  return out;
}

const json = v => JSON.stringify(v).replace(/</g, "\\u003c");
const ISLANDS = ["table", "detail", "header", "footer"];

/** Resumable markup + state for B (all bindings) or C (live closure). */
function resumable({ data, html }, all) {
  const b = [];
  const subs = { selected: [], renames: [] };
  let q = 0;
  const bind = (kind, expr, arg, sub) => {
    const i = b.length;
    b.push(arg === undefined ? [kind, q, expr] : [kind, q, expr, arg]);
    if (sub) (subs[sub] ??= []).push(i);
  };
  let row = -1;
  const out = {};
  for (const k of ISLANDS) {
    out[k] = html[k].replace(/ _hk=[^ >]+/g, "").replace(
      /<tr class="" data-row="(\d+)">|<td class="col-md-1">|<td class="col-md-4">|<p class="detail">|<span class="count">|<a href="([^"]*)">([^<]*)/g,
      (m, id, href, title) => {
        if (id !== undefined) {
          row = +id;
          bind(0, 0, row, "selected");
        } else if (m.startsWith('<td class="col-md-1"')) {
          if (all !== true) return m;
          bind(1, 4, row);
        } else if (m.startsWith('<td class="col-md-4"')) bind(1, 1, row, "l:" + row);
        else if (m.startsWith("<p")) bind(1, 2, undefined, "selected");
        else if (m.startsWith("<span")) bind(1, 3, undefined, "renames");
        else {
          if (all !== true) return m;
          bind(2, 4, href);
          b.push([1, q, 4, title]);
        }
        const tagEnd = m.indexOf(">");
        return m.slice(0, tagEnd) + ` data-q="${q++}"` + m.slice(tagEnd);
      }
    );
  }
  // C-broken (unsafe control): an over-pruned closure that misses one
  // subscriber (the detail text never learns about selection).
  if (all === "broken") subs.selected = subs.selected.filter(i => b[i][2] !== 2);
  const state = { s: { selected: -1, renames: 0, labels: data.labels }, b, subs };
  return { html: out, payload: `<script type="application/json" id="q">${json(state)}</script>` };
}

function pageFor(strategy, rendered) {
  let html = rendered.html;
  let payload;
  if (strategy === "C-compiled") {
    const out = compiledPages.get(rendered);
    html = out.html;
    payload = `<script type="application/json" id="q">${json(out.state)}</script>`;
  } else if (strategy === "B" || strategy === "C" || strategy === "C-broken")
    ({ html, payload } = resumable(rendered, strategy === "B" ? true : strategy === "C" ? false : "broken"));
  else {
    const hydratesFooter = !(strategy === "D" || strategy.startsWith("F"));
    const data = hydratesFooter ? rendered.data : { labels: rendered.data.labels, footer: [] };
    payload = `<script type="application/json" id="data">${json(data)}</script>`;
  }
  const body = ISLANDS.map(k => `<div id="r-${k}">${html[k]}</div>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}${payload}`;
}

// --- client bundles ----------------------------------------------------------
const clientApp = compile("dom");
const bundles = {};
for (const s of STRATEGIES) {
  const entry = join(dir, `${s}.entry.mjs`);
  if (s === "C-compiled") {
    writeFileSync(join(dir, "resumable-client.mjs"), compiled.client);
    writeFileSync(join(dir, "resumable-data.mjs"), COMPILED_RESUME_DATA);
    writeFileSync(entry, compiledResumeEntry("./resumable-client.mjs", "./resumable-data.mjs"));
  } else if (s === "F-linked") {
    writeFileSync(join(dir, "islands-app.mjs"), compileIslands("dom"));
    writeFileSync(join(dir, "islands-data.mjs"), LINKED_DATA);
    writeFileSync(entry, linkedEntry("./islands-app.mjs", "./islands-data.mjs", LINKED_MAP));
  } else writeFileSync(entry, s === "B" || s.startsWith("C") ? resumeEntry() : hydrationEntry(clientApp, s));
  const outfile = join(dir, `${s}.bundle.js`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    minify: true,
    outfile,
    logLevel: "error",
    alias: {
      "solid-js": join(ROOT, "packages/solid/dist/solid.js"),
      "@solidjs/web": join(ROOT, "packages/web/dist/web.js"),
      "@solidjs/signals": RUNTIMES.prod
    }
  });
  bundles[s] = readFileSync(outfile, "utf8");
}
const sizes = text => {
  const b = Buffer.from(text);
  return {
    raw: b.length,
    gzip: gzipSync(b, { level: 9 }).length,
    brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
  };
};

function writePage(name, strategy, rendered) {
  const head = pageFor(strategy, rendered);
  const file = join(dir, `${name}.html`);
  writeFileSync(
    file,
    // The bundle is inlined so the marks bracket its parse + evaluation only
    // (a <script src> mark pair also measured the file fetch).
    `${head}<script>performance.mark("js0")</script><script>${bundles[strategy].replace(/<\/script/gi, "<\\/script")}</script>` +
      `<script>performance.mark("js1");{const t=performance.now();__init();window.__initMs=performance.now()-t;}</script></body></html>`
  );
  return { file, html: head };
}

// --- browser -----------------------------------------------------------------
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}
const browser = await chromium.launch();

function snapshot() {
  const norm = s =>
    s
      .replace(/ _hk="?[^ >"]*"?/g, "")
      .replace(/ data-q="[\d ]+"/g, "")
      .replace(/ class=""/g, "");
  return ["table", "detail", "header", "footer"].map(k => norm(document.getElementById("r-" + k).innerHTML)).join("\n");
}
function step([h, arg]) {
  const el = h === "select" ? document.querySelector(`tr[data-row="${arg}"]`) : document.querySelector("[data-action=rename]");
  const t = performance.now();
  el.click();
  return performance.now() - t;
}

// Identity: the server-rendered nodes must still be the ones on screen at the
// end (claimed / resumed, never re-rendered). A strategy that re-creates DOM
// can pass an HTML-only gate.
const pinNodes = () => {
  window.__pins = [...document.querySelectorAll("tr[data-row], p.detail, span.count")];
};
const pinsIntact = () =>
  window.__pins.every(n => n.isConnected) && document.querySelectorAll("tr[data-row], p.detail, span.count").length === window.__pins.length;

async function trace(file) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(file).href);
  // Pin after the page's own script ran: for eager strategies the nodes
  // were already claimed by then; pin BEFORE load would be ideal but the
  // script runs during load — re-render would still detach the pinned
  // nodes on the first interaction for lazy strategies.
  await page.evaluate(pinNodes);
  const t = [await page.evaluate(snapshot)];
  for (const s of SESSION) {
    await page.evaluate(step, s);
    t.push(await page.evaluate(snapshot));
  }
  t.push(`identity:${await page.evaluate(pinsIntact)}`);
  await page.close();
  return t;
}

async function timeOnce(file, throttle) {
  // A fresh context per load: no V8 code cache or HTTP cache carried over
  // from the previous rep — every load compiles the bundle like a first visit.
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await page.goto(pathToFileURL(file).href);
  const load = await page.evaluate(() => ({
    evalMs: performance.measure("e", "js0", "js1").duration,
    // F-linked creates its state at module evaluation (window.__modMs).
    initMs: window.__initMs + (window.__modMs ?? 0)
  }));
  const steps = [];
  for (const s of SESSION) steps.push(await page.evaluate(step, s));
  await context.close();
  return { ...load, firstMs: steps[0], restMs: steps.slice(1).reduce((a, b) => a + b, 0), steps };
}

// 1. Gate.
const gateRendered = ssr(50, 20);
await assertIslandsMarkup(gateRendered);
await renderCompiled(gateRendered);
const ref = await trace(writePage("gate-A", "A", gateRendered).file);
let gateFailed = false;
const gate = {};
for (const s of STRATEGIES) {
  if (BOUNDS.has(s)) continue;
  const t = await trace(writePage(`gate-${s}`, s, gateRendered).file);
  const at = t.findIndex((x, i) => x !== ref[i]);
  const ok = at === -1;
  const expected = UNSAFE.has(s) ? !ok : ok;
  if (!expected) gateFailed = true;
  gate[s] = ok ? "equal" : `differs at step ${at}`;
  console.log(`${expected ? "ok  " : "FAIL"} ${s.padEnd(8)} ${ok ? "equal to A after load and every step" : `differs at step ${at}${UNSAFE.has(s) ? " (expected: unsafe control)" : ""}`}`);
  if (!ok && !UNSAFE.has(s)) console.log(`  A:   ${ref[at].slice(0, 300)}\n  got: ${t[at].slice(0, 300)}`);
}
if (gateFailed || args.check) {
  await browser.close();
  process.exit(gateFailed ? 1 : 0);
}

// 2 + 3. Timing and bytes.
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
// Bundle compile + evaluate, isolated: a blank page per sample (fresh
// context, no code cache), indirect eval of the bundle source. Marks around an
// inline <script> in the real page also caught layout/paint of the preceding
// markup (bimodal), so the page's own js0/js1 marks are not used.
const evalMs = {};
for (const throttle of [1, 4])
  for (const s of STRATEGIES) {
    if (UNSAFE.has(s)) continue;
    const xs = [];
    for (let r = 0; r < 11; r++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
      await page.goto("about:blank");
      xs.push(
        await page.evaluate(src => {
          const t = performance.now();
          (0, eval)(src);
          return performance.now() - t;
        }, bundles[s])
      );
      await context.close();
    }
    evalMs[`${s}@${throttle}`] = median(xs);
  }
const results = [];
for (const m of MS) {
  const rendered = ssr(N, m);
  await assertIslandsMarkup(rendered);
  await renderCompiled(rendered);
  const pages = {};
  const ONLY = args.only ? args.only.split(",") : null;
  for (const s of STRATEGIES) if (!UNSAFE.has(s) && (!ONLY || ONLY.includes(s))) pages[s] = writePage(`m${m}-${s}`, s, rendered);
  for (const throttle of [1, 4])
    for (const s of Object.keys(pages)) {
      const runs = [];
      // Interleave reps across strategies' fresh pages is not needed: each rep
      // is a fresh page; run reps back to back per strategy.
      for (let r = 0; r < REPS; r++) runs.push(await timeOnce(pages[s].file, throttle));
      const pick = k => median(runs.map(x => x[k]));
      const row = {
        m,
        throttle,
        strategy: s,
        evalMs: evalMs[`${s}@${throttle}`],
        initMs: pick("initMs"),
        firstMs: pick("firstMs"),
        restMs: pick("restMs"),
        html: sizes(pages[s].html),
        js: sizes(bundles[s])
      };
      row.loadMs = row.evalMs + row.initMs;
      row.sessionMs = row.loadMs + row.firstMs + row.restMs;
      results.push(row);
      console.log(
        `m=${String(m).padEnd(5)} ${throttle}x ${s.padEnd(7)} eval ${row.evalMs.toFixed(1).padStart(6)}  init ${row.initMs.toFixed(1).padStart(6)}  first ${row.firstMs.toFixed(1).padStart(6)}  rest ${row.restMs.toFixed(1).padStart(6)}  html ${String(row.html.gzip).padStart(6)} B gz  js ${String(row.js.gzip).padStart(6)} B gz`
      );
    }
}
await browser.close();
const out = resolve(ROOT, args.out ?? "documentation/plans/resumability/results-1.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ n: N, reps: REPS, session: SESSION, chromium: browser.version?.() ?? "", gate, results }, null, 2) + "\n"
);
console.log(`wrote ${out}`);
