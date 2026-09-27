#!/usr/bin/env node
// Instruction counts per operation for the blocks-v2 scenarios, one runtime,
// with ratios to the handwritten program (the Track A methodology,
// scripts/track-a/icount.mjs; see measure.mjs). To compare runtimes or
// compilers side by side use compare.mjs.
//
//   node scripts/blocks-v2/icount.mjs [--n 100] [--ops 50] [--variants a,b]
//        [--scenarios a,b] [--runtime <snapshot name or index.js>] [--out f.json]
//        [--jobs 4]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../track-a/compile.mjs";
import { buildModules, parseArgs } from "./build.mjs";
import { irPerOp, pool, runtimePath, WARMUP } from "./measure.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 100);
const OPS = Number(args.ops ?? 50);
const JOBS = Number(args.jobs ?? 4);
const ONLY = args.variants ? args.variants.split(",") : null;
const ONLY_SCENARIOS = args.scenarios ? args.scenarios.split(",") : null;
const runtime = runtimePath(args.runtime);
const modules = buildModules({
  runtime,
  only: ONLY,
  scenarios: ONLY_SCENARIOS,
  tag: "icount-" + (args.runtime ?? "prod").replace(/\W+/g, "-")
});

const cells = [];
for (const scenario of SCENARIOS) {
  if (ONLY_SCENARIOS && !ONLY_SCENARIOS.includes(scenario.name)) continue;
  for (const mode of scenario.modes) {
    for (const variant of Object.keys(VARIANTS)) {
      if (ONLY && !ONLY.includes(variant)) continue;
      if (!modules[`${scenario.name}/${variant}`]) continue;
      cells.push({ scenario: scenario.name, mode, variant });
    }
  }
}

const results = {};
await pool(
  cells.map(cell => async () => {
    const key = `${cell.scenario}/${cell.mode}/${cell.variant}`;
    results[key] = await irPerOp(modules[`${cell.scenario}/${cell.variant}`], cell.mode, OPS, N);
    process.stderr.write(`${key}: ${Math.round(results[key].irPerOp)} Ir/op\n`);
  }),
  Math.max(1, Math.floor(JOBS / 2))
);

const variants = Object.keys(VARIANTS).filter(v => !ONLY || ONLY.includes(v));
let md = `| scenario (per op, n=${N}) | ${variants.join(" | ")} |\n| --- |${variants.map(() => " ---: |").join("")}\n`;
for (const scenario of SCENARIOS) {
  for (const mode of scenario.modes) {
    const base = results[`${scenario.name}/${mode}/handwritten`];
    const row = variants.map(variant => {
      const r = results[`${scenario.name}/${mode}/${variant}`];
      if (!r) return "–";
      const k = `${(r.irPerOp / 1000).toFixed(0)}k`;
      if (!base || variant === "handwritten") return k;
      return `${k} (${(r.irPerOp / base.irPerOp).toFixed(2)}×)`;
    });
    if (row.every(c => c === "–")) continue;
    md += `| ${scenario.name} (${mode}) | ${row.join(" | ")} |\n`;
  }
}

const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const result = {
  env: {
    date: new Date().toISOString(),
    commit: sha,
    node: process.version,
    nodeFlags: "--predictable --single-threaded",
    runtime: runtime ?? "packages/signals/dist/prod",
    n: N,
    ops: OPS,
    warmup: WARMUP
  },
  results
};
const outFile = args.out ?? join(ROOT, "node_modules/.cache/blocks-v2/icount.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result.env)}\n\n${md}\nraw data: ${outFile}\n`);
