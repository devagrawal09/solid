// Test/bench harness: a Rollup build of a fixture app with the native Solid
// compiler (JSX + `$` lowering), esbuild (TS stripping), optional cold
// event-domain extraction, and optional minification.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { rollup } from "rollup";
import nodeResolve from "@rollup/plugin-node-resolve";
import esbuild from "esbuild";
import { solidColdEvents } from "../../src/plugin.js";

const require = createRequire(import.meta.url);
const { transform } = require("@solidjs/compiler");
export const runtimeModule = fileURLToPath(new URL("../../src/runtime.js", import.meta.url));

export function solidCompile({ generate = "dom" } = {}) {
  return {
    name: "solid-compile",
    transform(code, id) {
      if (id.startsWith("\0") || /[\\/]node_modules[\\/]/.test(id) || !/\.[jt]sx?$/.test(id))
        return null;
      if (id === runtimeModule || /[\\/]packages[\\/](solid|web|signals)[\\/]/.test(id))
        return null;
      const result = transform(code, {
        filename: id,
        generate,
        sourceMap: true,
        hydratable: false
      });
      return { code: result.code, map: result.map };
    }
  };
}

export function stripTypes() {
  return {
    name: "strip-types",
    transform(code, id) {
      if (id.startsWith("\0") || !/\.tsx?$/.test(id)) return null;
      const result = esbuild.transformSync(code, {
        loader: "ts",
        sourcemap: "external",
        sourcefile: id,
        format: "esm"
      });
      return { code: result.code, map: result.map };
    }
  };
}

export function aliases(map) {
  return {
    name: "aliases",
    resolveId(source) {
      return map[source] ?? null;
    }
  };
}

export function minify() {
  return {
    name: "minify",
    renderChunk(code) {
      const result = esbuild.transformSync(code, {
        minify: true,
        format: "esm",
        sourcemap: "external",
        target: "es2022"
      });
      return { code: result.code, map: result.map };
    }
  };
}

/**
 * Build `input` (absolute) into `outDir`. `cold`: false | plugin options.
 * Returns `{ output, manifest, analysis, plan, time }`.
 */
export async function buildApp({
  root,
  input,
  outDir,
  cold = false,
  aliasMap = {},
  minified = false,
  sourcemap = true
}) {
  const started = performance.now();
  let analysis = null;
  let plan = null;
  const plugins = [aliases({ "@solidjs/linker/runtime": runtimeModule, ...aliasMap })];
  if (cold) {
    plugins.push(
      solidColdEvents({
        root,
        runtimeModule,
        ...cold,
        onAnalysis(a, p) {
          analysis = a;
          plan = p;
        }
      })
    );
  }
  plugins.push(
    nodeResolve({
      browser: true,
      exportConditions: ["browser", "import", "default"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      dedupe: ["solid-js", "@solidjs/web"]
    }),
    solidCompile(),
    stripTypes()
  );
  if (minified) plugins.push(minify());
  const bundle = await rollup({ input, plugins, onwarn: () => {} });
  fs.rmSync(outDir, { recursive: true, force: true });
  const { output } = await bundle.write({
    dir: outDir,
    format: "es",
    sourcemap,
    entryFileNames: "[name]-[hash].js",
    chunkFileNames: "[name]-[hash].js"
  });
  await bundle.close();
  const manifestFile = path.join(outDir, "solid-link-manifest.json");
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(fs.readFileSync(manifestFile, "utf8"))
    : null;
  return { output, manifest, analysis, plan, time: performance.now() - started };
}
