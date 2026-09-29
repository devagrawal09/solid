#!/usr/bin/env node
// Register another tree's @solidjs/signals prod build as a blocks-v2 runtime
// snapshot (documentation/plans/vs-upstream-v2.md), so
// `scripts/blocks-v2/compare.mjs --runtimes <name>` can run the HANDWRITTEN
// cells against it.
//
//   node scripts/vs-upstream/snapshot-upstream.mjs <tree> [--name upstream]
//
// Copies <tree>/packages/signals/dist/prod to
// node_modules/.cache/blocks-v2/runtimes/<name>-prod and writes
// runtimes/<name>/index.js: a re-export of it plus inert stand-ins for the
// four block entry points scripts/blocks-v2/fake-web.mjs imports
// (isBlock/blockFlags/renderBlock/dispatchBlock), which a tree without
// generator blocks does not export. Handwritten cells never create a block,
// so `isBlock` is always false there and the other three are never reached
// (they throw if they are).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const tree = resolve(args[0]);
const name = args.includes("--name") ? args[args.indexOf("--name") + 1] : "upstream";
const runtimes = join(ROOT, "node_modules/.cache/blocks-v2/runtimes");
const src = join(tree, "packages/signals/dist/prod");
const prod = join(runtimes, `${name}-prod`);
rmSync(prod, { recursive: true, force: true });
cpSync(src, prod, { recursive: true });
const exported = new Set(
  [...readFileSync(join(prod, "index.js"), "utf8").matchAll(/export\s*\{([^}]*)\}/g)]
    .flatMap(m => m[1].split(","))
    .map(s => s.trim().split(/\s+as\s+/).pop())
    .filter(Boolean)
);
const stubs = {
  isBlock: "() => false",
  blockFlags: "() => 0",
  renderBlock: '() => { throw new Error("renderBlock: not in this runtime"); }',
  dispatchBlock: '() => { throw new Error("dispatchBlock: not in this runtime"); }'
};
let shim = `export * from "../${name}-prod/index.js";\n`;
for (const [k, v] of Object.entries(stubs)) if (!exported.has(k)) shim += `export const ${k} = ${v};\n`;
mkdirSync(join(runtimes, name), { recursive: true });
writeFileSync(join(runtimes, name, "index.js"), shim);
console.log(`snapshot ${name}: ${join(runtimes, name)} (${exported.size} exports; stubbed: ${Object.keys(stubs).filter(k => !exported.has(k)).join(", ") || "none"})`);
