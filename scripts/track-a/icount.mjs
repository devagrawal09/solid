#!/usr/bin/env node
// Track A: instruction counts per operation (low-noise CPU proxy).
//
//   node scripts/track-a/icount.mjs [--n 200] [--ops 20] [--variants a,b] [--out f.json]
//
// Each (scenario, mode, variant) runs twice under `valgrind --tool=cachegrind
// --cache-sim=no` with the same warmup and `ops` vs `2*ops` operations; the
// difference divided by `ops` is instructions per operation, with process
// startup, module loading and warmup cancelled out. Node runs with
// `--predictable --single-threaded` so JIT tiering and GC are deterministic
// (no concurrent compiler / collector threads). Instruction counts ignore
// cache and branch effects: they complement, not replace, wall time.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
const N = Number(args.n ?? 200);
const OPS = Number(args.ops ?? 20);
const WARMUP = { mount: 20, update: 100 };
const ONLY = args.variants ? args.variants.split(",") : null;
const RUNTIME = args.runtime ? args.runtime : undefined;

// One module directory per runtime: workers load their module per cell, so
// concurrent runs against different runtimes must not share files.
const outDir = join(
  ROOT,
  "node_modules/.cache/track-a/icount-modules",
  (RUNTIME ?? "prod").replace(/\W+/g, "-")
);
const modules = {};
for (const scenario of SCENARIOS) {
  for (const [variant, { source, options, rewrite }] of Object.entries(VARIANTS)) {
    if (ONLY && !ONLY.includes(variant)) continue;
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

function ir(module, mode, ops) {
  const result = spawnSync(
    "valgrind",
    [
      "--tool=cachegrind",
      "--cache-sim=no",
      "--cachegrind-out-file=/dev/null",
      process.execPath,
      "--predictable",
      "--single-threaded",
      join(here, "icount-worker.mjs"),
      pathToFileURL(module).href,
      mode,
      String(N),
      String(WARMUP[mode]),
      String(ops)
    ],
    { encoding: "utf8", maxBuffer: 1 << 24 }
  );
  const match = /I\s+refs:\s+([\d,]+)/.exec(result.stderr);
  if (!match) throw new Error(`no instruction count:\n${result.stderr.slice(-2000)}`);
  return Number(match[1].replaceAll(",", ""));
}

const results = {};
for (const scenario of SCENARIOS) {
  for (const mode of ["mount", "update"]) {
    for (const variant of Object.keys(VARIANTS)) {
      if (ONLY && !ONLY.includes(variant)) continue;
      const module = modules[`${scenario.name}/${variant}`];
      const once = ir(module, mode, OPS);
      const twice = ir(module, mode, 2 * OPS);
      results[`${scenario.name}/${mode}/${variant}`] = {
        irPerOp: (twice - once) / OPS,
        irOnce: once,
        irTwice: twice
      };
      process.stderr.write(
        `${scenario.name}/${mode}/${variant}: ${Math.round((twice - once) / OPS)} Ir/op\n`
      );
    }
  }
}

let md = `| scenario | mode | variant | Ir/op | vs handwritten | vs fused |\n| --- | --- | --- | ---: | ---: | ---: |\n`;
for (const scenario of SCENARIOS) {
  for (const mode of ["mount", "update"]) {
    const base = results[`${scenario.name}/${mode}/handwritten`];
    const fused = results[`${scenario.name}/${mode}/fused`];
    for (const variant of Object.keys(VARIANTS)) {
      const r = results[`${scenario.name}/${mode}/${variant}`];
      if (!r) continue;
      const pct = ref =>
        ref
          ? `${r.irPerOp >= ref.irPerOp ? "+" : ""}${((100 * (r.irPerOp - ref.irPerOp)) / ref.irPerOp).toFixed(1)}%`
          : "n/a";
      md += `| ${scenario.name} | ${mode} | ${variant} | ${Math.round(r.irPerOp)} | ${pct(base)} | ${pct(fused)} |\n`;
    }
  }
}

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const valgrind = execFileSync("valgrind", ["--version"], { encoding: "utf8" }).trim();
const result = {
  env: {
    date: new Date().toISOString(),
    commit: sha,
    node: process.version,
    valgrind,
    nodeFlags: "--predictable --single-threaded",
    runtime: RUNTIME ?? "packages/signals/dist/prod",
    n: N,
    ops: OPS,
    warmup: WARMUP
  },
  results
};
const outFile = args.out ?? join(ROOT, "node_modules/.cache/track-a/icount.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2));
process.stdout.write(`${JSON.stringify(result.env)}\n\n${md}\nraw data: ${outFile}\n`);
