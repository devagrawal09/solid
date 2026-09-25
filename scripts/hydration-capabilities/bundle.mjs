// Shared bundling for the slice-7 (capability-selected hydration runtime)
// measurements. Bundles a fixture graph from
// packages/web/test/harness/capability-apps/ against the BUILT production
// artifacts (the same aliases scripts/size/.size-limit.js uses), with JSX
// compiled by the native compiler exactly like the Vite plugin does for a
// hydratable client build. Requires `pnpm build` output for signals, solid,
// and web (including web's hydration-manifest subpath).
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const APPS_DIR = join(ROOT, "packages/web/test/harness/capability-apps");
export const MANIFEST_DIR = join(ROOT, "packages/web/test/hydration-capabilities/manifests");
export const ARTIFACT_DIR = join(ROOT, "packages/web/test/harness/__capability_artifacts__");

const require = createRequire(import.meta.url);
const compiler = require(join(ROOT, "packages/compiler/index.js"));

// SLICE7_DIST_ROOT points at a directory holding solid/, web/ and signals/
// dist copies (e.g. a pre-change baseline) instead of the packages' own.
// The copies need a package.json with "sideEffects": false next to them, as
// the packages have — without it the bundler keeps whole modules the
// packages let it drop, and the comparison is meaningless.
const DIST = process.env.SLICE7_DIST_ROOT;
export const PROD_ALIAS = DIST
  ? distAlias(DIST)
  : {
      "solid-js": join(ROOT, "packages/solid/dist/solid.js"),
      "@solidjs/web": join(ROOT, "packages/web/dist/web.js"),
      "@solidjs/signals": join(ROOT, "packages/signals/dist/prod/index.js")
    };

export const APPS = ["sync", "store", "async", "streaming", "lazy", "full"];

export async function loadManifestTools() {
  return import(join(ROOT, "packages/web/hydration-manifest/dist/hydration-manifest.js"));
}

export function readManifest(name) {
  return JSON.parse(readFileSync(join(MANIFEST_DIR, `${name}.json`), "utf-8"));
}

function compileJsx({ hydratable }) {
  return {
    name: "solid-compiler",
    setup(b) {
      b.onLoad({ filter: /capability-apps[\\/].*\.tsx$/ }, args => {
        const source = readFileSync(args.path, "utf-8");
        const { code } = compiler.transform(source, {
          generate: "dom",
          hydratable,
          dev: false,
          filename: args.path
        });
        return { contents: code, loader: "ts", resolveDir: dirname(args.path) };
      });
    }
  };
}

/**
 * Bundle `entrySource` (an ES module; may import "solid-js", "@solidjs/web",
 * and absolute paths) the way the size gate does: esbuild, minified, browser,
 * tree-shaken. Returns the code and its raw/gzip/brotli sizes.
 */
export function distAlias(root) {
  return {
    "solid-js": join(root, "solid/solid.js"),
    "@solidjs/web": join(root, "web/web.js"),
    "@solidjs/signals": join(root, "signals/prod/index.js")
  };
}

export async function bundle(
  entrySource,
  {
    hydratable = true,
    format = "esm",
    workDir,
    alias = PROD_ALIAS,
    minify = true,
    external = []
  } = {}
) {
  mkdirSync(workDir, { recursive: true });
  const entry = join(workDir, `entry-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(entry, entrySource);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify,
    format,
    external,
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    logLevel: "silent",
    alias,
    plugins: [compileJsx({ hydratable })],
    define: { "process.env.NODE_ENV": '"production"' }
  });
  const code = result.outputFiles[0].text;
  return { code, ...sizes(code) };
}

export function sizes(code) {
  const buf = Buffer.from(code);
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT
      }
    }).length
  };
}
