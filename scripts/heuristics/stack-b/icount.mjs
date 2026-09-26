#!/usr/bin/env node
// Instructions per op for stack-B cells (method of ../icount.mjs): per
// (scenario, cell, op) two cachegrind runs with identical warmup and `ops`
// vs `2·ops` measured ops; (Ir(2·ops) − Ir(ops)) / ops. Node runs
// `--predictable --single-threaded`. One invocation = one run; run it twice
// (different --out) for the run-to-run spread.
//
//   taskset -c 2,3 node scripts/heuristics/stack-b/icount.mjs --out icount-1.json
//        [--n 200] [--ops 40] [--jobs 2] [--scenarios sel,rows] [--cells a@prod,...] [--only-ops mount,select]
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CACHE, OUT_DIR, parseArgs, snapshotRuntimes, writeModule } from "./common.mjs";
import { SCENARIOS } from "./scenarios.mjs";

snapshotRuntimes();
const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 200);
const OPS = Number(args.ops ?? 40);
const JOBS = Math.min(2, Number(args.jobs ?? 2));
const WARMUP = { mount: Number(args.warmupMount ?? 300), update: Number(args.warmupUpdate ?? 2000) };
const ONLY = args.scenarios ? args.scenarios.split(",") : null;
const ONLY_CELLS = args.cells ? args.cells.split(",") : null;
const ONLY_OPS = args["only-ops"] ? args["only-ops"].split(",") : null;
const dir = join(CACHE, "icount", String(process.pid));

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
  const probe = await import(
    pathToFileURL(writeModule(dir, `${scenario.name}.probe`, scenario.cells[0].source, "prod")).href
  );
  const opNames = ["mount", ...Object.keys(probe.make(1).ops)].filter(o => !ONLY_OPS || ONLY_OPS.includes(o));
  for (const cell of scenario.cells) {
    if (ONLY_CELLS ? !ONLY_CELLS.includes(cell.label) : cell.extra) continue;
    const module = writeModule(dir, `${scenario.name}.${cell.label.replace(/[^\w.+-]/g, "_")}`, cell.source, cell.runtime);
    for (const op of opNames) tasks.push({ scenario: scenario.name, cell: cell.label, op, module });
  }
}
console.log(`${tasks.length} tasks, ${JOBS} jobs`);

const results = [];
let next = 0;
const t0 = Date.now();
async function worker() {
  while (next < tasks.length) {
    const t = tasks[next++];
    const [a, b] = [await ir(t.module, t.op, OPS), await ir(t.module, t.op, 2 * OPS)];
    const perOp = Math.round((b - a) / OPS);
    results.push({ scenario: t.scenario, cell: t.cell, op: t.op, irPerOp: perOp });
    console.log(
      `${String(results.length).padStart(4)}/${tasks.length} ${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s ` +
        `${t.scenario.padEnd(6)} ${t.op.padEnd(10)} ${t.cell.padEnd(22)} ${perOp}`
    );
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));

const out = join(OUT_DIR, args.out ?? "icount.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    { n: N, ops: OPS, warmup: WARMUP, node: process.version, date: new Date().toISOString(), results },
    null,
    2
  ) + "\n"
);
console.log(`wrote ${out}`);
