#!/usr/bin/env node
// Stack A: the fully stacked ceiling of the "build" heuristics, in Chromium.
// Adapted from scripts/heuristics/dom/bench.mjs (same page protocol) with:
//   - its own variants (list-variants.mjs, rows-variants.mjs);
//   - a fourth runtime, oracle-sync (build-oracle-sync.mjs);
//   - runtimes and dist bundles snapshotted under
//     node_modules/.cache/heuristics/stack-a/ so a concurrent build cannot
//     change them mid-run;
//   - landing checks before timing: source markers in each generated module,
//     the runtime identity in each bundle, and a behavioural H8b probe;
//   - adaptive >= 25 ms batches for every op (mount included);
//   - reps interleaved across variants (op -> rep -> variant) so slow drift
//     is shared rather than charged to one variant.
//
// Run pinned: taskset -c 0,1 node scripts/heuristics/stack-a/bench.mjs \
//   --suite list|rows [--n 1000] [--reps 5] [--out file.json] [--check]
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map(p => {
      const [k, ...v] = p.trim().split(/\s+/);
      return [k, v.join(" ") || "true"];
    })
);
const SUITE = args.suite ?? "list";
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 5);
const CACHE = join(ROOT, "node_modules/.cache/heuristics/stack-a");

// Snapshot runtimes + solid/web dist (per process).
const SNAP = join(CACHE, "snap", String(process.pid));
rmSync(SNAP, { recursive: true, force: true });
const SOURCES = {
  prod: [join(ROOT, "packages/signals/dist/prod"), "index.js"],
  oracle: [join(ROOT, "packages/signals/dist/oracle"), "index.js"],
  sync: [join(ROOT, "packages/signals/dist/sync"), "index.sync.js"],
  "oracle-sync": [join(CACHE, "oracle-sync"), "index.sync.js"]
};
const RUNTIMES = {};
for (const [k, [from, entry]] of Object.entries(SOURCES)) {
  if (!existsSync(join(from, entry))) throw new Error(`missing runtime ${from}/${entry}`);
  cpSync(from, join(SNAP, k), { recursive: true });
  RUNTIMES[k] = join(SNAP, k, entry);
}
cpSync(join(ROOT, "packages/solid/dist/solid.js"), join(SNAP, "solid.js"));
cpSync(join(ROOT, "packages/web/dist/web.js"), join(SNAP, "web.js"));

const VARIANTS =
  SUITE === "list"
    ? (await import("./list-variants.mjs")).LIST_VARIANTS
    : (await import("./rows-variants.mjs")).ROWS_VARIANTS;
const DETACHED_BITS = (1 << 26) | (1 << 27);
const dir = join(CACHE, "dom", SUITE);
mkdirSync(dir, { recursive: true });

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}

async function bundle(name, source, runtime) {
  const safe = name.replace(/[^\w.-]/g, "_");
  const entry = join(dir, `${safe}.mjs`);
  writeFileSync(entry, `${source}\nwindow.__make = make;\n`);
  const out = join(dir, `${safe}.bundle.js`);
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    outfile: out,
    minify: true,
    logLevel: "error",
    alias: {
      "solid-js": join(SNAP, "solid.js"),
      "@solidjs/web": join(SNAP, "web.js"),
      "@solidjs/signals": RUNTIMES[runtime]
    }
  });
  const html = join(dir, `${safe}.html`);
  writeFileSync(
    html,
    `<!doctype html><html><body><table><tbody id="tbody"></tbody></table><script src="${safe}.bundle.js"></script></body></html>`
  );
  return { html, entry, out };
}

// ---- landing checks (static) ------------------------------------------------
const verification = {};
const pages = {};
const probePages = {};
let bad = false;
for (const [name, v] of Object.entries(VARIANTS)) {
  const b = await bundle(name, v.source, v.runtime);
  pages[name] = b.html;
  const src = readFileSync(b.entry, "utf8");
  const bundled = readFileSync(b.out, "utf8");
  const checks = [];
  for (const [sign, needle] of v.markers) {
    const has = src.includes(needle);
    checks.push({ check: `${sign} ${needle}`, ok: sign === "+" ? has : !has });
  }
  const sites = src.split(`oracle: ${DETACHED_BITS}`).length - 1;
  checks.push({ check: `detached sites == ${v.detached}`, ok: sites === v.detached, got: sites });
  // Runtime identity: oracle arms read `.oracle`; the async-free trees carry
  // the ASYNC_CAPABILITY_EXCLUDED stubs.
  const isOracle = v.runtime.startsWith("oracle");
  const isSync = v.runtime.endsWith("sync");
  checks.push({ check: `bundle ${isOracle ? "has" : "lacks"} oracle arms`, ok: /\?\.oracle\b|\.oracle&/.test(bundled) === isOracle });
  checks.push({ check: `bundle ${isSync ? "is" : "is not"} async-free`, ok: bundled.includes("ASYNC_CAPABILITY_EXCLUDED") === isSync });
  // statusFree: the entry marker above plus esbuild's resolution (a missing
  // `statusFree` export fails the build). The frozen object itself is in
  // every bundle (solid-js re-exports it), so the bundle cannot tell.
  const failed = checks.filter(c => !c.ok);
  if (failed.length) bad = true;
  verification[name] = { runtime: v.runtime, flags: v.flags, bundleBytes: statSync(b.out).size, checks };
  console.log(`${failed.length ? "BAD " : "ok  "} landed  ${name.padEnd(20)} ${v.runtime.padEnd(12)} ${statSync(b.out).size} B${failed.length ? "  " + JSON.stringify(failed) : ""}`);
  // Probe build: exposes the rows so the H8b probe can write a label after
  // the row's owner was disposed. Never timed.
  const probeSrc =
    SUITE === "list"
      ? v.source.replace("return {\n\t\tmount() {", "return {\n\t\t__rows: () => rows(),\n\t\tmount() {")
      : v.source;
  if (SUITE === "list" && probeSrc === v.source) throw new Error("probe injection failed");
  probePages[name] = (await bundle(name + ".probe", probeSrc, v.runtime)).html;
}
if (bad) {
  console.log("a landing check failed; not measuring");
  process.exit(1);
}

// ---- in-page functions --------------------------------------------------------
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
// H8b probe: does an effect keep running after its row owner was disposed?
// list: remove the row at index 4 (removeAdd disposes it and creates a new
// one), then write that item's label. rows: unmount the whole root, then run
// update10th (row 0's label). A detached label effect still writes the old,
// now-disconnected <td>; an owned one was disposed.
function pageProbe([n, suite]) {
  const tbody = document.getElementById("tbody");
  const app = window.__make(n, tbody);
  app.mount();
  app.prepare?.();
  if (suite === "list") {
    // K rounds of removeAdd remove and re-create the same item's row.
    const x = app.__rows()[4];
    const olds = [];
    for (let k = 0; k < 20; k++) {
      olds.push(tbody.children[4]);
      app.ops.removeAdd();
    }
    const recreated = !olds.includes(tbody.children[4]);
    x.setLabel("PROBE");
    app.ops.select(); // flushes
    const r = {
      recreated,
      zombiesOf20: olds.filter(o => o.children[1].textContent === "PROBE").length,
      liveLabel: tbody.children[4].children[1].textContent
    };
    app.unmount();
    return r;
  }
  const old = tbody.children[0];
  app.unmount();
  app.ops.update10th();
  return { oldLabel: old.children[1].textContent };
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
  // Adaptive batch: every sample runs until >= 25 ms have elapsed (file://
  // coarsens performance.now()), so no sample is ever a single short run.
  const samples = [];
  const batches = [];
  for (let s = 0; s < 20; s++) {
    const t = performance.now();
    let k = 0, el = 0;
    do {
      run();
      k++;
      el = performance.now() - t;
    } while (el < 25);
    samples.push((el * 1000) / k);
    batches.push(k);
  }
  const order = samples.map((u, i) => i).sort((a, b) => samples[a] - samples[b]);
  const mid = order[10];
  return { us: samples[mid], batch: batches[mid], batchMs: (samples[mid] * batches[mid]) / 1000 };
}

// ---- equivalence gate ---------------------------------------------------------------
const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
const evalOn = async (html, fn, arg) => {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(pathToFileURL(html).href);
  const r = await page.evaluate(fn, arg);
  await page.close();
  if (errors.length) throw new Error(`page error in ${html}: ${errors[0]}`);
  return r;
};
const reference = await evalOn(pages.baseline, pageTrace, 50);
const gate = {};
let failed = false;
for (const name of Object.keys(pages)) {
  const t = await evalOn(pages[name], pageTrace, 50);
  const at = t.findIndex((s, i) => s !== reference[i]);
  const ok = at === -1 && t.length === reference.length;
  gate[name] = { ok, steps: t.length, firstDiff: ok ? null : at };
  if (!ok) {
    failed = true;
    console.log(`FAIL gate ${name} at step ${at}\n  expected ${reference[at]?.slice(0, 200)}\n  received ${t[at]?.slice(0, 200)}`);
  } else console.log(`ok   gate    ${name} (${t.length} HTML snapshots)`);
}
const probe = {};
for (const name of Object.keys(probePages)) {
  probe[name] = await evalOn(probePages[name], pageProbe, [50, SUITE]);
  console.log(`     probe   ${name.padEnd(20)} ${JSON.stringify(probe[name])}`);
}
if (failed || args.check) {
  await browser.close();
  if (args.check && !failed) {
    const out = args.out ?? join("documentation/plans/heuristic-oracles/stack-a", `${SUITE}-check.json`);
    writeFileSync(resolve(ROOT, out), JSON.stringify({ suite: SUITE, verification, gate, probe }, null, 2) + "\n");
    console.log(`wrote ${out}`);
  }
  process.exit(failed ? 1 : 0);
}

// ---- timing -----------------------------------------------------------------------
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const OPS = (args.ops ?? (SUITE === "list" ? "create,replace,update10th,select,swap,removeAdd" : "mount,update10th,select")).split(",");
const names = (args.only ?? Object.keys(pages).join(",")).split(",");
const raw = {};
for (const op of OPS) {
  for (let r = 0; r < REPS; r++)
    for (const name of names) {
      const res = await evalOn(pages[name], pageTime, [N, op]);
      ((raw[op] ??= {})[name] ??= []).push(res);
    }
  for (const name of names) {
    const reps = raw[op][name].map(x => x.us);
    const med = median(reps);
    const spread = (Math.max(...reps) - Math.min(...reps)) / med;
    console.log(`${op.padEnd(10)} ${name.padEnd(20)} ${med.toFixed(1).padStart(9)} µs  ±${(spread * 50).toFixed(0)}%  batch ${raw[op][name].map(x => x.batch).join("/")}`);
  }
}
const results = [];
for (const op of OPS)
  for (const name of names) {
    const reps = raw[op][name].map(x => x.us);
    const med = median(reps);
    results.push({
      variant: name,
      runtime: VARIANTS[name].runtime,
      op,
      usPerOp: med,
      reps,
      spread: (Math.max(...reps) - Math.min(...reps)) / med,
      batches: raw[op][name].map(x => x.batch),
      minBatchMs: Math.min(...raw[op][name].map(x => x.batchMs))
    });
  }
const version = browser.version();
await browser.close();
const out = args.out ?? join("documentation/plans/heuristic-oracles/stack-a", `${SUITE}-run.json`);
writeFileSync(
  resolve(ROOT, out),
  JSON.stringify(
    { suite: SUITE, n: N, reps: REPS, chromium: version, date: new Date().toISOString(), verification, gate, probe, results },
    null,
    2
  ) + "\n"
);
rmSync(SNAP, { recursive: true, force: true });
console.log(`wrote ${out}`);
