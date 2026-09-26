#!/usr/bin/env node
// Builds the oracle + async-free signals tree into
// node_modules/.cache/heuristics/stack-a/oracle-sync and property-mangles it
// like dist/sync. Touches nothing under packages/.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const cwd = join(ROOT, "packages/signals");
const OUT = join(ROOT, "node_modules/.cache/heuristics/stack-a/oracle-sync");
rmSync(OUT, { recursive: true, force: true });
const run = (cmd, args) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
run("npx", ["rollup", "-c", join(here, "rollup.oracle-sync.config.mjs")]);
run("node", ["./scripts/mangle-props.mjs", OUT]);
