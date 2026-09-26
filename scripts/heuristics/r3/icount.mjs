#!/usr/bin/env node
// Instructions per op for the round 3 scenarios (./scenarios.mjs). Same method
// as ../icount.mjs: cachegrind, (ops, 2·ops) differencing, --predictable
// --single-threaded, steady-state warmups (mount 300, update 2000).
//
//   node scripts/heuristics/r3/icount.mjs [--n 200] [--ops 40] [--jobs 2]
//        [--scenarios async-rows,...] --out documentation/plans/heuristic-oracles/r3/icount-1.json
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, ROOT, snapshotRuntimes, writeModule } from "../common.mjs";
import { SCENARIOS3 } from "./scenarios.mjs";

snapshotRuntimes();
const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 200);
const OPS = Number(args.ops ?? 40);
const JOBS = Number(args.jobs ?? 2);
const WARMUP = { mount: 300, update: 2000 };
const ONLY = args.scenarios ? args.scenarios.split(",") : null;
const dir = join(ROOT, "node_modules/.cache/heuristics/r3/icount");

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
for (const s of SCENARIOS3.filter(s => !ONLY || ONLY.includes(s.name)))
  for (const c of s.cells) {
    const module = writeModule(dir, `${s.name}.${c.label.replace(/\W/g, "_")}`, c.source, c.runtime);
    for (const op of s.ops) tasks.push({ scenario: s.name, cell: c.label, op, module });
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
      console.log(`${t.scenario.padEnd(12)} ${t.op.padEnd(10)} ${t.cell.padEnd(24)} ${irPerOp}`);
    }
  })
);
const out = resolve(ROOT, args.out ?? "documentation/plans/heuristic-oracles/r3/icount-1.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ n: N, ops: OPS, warmup: WARMUP, node: process.version, results }, null, 2) + "\n");
console.log(`wrote ${out}`);
