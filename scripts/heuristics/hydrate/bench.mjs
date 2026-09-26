#!/usr/bin/env node
// Cold-scope hydration oracle bench (Chromium via Playwright).
//
// app.jsx is compiled twice by the real compiler: `generate: "ssr",
// hydratable: true` (rendered once in Node with renderToString from
// packages/web/dist/server.js) and `generate: "dom", hydratable: true` (the
// client, hydrated with `hydrate` from packages/web/dist/web.js). The
// variants in variants.mjs are hand edits of the client output.
//
// 1. Equivalence gate (n = 50): after hydration the container's innerHTML must
//    equal the SSR HTML and the baseline's; then the ops the program can do
//    (select rows via the selection signal) must produce the baseline's DOM.
// 2. Unsafety: a label setter called after hydration (devtools / a handler the
//    compiler did not see) updates the baseline but not the inert variants.
// 3. Timing: µs per hydrate() (n = 1000 rows), median of 20 adaptive samples
//    of >= 25 ms per page, median of --reps fresh pages. Each sample prefills
//    K containers with the SSR HTML (untimed), then times K hydrate() calls
//    back to back; dispose is timed separately.
// 4. Heap: usedJSHeapSize retained by one hydrated n = 1000 app (after gc).
//
//   taskset -c 2,3 node scripts/heuristics/hydrate/bench.mjs [--n 1000] [--reps 5] [--out file]
//   node scripts/heuristics/hydrate/bench.mjs --check | --print-baseline | --print-ssr
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, ROOT, RUNTIMES, snapshotRuntimes } from "../common.mjs";
import { hydrateVariants } from "./variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 5);
const GATE_N = 50;

const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const src = readFileSync(join(here, "app.jsx"), "utf8");
const compile = generate => transform(src, { filename: "app.jsx", generate, hydratable: true }).code;
const clientBaseline = compile("dom");
if (args["print-baseline"]) {
  console.log(clientBaseline);
  process.exit(0);
}

snapshotRuntimes();
const dir = join(ROOT, "node_modules/.cache/heuristics/hydrate");
mkdirSync(dir, { recursive: true });

// --- SSR in Node ----------------------------------------------------------
const ssrEntry = join(dir, "ssr-entry.mjs");
writeFileSync(
  ssrEntry,
  `${compile("ssr")}
import { renderToString, createComponent } from "@solidjs/web";
export function ssrHtml(n) { const a = makeApp(n); return renderToString(() => createComponent(a.App, {})); }
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
const { ssrHtml } = await import(pathToFileURL(join(dir, "ssr.bundle.mjs")).href + `?${Date.now()}`);
const HTML = { gate: ssrHtml(GATE_N), bench: ssrHtml(N) };
if (args["print-ssr"]) {
  console.log(ssrHtml(3));
  process.exit(0);
}

// --- Client bundles ---------------------------------------------------------
const VARIANTS = hydrateVariants(clientBaseline);
// Reference, not a candidate: the same app client-rendered from scratch
// (non-hydratable compile, `render` into an empty container).
VARIANTS.csr = { source: transform(src, { filename: "app.jsx", generate: "dom" }).code, ops: true, csr: true };
const htmlFor = (name, which) => (VARIANTS[name].csr ? "" : HTML[which]);
async function bundle(name, source, csr) {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(
    entry,
    `${source}
import { hydrate as __hydrate, render as __render, createComponent as __cc } from "@solidjs/web";
import { flush as __flush } from "solid-js";
window.__hy = (container, n) => {
  globalThis._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
  const app = makeApp(n);
  const dispose = ${csr ? "__render" : "__hydrate"}(() => __cc(app.App, {}), container);
  return { app, dispose };
};
window.__flush = __flush;
`
  );
  const out = join(dir, `${name}.bundle.js`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    outfile: out,
    minify: !args.profile,
    logLevel: "error",
    alias: {
      "solid-js": join(ROOT, "packages/solid/dist/solid.js"),
      "@solidjs/web": join(ROOT, "packages/web/dist/web.js"),
      "@solidjs/signals": RUNTIMES.prod
    }
  });
  const html = join(dir, `${name}.html`);
  writeFileSync(
    html,
    `<!doctype html><html><body><div id="host" style="display:none"></div><script src="${name}.bundle.js"></script></body></html>`
  );
  return html;
}
const pages = {};
for (const [name, v] of Object.entries(VARIANTS)) pages[name] = await bundle(name, v.source, v.csr);

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}
const browser = await chromium.launch({ args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"] });

// --- In-page functions ------------------------------------------------------
function pageTrace([html, n, withOps]) {
  const host = document.getElementById("host");
  const c = document.createElement("div");
  c.innerHTML = html;
  host.appendChild(c);
  const out = { steps: [] };
  const parse = document.createElement("div");
  parse.innerHTML = html;
  out.ssrParsed = parse.innerHTML;
  // Hydration-id parity probe: a claimed node comes from the SSR registry; a
  // key miss falls back to cloning the template (getNextElement), which
  // leaves the server DOM untouched but binds the effects to a detached copy.
  const server = new Set(c.querySelectorAll("*"));
  let clones = 0;
  const clone = Node.prototype.cloneNode;
  const imp = Document.prototype.importNode;
  Node.prototype.cloneNode = function (...a) {
    clones++;
    return clone.apply(this, a);
  };
  Document.prototype.importNode = function (...a) {
    clones++;
    return imp.apply(this, a);
  };
  const { app, dispose } = window.__hy(c, n);
  Node.prototype.cloneNode = clone;
  Document.prototype.importNode = imp;
  out.clones = clones;
  out.serverNodesKept = [...c.querySelectorAll("*")].every(e => server.has(e));
  out.steps.push(["hydrated", c.innerHTML]);
  if (withOps)
    for (const id of [3, 7, 7, -1, 0, n - 1]) {
      app.setSelected(id);
      window.__flush();
      out.steps.push([`select(${id})`, c.innerHTML]);
    }
  // Unsafety probe: a write the "cold scope" proof said never happens.
  const label = () => c.querySelectorAll("tr")[5].children[1].textContent;
  const before = label();
  try {
    app.setters[5]?.("written after hydration");
    window.__flush();
  } catch (e) {
    out.unsafeError = String(e);
  }
  out.unsafe = { before, after: label(), setterExists: typeof app.setters[5] === "function" };
  if (withOps) {
    app.setSelected(5);
    window.__flush();
    out.afterUnsafeSelect = c.querySelectorAll("tr")[5].className;
  }
  dispose();
  c.remove();
  return out;
}

function pageTime([html, n]) {
  const host = document.getElementById("host");
  const fill = k => {
    const cs = [];
    for (let i = 0; i < k; i++) {
      const c = document.createElement("div");
      c.innerHTML = html;
      host.appendChild(c);
      cs.push(c);
    }
    return cs;
  };
  const batch = k => {
    const cs = fill(k);
    const ds = new Array(k);
    const t0 = performance.now();
    for (let i = 0; i < k; i++) ds[i] = window.__hy(cs[i], n).dispose;
    const t1 = performance.now();
    for (let i = 0; i < k; i++) ds[i]();
    const t2 = performance.now();
    for (const c of cs) c.remove();
    return [t1 - t0, t2 - t1];
  };
  // Warmup (also calibrates K).
  let per = 0;
  const w0 = performance.now();
  for (let i = 0; i < 40 && performance.now() - w0 < 3000; i++) per = batch(1)[0];
  let k = Math.max(1, Math.ceil(30 / Math.max(per, 0.05)));
  const hy = [],
    dis = [];
  for (let s = 0; s < 20; s++) {
    let [a, b] = batch(k);
    while (a < 25) {
      k = Math.ceil(k * 1.5);
      [a, b] = batch(k);
    }
    hy.push((a * 1000) / k);
    dis.push((b * 1000) / k);
    if (typeof gc === "function") gc();
  }
  const med = xs => [...xs].sort((x, y) => x - y)[xs.length >> 1];
  return { hydrate: med(hy), dispose: med(dis), k };
}

function pageHeap([html, n]) {
  const host = document.getElementById("host");
  const keep = [];
  const deltas = [];
  for (let r = 0; r < 5; r++) {
    const c = document.createElement("div");
    c.innerHTML = html;
    host.appendChild(c);
    gc();
    gc();
    const before = performance.memory.usedJSHeapSize;
    keep.push(window.__hy(c, n));
    gc();
    gc();
    deltas.push(performance.memory.usedJSHeapSize - before);
  }
  for (const k of keep) k.dispose();
  deltas.sort((a, b) => a - b);
  return deltas[2];
}

// --- Gate -------------------------------------------------------------------
const run = async (name, fn, arg) => {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(pages[name]).href);
  const r = await page.evaluate(fn, arg);
  await page.close();
  return r;
};
const gate = {};
const ref = await run("baseline", pageTrace, [HTML.gate, GATE_N, true]);
const norm = s => s.replace(/<!--.*?-->/g, "");
let failed = false;
for (const [name, v] of Object.entries(VARIANTS)) {
  const t = await run(name, pageTrace, [htmlFor(name, "gate"), GATE_N, true]);
  if (v.csr) {
    // No SSR DOM to claim: compare with hydration keys stripped.
    const strip = x => x.replace(/ _hk="[^"]*"/g, "");
    const same = t.steps.every((st, i) => strip(st[1]) === strip(ref.steps[i][1]));
    gate[name] = { reference: true, domEqualsBaselineModuloHk: same, unsafe: t.unsafe };
    if (!same) failed = true;
    console.log(`${same ? "ok  " : "FAIL"} ${name.padEnd(13)} [reference] DOM == baseline modulo _hk after render and every op: ${same}`);
    continue;
  }
  const ssrOk = norm(t.steps[0][1]) === norm(t.ssrParsed);
  const at = t.steps.findIndex((s, i) => s[1] !== ref.steps[i][1]);
  const hydratedOk = t.steps[0][1] === ref.steps[0][1];
  const opsOk = at === -1;
  gate[name] = {
    hydratedEqualsBaseline: hydratedOk,
    hydratedEqualsSSR: ssrOk,
    opsEqualBaseline: opsOk,
    firstMismatch: opsOk ? null : ref.steps[at][0],
    clonesDuringHydrate: t.clones,
    serverNodesKept: t.serverNodesKept,
    unsafe: t.unsafe,
    afterUnsafeSelect: t.afterUnsafeSelect ?? null,
    unsafeError: t.unsafeError ?? null
  };
  const expectedFail = !v.ops;
  const claimOk = t.clones === 0 && t.serverNodesKept;
  gate[name].claimOk = claimOk;
  const ok = hydratedOk && claimOk && (opsOk || expectedFail);
  const pass = v.expectFail ? !ok : ok;
  gate[name].pass = pass;
  if (!pass) failed = true;
  console.log(
    `${pass ? "ok  " : "FAIL"} ${name.padEnd(13)}${v.expectFail ? ` [self-test: gate ${ok ? "PASSED (bad)" : "rejects it"}]` : ""} hydrated==baseline ${hydratedOk} (==SSR ${ssrOk}) clones ${t.clones} ops ${
      opsOk ? "equal" : `differ at ${ref.steps[at][0]}${expectedFail ? " (expected: not a program variant)" : ""}`
    } | label after late write: "${t.unsafe.before}" -> "${t.unsafe.after}"`
  );
}
// --profile <variant>: CPU profile (CDP, unminified bundle) of repeated
// hydrates; prints self time by function and by source file.
if (args.profile && !failed) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(pages[args.profile]).href);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 50 });
  await page.evaluate(pageTime, [HTML.bench, N]); // warm
  // Profile only the hydrate() calls: containers prefilled, dispose after stop.
  const K = 40;
  await page.evaluate(
    ([html, k]) => {
      window.__cs = [];
      for (let i = 0; i < k; i++) {
        const c = document.createElement("div");
        c.innerHTML = html;
        document.getElementById("host").appendChild(c);
        window.__cs.push(c);
      }
      gc();
    },
    [HTML.bench, K]
  );
  await cdp.send("Profiler.start");
  await page.evaluate(n => {
    window.__ds = window.__cs.map(c => window.__hy(c, n).dispose);
  }, N);
  const { profile } = await cdp.send("Profiler.stop");
  const dt = profile.timeDeltas;
  const self = new Map();
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const f = byId.get(id).callFrame;
    const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0));
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(args.top ?? 40));
  for (const [k, v] of top) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  await browser.close();
  process.exit(0);
}
if (failed || args.check) {
  await browser.close();
  process.exit(failed ? 1 : 0);
}

// --- Timing -----------------------------------------------------------------
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = [];
for (const [name, v] of Object.entries(VARIANTS)) {
  if (v.expectFail) continue;
  const reps = [];
  for (let r = 0; r < REPS; r++) reps.push(await run(name, pageTime, [htmlFor(name, "bench"), N]));
  const hy = reps.map(r => r.hydrate);
  const dis = reps.map(r => r.dispose);
  const heap = await run(name, pageHeap, [htmlFor(name, "bench"), N]);
  const med = median(hy);
  const spread = (Math.max(...hy) - Math.min(...hy)) / med;
  results.push({
    variant: name,
    usPerHydrate: med,
    spread,
    reps: hy,
    usPerDispose: median(dis),
    disposeReps: dis,
    heapBytes: heap,
    batchK: reps.map(r => r.k)
  });
  console.log(
    `${name.padEnd(13)} hydrate ${med.toFixed(1).padStart(8)} µs ±${(spread * 50).toFixed(0)}%  dispose ${median(dis)
      .toFixed(1)
      .padStart(7)} µs  heap ${(heap / 1024).toFixed(0)} KiB`
  );
}
const version = browser.version();
await browser.close();
const out = args.out ?? "documentation/plans/heuristic-oracles/hydrate/hydrate-bench.json";
mkdirSync(dirname(resolve(ROOT, out)), { recursive: true });
writeFileSync(
  resolve(ROOT, out),
  JSON.stringify(
    { n: N, reps: REPS, chromium: version, date: new Date().toISOString(), ssrBytes: HTML.bench.length, gate, results },
    null,
    2
  ) + "\n"
);
console.log(`wrote ${out}`);
