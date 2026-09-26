#!/usr/bin/env node
// Markdown tables for the stack-B README from the raw JSON in
// documentation/plans/heuristic-oracles/stack-b/.
//
// Instruction counts: icount-run1.json and icount-run2.json are the two
// independent runs; icount-rerun-*.json (optional) hold extra runs of cells
// whose two runs disagreed. A delta is "(noise)" when |mean − ref mean| is
// not larger than the sum of the two cells' run-to-run spreads (max − min).
// A cell whose runs differ by > 1% is marked "bimodal?" and, when reruns
// exist, reported as its distribution.
//
// DOM: dom-<suite>-1.json and -2.json, same rule on the medians.
//
//   node scripts/heuristics/stack-b/report.mjs > /tmp/tables.md
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUT_DIR } from "./common.mjs";
import { SCENARIOS } from "./scenarios.mjs";

const load = f => JSON.parse(readFileSync(join(OUT_DIR, f), "utf8"));
const fmt = x => Math.round(x).toLocaleString("en-US");
const pct = x => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;

// Supplementary cells (scenario cells marked `extra`) are measured in their
// own pair of runs, icount-extra-1/2.json, merged into run 1 / run 2.
const runs = [1, 2]
  .filter(i => existsSync(join(OUT_DIR, `icount-run${i}.json`)))
  .map(i => {
    const r = load(`icount-run${i}.json`);
    for (const extra of [`icount-extra-${i}.json`, `icount-attr-${i}.json`, `icount-stack2-${i}.json`])
      if (existsSync(join(OUT_DIR, extra))) r.results = [...r.results, ...load(extra).results];
    return r;
  });
const reruns = readdirSync(OUT_DIR).filter(f => /^icount-rerun-.*\.json$/.test(f)).map(load);
const values = (scenario, cell, op) => {
  const main = runs.map(r => r.results.find(x => x.scenario === scenario && x.cell === cell && x.op === op)?.irPerOp);
  const extra = reruns.flatMap(r =>
    r.results.filter(x => x.scenario === scenario && x.cell === cell && x.op === op).map(x => x.irPerOp)
  );
  return { main, extra };
};
const stat = xs => {
  const v = xs.filter(x => x != null);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean, spread: Math.max(...v) - Math.min(...v), n: v.length, v };
};

function icountTable(scenario, cells, refOf, ops) {
  const lines = [];
  lines.push(`| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |`);
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: | --- |`);
  for (const op of ops)
    for (const cell of cells) {
      const { main, extra } = values(scenario, cell, op);
      if (main.every(x => x == null)) continue;
      const all = [...main, ...extra];
      const s = stat(all);
      const ref = refOf(cell);
      const r = stat([...values(scenario, ref, op).main, ...values(scenario, ref, op).extra]);
      const delta = cell === ref ? null : (s.mean - r.mean) / r.mean;
      const noise = cell !== ref && Math.abs(s.mean - r.mean) <= s.spread + r.spread;
      const disagree = stat(main).spread / stat(main).mean > 0.01;
      let flag = "";
      if (cell === ref) flag = "ref";
      else if (noise) flag = "(noise)";
      if (disagree) flag += (flag ? ", " : "") + (extra.length ? `bimodal: ${all.map(fmt).join(" / ")}` : "runs disagree >1%");
      lines.push(
        `| ${cell} | ${op} | ${fmt(main[0] ?? NaN)} | ${fmt(main[1] ?? NaN)} | ${fmt(s.mean)}${all.length > 2 ? ` (n=${all.length})` : ""} | ${delta == null ? "" : pct(delta)} | ${flag} |`
      );
    }
  return lines.join("\n");
}

const opsOf = name => [...new Set(runs.flatMap(r => r.results.filter(x => x.scenario === name).map(x => x.op)))];

for (const sc of SCENARIOS) {
  const labels = sc.cells.map(c => c.label);
  if (sc.name === "sel") {
    console.log(`\n#### sel (Q1) — instructions per op, n = 200, ref = memo@prod\n`);
    console.log(icountTable("sel", labels, () => "memo@prod", opsOf("sel")));
    continue;
  }
  console.log(`\n#### ${sc.name} (Q2) — ref = a@prod\n`);
  const attr = sc.cells.filter(c => c.extra).map(c => c.label);
  console.log(icountTable(sc.name, ["a@prod", "a@oracle", "b@oracle", ...attr, "c@oracle"], () => "a@prod", opsOf(sc.name)));
  console.log(`\n#### ${sc.name} (Q3) — ids cells vs a-ids@prod, others vs a@prod\n`);
  console.log(
    icountTable(
      sc.name,
      ["a@prod", "b@oracle", "b+H8b@oracle", "a-ids@prod", "b-ids@oracle", "b+H8b-ids@oracle"],
      c => (c.includes("ids") ? "a-ids@prod" : "a@prod"),
      opsOf(sc.name)
    )
  );
}

// ---- DOM ----
for (const suite of ["sel", "todos", "todos-memo"]) {
  const files = [1, 2].map(i => `dom-${suite}-${i}.json`).filter(f => existsSync(join(OUT_DIR, f)));
  if (!files.length) continue;
  const doms = files.map(load);
  console.log(`\n#### DOM ${suite} — µs per op, n = ${doms[0].n}, median of ${doms[0].reps} pages per run (${doms[0].chromium}, isolated=${doms[0].isolated})\n`);
  console.log(`| Variant | Op | run 1 | run 2 | mean | Δ vs baseline | flag |`);
  console.log(`| --- | --- | ---: | ---: | ---: | ---: | --- |`);
  const ops = [...new Set(doms[0].results.map(r => r.op))];
  const variants = [...new Set(doms[0].results.map(r => r.variant))];
  for (const op of ops)
    for (const v of variants) {
      const xs = doms.map(d => d.results.find(r => r.op === op && r.variant === v)?.usPerOp);
      const bs = doms.map(d => d.results.find(r => r.op === op && r.variant === "baseline")?.usPerOp);
      const s = stat(xs),
        b = stat(bs);
      const delta = v === "baseline" ? null : (s.mean - b.mean) / b.mean;
      const noise = v !== "baseline" && Math.abs(s.mean - b.mean) <= s.spread + b.spread;
      console.log(
        `| ${v} | ${op} | ${xs[0]?.toFixed(1)} | ${xs[1]?.toFixed(1) ?? ""} | ${s.mean.toFixed(1)} | ${delta == null ? "" : pct(delta)} | ${v === "baseline" ? "ref" : noise ? "(noise)" : ""} |`
      );
    }
}
