#!/usr/bin/env node
// Track A stage 2 measurements: the async-free reactive core.
//
//   node scripts/track-a/stage2.mjs [--out file.json]
//
// 1. Runtime floor: the five core primitives bundled (esbuild, minify) from
//    the full production tree (dist/prod) and from the async-free tree
//    (dist/sync) — raw / gzip / brotli, and the retained modules.
// 2. Applications: examples/sync-blocks (proven async-free) built with and
//    without the capability linker, client and server graphs; retained
//    module graph from the sourcemap; raw / gzip / brotli of the emitted JS.
// 3. Negative controls: the linker over examples/todos and
//    examples/todos-blocks (both use async capabilities) must keep the full
//    runtime; their reasons are recorded.
// 4. Linker cost: wall time of the summary + proof walk over each app.
//
// CPU cost of the async-free runtime is measured separately with
// scripts/track-a/icount.mjs --runtime packages/signals/dist/sync/index.sync.js.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { buildSync } from "esbuild";
import { ROOT } from "./compile.mjs";

const require = createRequire(import.meta.url);
const { proveGraph } = require(join(ROOT, "packages/compiler/capabilities.js"));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map(pair => pair.trim().split(/\s+/))
);
const work = join(ROOT, "node_modules/.cache/track-a/stage2");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const measure = code => {
  const buffer = Buffer.from(code);
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length
  };
};

// --- 1. runtime floor --------------------------------------------------------
const floor = {};
for (const [name, entry] of Object.entries({
  full: "packages/signals/dist/prod/index.js",
  sync: "packages/signals/dist/sync/index.sync.js"
})) {
  const file = join(work, `floor-${name}.mjs`);
  writeFileSync(
    file,
    `export { createSignal, createMemo, createEffect, createRenderEffect, createRoot, flush, createStore, createErrorBoundary } from ${JSON.stringify(join(ROOT, entry))};`
  );
  const result = buildSync({
    entryPoints: [file],
    bundle: true,
    minify: true,
    format: "esm",
    write: false,
    metafile: true,
    target: "es2022",
    logLevel: "silent"
  });
  const modules = Object.entries(result.metafile.outputs)[0][1].inputs;
  floor[name] = {
    ...measure(result.outputFiles[0].text),
    modules: Object.fromEntries(
      Object.entries(modules)
        .filter(([, v]) => v.bytesInOutput > 0)
        .map(([k, v]) => [
          k.replace(/.*packages\/signals\/dist\/(prod|sync)\//, ""),
          v.bytesInOutput
        ])
    )
  };
}

// --- 2. applications ---------------------------------------------------------
function build(dir, env, extra = []) {
  const out = join(
    work,
    `${relative(ROOT, dir).replace(/\W+/g, "-")}-${Object.values(env).join("-") || "default"}${extra.length ? "-ssr" : ""}`
  );
  const t0 = performance.now();
  execFileSync(
    "npx",
    [
      "vite",
      "build",
      "--outDir",
      out,
      "--emptyOutDir",
      "--sourcemap",
      "--logLevel",
      "error",
      ...extra
    ],
    {
      cwd: dir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "inherit"]
    }
  );
  const ms = performance.now() - t0;
  const walk = d =>
    readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []
    );
  const js = walk(out);
  const code = js.map(f => readFileSync(f, "utf8")).join("\n");
  const sources = new Set();
  for (const f of js) {
    try {
      for (const s of JSON.parse(readFileSync(`${f}.map`, "utf8")).sources)
        sources.add(s.replace(/.*packages\//, "packages/"));
    } catch {}
  }
  const signals = [...sources].filter(s => s.includes("packages/signals/")).sort();
  return {
    ...measure(code),
    buildMs: Math.round(ms),
    modules: sources.size,
    signalsModules: signals
  };
}

const syncApp = join(ROOT, "examples/sync-blocks");
execFileSync(
  "node",
  [
    "../../packages/typecheck/bin/solid-tsc.js",
    "--noEmit",
    "-p",
    "tsconfig.json",
    "--capabilities",
    ".solid-capabilities.json"
  ],
  { cwd: syncApp }
);
const apps = {
  "sync-blocks client (linker)": build(syncApp, {}),
  "sync-blocks client (full runtime)": build(syncApp, { SOLID_CAPABILITIES: "0" }),
  "sync-blocks server (linker)": build(syncApp, {}, ["--ssr", "src/app.tsx"]),
  "sync-blocks server (full runtime)": build(syncApp, { SOLID_CAPABILITIES: "0" }, [
    "--ssr",
    "src/app.tsx"
  ])
};
const linkerReport = JSON.parse(readFileSync(join(syncApp, "capabilities-report.json"), "utf8"));

// --- 3. negative controls and 4. linker cost -----------------------------------
const exts = ["", ".tsx", ".ts", ".jsx", ".js", ".css"];
const resolver = root => async (source, importer) => {
  if (source.startsWith(".")) {
    const base = join(dirname(importer), source);
    for (const ext of exts) {
      try {
        if (readdirSync(dirname(base + ext)).includes((base + ext).split("/").pop()))
          return base + ext;
      } catch {}
    }
    return null;
  }
  try {
    return require.resolve(source, { paths: [root] });
  } catch {
    return null;
  }
};
const controls = {};
for (const [name, dir] of Object.entries({
  "examples/todos (handwritten)": "examples/todos",
  "examples/todos-blocks": "examples/todos-blocks",
  "examples/sync-blocks": "examples/sync-blocks"
})) {
  const root = join(ROOT, dir);
  const typedSummary =
    dir === "examples/sync-blocks"
      ? JSON.parse(readFileSync(join(root, ".solid-capabilities.json"), "utf8"))
      : undefined;
  const times = [];
  let report;
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    report = await proveGraph({
      entries: [join(root, "src/main.tsx")],
      root,
      resolve: resolver(root),
      typedSummary
    });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  controls[name] = {
    asyncFree: report.asyncFree,
    modules: report.modules.length,
    counts: report.counts,
    reasons: report.reasons,
    proofMsMedian: Number(times[3].toFixed(2))
  };
}

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const result = {
  env: {
    date: new Date().toISOString(),
    commit: sha,
    node: process.version,
    gzip: "level 9",
    brotli: "quality 11"
  },
  floor,
  apps,
  linkerReport,
  controls
};
const outFile = args.out ?? join(work, "stage2.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2));

let md = "| runtime floor | raw | gzip | brotli | modules |\n| --- | ---: | ---: | ---: | ---: |\n";
for (const [k, v] of Object.entries(floor))
  md += `| ${k} | ${v.raw} | ${v.gzip} | ${v.brotli} | ${Object.keys(v.modules).length} |\n`;
md +=
  "\n| app build | raw | gzip | brotli | modules | signals modules | build ms |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n";
for (const [k, v] of Object.entries(apps))
  md += `| ${k} | ${v.raw} | ${v.gzip} | ${v.brotli} | ${v.modules} | ${v.signalsModules.length} | ${v.buildMs} |\n`;
md +=
  "\n| linker | async-free | modules | computes (local/typed) | proof ms | first reason |\n| --- | --- | ---: | --- | ---: | --- |\n";
for (const [k, v] of Object.entries(controls))
  md += `| ${k} | ${v.asyncFree} | ${v.modules} | ${v.counts.computes} (${v.counts.computesLocal}/${v.counts.computesTyped}) | ${v.proofMsMedian} | ${v.reasons[0]?.reason ?? ""} |\n`;
process.stdout.write(`${md}\nraw data: ${outFile}\n`);
