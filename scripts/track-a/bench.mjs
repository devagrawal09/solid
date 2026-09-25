#!/usr/bin/env node
// Track A stage-1 runtime benchmark: creation (mount+unmount) and update
// cost and allocation, handwritten Solid vs transformed / fused / optimized
// `$`, against the production signals build.
//
//   node scripts/track-a/bench.mjs [--reps 5] [--n 1000] [--out file.json]
//
// Prerequisites: `pnpm --filter @solidjs/compiler build` and
// `pnpm --filter @solidjs/signals build`.
//
// Method: every (scenario, mode, variant) cell runs in a FRESH node process
// (no JIT / inline-cache sharing between variants), `--reps` times, with the
// variant order shuffled per rep (seeded) to spread drift across variants.
// Each process warms up, then takes timed samples (a forced GC between
// samples, never inside one) and 15 isolated allocation samples.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileSource, ROOT, writeModule } from "./compile.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map(pair => pair.trim().split(/\s+/))
);
const REPS = Number(args.reps ?? 5);
// `--variants a,b` restricts the run (e.g. a paired fused/optimized rerun).
const ONLY = args.variants ? args.variants.split(",") : null;
const ONLY_SCENARIOS = args.scenarios ? args.scenarios.split(",") : null;
const N = Number(args.n ?? 1000);
const MODES = {
  mount: { warmup: 30, samples: 20, perSample: 10 },
  update: { warmup: 300, samples: 20, perSample: 100 }
};

// `--runtime <path>` measures against another signals build (e.g. a saved
// stage-1 dist/prod snapshot) instead of packages/signals/dist/prod.
const RUNTIME = args.runtime;
const outDir = join(ROOT, "node_modules/.cache/track-a/modules");
mkdirSync(outDir, { recursive: true });
const modules = {};
for (const scenario of SCENARIOS) {
  for (const [variant, { source, options, rewrite }] of Object.entries(VARIANTS)) {
    const compiled = compileSource(scenario[source], scenario.filename, options);
    const code = rewrite ? rewrite(compiled) : compiled;
    modules[`${scenario.name}/${variant}`] = writeModule(
      outDir,
      `${scenario.name}.${variant}`,
      code,
      RUNTIME ? { runtime: join(ROOT, RUNTIME) } : undefined
    );
  }
}

let seed = 0x2f6b1;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

const raw = {};
const variantNames = Object.keys(VARIANTS).filter(v => !ONLY || ONLY.includes(v));
const scenarios = SCENARIOS.filter(s => !ONLY_SCENARIOS || ONLY_SCENARIOS.includes(s.name));
for (let rep = 0; rep < REPS; rep++) {
  for (const scenario of scenarios) {
    for (const [mode, m] of Object.entries(MODES)) {
      for (const variant of shuffled(variantNames)) {
        const key = `${scenario.name}/${mode}/${variant}`;
        const out = execFileSync(
          process.execPath,
          [
            "--expose-gc",
            "--max-semi-space-size=256",
            join(here, "worker.mjs"),
            pathToFileURL(modules[`${scenario.name}/${variant}`]).href,
            mode,
            String(N),
            String(m.warmup),
            String(m.samples),
            String(m.perSample)
          ],
          { encoding: "utf8" }
        );
        (raw[key] ??= []).push(JSON.parse(out));
      }
    }
  }
  process.stderr.write(`rep ${rep + 1}/${REPS} done\n`);
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))];
function stats(runs) {
  const pooled = runs.flatMap(r => r.nsPerOp);
  const mean = pooled.reduce((a, b) => a + b, 0) / pooled.length;
  const sd = Math.sqrt(pooled.reduce((a, b) => a + (b - mean) ** 2, 0) / (pooled.length - 1));
  const repMedians = runs.map(r => median(r.nsPerOp));
  const bytes = runs.flatMap(r => r.bytesPerOp);
  return {
    medianNs: median(pooled),
    p25Ns: quantile(pooled, 0.25),
    p75Ns: quantile(pooled, 0.75),
    rmePct: (100 * 1.96 * sd) / Math.sqrt(pooled.length) / mean,
    repSpreadPct: (100 * (Math.max(...repMedians) - Math.min(...repMedians))) / median(repMedians),
    samples: pooled.length,
    bytesPerOp: bytes.length ? median(bytes) : null,
    allocSamples: bytes.length,
    allocDiscarded: runs.reduce((a, r) => a + r.discarded, 0)
  };
}

const summary = {};
for (const [key, runs] of Object.entries(raw)) summary[key] = stats(runs);

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean).length;
const env = {
  date: new Date().toISOString(),
  commit: sha,
  dirtyFiles: dirty,
  node: process.version,
  v8: process.versions.v8,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  cores: cpus().length,
  runtime: RUNTIME ?? "packages/signals/dist/prod (production tier)",
  n: N,
  reps: REPS,
  modes: MODES
};

// Paired statistic: within each rep every variant of a cell ran back to
// back, so the per-rep ratio of medians cancels most between-rep drift.
// Reported as the median ratio with its min–max over reps.
function paired(scenario, mode, variant, reference) {
  const a = raw[`${scenario}/${mode}/${variant}`];
  const b = raw[`${scenario}/${mode}/${reference}`];
  if (!a || !b) return null;
  const ratios = a.map((run, i) => median(run.nsPerOp) / median(b[i].nsPerOp));
  return { median: median(ratios), min: Math.min(...ratios), max: Math.max(...ratios) };
}
for (const [key] of Object.entries(summary)) {
  const [scenario, mode, variant] = key.split("/");
  summary[key].pairedVsFused = paired(scenario, mode, variant, "fused");
  summary[key].pairedVsHandwritten = paired(scenario, mode, variant, "handwritten");
}

// Markdown summary: per scenario/mode, each variant vs handwritten and fused.
const fmtPair = p =>
  p
    ? `${((p.median - 1) * 100).toFixed(1)}% [${((p.min - 1) * 100).toFixed(0)}, ${((p.max - 1) * 100).toFixed(0)}]`
    : "n/a";
let md = `| scenario | mode | variant | median | ±RME | rep spread | paired vs handwritten | paired vs fused | bytes/op |\n`;
md += `| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
for (const scenario of scenarios) {
  for (const mode of Object.keys(MODES)) {
    for (const variant of variantNames) {
      const s = summary[`${scenario.name}/${mode}/${variant}`];
      const fmt = ns => (ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : `${(ns / 1e3).toFixed(1)} µs`);
      md += `| ${scenario.name} | ${mode} | ${variant} | ${fmt(s.medianNs)} | ${s.rmePct.toFixed(1)}% | ${s.repSpreadPct.toFixed(1)}% | ${fmtPair(s.pairedVsHandwritten)} | ${fmtPair(s.pairedVsFused)} | ${s.bytesPerOp ?? "n/a"} |\n`;
    }
  }
}

const result = { env, summary, raw };
const outFile = args.out ?? join(ROOT, "node_modules/.cache/track-a/bench.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(env)}\n\n${md}\nraw data: ${outFile}\n`);
