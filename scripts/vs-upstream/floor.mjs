#!/usr/bin/env node
// @solidjs/signals core floor for one or more Solid trees
// (documentation/plans/vs-upstream-v2.md): the five core primitives
// (createSignal, createMemo, createEffect, createRoot, flush) re-exported from
// <tree>/packages/signals/dist/prod/index.js (and the async-free entry
// dist/sync/index.sync.js when the tree has one), bundled with esbuild
// (minify, esm, es2022), gzip -9.
//
//   node scripts/vs-upstream/floor.mjs <label>=<tree> [<label>=<tree> ...]
import { buildSync } from "esbuild";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const work = mkdtempSync(join(tmpdir(), "vs-upstream-floor-"));
const EXPORTS = "createSignal, createMemo, createEffect, createRoot, flush";
console.log("| tree | entry | min | gzip |\n| --- | --- | ---: | ---: |");
for (const spec of process.argv.slice(2)) {
  const [label, tree] = spec.split("=");
  for (const entry of ["packages/signals/dist/prod/index.js", "packages/signals/dist/sync/index.sync.js"]) {
    const path = join(resolve(tree), entry);
    if (!existsSync(path)) continue;
    const file = join(work, `${label}-${entry.replace(/\W+/g, "-")}.mjs`);
    writeFileSync(file, `export { ${EXPORTS} } from ${JSON.stringify(path)};`);
    const out = buildSync({ entryPoints: [file], bundle: true, minify: true, format: "esm", write: false, target: "es2022", logLevel: "silent" });
    const code = out.outputFiles[0].contents;
    console.log(`| ${label} | ${entry.replace("packages/signals/", "")} | ${code.length} | ${gzipSync(code, { level: 9 }).length} |`);
  }
}
