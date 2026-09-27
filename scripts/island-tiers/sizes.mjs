#!/usr/bin/env node
// Runtime sizes for the island tiers (documentation/plans/island-runtime-tiers.md):
// min and min+gzip of what each tier's activation code pulls in, bundled by
// esbuild exactly as the measure harness bundles clients.
//
//   node scripts/island-tiers/sizes.mjs [--json out.json]
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIST, gz, ROOT } from "../ssr-redesign/lib.mjs";

const KERNEL = join(ROOT, "packages/signals/src/kernel/index.ts");
const SYNC = join(ROOT, "packages/signals/dist/sync/index.sync.js");

async function size(contents, resolveDir = ROOT) {
  const res = await build({
    stdin: { contents, resolveDir, loader: "ts" },
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    logLevel: "error",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@solidjs/signals": DIST.signals }
  });
  const code = res.outputFiles[0].text;
  return { min: Buffer.byteLength(code), gzip: gz(code) };
}

const USED = "createSignal, createMemo, createEffect, createRenderEffect, createRoot, onCleanup, untrack, flush";
const rows = {
  "kernel (all exports)": await size(`export * from ${JSON.stringify(KERNEL)};`),
  "kernel: signal + render effect + root (Toggle)": await size(`export { createSignal, createRenderEffect, createRoot } from ${JSON.stringify(KERNEL)};`),
  [`core: the kernel's API (${USED.split(",").length} exports)`]: await size(`export { ${USED} } from "@solidjs/signals";`),
  "core: signal + render effect + root (Toggle)": await size(`export { createSignal, createRenderEffect, createRoot, flush } from "@solidjs/signals";`),
  "core async-free (@solidjs/signals/sync): the kernel's API": await size(`export { ${USED} } from ${JSON.stringify(SYNC)};`),
  "core (all exports)": await size(`export * from "@solidjs/signals";`)
};
for (const [k, v] of Object.entries(rows)) console.log(`${k.padEnd(62)} ${(v.min / 1024).toFixed(2).padStart(6)} KB min  ${(v.gzip / 1024).toFixed(2).padStart(5)} KB gz  (${v.gzip} B)`);
const args = process.argv.slice(2);
if (args.includes("--json")) writeFileSync(args[args.indexOf("--json") + 1], JSON.stringify(rows, null, 2) + "\n");
