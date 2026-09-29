#!/usr/bin/env node
// Baseline app bytes for any Solid tree (documentation/plans/vs-upstream-v2.md).
//
//   node scripts/vs-upstream/measure-apps.mjs --root <tree> [--examples a,b] [--out file.json]
//
// The `baseline` column of scripts/slices/measure-apps.mjs, for a tree that
// has no capability linker (e.g. upstream `next`): `vite build` of each
// example with its own config against <tree>'s built workspace packages and
// native compiler, write: false; reports the sum of emitted JS chunks (vite's
// esbuild minify) and the sum of their gzip -9 sizes.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const arg = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const ROOT = resolve(arg("--root") ?? ".");
const outFile = arg("--out") ? resolve(arg("--out")) : null;
const only = arg("--examples")?.split(",") ?? null;
const EXAMPLES = ["todos", "sierpinski", "hackernews", "hackernews-spa", "notes", "chat", "effect", "migrating-element", "room"];

async function buildBaseline(name) {
  const dir = join(ROOT, "examples", name);
  const require = createRequire(join(dir, "package.json"));
  const { build } = await import(require.resolve("vite"));
  process.env.SOLID_CAPABILITIES = "0";
  const result = await build({
    root: dir,
    configFile: ["vite.config.mjs", "vite.config.ts", "vite.config.js"].map(f => join(dir, f)).find(existsSync),
    logLevel: "warn",
    build: { write: false, reportCompressedSize: false }
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  let min = 0,
    gz = 0;
  const chunks = [];
  // Rendered (pre-minify) bytes per origin: where the app's JS comes from.
  const byPackage = {};
  const byModule = {};
  for (const o of outputs) {
    if (o.type !== "chunk") continue;
    const bytes = Buffer.byteLength(o.code);
    min += bytes;
    gz += gzipSync(o.code, { level: 9 }).length;
    chunks.push([o.fileName, bytes]);
    for (const [id, m] of Object.entries(o.modules)) {
      if (!m.renderedLength) continue;
      const pkg =
        /packages\/(signals|solid|web)\//.exec(id)?.[1] ?? (id.includes("node_modules") ? "deps" : "app");
      byPackage[pkg] = (byPackage[pkg] ?? 0) + m.renderedLength;
      const mod = /packages\/(?:web|solid|signals)\/.*$/.exec(id)?.[0];
      if (mod) byModule[mod] = (byModule[mod] ?? 0) + m.renderedLength;
    }
  }
  return { min, gz, chunks, byPackage, byModule };
}

const results = {};
for (const name of EXAMPLES) {
  if (only && !only.includes(name)) continue;
  if (!existsSync(join(ROOT, "examples", name))) continue;
  try {
    results[name] = { baseline: await buildBaseline(name) };
  } catch (error) {
    results[name] = { baseline: { error: String(error.message ?? error).split("\n")[0] } };
  }
  const b = results[name].baseline;
  console.log(`| ${name} | ${b.error ? "error: " + b.error : `${b.min} / ${b.gz}`} |`);
}
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(results, null, 2));
}
