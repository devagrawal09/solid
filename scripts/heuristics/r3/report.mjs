#!/usr/bin/env node
// Markdown tables for "Round 3" in documentation/plans/heuristic-oracles.md.
// Two runs per cell: icount-1 + icount-2, except async-rows, whose H9 oracle
// gained its settle pass-through between runs 1 and 2 — its pair is
// icount-2 + icount-async-3; scenarios added after run 1 pair icount-2 +
// icount-3. Delta vs baseline@prod; "(noise)" when within
// the two cells' combined run-to-run spread.
//
//   node scripts/heuristics/r3/report.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../common.mjs";

const DATA = join(ROOT, "documentation/plans/heuristic-oracles/r3");
const load = f => (existsSync(join(DATA, f)) ? JSON.parse(readFileSync(join(DATA, f), "utf8")).results : []);
const r1 = load("icount-1.json"), r2 = load("icount-2.json"), r3 = load("icount-async-3.json");
const r3b = load("icount-3.json"); // scenarios added after run 1: runs 2 + 3
const pairs = s =>
  s === "async-rows" ? [r2, r3] : r1.some(r => r.scenario === s) ? [r1, r2] : [r2, r3b];
const scenarios = [...new Set(r2.map(r => r.scenario))];
for (const s of scenarios) {
  let [a, b] = pairs(s).map(rs => rs.filter(r => r.scenario === s));
  if (!a.length) [a, b] = [b, []]; // added after run 1: single run
  const cell = (l, o) => {
    const x = a.find(r => r.cell === l && r.op === o)?.irPerOp;
    const y = b.find(r => r.cell === l && r.op === o)?.irPerOp;
    if (x === undefined) return null;
    if (y === undefined) return { mean: x, noise: NaN };
    const mean = (x + y) / 2;
    return { mean, noise: Math.abs(x - y) / mean };
  };
  const ops = [...new Set(a.map(r => r.op))];
  const labels = [...new Set(a.map(r => r.cell))];
  console.log(`\n#### ${s} (instructions per op, n = 200)\n`);
  console.log(`| Cell | ${ops.map(o => `${o} | Δ`).join(" | ")} |`);
  console.log(`| --- | ${ops.map(() => "---: | ---:").join(" | ")} |`);
  for (const l of labels) {
    const row = ops.map(o => {
      const c = cell(l, o), base = cell("baseline@prod", o);
      if (!c) return "– | –";
      const d = (c.mean - base.mean) / base.mean;
      const band = (c.noise || 0) + (base.noise || 0);
      const delta = l === "baseline@prod" ? "" : `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%${Math.abs(d) <= band ? " (noise)" : ""}`;
      return `${Math.round(c.mean).toLocaleString("en-US")} | ${delta}`;
    });
    console.log(`| ${l} | ${row.join(" | ")} |`);
  }
  const spreads = labels.flatMap(l => ops.map(o => cell(l, o)?.noise)).filter(x => x !== undefined && !Number.isNaN(x));
  console.log(`\nRun-to-run spread: max ${spreads.length ? (Math.max(...spreads) * 100).toFixed(2) + "%" : "single run"}.`);
}
