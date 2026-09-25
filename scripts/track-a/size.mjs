#!/usr/bin/env node
// Track A stage-1 production size: minified raw / gzip / brotli bytes.
//
//   node scripts/track-a/size.mjs [--out file.json]
//
// 1. Micro bundles: every benchmark scenario × variant, bundled by esbuild
//    (minify, ESM, tree-shaking) with the production signals build — the
//    runtime each variant retains (the `$` driver, the status-free module).
// 2. Application: examples/todos (handwritten TodoMVC) vs examples/todos-blocks
//    (the same app in `$` blocks) built by `vite build` in each compiler mode;
//    the sum of emitted JS chunks.
//
// Prerequisites: compiler, signals, solid-js and web builds.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { buildSync } from "esbuild";
import { compileSource, ROOT, writeModule } from "./compile.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map(pair => pair.trim().split(/\s+/))
);

function measure(code) {
  const buffer = Buffer.from(code);
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer, { level: 9 }).length,
    brotli: brotliCompressSync(buffer, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
    }).length
  };
}

// --- 1. micro bundles ---------------------------------------------------------
const outDir = join(ROOT, "node_modules/.cache/track-a/size");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const micro = {};
for (const scenario of SCENARIOS) {
  for (const [variant, { source, options, rewrite }] of Object.entries(VARIANTS)) {
    const compiled = compileSource(scenario[source], scenario.filename, options);
    const code = rewrite ? rewrite(compiled) : compiled;
    const entry = writeModule(outDir, `${scenario.name}.${variant}`, code, { url: false });
    const result = buildSync({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: "esm",
      write: false,
      target: "es2022",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent"
    });
    micro[`${scenario.name}/${variant}`] = measure(result.outputFiles[0].text);
  }
}

// --- 2. application ---------------------------------------------------------------
const APP_MODES = {
  "todos (handwritten)": { dir: "examples/todos", env: {} },
  "todos-blocks transformed": { dir: "examples/todos-blocks", env: {} },
  "todos-blocks fused": { dir: "examples/todos-blocks", env: { SOLID_HOST_FUSION: "1" } },
  "todos-blocks optimized": {
    dir: "examples/todos-blocks",
    env: { SOLID_HOST_FUSION: "1", SOLID_BLOCK_PROOFS: "1" }
  },
  "todos-blocks optimizedUnfused": {
    dir: "examples/todos-blocks",
    env: { SOLID_BLOCK_PROOFS: "1" }
  }
};
const app = {};
for (const [name, { dir, env }] of Object.entries(APP_MODES)) {
  const cwd = join(ROOT, dir);
  const out = join(outDir, name.replace(/[^\w]+/g, "-"));
  execFileSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "inherit"]
  });
  const assets = join(out, "assets");
  const js = readdirSync(assets).filter(f => f.endsWith(".js"));
  const code = js.map(f => readFileSync(join(assets, f), "utf8")).join("\n");
  app[name] = { chunks: js.length, ...measure(code) };
}

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const result = {
  env: {
    date: new Date().toISOString(),
    commit: sha,
    node: process.version,
    esbuild: "minify, esm, es2022",
    gzip: "level 9",
    brotli: "quality 11"
  },
  micro,
  app
};
const outFile = args.out ?? join(ROOT, "node_modules/.cache/track-a/size.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2));

let md = `| bundle | raw | gzip | brotli |\n| --- | ---: | ---: | ---: |\n`;
for (const [key, s] of Object.entries(micro))
  md += `| ${key} | ${s.raw} | ${s.gzip} | ${s.brotli} |\n`;
md += `\n| app | chunks | raw | gzip | brotli |\n| --- | ---: | ---: | ---: | ---: |\n`;
for (const [key, s] of Object.entries(app))
  md += `| ${key} | ${s.chunks} | ${s.raw} | ${s.gzip} | ${s.brotli} |\n`;
process.stdout.write(`${md}\nraw data: ${outFile}\n`);
