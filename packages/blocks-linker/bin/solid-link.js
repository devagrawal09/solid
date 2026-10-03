#!/usr/bin/env node
// solid-link — regenerate (default) or check (--check) the blocks type
// linker's output. Options: --root <dir> --out <file> --dir <src dir>
// (repeatable) --alias <prefix>=<dir> (repeatable) --public <module>
// (repeatable). Exit code 1 on a stale file (--check) or a parse error.
import { createLinker } from "../src/index.js";
import path from "node:path";

const args = process.argv.slice(2);
// No --alias: the tsconfig.json `paths` of the root are the aliases.
const opts = { dirs: [], alias: undefined, publicModules: [] };
let check = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--check") check = true;
  else if (a === "--root") opts.root = args[++i];
  else if (a === "--out") opts.out = args[++i];
  else if (a === "--dir") opts.dirs.push(args[++i]);
  else if (a === "--alias") {
    const [k, v] = args[++i].split("=");
    (opts.alias ||= {})[k] = v;
  } else if (a === "--public") opts.publicModules.push(args[++i]);
  else if (a === "--help" || a === "-h") {
    console.log(
      "usage: solid-link [--check] [--root dir] [--out file] [--dir srcdir] [--alias ~=src] [--public module]"
    );
    process.exit(0);
  }
}
if (!opts.dirs.length) delete opts.dirs;

const started = performance.now();
const linker = createLinker(opts).scan();
const rel = path.relative(process.cwd(), linker.out);
let failed = false;
if (check) {
  const { stale, diagnostics } = linker.check();
  for (const d of diagnostics) {
    console.error(`${d.level}: [${d.code}] ${d.message}`);
    if (d.level === "error") failed = true;
  }
  if (stale) {
    console.error(`[LINK_STALE] ${rel} is stale: run \`solid-link\` and commit it.`);
    failed = true;
  } else
    console.log(
      `${rel} is up to date (${linker.modules.size} modules, ${(performance.now() - started).toFixed(0)} ms)`
    );
} else {
  const { changed, diagnostics } = linker.write();
  for (const d of diagnostics) {
    console.error(`${d.level}: [${d.code}] ${d.message}`);
    if (d.level === "error") failed = true;
  }
  console.log(
    `${changed ? "wrote" : "unchanged"} ${rel} (${linker.modules.size} modules, ${(performance.now() - started).toFixed(0)} ms)`
  );
}
process.exit(failed ? 1 : 0);
