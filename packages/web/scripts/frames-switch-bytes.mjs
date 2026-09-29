#!/usr/bin/env node
// Bytes per frames-client switch (frames/src/features.ts;
// documentation/plans/core-runtime-slicing.md, "Frames client switches").
//
//   node scripts/frames-switch-bytes.mjs [--json out.json]
//
// Bundles the PUBLISHED frames client (frames/dist/client.js, so run the
// build first) the way an app bundler would — rollup with node resolution
// (browser conditions) over solid-js / @solidjs/signals / @solidjs/web, the
// server-function client and the lazy codec entry left external (shared with
// the rest of the app / loaded lazily) — with the features module substituted
// exactly as the capability linker does, then esbuild minify, then gzip. Reports the
// eager bytes of each configuration and what each switch removes, and whether
// the lazy codec entry is still reachable.
import { rollup } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import { transform } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { framesFeaturesModuleSource, FRAMES_SWITCHES } = require(
  resolve(pkg, "../compiler/capabilities.js")
);
const ENTRY = resolve(pkg, "frames/dist/client.js");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? resolve(args[args.indexOf("--json") + 1]) : null;

const EXTERNAL = new Set([
  "@solidjs/web/server-functions/client",
  "@solidjs/web/serialization/decode",
  "@solidjs/web/serialization",
  "seroval",
  "seroval-plugins/web"
]);

async function measure(off) {
  const features = {};
  for (const f of FRAMES_SWITCHES) features[f] = { on: !off.includes(f) };
  const bundle = await rollup({
    input: ENTRY,
    external: id => EXTERNAL.has(id),
    onwarn: () => {},
    plugins: [
      {
        name: "frames-features",
        resolveId(source) {
          if (/(^|\/)client\.features\.js$/.test(source)) return "\0frames-features";
          if (source === "@solidjs/web") return resolve(pkg, "dist/web.js");
          return null;
        },
        load(id) {
          return id === "\0frames-features" ? framesFeaturesModuleSource(features) : null;
        }
      },
      nodeResolve({ browser: true, exportConditions: ["browser", "import", "default"] })
    ]
  });
  const { output } = await bundle.generate({ format: "es" });
  await bundle.close();
  const code = output.map(c => (c.type === "chunk" ? c.code : "")).join("\n");
  const min = (await transform(code, { minify: true, format: "esm", target: "es2022" })).code;
  return {
    min: min.length,
    gz: gzipSync(min, { level: 9 }).length,
    lazyCodec: /@solidjs\/web\/serialization\/decode/.test(min)
  };
}

const rows = [];
const full = await measure([]);
rows.push({ config: "full (published)", off: [], ...full });
for (const s of FRAMES_SWITCHES) rows.push({ config: `−${s}`, off: [s], ...(await measure([s])) });
rows.push({ config: "−all", off: FRAMES_SWITCHES, ...(await measure(FRAMES_SWITCHES)) });
// Extra configurations: `--off A,B` (repeatable), e.g. what an app's proof
// switched off.
args.forEach((a, i) => {
  if (a === "--off") rows.push({ config: `−${args[i + 1]}`, off: args[i + 1].split(",") });
});
for (const r of rows) if (r.gz === undefined) Object.assign(r, await measure(r.off));

// The lazy codec chunk (loaded on the first `data` chunk): what FULL_CODEC
// off makes unreachable.
async function lazyCodec() {
  const bundle = await rollup({
    input: resolve(pkg, "serialization/dist/decode.js"),
    onwarn: () => {},
    plugins: [nodeResolve({ browser: true, exportConditions: ["browser", "import", "default"] })]
  });
  const { output } = await bundle.generate({ format: "es" });
  await bundle.close();
  const min = (await transform(output[0].code, { minify: true, format: "esm" })).code;
  return { min: min.length, gz: gzipSync(min, { level: 9 }).length };
}
const codec = await lazyCodec();

const kb = n => (n / 1024).toFixed(2);
console.log("| config | min KB | gz KB | saved gz bytes | lazy codec reachable |");
console.log("| --- | ---: | ---: | ---: | --- |");
for (const r of rows)
  console.log(
    `| ${r.config} | ${kb(r.min)} | ${kb(r.gz)} | ${full.gz - r.gz} | ${r.lazyCodec ? "yes" : "no"} |`
  );
console.log(
  `\nlazy codec chunk (decode entry + seroval): ${kb(codec.min)} KB min, ${kb(codec.gz)} KB gz`
);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ rows, lazyCodec: codec }, null, 2));
