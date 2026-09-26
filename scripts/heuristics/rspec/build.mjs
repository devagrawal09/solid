#!/usr/bin/env node
// Builds the runtime-speculation variants (R1-R3) from a worktree carrying the
// `__RSPEC__` patches (see README.md in this directory) into
// node_modules/.cache/heuristics/rspec/:
//   signals-r<bits>/   @solidjs/signals prod tree, property-mangled like dist/prod
//   web-r<bits>.js     @solidjs/web client prod bundle
//
//   node scripts/heuristics/rspec/build.mjs --worktree <path> [--web-only]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, ROOT } from "../common.mjs";

const args = parseArgs(process.argv.slice(2));
const WT = args.worktree;
if (!WT) throw new Error("--worktree <path> required");
const OUT = join(ROOT, "node_modules/.cache/heuristics/rspec");
mkdirSync(OUT, { recursive: true });

const SIGNALS_BITS = [0, 1, 2, 3];
const WEB_BITS = [0, 2, 4, 6];

// Signals: rspecTree(dir, bits) from the worktree's rollup config.
const signalsDir = join(WT, "packages/signals");
if (!args["web-only"]) {
  const cfg = join(signalsDir, "rollup.rspec.config.mjs");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    cfg,
    `import { rspecTree } from "./rollup.config.js";\nexport default [${SIGNALS_BITS.map(
      b => `rspecTree(${JSON.stringify(join(OUT, `signals-r${b}`))}, ${b})`
    ).join(", ")}];\n`
  );
  execFileSync("npx", ["rollup", "-c", cfg], { cwd: signalsDir, stdio: "inherit" });
  for (const b of SIGNALS_BITS)
    execFileSync("node", ["./scripts/mangle-props.mjs", join(OUT, `signals-r${b}`)], {
      cwd: signalsDir,
      stdio: "inherit"
    });
}

// Web: the dist/web.js entry of the worktree's config, with __RSPEC__ replaced.
const webDir = join(WT, "packages/web");
// pnpm hoists the build tools to the workspace root.
const { rollup } = await import(
  pathToFileURL(join(WT, "node_modules/rollup/dist/es/rollup.js")).href
);
const replace = (
  await import(pathToFileURL(join(WT, "node_modules/@rollup/plugin-replace/dist/es/index.js")).href)
).default;
const webConfigs = (await import(pathToFileURL(join(webDir, "rollup.config.js")).href)).default;
const webEntry = webConfigs.find(c => c.output?.file === "dist/web.js");
if (!webEntry) throw new Error("web rollup entry dist/web.js not found");
const cwd = process.cwd();
process.chdir(webDir);
try {
  for (const b of WEB_BITS) {
    const bundle = await rollup({
      ...webEntry,
      plugins: [replace({ __RSPEC__: String(b), preventAssignment: true }), ...webEntry.plugins]
    });
    await bundle.write({ ...webEntry.output, file: join(OUT, `web-r${b}.js`) });
    await bundle.close();
  }
} finally {
  process.chdir(cwd);
}
console.log(`built signals-r{${SIGNALS_BITS}} and web-r{${WEB_BITS}} into ${OUT}`);
