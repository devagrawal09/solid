#!/usr/bin/env node
// Core runtime slicing — app-level bytes (documentation/plans/core-runtime-slicing.md).
//
//   node scripts/slices/measure-apps.mjs [--out file.json] [--examples a,b]
//
// Builds each example with `vite build` (its own config: the solid plugin
// and the native compiler) against the built workspace packages, in three
// variants:
//   baseline  no capability linker — the full runtime, every switch on;
//   async     the Track A linker as it shipped (async-free entry only);
//   sliced    the linker with feature slicing (async-free entry when proven,
//             plus every feature switch the graph is proven not to use).
// Reports the JS emitted (esbuild-minified by vite, and gzip -9) and the
// linker's decision. Needs packages/{signals,solid,web} built and the
// native compiler (packages/compiler) built.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const outFile = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : null;
const only = args.includes("--examples") ? args[args.indexOf("--examples") + 1].split(",") : null;
// --dump <dir>: write each variant's chunks there for inspection.
const dump = args.includes("--dump") ? resolve(args[args.indexOf("--dump") + 1]) : null;

const EXAMPLES = {
  "sync-blocks": { entry: "src/main.tsx", typedSummary: ".solid-capabilities.json" },
  "todos-blocks": { entry: "src/main.tsx" },
  todos: { entry: "src/main.tsx" },
  sierpinski: { entry: "src/main.tsx" }
};

async function buildVariant(name, spec, variant) {
  const dir = join(ROOT, "examples", name);
  const require = createRequire(join(dir, "package.json"));
  const { build } = await import(require.resolve("vite"));
  const { solidCapabilities } = createRequire(import.meta.url)(
    join(ROOT, "packages/compiler/capabilities.js")
  );
  // sync-blocks wires the linker in its own config; keep it out and add ours.
  process.env.SOLID_CAPABILITIES = "0";
  const reportFile = join(ROOT, "node_modules/.cache/slices", `${name}.${variant}.report.json`);
  const plugins =
    variant === "baseline"
      ? []
      : [
          solidCapabilities({
            entries: [spec.entry],
            typedSummary: spec.typedSummary,
            report: reportFile,
            features: variant === "sliced"
          })
        ];
  const result = await build({
    root: dir,
    configFile: ["vite.config.mjs", "vite.config.ts", "vite.config.js"]
      .map(f => join(dir, f))
      .find(existsSync),
    logLevel: "warn",
    plugins,
    build: { write: false, reportCompressedSize: false }
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  let min = 0,
    gz = 0;
  const chunks = [];
  // Rendered (pre-minify) bytes per package and per runtime module: where
  // the app's JS comes from.
  const byPackage = {};
  const byModule = {};
  for (const o of outputs) {
    if (o.type !== "chunk") continue;
    const bytes = Buffer.byteLength(o.code);
    min += bytes;
    gz += gzipSync(o.code, { level: 9 }).length;
    chunks.push([o.fileName, bytes]);
    for (const [id, m] of Object.entries(o.modules)) {
      if (!m.renderedLength) continue;
      const pkg =
        /packages\/(signals|solid|web)\//.exec(id)?.[1] ??
        (id.includes("node_modules") ? "deps" : "app");
      byPackage[pkg] = (byPackage[pkg] ?? 0) + m.renderedLength;
      const mod = /packages\/signals\/dist\/\w+\/(.+)$/.exec(id)?.[1];
      if (mod) byModule[mod] = (byModule[mod] ?? 0) + m.renderedLength;
    }
    if (dump) {
      const file = join(dump, name, variant, o.fileName);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, o.code);
    }
  }
  let decision = null;
  if (variant !== "baseline") {
    const { readFileSync } = await import("node:fs");
    const r = JSON.parse(readFileSync(reportFile, "utf8"));
    decision = {
      asyncFree: r.asyncFree,
      firstReason: r.reasons[0]?.reason ?? null,
      off: variant === "sliced" ? Object.keys(r.features).filter(f => !r.features[f].on) : []
    };
  }
  return { min, gz, chunks, decision, byPackage, byModule };
}

const results = {};
for (const [name, spec] of Object.entries(EXAMPLES)) {
  if (only && !only.includes(name)) continue;
  results[name] = {};
  for (const variant of ["baseline", "async", "sliced"]) {
    try {
      results[name][variant] = await buildVariant(name, spec, variant);
    } catch (error) {
      results[name][variant] = { error: String(error.message ?? error).split("\n")[0] };
    }
  }
}

const pct = (a, b) => `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(1)}%`;
console.log(
  "| example | baseline min / gz | async linker min / gz | sliced min / gz | sliced vs baseline (gz) | linker decision |\n| --- | ---: | ---: | ---: | ---: | --- |"
);
for (const [name, r] of Object.entries(results)) {
  const cell = v => (v.error ? `error: ${v.error}` : `${v.min} / ${v.gz}`);
  const d = r.sliced.decision;
  const decision = d
    ? `${d.asyncFree ? "async-free" : `full (${d.firstReason})`}; off: ${d.off.join(", ") || "none"}`
    : "–";
  console.log(
    `| ${name} | ${cell(r.baseline)} | ${cell(r.async)} | ${cell(r.sliced)} | ${
      r.sliced.gz && r.baseline.gz ? pct(r.sliced.gz, r.baseline.gz) : "–"
    } | ${decision} |`
  );
}
if (args.includes("--modules"))
  for (const [name, r] of Object.entries(results))
    for (const variant of ["baseline", "sliced"]) {
      const v = r[variant];
      if (v.error) continue;
      console.log(
        `\n${name} (${variant}) rendered bytes by package: ${JSON.stringify(v.byPackage)}`
      );
      console.log(
        Object.entries(v.byModule)
          .sort((a, b) => b[1] - a[1])
          .map(([m, n]) => `  ${m} ${n}`)
          .join("\n")
      );
    }
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(results, null, 2));
}
