#!/usr/bin/env node
// Islands manifest of the `-blocks` example twins.
//
//   node scripts/example-blocks/islands.mjs [twin …] [--json]
//
// Runs `compileIslands` (packages/compiler) on every module of each twin
// that defines a `$component`, passing its relatively imported modules as
// `imports` (cross-module inlining, as the bundler plugin does), and prints
// per module: the inert components, the islands (root, members, tier,
// activation) and the fallback reason, if any.
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { compileIslands } = require(join(ROOT, "packages/compiler/index.js"));

const args = process.argv.slice(2);
const json = args.includes("--json");
const names = args.filter(a => !a.startsWith("--"));
const twins = names.length
  ? names
  : readdirSync(join(ROOT, "examples")).filter(
      d =>
        d.endsWith("-blocks") &&
        !["todos-blocks", "sync-blocks"].includes(d) &&
        statSync(join(ROOT, "examples", d)).isDirectory()
    );

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(f.name) && !f.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function resolveImport(from, spec) {
  const base = resolve(dirname(from), spec);
  for (const ext of ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"]) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

function importsOf(file, code) {
  const out = [];
  for (const m of code.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const p = resolveImport(file, m[1]);
    if (p) out.push({ specifier: m[1], filename: p, code: readFileSync(p, "utf8") });
  }
  return out;
}

const report = {};
for (const twin of twins) {
  const dir = join(ROOT, "examples", twin);
  const files = [dir]
    .flatMap(d => ["src", "shared/src"].map(s => join(d, s)))
    .flatMap(d => walk(d))
    .filter(f => /\$component\s*[(<]/.test(readFileSync(f, "utf8")));
  report[twin] = {};
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const rel = relative(dir, file);
    let result;
    try {
      result = compileIslands(code, {
        filename: file,
        idPrefix: rel.replace(/\W+/g, "_"),
        imports: importsOf(file, code)
      });
    } catch (error) {
      report[twin][rel] = { error: String(error.message ?? error).split("\n")[0] };
      continue;
    }
    const m = result.manifest;
    report[twin][rel] = {
      fallback: result.fallback,
      streams: m.streams,
      inert: m.components.filter(c => c.class === "inert").map(c => c.name),
      islands: m.islands.map(i => ({
        root: i.root,
        members: i.members,
        tier: i.tier,
        activation: i.activation,
        why: i.why,
        notes: i.notes
      }))
    };
  }
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const [twin, mods] of Object.entries(report)) {
    console.log(`\n## ${twin}`);
    for (const [mod, r] of Object.entries(mods)) {
      if (r.error) {
        console.log(`- ${mod}: compileIslands threw: ${r.error}`);
        continue;
      }
      const islands = r.islands
        .map(
          i =>
            `${i.root}${i.members.length > 1 ? ` [${i.members.join(", ")}]` : ""} (tier ${i.tier}, ${i.activation}${i.why.length ? `; ${i.why.join("; ")}` : ""})`
        )
        .join("; ");
      console.log(
        `- ${mod}: ${r.fallback ? `FALLBACK: ${r.fallback}` : "compiled"}` +
          `${r.streams ? " (streams)" : ""}\n    inert: ${r.inert.join(", ") || "none"}\n    islands: ${islands || "none"}`
      );
    }
  }
}
