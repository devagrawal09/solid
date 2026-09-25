#!/usr/bin/env node
/**
 * Strict store paths (Track B, slice 2): real minified output size.
 *
 * Compiles one representative strict-mode module (typed `$` blocks with
 * direct store paths — shallow, deep, dynamic, list rows) with a compiler
 * build, bundles it against a signals production build (`dist/prod`) with
 * esbuild (bundle + minify + tree-shake, ESM, browser), and reports raw /
 * gzip -9 / brotli -q11 bytes for:
 *
 *   app      the compiled module alone, minified (runtime external)
 *   bundle   the module + the runtime it pulls in
 *   compat   a store-only app with no `$` (handwritten proxy reads): the
 *            runtime cost every non-strict app pays for this change
 *
 * Usage:
 *   node scripts/size-store-paths.mjs --label current \
 *     [--repo <checkout>] [--json out.json] [--handles]
 * `--repo` points at another checkout (e.g. a base worktree) whose
 * `packages/signals/dist/prod` and `packages/compiler` build are used;
 * `--handles` compiles with the stage-2 `storeHandles` option.
 */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const repo = resolve(opt("repo", join(here, "../../..")));
const label = opt("label", "current");
const handles = args.includes("--handles");
const require = createRequire(import.meta.url);
const compiler = require(join(repo, "packages/compiler"));
const runtime = join(repo, "packages/signals/dist/prod/index.js");

// A representative strict module: one store, reads of every shape.
export const STRICT_APP = `
import { $, createMemo, createRoot, createSignal, createStore, flush } from "solid-js";

export function app(rows) {
  return createRoot(() => {
    const [store, setStore] = createStore({
      user: { name: "Ada", address: { city: "London", zip: "N1" }, prefs: { theme: { mode: "dark" } } },
      filter: "all",
      items: rows,
      count: 0
    });
    const [index, setIndex] = createSignal(0);
    const name = createMemo($(function* () { return yield* store.user.name; }));
    const city = createMemo($(function* () { return yield* store.user.address.city; }));
    const mode = createMemo($(function* () { return yield* store.user.prefs.theme.mode; }));
    const filter = createMemo($(function* () { return yield* store.filter; }));
    const count = createMemo($(function* () { return yield* store.count; }));
    const length = createMemo($(function* () { return yield* store.items.length; }));
    const current = createMemo($(function* () {
      const i = yield* index;
      return \`\${yield* store.items[i].title}:\${yield* store.items[i].meta.done}\`;
    }));
    const summary = createMemo($(function* () {
      return \`\${yield* name} in \${yield* city} (\${yield* mode}) \${yield* filter} \${yield* count}/\${yield* length}\`;
    }));
    const labels = [];
    for (let i = 0; i < rows.length; i++) {
      const row = store.items[i];
      labels.push(createMemo($(function* () {
        return \`\${yield* row.title}\${(yield* row.meta.done) ? " ✓" : ""}\`;
      })));
    }
    return { summary, current, labels, setStore, setIndex, flush };
  });
}
`;

// The same reads handwritten (no `$`): what a non-strict app ships.
const COMPAT_APP = `
import { createMemo, createRoot, createSignal, createStore, flush } from "solid-js";
export function app(rows) {
  return createRoot(() => {
    const [store, setStore] = createStore({
      user: { name: "Ada", address: { city: "London", zip: "N1" }, prefs: { theme: { mode: "dark" } } },
      filter: "all", items: rows, count: 0
    });
    const [index, setIndex] = createSignal(0);
    const summary = createMemo(() =>
      \`\${store.user.name} in \${store.user.address.city} (\${store.user.prefs.theme.mode}) \${store.filter} \${store.count}/\${store.items.length}\`);
    const current = createMemo(() => \`\${store.items[index()].title}:\${store.items[index()].meta.done}\`);
    const labels = rows.map((_, i) => { const row = store.items[i]; return createMemo(() => row.title + (row.meta.done ? " ✓" : "")); });
    return { summary, current, labels, setStore, setIndex, flush };
  });
}
`;

function sizes(code) {
  const buf = Buffer.from(code);
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: 1 }
    }).length
  };
}

async function bundle(entry, external) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    write: false,
    treeShaking: true,
    external: external ? ["solid-js"] : [],
    alias: external ? undefined : { "solid-js": runtime },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent"
  });
  return result.outputFiles[0].text;
}

const dir = mkdtempSync(join(tmpdir(), "store-paths-size-"));
try {
  const compiled = compiler.transform(STRICT_APP, {
    filename: "app.js",
    generate: "dom",
    ...(handles ? { storeHandles: true } : {})
  }).code;
  const strictFile = join(dir, "strict.js");
  const compatFile = join(dir, "compat.js");
  writeFileSync(strictFile, compiled);
  writeFileSync(compatFile, COMPAT_APP);
  const out = {
    label,
    repo,
    handles,
    app: sizes(await bundle(strictFile, true)),
    bundle: sizes(await bundle(strictFile, false)),
    compat: sizes(await bundle(compatFile, false)),
    compiled
  };
  const json = opt("json", null);
  if (json) writeFileSync(json, JSON.stringify(out, null, 2));
  const row = (name, s) =>
    `  ${name.padEnd(7)} raw ${String(s.raw).padStart(6)}  gzip ${String(s.gzip).padStart(6)}  brotli ${String(
      s.brotli
    ).padStart(6)}`;
  console.log(`${label}${handles ? " (storeHandles)" : ""}`);
  console.log(row("app", out.app));
  console.log(row("bundle", out.bundle));
  console.log(row("compat", out.compat));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
