#!/usr/bin/env node
// Track A: compiler overhead of the block proofs (stage 1) and the capability
// summary (stage 2), measured on the repository's block examples.
//
//   node scripts/track-a/compiler-cost.mjs [--reps 200] [--out file.json]
//
// For each source: median wall time of `transform` without proofs (host
// fusion only, the unfused/fused baselines), with `blockProofs`, and of
// `summarizeCapabilities`, after a warmup. Emitted bytes are reported for each
// transform so the size delta of the proof metadata is visible per file.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { compiler, ROOT } from "./compile.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map(pair => pair.trim().split(/\s+/))
);
const REPS = Number(args.reps ?? 200);
const FILES = [
  "examples/todos-blocks/src/app.tsx",
  "examples/sync-blocks/src/app.tsx",
  "examples/sync-blocks/src/main.tsx"
];
const CONFIGS = {
  unfused: { generate: "dom" },
  fused: { generate: "dom", hostFusion: true },
  "fused+proofs": { generate: "dom", hostFusion: true, blockProofs: true },
  "unfused+proofs": { generate: "dom", blockProofs: true }
};

const median = xs => xs.sort((a, b) => a - b)[xs.length >> 1];
function time(fn) {
  for (let i = 0; i < 20; i++) fn();
  const samples = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    medianUs: Number((median(samples) * 1000).toFixed(1)),
    p10Us: Number((samples[Math.floor(REPS * 0.1)] * 1000).toFixed(1)),
    p90Us: Number((samples[Math.floor(REPS * 0.9)] * 1000).toFixed(1))
  };
}

const results = {};
for (const file of FILES) {
  const source = readFileSync(join(ROOT, file), "utf8");
  const row = { sourceBytes: Buffer.byteLength(source) };
  for (const [name, options] of Object.entries(CONFIGS)) {
    const run = () => compiler.transform(source, { filename: file, ...options });
    row[name] = { ...time(run), emittedBytes: Buffer.byteLength(run().code) };
  }
  row.summarizeCapabilities = time(() =>
    compiler.summarizeCapabilities(source, { filename: file })
  );
  results[file] = row;
}

const outFile = args.out ?? join(ROOT, "node_modules/.cache/track-a/compiler-cost.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify(
    { env: { date: new Date().toISOString(), node: process.version, reps: REPS }, results },
    null,
    2
  )
);

let md =
  "| file | config | median µs | p10 | p90 | emitted B |\n| --- | --- | ---: | ---: | ---: | ---: |\n";
for (const [file, row] of Object.entries(results)) {
  for (const name of [...Object.keys(CONFIGS), "summarizeCapabilities"]) {
    const r = row[name];
    md += `| ${file} | ${name} | ${r.medianUs} | ${r.p10Us} | ${r.p90Us} | ${r.emittedBytes ?? ""} |\n`;
  }
}
process.stdout.write(`${md}\nraw data: ${outFile}\n`);
