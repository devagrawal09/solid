#!/usr/bin/env node
// Wall-clock companion to icount.mjs / compare.mjs (a sanity check of the
// instruction counts, not a replacement: wall time on a shared machine is
// noisy — the spread column says how noisy).
//
//   node scripts/blocks-v2/bench.mjs [--runtimes baseline,current] [--scenarios a,b]
//        [--variants a,b] [--reps 5] [--n 100] [--samples 15]
//
// Every (runtime, cell) runs in a fresh node process per rep, in a shuffled
// order per rep; each process warms up (the icount warmup), then takes
// `samples` batches (forced GC between batches, never inside one) of `ops`
// ops. Reported: the median over reps of each process's median µs/op, and
// the spread (max/min of those per-process medians).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildModules, parseArgs, parseSpec } from "./build.mjs";
import { runtimePath, WARMUP } from "./measure.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const runtimes = (args.runtimes ?? "current").split(",");
const REPS = Number(args.reps ?? 5);
const N = Number(args.n ?? 100);
const SAMPLES = Number(args.samples ?? 15);
const OPS = { mount: 5, update: 50 };
const ONLY = args.variants ? args.variants.split(",") : Object.keys(VARIANTS);
const ONLY_SCENARIOS = args.scenarios ? args.scenarios.split(",") : SCENARIOS.map(s => s.name);

const cells = [];
for (const runtime of runtimes) {
  const spec = parseSpec(runtime);
  const modules = buildModules({
    runtime: runtimePath(spec.runtime),
    compiler: spec.compiler,
    only: ONLY,
    scenarios: ONLY_SCENARIOS,
    tag: "bench-" + runtime.replace(/\W+/g, "-")
  });
  for (const scenario of SCENARIOS) {
    if (!ONLY_SCENARIOS.includes(scenario.name)) continue;
    for (const mode of scenario.modes) {
      for (const variant of ONLY) {
        const module = modules[`${scenario.name}/${variant}`];
        if (module) cells.push({ runtime, scenario: scenario.name, mode, variant, module, runs: [] });
      }
    }
  }
}

let seed = 42;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
for (let rep = 0; rep < REPS; rep++) {
  const order = cells.map((c, i) => [random(), i]).sort((a, b) => a[0] - b[0]);
  for (const [, i] of order) {
    const cell = cells[i];
    const out = execFileSync(
      process.execPath,
      [
        "--expose-gc",
        join(here, "worker.mjs"),
        pathToFileURL(cell.module).href,
        cell.mode,
        String(N),
        String(WARMUP[cell.mode]),
        String(OPS[cell.mode]),
        String(SAMPLES)
      ],
      { encoding: "utf8" }
    );
    const samples = JSON.parse(out).sort((a, b) => a - b);
    cell.runs.push(samples[samples.length >> 1] / 1000);
  }
  process.stderr.write(`rep ${rep + 1}/${REPS}\n`);
}

const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
let md = `| cell (µs/op, n=${N}) | ${runtimes.join(" | ")} |\n| --- |${runtimes.map(() => " ---: |").join("")}\n`;
const keys = [...new Set(cells.map(c => `${c.scenario} ${c.mode} ${c.variant}`))];
for (const key of keys) {
  const cols = runtimes.map(rt => {
    const cell = cells.find(c => c.runtime === rt && `${c.scenario} ${c.mode} ${c.variant}` === key);
    if (!cell) return "–";
    const spread = Math.max(...cell.runs) / Math.min(...cell.runs);
    return `${median(cell.runs).toFixed(1)} (±${((spread - 1) * 50).toFixed(0)}%)`;
  });
  md += `| ${key} | ${cols.join(" | ")} |\n`;
}
process.stdout.write(md);
