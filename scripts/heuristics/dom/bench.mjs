#!/usr/bin/env node
// DOM oracle bench in Chromium (Playwright): script time per op for the rows
// variants in variants.mjs, bundled with esbuild against the built solid-js,
// @solidjs/web and the prod or oracle signals tree. Layout/paint are not
// measured: the question is the binding and reactive cost the compiler
// controls.
//
// Before timing, every variant must produce the same tbody HTML as the
// baseline after mount and after each op (the equivalence gate).
//
//   node scripts/heuristics/dom/bench.mjs [--n 1000] [--reps 5]
//        [--out documentation/plans/heuristic-oracles/dom-bench.json]
//   node scripts/heuristics/dom/bench.mjs --check            (equivalence gate only)
//   node scripts/heuristics/dom/bench.mjs --print-baseline
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, ROOT, RUNTIMES, snapshotRuntimes } from "../common.mjs";
import { DOM_VARIANTS } from "./variants.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

if (args["print-baseline"]) {
  const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
  const src = readFileSync(join(here, "rows.jsx"), "utf8");
  console.log(transform(src, { filename: "rows.jsx", generate: "dom" }).code);
  process.exit(0);
}

snapshotRuntimes();
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 5);
const dir = join(ROOT, "node_modules/.cache/heuristics/dom");
mkdirSync(dir, { recursive: true });

// Global Playwright (the environment's pre-installed browser); a project-local
// install works too.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}

async function bundle(name, { source, runtime }) {
  const entry = join(dir, `${name}.mjs`);
  writeFileSync(entry, `${source}\nwindow.__make = make;\n`);
  const out = join(dir, `${name}.bundle.js`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    outfile: out,
    minify: true,
    logLevel: "error",
    alias: {
      "solid-js": join(ROOT, "packages/solid/dist/solid.js"),
      "@solidjs/web": join(ROOT, "packages/web/dist/web.js"),
      "@solidjs/signals": RUNTIMES[runtime]
    }
  });
  const html = join(dir, `${name}.html`);
  writeFileSync(
    html,
    `<!doctype html><html><body><table><tbody id="tbody"></tbody></table><script src="${name}.bundle.js"></script></body></html>`
  );
  return html;
}

// In-page: equivalence trace, then timings (median of 20 batches after warmup).
function pageTrace(n) {
  const tbody = document.getElementById("tbody");
  const app = window.__make(n, tbody);
  const out = [];
  app.mount();
  out.push(tbody.innerHTML);
  for (let r = 0; r < 3; r++)
    for (const k of Object.keys(app.ops)) {
      app.ops[k]();
      out.push(tbody.innerHTML);
    }
  app.unmount();
  return out;
}
function pageTime([n, op]) {
  const tbody = document.getElementById("tbody");
  let run, batch, warmup;
  if (op === "mount") {
    run = () => {
      const app = window.__make(n, tbody);
      app.mount();
      app.unmount();
    };
    batch = 3;
    warmup = 30;
  } else {
    const app = window.__make(n, tbody);
    app.mount();
    run = app.ops[op];
    batch = 20;
    warmup = 500;
  }
  for (let i = 0; i < warmup; i++) run();
  const samples = [];
  for (let s = 0; s < 20; s++) {
    const t = performance.now();
    for (let i = 0; i < batch; i++) run();
    samples.push(((performance.now() - t) * 1000) / batch);
  }
  samples.sort((a, b) => a - b);
  return samples[10];
}

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const pages = {};
for (const [name, variant] of Object.entries(DOM_VARIANTS)) pages[name] = await bundle(name, variant);

// Equivalence gate.
const traceOf = async name => {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(pages[name]).href);
  const t = await page.evaluate(pageTrace, 50);
  await page.close();
  return t;
};
const reference = await traceOf("baseline");
let failed = false;
for (const name of Object.keys(pages)) {
  const t = await traceOf(name);
  const at = t.findIndex((s, i) => s !== reference[i]);
  if (at !== -1) {
    failed = true;
    console.log(`FAIL ${name} at step ${at}\n  expected ${reference[at].slice(0, 200)}\n  received ${t[at].slice(0, 200)}`);
  } else console.log(`ok   ${name}`);
}
if (failed || args.check) {
  await browser.close();
  process.exit(failed ? 1 : 0);
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = [];
for (const op of ["mount", "update10th", "select"])
  for (const name of Object.keys(pages)) {
    const reps = [];
    for (let r = 0; r < REPS; r++) {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(pages[name]).href);
      reps.push(await page.evaluate(pageTime, [N, op]));
      await page.close();
    }
    const med = median(reps);
    const spread = (Math.max(...reps) - Math.min(...reps)) / med;
    results.push({ variant: name, op, usPerOp: med, reps, spread });
    console.log(`${op.padEnd(10)} ${name.padEnd(10)} ${med.toFixed(1).padStart(9)} µs  ±${(spread * 50).toFixed(0)}%`);
  }
const version = browser.version();
await browser.close();
const out = args.out ?? "documentation/plans/heuristic-oracles/dom-bench.json";
writeFileSync(
  join(ROOT, out),
  JSON.stringify({ n: N, reps: REPS, chromium: version, date: new Date().toISOString(), results }, null, 2) + "\n"
);
console.log(`wrote ${out}`);
