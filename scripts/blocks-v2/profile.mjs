#!/usr/bin/env node
// Self-time profile of one cell (a diagnosis aid, not a measurement):
//   node scripts/blocks-v2/profile.mjs <scenario> <variant> [mode] [ops]
// Runs the worker under `--cpu-prof` and prints the top functions by self time.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildModules } from "./build.mjs";
import { runtimePath } from "./measure.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [scenario, variant, modeArg, opsArg] = process.argv.slice(2);
const mode = modeArg ?? SCENARIOS.find(s => s.name === scenario).modes[0];
// `BV2_RUNTIME=r6` profiles a saved runtime snapshot (see build-prod.mjs).
const modules = buildModules({
  scenarios: [scenario],
  only: [variant],
  tag: "profile",
  runtime: runtimePath(process.env.BV2_RUNTIME)
});
const dir = mkdtempSync(join(tmpdir(), "bv2-prof-"));
execFileSync(process.execPath, [
  "--cpu-prof",
  "--cpu-prof-dir",
  dir,
  "--cpu-prof-interval",
  "50",
  join(here, "worker.mjs"),
  pathToFileURL(modules[`${scenario}/${variant}`]).href,
  mode,
  "100",
  "50",
  opsArg ?? "400"
]);
const profile = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
rmSync(dir, { recursive: true, force: true });
const self = new Map();
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const counts = new Map();
for (const s of profile.samples) counts.set(s, (counts.get(s) ?? 0) + 1);
let total = 0;
for (const [id, c] of counts) {
  const n = byId.get(id);
  const f = n.callFrame;
  const key = `${f.functionName || "(anon)"} ${f.url.split("/").slice(-2).join("/")}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + c);
  total += c;
}
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
for (const [k, c] of top) console.log(`${((100 * c) / total).toFixed(1).padStart(5)}%  ${k}`);
