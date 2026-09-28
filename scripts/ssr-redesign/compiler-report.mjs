#!/usr/bin/env node
// Markdown tables for ssr-hydration-redesign.md, "Compiler emission":
// compiler output (the C-* variants, `compileIslands`) against the
// hand-written prototypes of the same strategy and tier, from the
// measure.mjs JSON in documentation/plans/ssr-hydration-redesign/
// (compiler-<app>-{1,2}.json; mean of the runs present).
//
//   node scripts/ssr-redesign/compiler-report.mjs
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const dir = join(ROOT, "documentation/plans/ssr-hydration-redesign");
const kb = n => (n / 1024).toFixed(2);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const f1 = n => (Number.isFinite(n) ? n.toFixed(1) : "–");

// [label, hand-written variant, compiler variant]
const PAIRS = {
  hn: [
    ["tier 0, eager", "T0-eager", "C-eager"],
    ["tier 0, lazy", "T0-lazy", "C-lazy"],
    ["tier 1 (kernel), eager", "T1-eager", "C-T1-eager"],
    ["tier 1 (kernel), lazy", "T1-lazy", "C-T1-lazy"],
    ["tier 2 (core), eager", "P1-eager", "C-T2-eager"],
    ["tier 2 (core), lazy", "P1-lazy", "C-T2-lazy"]
  ],
  "todos-local": [
    ["tier 1 (kernel), eager", "T1-eager", "C-eager"],
    ["tier 1 (kernel), lazy", "T1-lazy", "C-lazy"],
    ["tier 2 (core), eager", "T2-eager", "C-T2-eager"],
    ["tier 2 (core), lazy", "T2-lazy", "C-T2-lazy"]
  ],
  todos: [["tier 2: whole-module hydration fallback", "A", "C"]]
};

for (const app of Object.keys(PAIRS)) {
  const runs = [1, 2]
    .map(i => join(dir, `compiler-${app}-${i}.json`))
    .filter(existsSync)
    .map(f => JSON.parse(readFileSync(f, "utf8")));
  if (!runs.length) continue;
  const get = (r, v) => r.apps[app]?.variants[v];
  const a = get(runs[0], "A");
  console.log(`\n### ${app}\n`);
  console.log(
    `Today (A, hydrate): HTML ${kb(a.html.gzip)} KB gz, JS ${kb(a.js.gzip)} KB gz, server render ${f1(a.ssrCpuMs)} ms CPU.\n`
  );
  console.log(
    "| | hand-written | compiler | HTML gz (hand / compiler) | JS gz at load | + JS gz on first interaction | script at load 1× | 4× | first interaction 1× | 4× | server render (CPU ms) | gate |"
  );
  console.log("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const [label, hand, comp] of PAIRS[app]) {
    const h = get(runs[0], hand),
      c = get(runs[0], comp);
    if (!h || !c) continue;
    const t = (v, cpu, k) => {
      const xs = runs.map(r => get(r, v)?.timing?.[cpu]?.[k]).filter(Number.isFinite);
      return xs.length ? mean(xs) : NaN;
    };
    const pair = (x, y) => `${x} / **${y}**`;
    const lazy = r => (r.js.lazy?.gzip ? kb(r.js.lazy.gzip) : "–");
    const gate = r => (r.gate?.equalToA === true ? "pass" : r.gate?.equalToA === "reference (not gated)" ? "ref" : String(r.gate?.equalToA ?? "ref"));
    console.log(
      `| ${label} | ${hand} | ${comp} | ${pair(kb(h.html.gzip), kb(c.html.gzip))} | ${pair(kb(h.js.gzip), kb(c.js.gzip))} | ${pair(lazy(h), lazy(c))} | ${pair(f1(t(hand, 1, "scriptMs")), f1(t(comp, 1, "scriptMs")))} | ${pair(f1(t(hand, 4, "scriptMs")), f1(t(comp, 4, "scriptMs")))} | ${pair(f1(t(hand, 1, "firstMs")), f1(t(comp, 1, "firstMs")))} | ${pair(f1(t(hand, 4, "firstMs")), f1(t(comp, 4, "firstMs")))} | ${pair(f1(h.ssrCpuMs), f1(c.ssrCpuMs))} | ${gate(h)} / ${gate(c)} |`
    );
  }
  console.log(`\n(${runs.length} run(s), ${runs[0].reps} loads per run and CPU rate.)`);
}
