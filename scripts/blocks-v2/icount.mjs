#!/usr/bin/env node
// Instruction counts per operation for the blocks-v2 scenarios (the Track A
// methodology, scripts/track-a/icount.mjs): each cell runs twice under
// `valgrind --tool=cachegrind --cache-sim=no` with the same warmup and
// `ops` vs `2*ops` operations; (twice - once) / ops is instructions per
// operation with startup, module loading and warmup cancelled out. Node runs
// `--predictable --single-threaded` (deterministic JIT tiering and GC).
//
//   node scripts/blocks-v2/icount.mjs [--n 100] [--ops 20] [--variants a,b]
//        [--scenarios a,b] [--runtime packages/signals/dist/prod] [--out f.json]
//        [--jobs 3]
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "../track-a/compile.mjs";
import { buildModules, parseArgs } from "./build.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 100);
const OPS = Number(args.ops ?? 20);
const JOBS = Number(args.jobs ?? 3);
const WARMUP = { mount: 20, update: 60 };
const ONLY = args.variants ? args.variants.split(",") : null;
const ONLY_SCENARIOS = args.scenarios ? args.scenarios.split(",") : null;
const modules = buildModules({
  runtime: args.runtime,
  only: ONLY,
  scenarios: ONLY_SCENARIOS,
  tag: "icount-" + (args.runtime ?? "prod").replace(/\W+/g, "-")
});

function ir(module, mode, ops) {
  return new Promise((resolve, reject) => {
    const child = spawn("valgrind", [
      "--tool=cachegrind",
      "--cache-sim=no",
      "--cachegrind-out-file=/dev/null",
      process.execPath,
      "--predictable",
      "--single-threaded",
      join(here, "worker.mjs"),
      pathToFileURL(module).href,
      mode,
      String(N),
      String(WARMUP[mode]),
      String(ops)
    ]);
    let stderr = "";
    child.stderr.on("data", d => (stderr += d));
    child.on("close", () => {
      const match = /I\s+refs:\s+([\d,]+)/.exec(stderr);
      if (!match) reject(new Error(`no instruction count:\n${stderr.slice(-2000)}`));
      else resolve(Number(match[1].replaceAll(",", "")));
    });
  });
}

const cells = [];
for (const scenario of SCENARIOS) {
  if (ONLY_SCENARIOS && !ONLY_SCENARIOS.includes(scenario.name)) continue;
  for (const mode of scenario.modes) {
    for (const variant of Object.keys(VARIANTS)) {
      if (ONLY && !ONLY.includes(variant)) continue;
      cells.push({ scenario: scenario.name, mode, variant });
    }
  }
}

const results = {};
let next = 0;
async function worker() {
  while (next < cells.length) {
    const cell = cells[next++];
    const module = modules[`${cell.scenario}/${cell.variant}`];
    const [once, twice] = await Promise.all([ir(module, cell.mode, OPS), ir(module, cell.mode, 2 * OPS)]);
    const key = `${cell.scenario}/${cell.mode}/${cell.variant}`;
    results[key] = { irPerOp: (twice - once) / OPS, irOnce: once, irTwice: twice };
    process.stderr.write(`${key}: ${Math.round((twice - once) / OPS)} Ir/op\n`);
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.floor(JOBS / 2)) }, worker));

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
    runtime: args.runtime ?? "packages/signals/dist/prod",
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
