#!/usr/bin/env node
// Aggregates JFB result files (run.sh output dirs) into one JSON and markdown
// tables: per benchmark and variant, median script / total, stddev, and the
// delta vs the reference, per run.
//
// A delta is "(noise)" unless, in BOTH runs, it has the same sign and its
// magnitude exceeds the pooled stddev of the two samples,
// sqrt((σ_ref² + σ_var²) / 2). A two-sided Mann-Whitney U over both runs
// pooled is given as a second opinion (p < 0.01 required as well).
//
//   node scripts/heuristics/jfb/report.mjs <run1-dir> <run2-dir> --out <file.json> [--md <file.md>]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const dirs = [];
const args = {};
for (let i = 0; i < argv.length; i++)
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  else dirs.push(argv[i]);

const BENCH = ["01_run1k", "02_replace1k", "03_update10th1k_x16", "04_select1k", "05_swap1k", "06_remove-one-1k", "07_create10k", "08_create1k-after1k_x2", "09_clear1k_x8"];
const NAMES = {
  "solid-next": "baseline",
  "solid-next-h7": "H7",
  "solid-next-l1": "L1",
  "solid-next-h7l1": "H7+L1",
  "solid-next-child": "child",
  "solid-next-child-h7": "child-H7",
  "solid-next-rspec-r0": "rspec-r0",
  "solid-next-rspec-r1b": "rspec-r1b"
};
// Comparisons: [variant, reference].
const PAIRS = [
  ["rspec-r0", "baseline"], // A/A: byte-identical bundle, the noise floor
  ["H7", "baseline"],
  ["L1", "baseline"],
  ["H7+L1", "baseline"],
  ["child", "baseline"],
  ["child-H7", "child"],
  ["rspec-r1b", "rspec-r0"],
  ["rspec-r1b", "baseline"]
];

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sd = xs => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
// Two-sided Mann-Whitney U, normal approximation with tie correction.
function mannWhitney(a, b) {
  const all = [...a.map(v => [v, 0]), ...b.map(v => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  let tieSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    const t = j - i + 1;
    tieSum += t ** 3 - t;
    i = j + 1;
  }
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  let r1 = 0;
  all.forEach((x, i) => x[1] === 0 && (r1 += ranks[i]));
  const u = r1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieSum / (n * (n - 1))));
  const z = (u - mu) / sigma;
  // erfc approximation
  const p = 2 * (1 - phi(Math.abs(z)));
  return { z, p };
}
function phi(x) {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  return 1 - d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
}

// runs[r][variant][bench] = {script:[...], total:[...]}
const runs = dirs.map(dir => {
  const out = {};
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f.startsWith("solid-next"))) {
    const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const fw = d.framework.replace(/-v2\.0\.0.*$/, "");
    const name = NAMES[fw];
    if (!name) continue;
    (out[name] ??= {})[d.benchmark] = { script: d.values.script.values, total: d.values.total.values };
  }
  return out;
});

const result = { runs: dirs, cells: [], comparisons: [] };
for (const [r, run] of runs.entries())
  for (const [name, byBench] of Object.entries(run))
    for (const [bench, v] of Object.entries(byBench))
      result.cells.push({
        run: r + 1,
        variant: name,
        benchmark: bench,
        n: v.script.length,
        script: { median: median(v.script), stddev: sd(v.script) },
        total: { median: median(v.total), stddev: sd(v.total) }
      });

const fmt = (x, d = 1) => x.toFixed(d);
const pct = x => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
for (const metric of ["script", "total"])
  for (const [v, ref] of PAIRS)
    for (const bench of BENCH) {
      const per = runs.map(run => {
        const a = run[v]?.[bench]?.[metric], b = run[ref]?.[bench]?.[metric];
        if (!a || !b) return null;
        const band = Math.sqrt((sd(a) ** 2 + sd(b) ** 2) / 2);
        return { var: median(a), ref: median(b), delta: median(a) - median(b), band, rel: (median(a) - median(b)) / median(b) };
      });
      if (per.some(x => !x)) continue;
      const pooledA = runs.flatMap(run => run[v][bench][metric]);
      const pooledB = runs.flatMap(run => run[ref][bench][metric]);
      const mw = mannWhitney(pooledA, pooledB);
      const sameSign = per.every(x => Math.sign(x.delta) === Math.sign(per[0].delta) && x.delta !== 0);
      const outside = per.every(x => Math.abs(x.delta) > x.band);
      result.comparisons.push({ metric, variant: v, reference: ref, benchmark: bench, perRun: per, mannWhitney: mw, real: sameSign && outside && mw.p < 0.01 });
    }

if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");

// Markdown
const lines = [];
for (const metric of ["script", "total"]) {
  lines.push(`#### Per-variant ${metric} time (ms): median ± stddev, run 1 / run 2\n`);
  const variants = Object.keys(NAMES).map(k => NAMES[k]).filter(n => runs[0][n]);
  lines.push(`| Benchmark | ${variants.join(" | ")} |`);
  lines.push(`| --- | ${variants.map(() => "---:").join(" | ")} |`);
  for (const bench of BENCH) {
    const cells = variants.map(n =>
      runs
        .map(run => {
          const x = run[n]?.[bench]?.[metric];
          return x ? `${fmt(median(x))} ± ${fmt(sd(x))}` : "–";
        })
        .join(" / ")
    );
    lines.push(`| ${bench} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  for (const [v, ref] of PAIRS) {
    const rows = result.comparisons.filter(c => c.metric === metric && c.variant === v && c.reference === ref);
    if (!rows.length) continue;
    lines.push(`##### ${v} vs ${ref} (${metric})\n`);
    lines.push("| Benchmark | ref (r1 / r2) | variant (r1 / r2) | Δ r1 | Δ r2 | σ band r1 / r2 | MW p | verdict |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const c of rows) {
      const [a, b] = c.perRun;
      lines.push(
        `| ${c.benchmark} | ${fmt(a.ref)} / ${fmt(b.ref)} | ${fmt(a.var)} / ${fmt(b.var)} | ${pct(a.rel)} | ${pct(b.rel)} | ±${fmt(a.band, 2)} / ±${fmt(b.band, 2)} | ${c.mannWhitney.p < 0.001 ? "<0.001" : fmt(c.mannWhitney.p, 3)} | ${c.real ? `**${pct((a.rel + b.rel) / 2)}**` : "(noise)"} |`
      );
    }
    lines.push("");
  }
}
const md = lines.join("\n");
if (args.md) writeFileSync(args.md, md + "\n");
else console.log(md);
