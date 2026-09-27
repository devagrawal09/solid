#!/usr/bin/env node
// Instruction counts per op of the same compiled cells against several
// signals runtimes (before/after a runtime change):
//
//   node scripts/blocks-v2/compare.mjs --runtimes baseline,r3,current
//        [--scenarios a,b] [--variants compiled,uncompiled] [--n 100] [--ops 20] [--jobs 2]
//
// Runtime names are snapshots written by `build-prod.mjs --snapshot <name>`
// (node_modules/.cache/blocks-v2/runtimes/<name>), or `current`
// (packages/signals/dist/prod). Each cell is two processes (ops, 2*ops).
import { buildModules, parseArgs } from "./build.mjs";
import { irPerOp, pool, runtimePath } from "./measure.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const args = parseArgs(process.argv.slice(2));
const runtimes = (args.runtimes ?? "current").split(",");
const N = Number(args.n ?? 100);
const OPS = Number(args.ops ?? 20);
const JOBS = Number(args.jobs ?? 2);
const ONLY = args.variants ? args.variants.split(",") : Object.keys(VARIANTS);
const ONLY_SCENARIOS = args.scenarios ? args.scenarios.split(",") : SCENARIOS.map(s => s.name);

const tasks = [];
const rows = [];
for (const scenario of SCENARIOS) {
  if (!ONLY_SCENARIOS.includes(scenario.name)) continue;
  for (const mode of scenario.modes) {
    for (const variant of ONLY) rows.push({ scenario: scenario.name, mode, variant, cells: {} });
  }
}
for (const runtime of runtimes) {
  const modules = buildModules({
    runtime: runtimePath(runtime),
    only: ONLY,
    scenarios: ONLY_SCENARIOS,
    tag: "compare-" + runtime.replace(/\W+/g, "-")
  });
  for (const row of rows) {
    tasks.push(async () => {
      const r = await irPerOp(modules[`${row.scenario}/${row.variant}`], row.mode, OPS, N);
      row.cells[runtime] = r.irPerOp;
      process.stderr.write(`${row.scenario}/${row.mode}/${row.variant} @${runtime}: ${Math.round(r.irPerOp)}\n`);
    });
  }
}
await pool(tasks, JOBS);

let md = `| cell (Ir/op, n=${N}) | ${runtimes.join(" | ")} |\n| --- |${runtimes.map(() => " ---: |").join("")}\n`;
for (const row of rows) {
  const base = row.cells[runtimes[0]];
  const cols = runtimes.map((rt, i) => {
    const v = row.cells[rt];
    const k = `${(v / 1000).toFixed(0)}k`;
    return i === 0 ? k : `${k} (${v >= base ? "+" : ""}${((100 * (v - base)) / base).toFixed(1)}%)`;
  });
  md += `| ${row.scenario} ${row.mode} ${row.variant} | ${cols.join(" | ")} |\n`;
}
process.stdout.write(md);
