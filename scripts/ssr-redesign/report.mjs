#!/usr/bin/env node
// Markdown tables for documentation/plans/ssr-hydration-redesign.md from the
// JSON the measurement scripts write (mean of the runs given).
//
//   node scripts/ssr-redesign/report.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const dir = join(ROOT, "documentation/plans/ssr-hydration-redesign");
const load = f => JSON.parse(readFileSync(join(dir, f), "utf8"));
const runs = ["results-1.json", "results-2.json"].filter(f => existsSync(join(dir, f))).map(load);
const kb = n => (n / 1024).toFixed(1);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const f1 = n => (Number.isFinite(n) ? n.toFixed(1) : "–");

for (const app of Object.keys(runs[0].apps)) {
  const variants = Object.keys(runs[0].apps[app].variants);
  const v0 = name => runs[0].apps[app].variants[name];
  console.log(`\n### ${app}: bytes and work (identical across runs)\n`);
  console.log("| Variant | HTML gz | of which data | of which `_hk` | JS gz at load | lazy JS gz | signals / solid / web / app (min KB) | owners | computations | claims | trace re-runs | gate |");
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |");
  for (const v of variants) {
    const r = v0(v);
    const g = r.js.groups;
    const c = r.counts || {};
    const gate = v === "A" ? "reference" : r.bytesOnly || !r.gate ? "–" : r.gate.equalToA === true ? `pass${r.gate.identity === true || r.gate.identity === "11" ? ", nodes kept" : ""}` : String(r.gate.equalToA);
    console.log(
      `| ${v} | ${r.html ? kb(r.html.gzip) : "–"} | ${r.html ? kb(r.html.data.gzip) : "–"} | ${r.html ? kb(r.html.hk.gzip) : "–"} | ${kb(r.js.gzip)} | ${r.js.lazy?.gzip ? kb(r.js.lazy.gzip) : "–"} | ${[g.signals, g.solid, g.web, g.app].map(kb).join(" / ")} | ${c.owner ?? "–"} | ${c.computed ?? "–"} | ${c.claim ?? "–"} | ${c.traceRerun ?? 0} | ${gate} |`
    );
  }
  for (const cpu of runs[0].cpus) {
    console.log(`\n### ${app}: time at CPU ${cpu}x (ms; median of ${runs[0].reps} loads per run, mean of ${runs.length} runs; ssr = server render, median of 5)\n`);
    console.log("| Variant | ready (from navigation) | hydrate() / activation | script at load | heap KB | first interaction | script through first interaction | ssr wall | ssr CPU |");
    console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const v of variants) {
      const rs = runs.map(r => r.apps[app].variants[v]).filter(r => r && r.timing);
      if (!rs.length) continue;
      const m = k => mean(rs.map(r => r.timing[cpu][k]));
      console.log(
        `| ${v} | ${f1(m("readyAt"))} | ${f1(m("hydrateMs"))} | ${f1(m("scriptMs"))} | ${m("heapKB").toFixed(0)} | ${f1(m("firstMs"))} | ${f1(m("scriptTotalMs"))} | ${f1(mean(rs.map(r => r.ssrMs)))} | ${f1(mean(rs.map(r => r.ssrCpuMs)))} |`
      );
    }
    // run-to-run spread on the main number
    const spread = variants
      .map(v => {
        const xs = runs.map(r => r.apps[app].variants[v]?.timing?.[cpu]?.scriptMs).filter(Number.isFinite);
        return xs.length > 1 ? Math.abs(xs[0] - xs[1]) / mean(xs) : 0;
      })
      .reduce((a, b) => Math.max(a, b), 0);
    console.log(`\nMax run-to-run spread of "script at load": ${(spread * 100).toFixed(0)}%.`);
  }
}

if (existsSync(join(dir, "twins-1.json"))) {
  const t = load("twins-1.json");
  console.log(`\n### Real twins (vite production builds, their own servers; median of ${t.reps} loads)\n`);
  console.log("| Twin | HTML gz | data gz | `_hk` gz | JS gz | CPU | hydrated at | script | heap KB | first toggle | dead toggles | failed loads |");
  console.log("| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [name, r] of Object.entries(t.twins))
    for (const [cpu, x] of Object.entries(r.timing))
      console.log(
        `| ${name} | ${kb(r.html.gzip)} | ${kb(r.html.data.gzip)} | ${kb(r.html.hk.gzip)} | ${kb(r.js.gzip)} | ${cpu}x | ${f1(x.hydratedAt)} | ${f1(x.scriptMs)} | ${x.heapKB.toFixed(0)} | ${f1(x.firstMs)} | ${x.deadLoads}/${t.reps} | ${x.loadsWithoutThread ?? 0}/${t.reps} |`
      );
}

const benches = ["ssr-bench-1.json", "ssr-bench-2.json"].filter(f => existsSync(join(dir, f))).map(load);
if (benches.length) {
  console.log(`\n### Server render of the HN story page (ms per render; median of ${benches[0].iters}; ${benches.length} runs)\n`);
  console.log("| Strategy | run 1 | run 2 | raw KB | gz KB |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const k of Object.keys(benches[0].results))
    console.log(`| ${k} | ${benches.map(b => b.results[k].ms.toFixed(2)).join(" | ")} | ${kb(benches[0].results[k].bytes)} | ${kb(benches[0].results[k].gzip)} |`);
}
