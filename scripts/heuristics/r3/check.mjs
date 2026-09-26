#!/usr/bin/env node
// Equivalence gate for round 3: every non-bound cell of a scenario must leave
// the same observable sink as baseline@prod after mount and after each op
// (run 5 times). `bound` cells are floors, not equivalent programs.
//
//   node scripts/heuristics/r3/check.mjs [--n 50]
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, ROOT, snapshotRuntimes, writeModule } from "../common.mjs";
import { SCENARIOS3 } from "./scenarios.mjs";

snapshotRuntimes();
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 50);
const dir = join(ROOT, "node_modules/.cache/heuristics/r3/check");
let failed = 0;
for (const s of SCENARIOS3) {
  const traces = [];
  for (const c of s.cells) {
    const file = writeModule(dir, `${s.name}.${c.label.replace(/\W/g, "_")}`, c.source, c.runtime);
    const app = (await import(pathToFileURL(file).href)).make(N);
    const trace = [];
    app.mount();
    trace.push(JSON.stringify(app.sink));
    for (const op of s.ops.filter(o => o !== "mount"))
      for (let i = 0; i < 5; i++) {
        app.ops[op]();
        trace.push(`${op}:${JSON.stringify(app.sink)}`);
      }
    app.unmount();
    traces.push({ c, trace });
  }
  const base = traces[0].trace;
  for (const { c, trace } of traces.slice(1)) {
    const same = JSON.stringify(trace) === JSON.stringify(base);
    const tag = same ? "same" : c.bound ? "differs (bound, expected)" : "DIFFERS";
    if (!same && !c.bound) {
      failed++;
      console.log(base.join("\n"), "\n---\n", trace.join("\n"));
    }
    console.log(`${s.name.padEnd(12)} ${c.label.padEnd(24)} ${tag}`);
  }
}
process.exit(failed ? 1 : 0);
