#!/usr/bin/env node
// Tables and the network model for documentation/plans/resumability.md, from
// documentation/plans/resumability/results-{1,2}.json (bench.mjs).
//
// Measured (Chromium, fresh context per load, mean of two runs of 7-load
// medians):
//   load   = bundle compile+eval (isolated probe) + __init (work before the
//            page responds: hydration for A/D, a listener for the lazy ones)
//   first  = the first interaction (select): lazy hydration / resume + handler
//   rest   = the other 6 interactions of the session
// Bytes: page HTML (markup + payload) and JS bundle, gzip.
//
// Model: per network profile, with the profile's CPU throttle —
//   ready  = RTT + (HTML + eager JS) / bandwidth + load
//   click  = first (+ RTT + JS / bandwidth when that JS is deferred to the
//            first interaction, the lazy strategies' "deferred" mode)
// and the break-even bandwidth at which C's extra bytes cost exactly the CPU it
// saves against F and against D.
//
//   node scripts/heuristics/resume/report.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../common.mjs";

const DIR = join(ROOT, "documentation/plans/resumability");
// results-{i}.json, with any results-{i}-<strategy>.json re-run (--only)
// replacing or adding that one strategy's rows (the suffix is the strategy
// name, lower case, without dashes: fcsr → F-csr, flinked → F-linked; the
// other strategies a re-run timed alongside for comparison are not merged).
const load = f => JSON.parse(readFileSync(join(DIR, f), "utf8"));
const flat = s => s.toLowerCase().replace(/-/g, "");
const runs = [1, 2].map(i => {
  const base = load(`results-${i}.json`);
  for (const f of readdirSync(DIR).filter(f => f.startsWith(`results-${i}-`) && f.endsWith(".json"))) {
    const suffix = f.slice(`results-${i}-`.length, -".json".length);
    const extra = load(f);
    extra.results = extra.results.filter(r => flat(r.strategy) === suffix);
    const redone = new Set(extra.results.map(r => r.strategy));
    base.results = base.results.filter(r => !redone.has(r.strategy)).concat(extra.results);
  }
  return base;
});
const key = r => `${r.m}|${r.throttle}|${r.strategy}`;
const rows = new Map();
for (const r of runs[0].results) {
  const o = runs[1].results.find(x => key(x) === key(r));
  const avg = k => (r[k] + o[k]) / 2;
  const spread = k => Math.abs(r[k] - o[k]) / ((r[k] + o[k]) / 2 || 1);
  rows.set(key(r), {
    ...r,
    load: avg("evalMs") + avg("initMs"),
    first: avg("firstMs"),
    rest: avg("restMs"),
    spreadFirst: spread("firstMs"),
    spreadInit: spread("initMs")
  });
}
const S = ["A", "D", "E-lazy", "F", "F-linked", "F-csr", "B", "C"];
const MS = [...new Set(runs[0].results.map(r => r.m))];
const n = runs[0].n;
// Bindings: live = 2 per row (class, label) + detail + header count;
// static (serialized by B only) = 1 per row (id) + 2 per footer item.
const liveFraction = m => (2 * n + 2) / (2 * n + 2 + n + 2 * m);

for (const t of [1, 4]) {
  console.log(`\n#### CPU ${t}x (ms; n = ${n} rows, mean of two runs)\n`);
  console.log("| footer m (live bindings) | Strategy | load | first click | rest of session | total | HTML gz | JS gz |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const m of MS)
    for (const s of S) {
      const r = rows.get(`${m}|${t}|${s}`);
      console.log(
        `| ${m} (${Math.round(liveFraction(m) * 100)}%) | ${s} | ${r.load.toFixed(1)} | ${r.first.toFixed(1)} | ${r.rest.toFixed(1)} | ${(r.load + r.first + r.rest).toFixed(1)} | ${(r.html.gzip / 1024).toFixed(1)} KB | ${(r.js.gzip / 1024).toFixed(1)} KB |`
      );
    }
}
const maxSpread = Math.max(...[...rows.values()].map(r => Math.max(r.spreadFirst, r.initMs > 5 ? r.spreadInit : 0)));
console.log(`\nRun-to-run spread (first click, and init where > 5 ms): max ${(maxSpread * 100).toFixed(0)}%.`);

const PROFILES = [
  { name: "slow 3G, 4x CPU", bw: 50_000, rtt: 400, t: 4 },
  { name: "4G, 4x CPU", bw: 1_125_000, rtt: 85, t: 4 },
  { name: "cable, 1x CPU", bw: 6_250_000, rtt: 20, t: 1 }
];
const lazy = new Set(["E-lazy", "F", "F-linked", "F-csr", "B", "C"]);
for (const p of PROFILES) {
  console.log(`\n#### Model: ${p.name} (${(p.bw * 8 / 1e6).toFixed(1)} Mbps, RTT ${p.rtt} ms)\n`);
  console.log("| footer m | Strategy | ready (JS eager) | first click | ready (JS deferred) | first click (JS deferred) |");
  console.log("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const m of MS)
    for (const s of S) {
      const r = rows.get(`${m}|${p.t}|${s}`);
      const dl = b => (b / p.bw) * 1000;
      const ready = p.rtt + dl(r.html.gzip + r.js.gzip) + r.load;
      const click = r.first;
      const def = lazy.has(s)
        ? [p.rtt + dl(r.html.gzip) + 1, r.first + p.rtt + dl(r.js.gzip) + r.load]
        : null;
      console.log(
        `| ${m} | ${s} | ${ready.toFixed(0)} | ${click.toFixed(0)} | ${def ? def[0].toFixed(0) : "–"} | ${def ? def[1].toFixed(0) : "–"} |`
      );
    }
}

console.log("\n#### Break-even bandwidth for C (pruned resumability)\n");
console.log("C ships more bytes than hydration strategies and spends less CPU. Break-even: extra bytes / CPU saved; above it C wins, below it C loses.\n");
console.log("| footer m | CPU | vs | extra bytes (gz, HTML+JS) | CPU saved (load + first click) | break-even |");
console.log("| --- | --- | --- | ---: | ---: | ---: |");
for (const m of MS)
  for (const t of [1, 4])
    for (const vs of ["F", "D", "F-csr"]) {
      const c = rows.get(`${m}|${t}|C`);
      const o = rows.get(`${m}|${t}|${vs}`);
      const db = c.html.gzip + c.js.gzip - (o.html.gzip + o.js.gzip);
      const dt = o.load + o.first - (c.load + c.first);
      const be = db <= 0 ? "C wins at any bandwidth" : dt <= 0 ? "never" : `${((db / (dt / 1000)) * 8 / 1e6).toFixed(2)} Mbps`;
      console.log(`| ${m} | ${t}x | ${vs} | ${(db / 1024).toFixed(1)} KB | ${dt.toFixed(0)} ms | ${be} |`);
    }
