#!/usr/bin/env node
// Instruction counts per op, one column per (runtime spec, variant)
// (documentation/plans/vs-upstream-v2.md). A thin wrapper over the
// scripts/blocks-v2 harness (same modules, same worker, same valgrind
// Ir/op = (run(2*ops) - run(ops)) / ops) that lets columns differ in variant
// as well as runtime, e.g. upstream handwritten vs branch compiled v2:
//
//   node scripts/vs-upstream/compare.mjs \
//     --cols upstream+upstream-compiler:handwritten,branch:handwritten,branch:compiled \
//     [--scenarios a,b] [--n 300] [--ops 20] [--jobs 2]
//
// Runtime specs are blocks-v2 snapshot names (build-prod.mjs --snapshot, or
// scripts/vs-upstream/snapshot-upstream.mjs), optionally `+<saved compiler>`.
// Compiled output is post-processed in one place: a tree whose compiler
// emits delegated handlers as `el._$$click = h` (upstream rc.9) is rewritten
// to the fake web's `el.$$click = h` slot (the same single property store),
// so the fake web registers the handler.
import { readFileSync, writeFileSync } from "node:fs";
import { buildModules, parseArgs, parseSpec } from "../blocks-v2/build.mjs";
import { irPerOp, pool, runtimePath } from "../blocks-v2/measure.mjs";
import { SCENARIOS, VARIANTS } from "../blocks-v2/scenarios.mjs";

const args = parseArgs(process.argv.slice(2));
const cols = args.cols.split(",").map(c => {
  const [spec, variant] = c.split(":");
  return { label: c, spec, variant };
});
const N = Number(args.n ?? 100);
const OPS = Number(args.ops ?? 20);
const JOBS = Number(args.jobs ?? 2);
const ONLY_SCENARIOS = args.scenarios ? args.scenarios.split(",") : SCENARIOS.map(s => s.name);

const rows = [];
for (const scenario of SCENARIOS) {
  if (!ONLY_SCENARIOS.includes(scenario.name)) continue;
  for (const mode of scenario.modes) rows.push({ scenario, mode, cells: {} });
}
const tasks = [];
const bySpec = {};
for (const c of cols) (bySpec[c.spec] ??= new Set()).add(c.variant);
const modules = {};
for (const [s, variants] of Object.entries(bySpec)) {
  const spec = parseSpec(s);
  const built = buildModules({
    runtime: runtimePath(spec.runtime),
    compiler: spec.compiler,
    only: [...variants],
    scenarios: ONLY_SCENARIOS,
    tag: "vsu-" + s.replace(/\W+/g, "-")
  });
  for (const [k, file] of Object.entries(built)) {
    const code = readFileSync(file, "utf8");
    const fixed = code.replace(/\._\$\$(\w+) = /g, ".$$$$$1 = ");
    if (fixed !== code) writeFileSync(file, fixed);
    modules[`${s}|${k}`] = file;
  }
}
for (const row of rows) {
  for (const c of cols) {
    const file = modules[`${c.spec}|${row.scenario.name}/${c.variant}`];
    if (!file) continue;
    tasks.push(async () => {
      try {
        const r = await irPerOp(file, row.mode, OPS, N);
        row.cells[c.label] = r.irPerOp;
      } catch (e) {
        row.cells[c.label] = NaN;
      }
      process.stderr.write(`${row.scenario.name}/${row.mode} @${c.label}: ${Math.round(row.cells[c.label])}\n`);
    });
  }
}
await pool(tasks, JOBS);

let md = `| cell (Ir/op, n=${N}) | ${cols.map(c => c.label).join(" | ")} |\n| --- |${cols.map(() => " ---: |").join("")}\n`;
for (const row of rows) {
  const base = row.cells[cols[0].label];
  const out = cols.map((c, i) => {
    const v = row.cells[c.label];
    if (v === undefined) return "–";
    if (!(v > 0)) return "n/a";
    const k = `${(v / 1000).toFixed(0)}k`;
    return i === 0 || !(base > 0) ? k : `${k} (${v >= base ? "+" : ""}${((100 * (v - base)) / base).toFixed(1)}%)`;
  });
  md += `| ${row.scenario.name} ${row.mode} | ${out.join(" | ")} |\n`;
}
process.stdout.write(md);
