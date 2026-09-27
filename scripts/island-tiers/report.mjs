#!/usr/bin/env node
// Markdown tables for documentation/plans/island-runtime-tiers.md from the
// measure.mjs JSON (mean of the runs present).
//
//   node scripts/island-tiers/report.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../ssr-redesign/lib.mjs";

const dir = join(ROOT, "documentation/plans/island-runtime-tiers");
const runs = ["results-1.json", "results-2.json"].filter(f => existsSync(join(dir, f))).map(f => JSON.parse(readFileSync(join(dir, f), "utf8")));
const kb = n => (n / 1024).toFixed(1);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const f1 = n => (Number.isFinite(n) ? n.toFixed(1) : "–");

const LABEL = {
  A: "today: hydrate",
  "A-lazy": "today: hydrate on first interaction",
  "P1-eager": "tier 2 (core), eager",
  "P1-lazy": "tier 2 (core), lazy",
  "T2-eager": "tier 2 (core), eager",
  "T2-lazy": "tier 2 (core), lazy",
  "T1-eager": "tier 1 (kernel), eager",
  "T1-lazy": "tier 1 (kernel), lazy",
  "T0-eager": "tier 0 (no runtime), eager",
  "T0-lazy": "tier 0 (no runtime), lazy",
  "T0*-eager": "T0* (hand-written, outside the rule), eager"
};

for (const app of Object.keys(runs[0].apps)) {
  const variants = Object.keys(runs[0].apps[app].variants);
  const v0 = name => runs[0].apps[app].variants[name];
  console.log(`\n### ${app}: bytes (identical across runs)\n`);
  console.log("| Variant | | HTML gz | JS gz at load | + JS gz on first interaction | runtime min KB (signals group) | gate |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const v of variants) {
    const r = v0(v);
    const gate = v === "A" ? "reference" : !r.gate ? "–" : r.gate.equalToA === true ? `pass${r.gate.identity === true || r.gate.identity === "11" ? ", nodes kept" : ""}` : String(r.gate.equalToA);
    const signals = r.js.groups.signals + (r.js.lazy?.groups?.signals || 0);
    console.log(`| ${v} | ${LABEL[v] || ""} | ${kb(r.html.gzip)} | ${kb(r.js.gzip)} | ${r.js.lazy?.gzip ? kb(r.js.lazy.gzip) : "–"} | ${kb(signals)} | ${gate} |`);
  }
  console.log(`\n### ${app}: time (ms; median of ${runs[0].reps} fresh loads per run, mean of ${runs.length} runs)\n`);
  console.log("| Variant | script at load 1× | 4× | activation 4× | heap KB | first interaction 1× | 4× | script through first interaction 1× | 4× | ready 4× |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const v of variants) {
    const rs = runs.map(r => r.apps[app].variants[v]).filter(r => r && r.timing);
    if (!rs.length) continue;
    const m = (cpu, k) => mean(rs.map(r => r.timing[cpu][k]));
    console.log(
      `| ${v} | ${f1(m(1, "scriptMs"))} | ${f1(m(4, "scriptMs"))} | ${f1(m(4, "hydrateMs"))} | ${m(1, "heapKB").toFixed(0)} | ${f1(m(1, "firstMs"))} | ${f1(m(4, "firstMs"))} | ${f1(m(1, "scriptTotalMs"))} | ${f1(m(4, "scriptTotalMs"))} | ${f1(m(4, "readyAt"))} |`
    );
  }
  for (const cpu of runs[0].cpus) {
    const spread = variants
      .map(v => {
        const xs = runs.map(r => r.apps[app].variants[v]?.timing?.[cpu]?.scriptMs).filter(Number.isFinite);
        return xs.length > 1 ? Math.abs(xs[0] - xs[1]) / mean(xs) : 0;
      })
      .reduce((a, b) => Math.max(a, b), 0);
    console.log(`\nMax run-to-run spread of script at load, ${cpu}×: ${(spread * 100).toFixed(0)}%.`);
  }
}
