#!/usr/bin/env node
// Core runtime slicing — byte measurements (documentation/plans/core-runtime-slicing.md).
//
// Bundles small fixtures against src/ the way tests/treeshake.test.ts does
// (vite/rollup with production defines, then esbuild minify with `_`-property
// mangling) and reports minified and min+gzip bytes plus the per-module
// rendered share. A fixture may run on the full runtime, on the async-free
// runtime (`__ASYNC__` false, try deoptimization off, like the dist/sync
// build), and with any feature switches off: the switches live in
// src/core/features.ts and are substituted here by a generated module, which
// is exactly what the capability linker does at app link time.
//
//   node scripts/slices.mjs                 # the standard matrix (markdown)
//   node scripts/slices.mjs --json out.json # and write the raw numbers
//   node scripts/slices.mjs --modules       # per-module breakdown of the floors
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, transformWithEsbuild } from "vite";

const SRC = process.env.SLICES_SRC
  ? resolve(process.env.SLICES_SRC)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const FEATURES = join(SRC, "core/features.ts");

/** Every switch in src/core/features.ts, default on. */
export const FEATURE_NAMES = [
  "OPTIMISTIC",
  "VERDICTS",
  "STORES",
  "SNAPSHOTS",
  "ITERABLE",
  "COMPILED_SEAMS"
];

export async function measure(code, { asyncCapability = true, off = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "solid-slices-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, code);
    // OPTIMISTIC and VERDICTS are async capabilities: the default module
    // derives them from __ASYNC__, and so does the substitute.
    const asyncOnly = ["OPTIMISTIC", "VERDICTS"];
    const featuresModule = FEATURE_NAMES.map(
      name =>
        `export const ${name} = ${!off.includes(name) && (asyncCapability || !asyncOnly.includes(name))};`
    ).join("\n");
    const result = await build({
      configFile: false,
      logLevel: "silent",
      define: {
        __DEV__: "false",
        __OBSERVE__: "false",
        __TEST__: "false",
        __ASYNC__: String(asyncCapability),
        __ORACLE__: "false"
      },
      resolve: {
        alias: {
          "sigsrc-sync": join(SRC, "index.sync.ts"),
          sigsrc: join(SRC, "index.ts")
        }
      },
      plugins: [
        {
          name: "slices:features",
          enforce: "pre",
          async resolveId(source, importer, options) {
            if (!off.length || !/features(\.js|\.ts)?$/.test(source)) return null;
            const r = await this.resolve(source, importer, { ...options, skipSelf: true });
            return r && r.id === FEATURES ? "\0slices-features" : null;
          },
          load(id) {
            return id === "\0slices-features" ? featuresModule : null;
          }
        }
      ],
      build: {
        write: false,
        minify: false,
        target: "esnext",
        lib: { entry, formats: ["es"], fileName: "out" },
        rollupOptions: asyncCapability ? {} : { treeshake: { tryCatchDeoptimization: false } }
      }
    });
    const chunk = result[0].output[0];
    const modules = Object.entries(chunk.modules)
      .filter(([, m]) => m.renderedLength > 0)
      .map(([id, m]) => [id.replace(SRC + "/", ""), m.renderedLength])
      .sort((a, b) => b[1] - a[1]);
    // `min`/`gz`: the treeshake.test.ts harness (esbuild transform with no
    // format — top-level declarations might be globals, so no constant is
    // inlined). `esm`/`esmGz`: the same with `format: "esm"`, which is what a
    // Vite app build's chunk minify does (module-scope constants inline).
    const minified = (
      await transformWithEsbuild(chunk.code, "out.js", { minify: true, mangleProps: /^_/ })
    ).code;
    const esm = (
      await transformWithEsbuild(chunk.code, "out.js", {
        minify: true,
        mangleProps: /^_/,
        format: "esm",
        treeShaking: true
      })
    ).code;
    return {
      min: Buffer.byteLength(minified),
      gz: gzipSync(minified, { level: 9 }).length,
      esm: Buffer.byteLength(esm),
      esmGz: gzipSync(esm, { level: 9 }).length,
      modules,
      code: chunk.code
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FLOOR = "createSignal, createMemo, createEffect, createRoot, flush";
export const FIXTURES = {
  floor: `export { ${FLOOR} } from "SIG";`,
  "floor+context": `export { ${FLOOR}, createContext, getContext, setContext } from "SIG";`,
  "floor+store": `export { ${FLOOR}, createStore } from "SIG";`,
  "floor+projection": `export { ${FLOOR}, createProjection } from "SIG";`,
  "floor+mapArray": `export { ${FLOOR}, mapArray } from "SIG";`,
  "floor+errorBoundary": `export { ${FLOOR}, createErrorBoundary } from "SIG";`,
  "floor+loadingBoundary": `export { ${FLOOR}, createLoadingBoundary } from "SIG";`,
  "floor+reveal": `export { ${FLOOR}, createRevealOrder } from "SIG";`,
  "floor+action": `export { ${FLOOR}, action } from "SIG";`,
  "floor+optimistic": `export { ${FLOOR}, createOptimistic } from "SIG";`,
  "floor+optimisticStore": `export { ${FLOOR}, createOptimisticStore } from "SIG";`,
  "floor+isPending/latest": `export { ${FLOOR}, isPending, latest } from "SIG";`,
  "floor+refresh": `export { ${FLOOR}, refresh } from "SIG";`,
  "floor+resolve/until": `export { ${FLOOR}, resolve, until } from "SIG";`,
  "floor+affects": `export { ${FLOOR}, affects } from "SIG";`,
  "floor+statusFree": `export { ${FLOOR}, statusFree } from "SIG";`,
  "floor+$ driver": `export { ${FLOOR}, $ } from "SIG";`,
  "floor+block api": `export { ${FLOOR}, $component, $memo, $effect, $event, $signal, $store } from "SIG";`,
  "floor+externalSource": `export { ${FLOOR}, enableExternalSource } from "SIG";`,
  "floor+snapshots": `export { ${FLOOR}, setSnapshotCapture, markSnapshotScope, releaseSnapshotScope, clearSnapshots } from "SIG";`,
  "floor+ids": `export { ${FLOOR}, getNextChildId } from "SIG";`
};

/** App-shaped fixtures: what a component tree built on solid-js typically
 * pulls from the core (control flow needs mapArray / boundaries, components
 * need context). `runtime` picks the full or async-free entry; `off` the
 * switches a linker could prove off for such an app. */
export const APPS = {
  "sync app (no stores)": {
    code: `export { ${FLOOR}, createRenderEffect, createContext, getContext, setContext, mapArray, createErrorBoundary, onCleanup, untrack } from "SIG";`,
    runtime: "sync",
    off: ["STORES", "SNAPSHOTS", "ITERABLE", "COMPILED_SEAMS"]
  },
  "sync app + stores": {
    code: `export { ${FLOOR}, createRenderEffect, createContext, getContext, setContext, mapArray, createErrorBoundary, onCleanup, untrack, createStore } from "SIG";`,
    runtime: "sync",
    off: ["SNAPSHOTS", "ITERABLE", "COMPILED_SEAMS"]
  },
  "async app (Loading, no optimistic)": {
    code: `export { ${FLOOR}, createRenderEffect, createContext, getContext, setContext, mapArray, createErrorBoundary, createLoadingBoundary, onCleanup, untrack, refresh } from "SIG";`,
    runtime: "full",
    off: ["OPTIMISTIC", "VERDICTS", "STORES", "SNAPSHOTS", "ITERABLE", "COMPILED_SEAMS"]
  },
  "async app + isPending": {
    code: `export { ${FLOOR}, createRenderEffect, createContext, getContext, setContext, mapArray, createErrorBoundary, createLoadingBoundary, onCleanup, untrack, refresh, isPending, latest } from "SIG";`,
    runtime: "full",
    off: ["STORES", "SNAPSHOTS", "ITERABLE", "COMPILED_SEAMS"]
  },
  "async app + actions/optimistic stores": {
    code: `export { ${FLOOR}, createRenderEffect, createContext, getContext, setContext, mapArray, createErrorBoundary, createLoadingBoundary, onCleanup, untrack, refresh, isPending, action, createOptimisticStore } from "SIG";`,
    runtime: "full",
    off: ["SNAPSHOTS", "ITERABLE", "COMPILED_SEAMS"]
  }
};

const pct = (a, b) => `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%`;
const run = (code, runtime, off = []) =>
  measure(code.replace("SIG", runtime === "sync" ? "sigsrc-sync" : "sigsrc"), {
    asyncCapability: runtime !== "sync",
    off
  });
const pick = r => ({ harness: r.min, harnessGz: r.gz, min: r.esm, gz: r.esmGz });

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
  const out = { opt_in: {}, switches: {}, apps: {}, modules: {} };
  console.log(
    "min / gz: esbuild ESM minify with tree shaking (what a Vite app build does);\n" +
      "harness: tests/treeshake.test.ts's minify (no module format: top-level constants stay)."
  );

  const floorFull = await run(FIXTURES.floor, "full");
  const floorSync = await run(FIXTURES.floor, "sync");
  if (args.includes("--modules")) {
    for (const [label, r] of [
      ["full floor", floorFull],
      ["sync floor", floorSync]
    ]) {
      console.log(`\n### ${label}: ${r.esm} B min, ${r.esmGz} B gz\n`);
      console.log("| module | rendered bytes (unminified) |\n| --- | ---: |");
      for (const [id, n] of r.modules) console.log(`| ${id} | ${n} |`);
      out.modules[label] = r.modules;
    }
  }

  // 1. Opt-in cost: what an explicit import adds over the five-primitive floor.
  console.log("\n### Opt-in APIs over the floor (full runtime)\n");
  console.log("| fixture | min | gz | Δ min | Δ gz |\n| --- | ---: | ---: | ---: | ---: |");
  for (const [name, code] of Object.entries(FIXTURES)) {
    const r = name === "floor" ? floorFull : await run(code, "full");
    out.opt_in[name] = pick(r);
    console.log(
      `| ${name} | ${r.esm} | ${r.esmGz} | ${r.esm - floorFull.esm} | ${r.esmGz - floorFull.esmGz} |`
    );
  }

  // 2. Seam cost: what each switch removes from the floor when turned off.
  console.log("\n### Core seams removed by each switch (floor fixture)\n");
  console.log(
    "| runtime | switches off | harness | min | gz | Δ min | Δ gz |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |"
  );
  const rows = [
    ["full", []],
    ...FEATURE_NAMES.map(n => ["full", [n]]),
    ["full", FEATURE_NAMES],
    ["sync", []],
    ...FEATURE_NAMES.filter(n => n !== "OPTIMISTIC" && n !== "VERDICTS").map(n => ["sync", [n]]),
    ["sync", FEATURE_NAMES]
  ];
  for (const [runtime, off] of rows) {
    const base = runtime === "sync" ? floorSync : floorFull;
    const r = off.length ? await run(FIXTURES.floor, runtime, off) : base;
    out.switches[`${runtime}:${off.join("+") || "-"}`] = pick(r);
    const offLabel = off.length === FEATURE_NAMES.length ? "all" : off.join(", ") || "–";
    console.log(
      `| ${runtime} | ${offLabel} | ${r.min} | ${r.esm} | ${r.esmGz} | ${r.esm - base.esm} (${pct(r.esm, base.esm)}) | ${r.esmGz - base.esmGz} |`
    );
  }

  // 3. App-shaped fixtures: full runtime vs the slice a linker would pick.
  console.log("\n### App-shaped fixtures: full runtime vs selected slice\n");
  console.log(
    "| fixture | full min | full gz | slice | slice min | slice gz | Δ min | Δ gz |\n| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |"
  );
  for (const [name, app] of Object.entries(APPS)) {
    const full = await run(app.code, "full");
    const slice = await run(app.code, app.runtime, app.off);
    const label = `${app.runtime}${app.off.length ? ` −${app.off.length} switches` : ""}`;
    out.apps[name] = { full: pick(full), slice: pick(slice), runtime: app.runtime, off: app.off };
    console.log(
      `| ${name} | ${full.esm} | ${full.esmGz} | ${label} | ${slice.esm} | ${slice.esmGz} | ${slice.esm - full.esm} (${pct(slice.esm, full.esm)}) | ${slice.esmGz - full.esmGz} (${pct(slice.esmGz, full.esmGz)}) |`
    );
  }
  if (json) writeFileSync(json, JSON.stringify(out, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
