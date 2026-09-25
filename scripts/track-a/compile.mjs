// Compile Track A scenario sources into runnable ESM modules, one per
// variant, against the PRODUCTION signals build (packages/signals/dist/prod).
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../..");
const require = createRequire(import.meta.url);
export const compiler = require(join(ROOT, "packages/compiler/index.js"));
export const SIGNALS_PROD = join(ROOT, "packages/signals/dist/prod/index.js");

/** Compile one source for one variant; returns the emitted JS (imports intact). */
export function compileSource(source, filename, options) {
  let code = compiler.transform(source, { filename, generate: "dom", ...options }).code;
  if (filename.endsWith(".ts")) code = transformSync(code, { loader: "ts" }).code;
  return code;
}

/** Write a module whose runtime import resolves to `runtime` — a file URL
 * for node's loader, or a plain absolute path for a bundler. */
export function writeModule(outDir, name, code, { runtime = SIGNALS_PROD, url = true } = {}) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.mjs`);
  const specifier = url ? pathToFileURL(runtime).href : runtime;
  writeFileSync(file, code.replaceAll('"@solidjs/signals"', JSON.stringify(specifier)));
  return file;
}
