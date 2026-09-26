#!/usr/bin/env node
// Wall-time cross-check of the instruction counts: a fresh process per
// (scenario, cell, op), `reps` processes each reporting the median of
// `samples` timed batches after a warmup long enough to reach steady state.
// Wall time on a shared VM is noisy; only differences well beyond the
// reported spread mean anything.
//
//   node scripts/heuristics/bench.mjs [--n 1000] [--reps 5] [--cells a,b]
//        [--out documentation/plans/heuristic-oracles/bench.json]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cells, parseArgs, ROOT, snapshotRuntimes, writeModule } from "./common.mjs";
import { SCENARIOS } from "./scenarios.mjs";

snapshotRuntimes();

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 5);
const ONLY = args.scenarios ? args.scenarios.split(",") : null;
const ONLY_CELLS = args.cells ? args.cells.split(",") : null;
const dir = join(ROOT, "node_modules/.cache/heuristics/bench");
const worker = join(here, "bench-worker.mjs");

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = [];
for (const scenario of SCENARIOS) {
  if (ONLY && !ONLY.includes(scenario.name)) continue;
  const probe = writeModule(dir, `${scenario.name}.probe`, scenario.variants.baseline, "prod");
  const opNames = ["mount", ...Object.keys((await import(pathToFileURL(probe).href)).make(1).ops)];
  for (const cell of cells(scenario)) {
    if (ONLY_CELLS && !ONLY_CELLS.includes(cell.label)) continue;
    const module = writeModule(
      dir,
      `${scenario.name}.${cell.variant}.${cell.runtime}`,
      scenario.variants[cell.variant],
      cell.runtime
    );
    for (const op of opNames) {
      const reps = [];
      for (let r = 0; r < REPS; r++)
        reps.push(
          Number(
            execFileSync(process.execPath, ["--expose-gc", worker, pathToFileURL(module).href, op, String(N)], {
              encoding: "utf8"
            }).trim()
          )
        );
      const med = median(reps);
      const spread = (Math.max(...reps) - Math.min(...reps)) / med;
      results.push({ scenario: scenario.name, cell: cell.label, op, usPerOp: med, reps, spread });
      console.log(
        `${scenario.name.padEnd(6)} ${op.padEnd(10)} ${cell.label.padEnd(18)} ${med.toFixed(1).padStart(9)} µs  ±${(spread * 50).toFixed(0)}%`
      );
    }
  }
}
const out = args.out ?? "documentation/plans/heuristic-oracles/bench.json";
mkdirSync(dirname(resolve(ROOT, out)), { recursive: true });
writeFileSync(
  resolve(ROOT, out),
  JSON.stringify({ n: N, reps: REPS, node: process.version, date: new Date().toISOString(), results }, null, 2) + "\n"
);
console.log(`wrote ${out}`);
