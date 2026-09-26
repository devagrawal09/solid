#!/usr/bin/env node
// Markdown tables for documentation/plans/heuristic-oracles.md from the raw
// data in documentation/plans/heuristic-oracles/:
//
//   icount.json + icount-repeat.json  instructions/op, two independent runs
//   (icount-h5*.json: Track A's shipped options, same method).
//     Each cell reports the mean; the noise column is the run-to-run spread
//     |a − b| / mean, and a delta is only called out when it exceeds the
//     combined spread of the two cells compared.
//   dom-bench.json                    Chromium script time per op (median of reps).
//
//   node scripts/heuristics/report.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./common.mjs";

const DATA = join(ROOT, "documentation/plans/heuristic-oracles");
const load = f => (existsSync(join(DATA, f)) ? JSON.parse(readFileSync(join(DATA, f), "utf8")) : null);

for (const [firstFile, secondFile, title] of [
  ["icount.json", "icount-repeat.json", "oracles"],
  ["icount-h5.json", "icount-h5-repeat.json", "Track A options, re-measured"]
]) {
  const a = load(firstFile);
  const b = load(secondFile);
  if (!a) continue;
  console.log(`\n### ${title}`);
  const key = r => `${r.scenario}|${r.cell}|${r.op}`;
  const second = new Map((b?.results ?? []).map(r => [key(r), r.irPerOp]));
  const cells = new Map();
  for (const r of a.results) {
    const r2 = second.get(key(r));
    const mean = r2 === undefined ? r.irPerOp : (r.irPerOp + r2) / 2;
    const noise = r2 === undefined ? NaN : Math.abs(r.irPerOp - r2) / mean;
    cells.set(key(r), { mean, noise });
  }
  const scenarios = [...new Set(a.results.map(r => r.scenario))];
  for (const s of scenarios) {
    const ops = [...new Set(a.results.filter(r => r.scenario === s).map(r => r.op))];
    const labels = [...new Set(a.results.filter(r => r.scenario === s).map(r => r.cell))];
    console.log(`\n#### ${s} (instructions per op, n = ${a.n})\n`);
    console.log(`| Cell | ${ops.map(o => `${o} | Δ`).join(" | ")} |`);
    console.log(`| --- | ${ops.map(() => "---: | ---:").join(" | ")} |`);
    for (const l of labels) {
      const row = ops.map(o => {
        const c = cells.get(`${s}|${l}|${o}`);
        const base = cells.get(`${s}|baseline@prod|${o}`);
        if (!c) return "– | –";
        const d = (c.mean - base.mean) / base.mean;
        const band = (c.noise || 0) + (base.noise || 0);
        const delta = l === "baseline@prod" ? "" : `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%${Math.abs(d) <= band ? " (noise)" : ""}`;
        return `${Math.round(c.mean).toLocaleString("en-US")} | ${delta}`;
      });
      console.log(`| ${l} | ${row.join(" | ")} |`);
    }
    const noisy = ops.map(o => {
      const ns = labels.map(l => cells.get(`${s}|${l}|${o}`)?.noise).filter(x => x !== undefined && !Number.isNaN(x));
      return ns.length ? `${o} max ${(Math.max(...ns) * 100).toFixed(1)}%` : `${o} single run`;
    });
    console.log(`\nRun-to-run spread: ${noisy.join(", ")}.`);
  }
}

const dom = load("dom-bench.json");
if (dom) {
  console.log(`\n#### DOM rows in Chromium ${dom.chromium} (µs per op, n = ${dom.n}, median of ${dom.reps} pages)\n`);
  const ops = [...new Set(dom.results.map(r => r.op))];
  const variants = [...new Set(dom.results.map(r => r.variant))];
  console.log(`| Variant | ${ops.map(o => `${o} | Δ`).join(" | ")} |`);
  console.log(`| --- | ${ops.map(() => "---: | ---:").join(" | ")} |`);
  for (const v of variants) {
    const row = ops.map(o => {
      const c = dom.results.find(r => r.variant === v && r.op === o);
      const base = dom.results.find(r => r.variant === "baseline" && r.op === o);
      const d = (c.usPerOp - base.usPerOp) / base.usPerOp;
      const band = (c.spread + base.spread) / 2;
      const delta = v === "baseline" ? "" : `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)}%${Math.abs(d) <= band ? " (noise)" : ""}`;
      return `${c.usPerOp.toFixed(1)} | ${delta}`;
    });
    console.log(`| ${v} | ${row.join(" | ")} |`);
  }
}
