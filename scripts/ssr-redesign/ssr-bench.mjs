#!/usr/bin/env node
// Server render cost of the HN story page (1,406 comments) under three
// server strategies:
//   A          today: hydratable SSR (ids, hole markers, serialized story)
//   P1-zone    the same components in a NoHydration zone, Toggle as an
//              anchored island (what P1-static serves)
//   P1-string  a compiler-style string template for the inert region
//              (apps/hn/string-template.ts) — no owners, thunks or markers
// Gate: P1-string's HTML equals P1-zone's with hole markers removed.
//
//   node scripts/ssr-redesign/ssr-bench.mjs [--iters 30] [--out file]
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gz, HERE, kb, loadServer, median, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const ITERS = Number(args.includes("--iters") ? args[args.indexOf("--iters") + 1] : 30);
const cache = join(ROOT, "node_modules/.cache/ssr-redesign");
const story = JSON.parse(readFileSync(join(ROOT, "examples/hackernews-spa/src/lib/story-30186326.json"), "utf8"));
const TOGGLE = "examples/hackernews-spa/src/components/toggle.tsx";

const A = await loadServer(join(HERE, "apps/hn/server.tsx"), join(cache, "bench-A.mjs"));
const Z = await loadServer(join(HERE, "apps/hn/islands-static/server.tsx"), join(cache, "bench-Z.mjs"), {
  swaps: { [TOGGLE]: "scripts/ssr-redesign/apps/hn/islands-static/toggle.server.tsx" }
});
await build({ entryPoints: [join(HERE, "apps/hn/string-template.ts")], bundle: true, format: "esm", platform: "node", outfile: join(cache, "bench-S.mjs"), logLevel: "error" });
const S = await import(pathToFileURL(join(cache, "bench-S.mjs")).href);

const strip = h => h.replace(/<!--(\$|\/|!\$)-->/g, "");
const zHtml = await Z.render();
const sHtml = S.storyHTML(story);
if (strip(zHtml) !== sHtml) {
  let i = 0;
  while (strip(zHtml)[i] === sHtml[i]) i++;
  throw new Error(`P1-string differs from P1-zone at ${i}:\n${strip(zHtml).slice(i - 80, i + 80)}\n${sHtml.slice(i - 80, i + 80)}`);
}
console.log("gate: P1-string HTML equals P1-zone HTML without hole markers");

async function time(fn) {
  for (let i = 0; i < 5; i++) await fn();
  const s = [];
  for (let i = 0; i < ITERS; i++) {
    const t = performance.now();
    await fn();
    s.push(performance.now() - t);
  }
  return median(s);
}
const res = {};
for (const [name, fn, html] of [
  ["A", () => A.render(), await A.render()],
  ["P1-zone", () => Z.render(), zHtml],
  ["P1-string", async () => S.storyHTML(story), sHtml]
]) {
  const ms = await time(fn);
  res[name] = { ms, bytes: Buffer.byteLength(html), gzip: gz(html) };
  console.log(`${name.padEnd(10)} ${ms.toFixed(2)} ms/render | ${kb(Buffer.byteLength(html))} KB raw, ${kb(gz(html))} KB gz`);
}
if (args.includes("--out")) writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify({ iters: ITERS, node: process.version, results: res }, null, 2) + "\n");
