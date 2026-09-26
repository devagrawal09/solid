#!/usr/bin/env node
// R1 at signal level: the baseline programs of rows / chain / todos on the
// speculative status-free runtime (signals-r1) against prod, next to Track
// A's compiler-emitted `statusFree` option (H5-statusFree@prod). Same method as
// ../icount.mjs (cachegrind, (ops, 2·ops) differencing, steady-state warmups).
//
//   node scripts/heuristics/rspec/icount.mjs [--jobs 4] --out <file>
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, ROOT } from "../common.mjs";
import { SCENARIOS } from "../scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 200);
const OPS = Number(args.ops ?? 40);
const JOBS = Number(args.jobs ?? 4);
const WARMUP = { mount: 300, update: 2000 };
const dir = join(ROOT, "node_modules/.cache/heuristics/rspec/icount");

// Snapshot the runtimes this run measures (per process).
const snap = join(ROOT, "node_modules/.cache/heuristics/rspec/snap", String(process.pid));
rmSync(snap, { recursive: true, force: true });
cpSync(join(ROOT, "packages/signals/dist/prod"), join(snap, "prod"), { recursive: true });
cpSync(join(ROOT, "node_modules/.cache/heuristics/rspec/signals-r1"), join(snap, "r1"), { recursive: true });
const RUNTIME = { prod: join(snap, "prod/index.js"), r1: join(snap, "r1/index.js") };

function write(name, source, runtime) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, source.replaceAll('"@solidjs/signals"', JSON.stringify(pathToFileURL(RUNTIME[runtime]).href)));
  return file;
}

function ir(module, op, ops) {
  return new Promise((res, rej) => {
    const child = spawn("valgrind", [
      "--tool=cachegrind",
      "--cache-sim=no",
      "--cachegrind-out-file=/dev/null",
      process.execPath,
      "--predictable",
      "--single-threaded",
      join(here, "../icount-worker.mjs"),
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
      m ? res(Number(m[1].replaceAll(",", ""))) : rej(new Error(err.slice(-2000)));
    });
  });
}

const tasks = [];
for (const s of SCENARIOS.filter(s => ["rows", "chain", "todos"].includes(s.name))) {
  const cells = [
    ["baseline@prod", s.variants.baseline, "prod"],
    ["R1@r1", s.variants.baseline, "r1"]
  ];
  if (s.variants["H5-statusFree"]) cells.push(["H5-statusFree@prod", s.variants["H5-statusFree"], "prod"]);
  const probe = await import(pathToFileURL(write(`${s.name}.probe`, s.variants.baseline, "prod")).href);
  const ops = ["mount", ...Object.keys(probe.make(1).ops)];
  for (const [label, source, runtime] of cells) {
    const module = write(`${s.name}.${label.replace(/\W/g, "_")}`, source, runtime);
    for (const op of ops) tasks.push({ scenario: s.name, cell: label, op, module });
  }
}

const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: JOBS }, async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      const a = await ir(t.module, t.op, OPS);
      const b = await ir(t.module, t.op, 2 * OPS);
      const irPerOp = Math.round((b - a) / OPS);
      results.push({ scenario: t.scenario, cell: t.cell, op: t.op, irPerOp });
      console.log(`${t.scenario.padEnd(6)} ${t.op.padEnd(10)} ${t.cell.padEnd(20)} ${irPerOp}`);
    }
  })
);
const out = args.out ?? "documentation/plans/heuristic-oracles/rspec/icount.json";
mkdirSync(dirname(resolve(ROOT, out)), { recursive: true });
writeFileSync(
  resolve(ROOT, out),
  JSON.stringify({ n: N, ops: OPS, warmup: WARMUP, node: process.version, results }, null, 2) + "\n"
);
console.log(`wrote ${out}`);
