#!/usr/bin/env node
// Markdown tables for ssr-hydration-redesign.md, "Islands for real apps":
// compiled islands after this work (trackg-<app>-{1,2}.json) against the
// compiler emission before it (compiler-<app>-{1,2}.json) and today's
// hydrated page (A, from the new runs). Mean of the runs present; byte
// numbers are exact.
//
//   node scripts/ssr-redesign/trackg-report.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const dir = join(ROOT, "documentation/plans/ssr-hydration-redesign");
const kb = n => (n / 1024).toFixed(2);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const f1 = n => (Number.isFinite(n) ? n.toFixed(1) : "–");

const load = prefix => app =>
  [1, 2]
    .map(i => join(dir, `${prefix}-${app}-${i}.json`))
    .filter(existsSync)
    .map(f => JSON.parse(readFileSync(f, "utf8")));
const before = load("compiler");
const after = load("trackg");

// [label, runs, variant]
const ROWS = {
  hn: [
    ["today: hydrate (A)", "after", "A"],
    ["before: compiled islands, tier 0, eager", "before", "C-eager"],
    ["before: compiled islands, tier 0, lazy", "before", "C-lazy"],
    ["after: tier 0, eager", "after", "C-eager"],
    ["after: tier 0, lazy", "after", "C-lazy"],
    ["after: tier 0, lazy, streamed boundary", "after", "C-stream"]
  ],
  "todos-local": [
    ["today: hydrate (A)", "after", "A"],
    ["before: tier 1, eager", "before", "C-eager"],
    ["before: tier 1, lazy", "before", "C-lazy"],
    ["after: tier 1, eager", "after", "C-eager"],
    ["after: tier 1, lazy", "after", "C-lazy"]
  ],
  todos: [
    ["today: hydrate (A)", "after", "A"],
    ["before: whole-module fallback (hydrate)", "before", "C"],
    ["after: one tier-2 island, eager", "after", "C-eager"],
    ["after: one tier-2 island, lazy", "after", "C"]
  ]
};

for (const app of Object.keys(ROWS)) {
  const sets = { before: before(app), after: after(app) };
  if (!sets.after.length) continue;
  console.log(`\n### ${app}\n`);
  console.log(
    "| | HTML gz | JS gz at load | + JS gz on first interaction | script at load 1× | 4× | first interaction 1× | 4× | server render (CPU ms) | gate |"
  );
  console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const [label, which, v] of ROWS[app]) {
    const runs = sets[which];
    const r = runs[0]?.apps[app]?.variants[v];
    if (!r) continue;
    const t = (cpu, k) => {
      const xs = runs.map(x => x.apps[app]?.variants[v]?.timing?.[cpu]?.[k]).filter(Number.isFinite);
      return xs.length ? mean(xs) : NaN;
    };
    // A first-interaction probe that timed out (8 s) is not a time.
    const first = cpu => {
      const x = t(cpu, "firstMs");
      return x > 5000 ? "timeout" : f1(x);
    };
    const lazy = r.js.lazy?.gzip ? kb(r.js.lazy.gzip) : "–";
    const gate =
      r.gate?.equalToA === true ? "pass" : v === "A" ? "reference" : String(r.gate?.equalToA ?? "–");
    console.log(
      `| ${label} | ${kb(r.html.gzip)} | ${kb(r.js.gzip)} | ${lazy} | ${f1(t(1, "scriptMs"))} | ${f1(t(4, "scriptMs"))} | ${first(1)} | ${first(4)} | ${f1(r.ssrCpuMs)} | ${gate} |`
    );
  }
  const n = sets.after.length;
  console.log(`\n(after: ${n} run(s); before: ${sets.before.length} run(s); ${sets.after[0].reps} loads per run and CPU rate.)`);
}
