#!/usr/bin/env node
// Markdown tables for Stack A from the two independent runs:
//   node scripts/heuristics/stack-a/report.mjs > tables.md
// Per cell: run 1, run 2 (each the median of 5 fresh pages), their mean.
// band(cell) = |run1 - run2| / mean + max(within-run spread) / 2, where the
// within-run spread is (max - min) / median over the 5 pages. A delta is
// flagged "(noise)" unless it exceeds the larger band of the two cells
// compared (the rule used by scripts/heuristics/report.mjs for DOM runs).
// A second, secondary flag (†) uses a trimmed within-run spread: the 5 pages
// sorted, (4th - 2nd) / median, i.e. one outlier page per cell dropped at
// each end. It is reported next to the strict flag, never instead of it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIR = join(ROOT, "documentation/plans/heuristic-oracles/stack-a");
const load = f => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const pct = d => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`;
const us = x => (x >= 100 ? x.toFixed(0) : x.toFixed(1));

function cells(suite) {
  const [a, b] = [load(`${suite}-1.json`), load(`${suite}-2.json`)];
  const m = new Map();
  for (const r of a.results) {
    const r2 = b.results.find(x => x.variant === r.variant && x.op === r.op);
    const mean = (r.usPerOp + r2.usPerOp) / 2;
    m.set(`${r.variant}|${r.op}`, {
      r1: r.usPerOp,
      r2: r2.usPerOp,
      mean,
      rr: Math.abs(r.usPerOp - r2.usPerOp) / mean,
      within: Math.max(r.spread, r2.spread) / 2,
      band: Math.abs(r.usPerOp - r2.usPerOp) / mean + Math.max(r.spread, r2.spread) / 2,
      tband: Math.abs(r.usPerOp - r2.usPerOp) / mean + Math.max(trim(r), trim(r2)) / 2,
      minBatchMs: Math.min(r.minBatchMs, r2.minBatchMs)
    });
  }
  const ops = [...new Set(a.results.map(r => r.op))];
  const variants = [...new Set(a.results.map(r => r.variant))];
  return { m, ops, variants, meta: [a, b] };
}

function trim(r) {
  const x = [...r.reps].sort((a, b) => a - b);
  return (x[3] - x[1]) / r.usPerOp;
}
function delta(m, v, ref, op) {
  const c = m.get(`${v}|${op}`), base = m.get(`${ref}|${op}`);
  const d = c.mean / base.mean - 1;
  const band = Math.max(c.band, base.band), tband = Math.max(c.tband, base.tband);
  return { d, band, real: Math.abs(d) > band, treal: Math.abs(d) > tband };
}
const flag = x => (x.real ? " ★" : x.treal ? " †" : "");

for (const suite of ["list", "rows"]) {
  const { m, ops, variants, meta } = cells(suite);
  console.log(`\n### ${suite} suite (µs/op, n = ${meta[0].n}; Chromium ${meta[0].chromium}; run 1 ${meta[0].date}, run 2 ${meta[1].date})\n`);
  for (const op of ops) {
    console.log(`\n#### ${op}\n`);
    console.log("| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |");
    console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |");
    for (const v of variants) {
      const c = m.get(`${v}|${op}`);
      const dd = v === "baseline" ? null : delta(m, v, "baseline", op);
      console.log(
        `| ${v} | ${us(c.r1)} | ${us(c.r2)} | ${us(c.mean)} | ±${(c.band * 100).toFixed(0)}% | ±${(c.tband * 100).toFixed(0)}% | ${dd ? pct(dd.d) : ""} | ${dd ? (dd.real ? "**real**" : "noise") : ""} | ${dd ? (dd.treal ? "real" : "noise") : ""} |`
      );
    }
  }
  // Compact summary: mean Δ vs baseline per op.
  console.log(`\n#### ${suite}: summary, mean Δ vs baseline (★ exceeds the strict band; † exceeds only the trimmed band)\n`);
  console.log(`| Variant | ${ops.join(" | ")} |`);
  console.log(`| --- | ${ops.map(() => "---:").join(" | ")} |`);
  for (const v of variants) {
    if (v === "baseline") {
      console.log(`| baseline (µs) | ${ops.map(op => us(m.get(`${v}|${op}`).mean)).join(" | ")} |`);
      continue;
    }
    console.log(`| ${v} | ${ops.map(op => { const x = delta(m, v, "baseline", op); return pct(x.d) + flag(x); }).join(" | ")} |`);
  }
  // Leave-one-out: cost of removing X from the stack, relative to STACK.
  console.log(`\n#### ${suite}: leave-one-out (STACK−X vs STACK; + means X was helping) (★ strict, † trimmed only)\n`);
  console.log(`| Removed | ${ops.join(" | ")} |`);
  console.log(`| --- | ${ops.map(() => "---:").join(" | ")} |`);
  for (const v of variants.filter(v => v.startsWith("STACK-") || v.startsWith("STACK+") || v.startsWith("STACK@"))) {
    console.log(`| ${v} | ${ops.map(op => { const x = delta(m, v, "STACK", op); return pct(x.d) + flag(x); }).join(" | ")} |`);
  }
  const minBatch = Math.min(...[...m.values()].map(c => c.minBatchMs));
  console.log(`\nSmallest timed batch in any sample: ${minBatch.toFixed(1)} ms.`);
}
