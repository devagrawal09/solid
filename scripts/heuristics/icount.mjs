#!/usr/bin/env node
// Instructions per operation for every (scenario, cell, op), the Track A
// method: each cell runs twice under `valgrind --tool=cachegrind
// --cache-sim=no` with identical warmup and `ops` vs `2*ops` operations, and
// (Ir(2·ops) − Ir(ops)) / ops cancels startup, module load and warmup. Node
// runs `--predictable --single-threaded` for deterministic JIT and GC.
//
//   node scripts/heuristics/icount.mjs [--n 200] [--ops 40] [--jobs 4]
//        [--scenarios rows,chain] [--cells H1-fuse@oracle,...] [--out documentation/plans/heuristic-oracles/icount.json]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cells, parseArgs, ROOT, snapshotRuntimes, writeModule } from "./common.mjs";
import { SCENARIOS } from "./scenarios.mjs";

snapshotRuntimes();

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 200);
const OPS = Number(args.ops ?? 40);
const JOBS = Number(args.jobs ?? 4);
// Measured with --predictable --single-threaded: at 100 update warmups the
// ops window still contains tier-up compiles (per-op time swings 10-100x
// between windows); by 2000 it is flat. Mount flattens by ~300.
const WARMUP = { mount: Number(args.warmupMount ?? 300), update: Number(args.warmupUpdate ?? 2000) };
const ONLY = args.scenarios ? args.scenarios.split(",") : null;
const ONLY_CELLS = args.cells ? args.cells.split(",") : null;
const dir = join(ROOT, "node_modules/.cache/heuristics/icount");

function ir(module, op, ops) {
  return new Promise((resolve, reject) => {
    const child = spawn("valgrind", [
      "--tool=cachegrind",
      "--cache-sim=no",
      "--cachegrind-out-file=/dev/null",
      process.execPath,
      "--predictable",
      "--single-threaded",
      join(here, "icount-worker.mjs"),
      pathToFileURL(module).href,
      op,
      String(N),
      String(op === "mount" ? WARMUP.mount : WARMUP.update),
      String(ops)
    ]);
    let err = "";
    child.stderr.on("data", d => (err += d));
    child.on("close", () => {
      const m = /I\s+refs:\s+([\d,]+)/.exec(err);
      if (!m) reject(new Error(`no instruction count:\n${err.slice(-2000)}`));
      else resolve(Number(m[1].replaceAll(",", "")));
    });
  });
}

const tasks = [];
for (const scenario of SCENARIOS) {
  if (ONLY && !ONLY.includes(scenario.name)) continue;
  const opNames = ["mount", ...Object.keys((await import(
    pathToFileURL(writeModule(dir, `${scenario.name}.probe`, scenario.variants.baseline, "prod")).href
  )).make(1).ops)];
  for (const cell of cells(scenario)) {
    if (ONLY_CELLS && !ONLY_CELLS.includes(cell.label)) continue;
    const module = writeModule(
      dir,
      `${scenario.name}.${cell.variant}.${cell.runtime}`,
      scenario.variants[cell.variant],
      cell.runtime
    );
    for (const op of opNames) tasks.push({ scenario: scenario.name, cell: cell.label, op, module });
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < tasks.length) {
    const t = tasks[next++];
    const [a, b] = [await ir(t.module, t.op, OPS), await ir(t.module, t.op, 2 * OPS)];
    const perOp = Math.round((b - a) / OPS);
    results.push({ scenario: t.scenario, cell: t.cell, op: t.op, irPerOp: perOp });
    console.log(`${t.scenario.padEnd(6)} ${t.op.padEnd(10)} ${t.cell.padEnd(18)} ${perOp}`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));

const out = args.out ?? "documentation/plans/heuristic-oracles/icount.json";
mkdirSync(dirname(resolve(ROOT, out)), { recursive: true });
writeFileSync(
  resolve(ROOT, out),
  JSON.stringify(
    { n: N, ops: OPS, warmup: WARMUP, node: process.version, date: new Date().toISOString(), results },
    null,
    2
  ) + "\n"
);
console.log(`wrote ${out}`);
