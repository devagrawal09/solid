#!/usr/bin/env node
// js-reactivity-benchmark (Tier 2, Node lane) for the heuristic oracles:
// this repo's @solidjs/signals builds side by side. Reads
// documentation/plans/heuristic-oracles/jsrb/solid-next-<build>-<round>.csv
// (jsrb's own output: fastest-of-N ms per test) and prints the median across
// rounds per (test, build), with the round-to-round spread and the delta
// against the matching reference:
//   h5  (prod + `statusFree` on every memo — the compiler's H5 fact) vs prod
//   r1b (runtime speculation, rspec bit 16)                          vs r0
//   r0  (rspec control, built like r1b with every bit off)           vs prod
//
//   node scripts/heuristics/jsrb/report.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../common.mjs";

const DIR = join(ROOT, "documentation/plans/heuristic-oracles/jsrb");
const data = {}; // build -> test -> [ms per round]
for (const f of readdirSync(DIR).filter(f => f.endsWith(".csv"))) {
  const [, build] = /^solid-next-(\w+)-\d+\.csv$/.exec(f) ?? [];
  if (!build) continue;
  for (const line of readFileSync(join(DIR, f), "utf8").split("\n")) {
    const cols = line.split(",").map(s => s.trim());
    if (cols.length !== 3 || cols[0] === "framework" || !cols[0].startsWith("solid-next")) continue;
    ((data[build] ??= {})[cols[1]] ??= []).push(Number(cols[2]));
  }
}
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const spread = xs => (Math.max(...xs) - Math.min(...xs)) / median(xs);
const tests = Object.keys(data.prod ?? {});
const pairs = [
  ["h5", "prod"],
  ["r1b", "r0"],
  ["r0", "prod"]
];
console.log(`| Test | prod ms | ${pairs.map(([a, b]) => `${a} vs ${b}`).join(" | ")} |`);
console.log(`| --- | ---: | ${pairs.map(() => "---:").join(" | ")} |`);
let wins = Object.fromEntries(pairs.map(p => [p.join("/"), { better: 0, worse: 0, noise: 0 }]));
for (const t of tests) {
  const cells = pairs.map(([a, b]) => {
    const x = data[a]?.[t], y = data[b]?.[t];
    if (!x || !y) return "–";
    const d = (median(x) - median(y)) / median(y);
    const band = spread(x) + spread(y);
    const w = wins[`${a}/${b}`];
    if (Math.abs(d) <= band) w.noise++;
    else d < 0 ? w.better++ : w.worse++;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%${Math.abs(d) <= band ? " (noise)" : ""}`;
  });
  console.log(`| ${t} | ${median(data.prod[t]).toFixed(1)} | ${cells.join(" | ")} |`);
}
console.log(`\nRounds per build: ${Object.entries(data).map(([b, ts]) => `${b} ${Object.values(ts)[0]?.length}`).join(", ")}.`);
for (const [k, w] of Object.entries(wins)) console.log(`${k}: ${w.better} faster, ${w.worse} slower, ${w.noise} within noise`);
