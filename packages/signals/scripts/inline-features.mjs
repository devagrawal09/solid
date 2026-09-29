#!/usr/bin/env node
/**
 * Inlines the link-time feature switches (src/core/features.ts) into a
 * per-module dist tree as MARKED LITERALS:
 *
 *   import { STORES } from "./features.js";   →   import "./features.js";
 *   STORES && x                                →   /* @solid-feature STORES *\/ true && x
 *
 * Why: an imported binding is a module-cell load in V8 at every use (it is
 * not constant-folded), and the switches sit on the hottest paths (read,
 * recompute, insertSubs, the node literals). A consumer that loads the tree
 * unbundled (Node SSR externals, benchmarks, tests) paid one cell load and
 * branch per switch test: +7–13% instructions on handwritten update paths vs
 * the pre-switch runtime (documentation/plans/vs-upstream-v2.md, "Handwritten
 * path regression"). A literal `true` is folded by V8's bytecode generator
 * and by every app bundler, exactly like the imported constant was.
 *
 * The capability linker (`@solidjs/compiler/capabilities`) turns a switch off
 * by rewriting the marked literals of that switch to `false` in the tree's
 * modules (and still substitutes `core/features.js` for any importer that
 * reads it). The marker comment is the contract: keep its spelling in sync
 * with FEATURE_MARKER in packages/compiler/capabilities.js.
 *
 * Runs after scripts/mangle-props.mjs (terser would otherwise re-print the
 * comments). Each argument is a tree root containing core/features.js; the
 * values inlined are that tree's published defaults.
 *
 * Usage: node scripts/inline-features.mjs <tree> [...]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseAst } from "rollup/parseAst";

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (/\.js$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

/** Every Identifier node that is a variable reference, with its parent. */
function references(node, parent, out) {
  if (!node || typeof node.type !== "string") return out;
  if (node.type === "Identifier") {
    const nonRef =
      (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
      ((parent?.type === "Property" ||
        parent?.type === "MethodDefinition" ||
        parent?.type === "PropertyDefinition") &&
        parent.key === node &&
        !parent.computed &&
        !parent.shorthand) ||
      parent?.type === "ImportSpecifier" ||
      parent?.type === "ImportDefaultSpecifier" ||
      parent?.type === "ImportNamespaceSpecifier" ||
      parent?.type === "ExportSpecifier" ||
      parent?.type === "LabeledStatement" ||
      parent?.type === "BreakStatement" ||
      parent?.type === "ContinueStatement";
    if (!nonRef) out.push({ node, parent });
    return out;
  }
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const v of value) references(v, node, out);
    else if (value && typeof value === "object") references(value, node, out);
  }
  return out;
}

export const FEATURE_MARKER = "@solid-feature";

for (const tree of process.argv.slice(2)) {
  const defaults = Object.fromEntries(
    [
      ...readFileSync(join(tree, "core/features.js"), "utf8").matchAll(
        /export const (\w+) = (true|false);/g
      )
    ].map(m => [m[1], m[2]])
  );
  if (!Object.keys(defaults).length) throw new Error(`${tree}: no switches in core/features.js`);
  let files = 0;
  let sites = 0;
  for (const file of walk(tree)) {
    if (relative(tree, file) === join("core", "features.js")) continue;
    const code = readFileSync(file, "utf8");
    if (!/features\.js["']/.test(code)) continue;
    const ast = parseAst(code);
    const edits = [];
    const local = new Map();
    for (const stmt of ast.body) {
      if (stmt.type !== "ImportDeclaration" || !/(^|\/)features\.js$/.test(stmt.source.value))
        continue;
      if (!stmt.specifiers.length) continue;
      for (const s of stmt.specifiers) {
        const name = s.imported?.name;
        if (s.type !== "ImportSpecifier" || !(name in defaults))
          throw new Error(`${file}: unexpected features import ${code.slice(s.start, s.end)}`);
        local.set(s.local.name, name);
      }
      edits.push({ start: stmt.start, end: stmt.end, text: `import ${JSON.stringify(stmt.source.value)};` });
    }
    if (!local.size) continue;
    for (const { node, parent } of references(ast, null, [])) {
      const name = local.get(node.name);
      if (!name) continue;
      if (
        (parent?.type === "VariableDeclarator" && parent.id === node) ||
        (parent?.type === "FunctionDeclaration" && parent.id === node) ||
        parent?.type === "AssignmentExpression" && parent.left === node
      )
        throw new Error(`${file}: ${node.name} is declared or assigned locally`);
      const literal = `/* ${FEATURE_MARKER} ${name} */ ${defaults[name]}`;
      // `{ STORES }` shorthand property: keep the key.
      const text = parent?.type === "Property" && parent.shorthand ? `${node.name}: ${literal}` : literal;
      edits.push({ start: node.start, end: node.end, text });
      sites++;
    }
    edits.sort((a, b) => b.start - a.start);
    let out = code;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    writeFileSync(file, out);
    files++;
  }
  console.log(`inlined ${sites} feature switch sites across ${files} files in ${tree}`);
}
