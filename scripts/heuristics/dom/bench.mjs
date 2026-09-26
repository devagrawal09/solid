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
//   node scripts/heuristics/dom/bench.mjs [--suite rows|list] [--n 1000] [--reps 5]
//        [--out documentation/plans/heuristic-oracles/dom-bench.json]
//   node scripts/heuristics/dom/bench.mjs --check            (equivalence gate only)
//   node scripts/heuristics/dom/bench.mjs --print-baseline
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, ROOT, RUNTIMES, snapshotRuntimes } from "../common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));

if (args["print-baseline"]) {
  const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
  const src = readFileSync(join(here, "rows.jsx"), "utf8");
  console.log(transform(src, { filename: "rows.jsx", generate: "dom" }).code);
  process.exit(0);
}

snapshotRuntimes();
// --suite rows (variants.mjs) | list (list/variants.mjs: <For> + components)
const SUITE = args.suite ?? "rows";
// rspec-rows / rspec-list: the runtime-speculation variants (../rspec/variants.mjs).
const DOM_VARIANTS =
  SUITE === "list"
    ? (await import("./list/variants.mjs")).LIST_VARIANTS
    : SUITE.startsWith("rspec-")
      ? (await import("../rspec/variants.mjs")).rspecVariants(SUITE.slice(6))
      : (await import("./variants.mjs")).DOM_VARIANTS;
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 5);
const dir = join(ROOT, "node_modules/.cache/heuristics/dom", SUITE);
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

// A variant may pin its own runtime bundles (`signals` / `web` paths).
async function bundle(name, { source, runtime, signals, web }) {
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
      "@solidjs/web": web ?? join(ROOT, "packages/web/dist/web.js"),
      "@solidjs/signals": signals ?? RUNTIMES[runtime]
    }
  });
  const html = join(dir, `${name}.html`);
  writeFileSync(
    html,
    `<!doctype html><html><body><table><tbody id="tbody"></tbody></table><script src="${name}.bundle.js"></script></body></html>`
  );
  return html;
}

// In-page: equivalence trace, then timings (median of 20 adaptive >= 25 ms samples after warmup).
function pageTrace(n) {
  const tbody = document.getElementById("tbody");
  const app = window.__make(n, tbody);
  const out = [];
  app.mount();
  app.prepare?.();
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
  let run, warmup;
  if (op === "mount") {
    run = () => {
      const app = window.__make(n, tbody);
      app.mount();
      app.unmount();
    };
    warmup = 40;
  } else {
    const app = window.__make(n, tbody);
    app.mount();
    app.prepare?.();
    run = app.ops[op];
    warmup = 1000;
  }
  const w0 = performance.now();
  let done = 0;
  while (done < warmup && performance.now() - w0 < 1500) {
    run();
    done++;
  }
  // Adaptive batches (ported from stack-a/bench.mjs): every sample runs until
  // >= 25 ms have elapsed — file:// pages are not cross-origin isolated, so
  // performance.now() is coarsened, and a fixed mount batch of 20 could fall
  // below that on fast variants.
  const samples = [];
  for (let s = 0; s < 20; s++) {
    const t = performance.now();
    let k = 0,
      el = 0;
    do {
      run();
      k++;
      el = performance.now() - t;
    } while (el < 25);
    samples.push((el * 1000) / k);
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
const OPS = SUITE.endsWith("list") ? ["create", "replace", "update10th", "select", "swap", "removeAdd"] : ["mount", "update10th", "select"];
for (const op of OPS)
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
const out =
  args.out ?? `documentation/plans/heuristic-oracles/dom-${SUITE === "rows" ? "bench" : SUITE}.json`;
writeFileSync(
  resolve(ROOT, out),
  JSON.stringify({ n: N, reps: REPS, chromium: version, date: new Date().toISOString(), results }, null, 2) + "\n"
);
console.log(`wrote ${out}`);
