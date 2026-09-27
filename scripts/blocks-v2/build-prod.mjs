#!/usr/bin/env node
// Rebuild only packages/signals/dist/prod (what the benchmarks load): the
// prod rollup tree + the `_`-property mangle pass. `--snapshot <name>` also
// copies the result to node_modules/.cache/blocks-v2/runtimes/<name>, so a
// later run can measure it with `--runtime`.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../track-a/compile.mjs";
import { parseArgs } from "./build.mjs";

const args = parseArgs(process.argv.slice(2));
const pkg = join(ROOT, "packages/signals");
const t0 = Date.now();
execFileSync(
  process.execPath,
  [join(pkg, "node_modules/rollup/dist/bin/rollup"), "-c", join(ROOT, "scripts/blocks-v2/rollup.prod.config.mjs"), "--silent"],
  { cwd: pkg, stdio: "inherit" }
);
execFileSync(process.execPath, ["./scripts/mangle-props.mjs", "dist/prod"], { cwd: pkg, stdio: "inherit" });
if (args.snapshot) {
  const dest = join(ROOT, "node_modules/.cache/blocks-v2/runtimes", args.snapshot);
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(pkg, "dist/prod"), dest, { recursive: true });
  console.log(`snapshot: ${dest}`);
}
console.log(`built dist/prod in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
