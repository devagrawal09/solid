#!/usr/bin/env node
// Client bundle bytes of each example against its `-blocks` twin.
//
//   node scripts/example-blocks/bytes.mjs [example …]
//
// The method of scripts/slices/measure-apps.mjs (baseline variant): `vite
// build` with the example's own config (the solid plugin and the native
// compiler), `write: false`, summing every emitted JS chunk as vite minifies
// it (esbuild) and gzip -9. For an example with several client configs
// (rendering: csr / stream / string) each variant is built. Needs
// packages/{signals,solid,web} and the native compiler built.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ALL = [
  "sierpinski",
  "migrating-element",
  "effect",
  "attribution-lab",
  "chat",
  "hackernews-spa",
  "hackernews",
  "rendering",
  "diagnostics",
  "notes"
];
const names = process.argv.slice(2).filter(a => !a.startsWith("--"));

const CONFIGS = ["vite.config.mjs", "vite.config.ts", "vite.config.mts", "vite.config.js"];
/** Client build configs: the app's own, or one per rendering variant. */
function configsOf(dir) {
  const own = CONFIGS.map(f => join(dir, f)).find(existsSync);
  if (own) return [["client", dir, own]];
  return ["csr", "stream", "string"]
    .map(v => [v, join(dir, v), CONFIGS.map(f => join(dir, v, f)).find(existsSync)])
    .filter(([, , c]) => c);
}

async function measure(name) {
  const dir = join(ROOT, "examples", name);
  const require = createRequire(join(dir, "package.json"));
  const { build } = await import(require.resolve("vite"));
  const out = {};
  for (const [variant, root, configFile] of configsOf(dir)) {
    try {
      const result = await build({
        root,
        configFile,
        logLevel: "silent",
        build: { write: false, reportCompressedSize: false, ssr: false }
      });
      // Frames / SSR configs build several environments; keep the client.
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(r => r.output ?? []);
      let min = 0,
        gz = 0;
      for (const o of outputs) {
        if (o.type !== "chunk") continue;
        min += Buffer.byteLength(o.code);
        gz += gzipSync(o.code, { level: 9 }).length;
      }
      out[variant] = { min, gz };
    } catch (error) {
      out[variant] = { error: String(error.message ?? error).split("\n")[0] };
    }
  }
  return out;
}

console.log("| example | variant | original min / gz | twin min / gz | twin vs original (gz) |");
console.log("| --- | --- | ---: | ---: | ---: |");
for (const name of names.length ? names : ALL) {
  const a = await measure(name);
  const b = existsSync(join(ROOT, "examples", `${name}-blocks`))
    ? await measure(`${name}-blocks`)
    : {};
  for (const variant of Object.keys(a)) {
    const x = a[variant],
      y = b[variant] ?? { error: "missing" };
    const cell = v => (v.error ? `error: ${v.error}` : `${v.min} / ${v.gz}`);
    const pct =
      x.gz && y.gz ? `${y.gz >= x.gz ? "+" : ""}${(((y.gz - x.gz) / x.gz) * 100).toFixed(1)}%` : "–";
    console.log(`| ${name} | ${variant} | ${cell(x)} | ${cell(y)} | ${pct} |`);
  }
}
