#!/usr/bin/env node
// Stack-B DOM bench (adapted from ../../dom/bench.mjs). Differences:
//   - pages are served from a local HTTP server with COOP/COEP headers, so
//     the page is cross-origin isolated and performance.now() is not
//     coarsened to 100 µs; this lets an op carry untimed `setup`/`restore`
//     steps around its timed `run` (per-iteration timing);
//   - suites: `todos` (Q4, todos-variants.mjs) and `sel` (Q1, sel-variants.mjs).
// Equivalence gate first: every variant's container innerHTML must equal the
// baseline's after mount and after every op (3 rounds). Unequal variants are
// not measured.
//
//   taskset -c 2,3 node scripts/heuristics/stack-b/dom/bench.mjs --suite todos [--n 1000] [--reps 5] [--out dom-todos-1.json] [--check]
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { CACHE, OUT_DIR, parseArgs, ROOT, RUNTIMES, snapshotRuntimes } from "../common.mjs";

const args = parseArgs(process.argv.slice(2));
snapshotRuntimes();
const SUITE = args.suite ?? "todos";
const { VARIANTS, FIRED, OPS, CONTAINER } =
  SUITE === "todos"
    ? await import("./todos-variants.mjs").then(m => ({
        VARIANTS: m.TODOS_VARIANTS,
        FIRED: m.TODOS_FIRED,
        OPS: ["mount", "add", "toggle", "filter", "clearCompleted"],
        CONTAINER: `<div id="root"></div>`
      }))
    : await import("./sel-variants.mjs").then(m => ({
        VARIANTS: m.SEL_VARIANTS,
        FIRED: m.SEL_FIRED,
        OPS: ["create", "replace", "update10th", "select"],
        CONTAINER: `<table><tbody id="root"></tbody></table>`
      }));
// Variants marked `extra` run only when named with --variants.
const ONLY = args.variants ? args.variants.split(",") : Object.keys(VARIANTS).filter(k => !VARIANTS[k].extra);
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 5);
const dir = join(CACHE, "dom", SUITE, String(process.pid));
mkdirSync(dir, { recursive: true });

// Oracle fired: each variant's module contains its edit.
for (const name of ONLY) {
  const missing = FIRED[name].filter(m => !VARIANTS[name].source.includes(m));
  if (missing.length) throw new Error(`${name}: oracle edit missing: ${missing}`);
  console.log(`fired ${name.padEnd(10)} ${FIRED[name].join(" | ") || "(baseline)"} [${VARIANTS[name].runtime}]`);
}

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}

async function bundle(name, { source, runtime }) {
  const safe = name.replace(/[^\w-]/g, "_");
  const entry = join(dir, `${safe}.mjs`);
  writeFileSync(entry, `${source}\nwindow.__make = make;\n`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    outfile: join(dir, `${safe}.bundle.js`),
    minify: true,
    logLevel: "error",
    alias: {
      "solid-js": join(ROOT, "packages/solid/dist/solid.js"),
      "@solidjs/web": join(ROOT, "packages/web/dist/web.js"),
      "@solidjs/signals": RUNTIMES[runtime]
    }
  });
  writeFileSync(
    join(dir, `${safe}.html`),
    `<!doctype html><html><body>${CONTAINER}<script src="${safe}.bundle.js"></script></body></html>`
  );
  return `${safe}.html`;
}

const server = createServer((req, res) => {
  try {
    const body = readFileSync(join(dir, decodeURIComponent(req.url.slice(1))));
    res.writeHead(200, {
      "content-type": extname(req.url) === ".html" ? "text/html" : "text/javascript",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp"
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---- in-page ----
function normalize(op) {
  return typeof op === "function" ? { run: op } : op;
}
function pageTrace(n) {
  const root = document.getElementById("root");
  const norm = op => (typeof op === "function" ? { run: op } : op);
  const app = window.__make(n, root);
  const out = [];
  app.mount();
  app.prepare?.();
  out.push(root.innerHTML);
  for (let r = 0; r < 3; r++)
    for (const k of Object.keys(app.ops)) {
      const op = norm(app.ops[k]);
      op.setup?.();
      op.run();
      out.push(`${k}:${root.innerHTML}`);
      op.restore?.();
      out.push(`${k}/restore:${root.innerHTML}`);
    }
  app.unmount();
  return { out, isolated: self.crossOriginIsolated };
}
function pageTime([n, opName]) {
  const root = document.getElementById("root");
  let step;
  if (opName === "mount") {
    step = () => {
      const t = performance.now();
      const app = window.__make(n, root);
      app.mount();
      app.unmount();
      return performance.now() - t;
    };
  } else {
    const app = window.__make(n, root);
    app.mount();
    app.prepare?.();
    const raw = app.ops[opName];
    const op = typeof raw === "function" ? { run: raw } : raw;
    step = () => {
      op.setup?.();
      const t = performance.now();
      op.run();
      const dt = performance.now() - t;
      op.restore?.();
      return dt;
    };
  }
  // Warm up ~1.5 s (max 1000 steps), then 20 samples of ≥ 25 ms timed work.
  const w0 = performance.now();
  for (let i = 0; i < 1000 && performance.now() - w0 < 1500; i++) step();
  const samples = [];
  for (let s = 0; s < 20; s++) {
    let acc = 0,
      k = 0;
    while (acc < 25 || k < 2) {
      acc += step();
      k++;
    }
    samples.push((acc * 1000) / k);
  }
  samples.sort((a, b) => a - b);
  return samples[10];
}

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const pages = {};
for (const name of ONLY) pages[name] = await bundle(name, VARIANTS[name]);

const traceOf = async name => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(base + pages[name]);
  const t = await page.evaluate(pageTrace, 50);
  await page.close();
  if (errors.length) throw new Error(`${name}: ${errors.join("\n")}`);
  return t;
};
const ref = await traceOf("baseline");
if (!ref.isolated) console.log("WARNING: page is not cross-origin isolated (coarse timer)");
let failed = false;
const gate = {};
for (const name of ONLY) {
  const { out } = await traceOf(name);
  const at = out.findIndex((s, i) => s !== ref.out[i]);
  gate[name] = at === -1 && out.length === ref.out.length;
  if (!gate[name]) {
    failed = true;
    console.log(`FAIL ${name} at step ${at}\n  expected ${ref.out[at]?.slice(0, 300)}\n  received ${out[at]?.slice(0, 300)}`);
  } else console.log(`ok   ${name} (${out.length} snapshots)`);
}
if (failed || args.check) {
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = [];
const onlyOps = args.ops ? args.ops.split(",") : OPS;
for (const op of onlyOps)
  for (const name of ONLY) {
    const reps = [];
    for (let r = 0; r < REPS; r++) {
      const page = await browser.newPage();
      await page.goto(base + pages[name]);
      reps.push(await page.evaluate(pageTime, [N, op]));
      await page.close();
    }
    const med = median(reps);
    const spread = (Math.max(...reps) - Math.min(...reps)) / med;
    results.push({ variant: name, op, usPerOp: med, reps, spread });
    console.log(`${op.padEnd(14)} ${name.padEnd(10)} ${med.toFixed(1).padStart(9)} µs  ±${(spread * 50).toFixed(0)}%`);
  }
const version = browser.version();
await browser.close();
server.close();
mkdirSync(OUT_DIR, { recursive: true });
const out = join(OUT_DIR, args.out ?? `dom-${SUITE}.json`);
writeFileSync(
  out,
  JSON.stringify(
    { suite: SUITE, n: N, reps: REPS, chromium: version, isolated: ref.isolated, date: new Date().toISOString(), gate, results },
    null,
    2
  ) + "\n"
);
console.log(`wrote ${out}`);
