#!/usr/bin/env node
// The frames report of examples/hackernews-sc-blocks (the `.vite/solid-frames.json`
// its build writes): every derived frame, its arguments and server
// functions, the islands its HTML carries and how each is keyed, the
// candidates that are not frames and why, and the route table.
//
//   node scripts/ssr-redesign/sc-manifest.mjs [--out file]
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { IslandsCompiler, framesReport } = require(join(ROOT, "packages/compiler/islands-build.js"));
const app = join(ROOT, "examples/hackernews-sc-blocks");
const compiler = new IslandsCompiler({ keyedState: true });
const collected = compiler.collect(join(app, "src/app.tsx"));
const report = framesReport(collected, app);
const text = JSON.stringify(report, null, 2) + "\n";
const i = process.argv.indexOf("--out");
if (i > 0) writeFileSync(process.argv[i + 1], text);
else process.stdout.write(text);
