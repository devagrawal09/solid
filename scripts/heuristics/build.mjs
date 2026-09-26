#!/usr/bin/env node
// Builds packages/signals/dist/oracle: the prod tree with the __ORACLE__ arms
// compiled in, property-mangled like dist/prod. Run after the regular
// `pnpm --filter @solidjs/signals build` (dist/prod and dist/sync).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./common.mjs";

const cwd = join(ROOT, "packages/signals");
const run = (cmd, args) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
run("npx", ["rollup", "-c", "rollup.oracle.config.js"]);
run("node", ["./scripts/mangle-props.mjs", "dist/oracle"]);
