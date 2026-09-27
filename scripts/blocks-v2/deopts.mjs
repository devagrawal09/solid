#!/usr/bin/env node
// Deoptimization summary of one cell (a diagnosis aid):
//   node scripts/blocks-v2/deopts.mjs <scenario> <variant> [--runtime path/index.js] [--mode update]
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildModules, parseArgs } from "./build.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [scenario, variant, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const mode = args.mode ?? SCENARIOS.find(s => s.name === scenario).modes[0];
const modules = buildModules({
  runtime: args.runtime,
  scenarios: [scenario],
  only: [variant],
  tag: "deopts"
});
const r = spawnSync(
  process.execPath,
  [
    "--predictable",
    "--single-threaded",
    "--trace-deopt",
    ...(args.opt ? ["--trace-opt"] : []),
    join(here, "worker.mjs"),
    pathToFileURL(modules[`${scenario}/${variant}`]).href,
    mode,
    "100",
    "60",
    "40"
  ],
  { encoding: "utf8", maxBuffer: 1 << 28 }
);
if (r.status !== 0) console.log(r.stderr.slice(-2000));
console.log("optimized:", (r.stdout + r.stderr).split("completed").length - 1, "bailouts:", (r.stdout + r.stderr).split("bailout").length - 1, "stdout bytes:", r.stdout.length);
const counts = new Map();
for (const line of (r.stdout + r.stderr).split("\n")) {
  const m = /bailout \(kind: ([^,]+), reason: ([^)]*)\): begin\. deoptimizing[^<]*<JSFunction ([^ >]+)/.exec(line);
  if (m) {
    const key = `${m[3]}  [${m[1]}] ${m[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}
if (args.opt) for (const l of (r.stdout + r.stderr).split("\n")) if (l.includes("completed")) console.log(l.replace(/0x[0-9a-f]+ /g, "").slice(0, 150));
for (const [k, c] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(c).padStart(4), k);
