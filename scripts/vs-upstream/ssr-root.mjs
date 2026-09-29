#!/usr/bin/env node
// Stage the branch's SSR / hydration harness (scripts/ssr-redesign) against
// any Solid tree (documentation/plans/vs-upstream-v2.md):
//
//   node scripts/vs-upstream/ssr-root.mjs <tree> <out-dir>
//   node <out-dir>/scripts/ssr-redesign/measure.mjs --apps hn,todos-hw --only A ...
//
// <out-dir> becomes a stand-in repo root: packages/ and examples/ are
// symlinks into <tree> (esbuild resolves them to real paths, so the
// harness's packages/*/dist patterns still match), node_modules/ holds only
// esbuild (the harness's bundler, from this repo), and scripts/ssr-redesign
// is a copy of this repo's harness with four adaptations:
//   - packages/compiler/islands-build.js is optional (a tree without the
//     islands compiler can still run the non-island variants);
//   - the counter anchors on signals/dist/prod/core/core.js follow the
//     tree's own minified parameter names (computed / recompute / signal);
//   - `solid-js/internal` is aliased when the tree ships it (rc.9's web
//     imports it);
//   - one more app, `todos-hw`: the HANDWRITTEN examples/todos app with the
//     `todos` app's seed, session, identity probe and first interaction
//     (the harness's `todos` app is the generator-blocks port, todos-blocks).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [treeArg, outArg] = process.argv.slice(2);
const tree = resolve(treeArg);
const out = resolve(outArg);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "scripts"), { recursive: true });
mkdirSync(join(out, "node_modules"), { recursive: true });
symlinkSync(join(tree, "packages"), join(out, "packages"));
symlinkSync(join(tree, "examples"), join(out, "examples"));
const esbuildDir = dirname(createRequire(join(ROOT, "scripts/ssr-redesign/lib.mjs")).resolve("esbuild/package.json"));
symlinkSync(esbuildDir, join(out, "node_modules/esbuild"));
const harness = join(out, "scripts/ssr-redesign");
cpSync(join(ROOT, "scripts/ssr-redesign"), harness, { recursive: true });
cpSync(join(ROOT, "scripts/vs-upstream/ssr/todos-hw"), join(harness, "apps/todos-hw"), { recursive: true });

const replaceOnce = (src, from, to) => {
  if (src.split(from).length !== 2) throw new Error(`anchor not unique/found: ${from}`);
  return src.replace(from, () => to);
};
let lib = readFileSync(join(harness, "lib.mjs"), "utf8");
lib = replaceOnce(
  lib,
  'const islandsBuild = await import(pathToFileURL(join(ROOT, "packages/compiler/islands-build.js")).href);',
  'const islandsBuild = existsSync(join(ROOT, "packages/compiler/islands-build.js")) ? await import(pathToFileURL(join(ROOT, "packages/compiler/islands-build.js")).href) : null;'
);
lib = replaceOnce(lib, 'import { readFileSync } from "node:fs";', 'import { existsSync, readFileSync } from "node:fs";');
const core = readFileSync(join(tree, "packages/signals/dist/prod/core/core.js"), "utf8");
for (const [fn, anchor] of [
  ["computed", "function computed(e, t) {"],
  ["recompute", "function recompute(e, t = false) {"],
  ["signal", "function signal(e, t, n = null) {"]
]) {
  const actual = new RegExp(`function ${fn}\\([^)]*\\) \\{`).exec(core)?.[0];
  if (!actual) throw new Error(`no ${fn} in ${tree} core.js`);
  lib = lib.split(`"${anchor}", \`${anchor}`).join(`"${actual}", \`${actual}`);
}
// A tree whose @solidjs/web imports `solid-js/internal` (upstream rc.9): alias
// it to its dist next to the `solid-js` alias (which would otherwise map it
// to "<solid dist file>/internal").
if (existsSync(join(tree, "packages/solid/dist/internal.js")) && !lib.includes('"solid-js/internal"')) {
  const internal = '"solid-js/internal": join(ROOT, "packages/solid/dist/internal.js"), ';
  lib = replaceOnce(lib, 'alias: { "solid-js": DIST.solidServer,', `alias: { ${internal}"solid-js": DIST.solidServer,`);
  lib = replaceOnce(lib, ': { "solid-js": DIST.solid, "@solidjs/web": DIST.web,', `: { ${internal}"solid-js": DIST.solid, "@solidjs/web": DIST.web,`);
  lib = replaceOnce(lib, 'alias: dev\n      ? { "solid-js"', `alias: dev\n      ? { ${internal}"solid-js"`);
}
writeFileSync(join(harness, "lib.mjs"), lib);

let apps = readFileSync(join(harness, "apps.mjs"), "utf8");
apps += `
// vs-upstream: the handwritten examples/todos app, same seed/session/probes as \`todos\`.
APPS["todos-hw"] = {
  ...APPS.todos,
  variants: { A: { server: "apps/todos-hw/server.tsx", client: "apps/todos-hw/client.tsx" } }
};
`;
writeFileSync(join(harness, "apps.mjs"), apps);
console.log(`staged ${harness} -> ${tree}`);
