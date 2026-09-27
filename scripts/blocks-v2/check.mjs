#!/usr/bin/env node
// Equivalence check: every variant of a scenario renders the same tree and
// sink after mount and after each of three updates.
//
//   node scripts/blocks-v2/check.mjs [--runtime packages/signals/dist/prod]
import { pathToFileURL } from "node:url";
import { buildModules, parseArgs } from "./build.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const args = parseArgs(process.argv.slice(2));
const modules = buildModules({ runtime: args.runtime, tag: "check" });
const N = 3;
let failed = false;
for (const scenario of SCENARIOS) {
  const traces = {};
  for (const variant of Object.keys(VARIANTS)) {
    const { make } = await import(pathToFileURL(modules[`${scenario.name}/${variant}`]).href);
    const app = make(N);
    const trace = [];
    try {
      app.mount();
      trace.push(app.snapshot());
      for (let i = 0; i < 3; i++) {
        const r = app.update();
        if (r) await r;
        trace.push(app.snapshot());
      }
      app.unmount();
    } catch (e) {
      trace.push("THREW " + (e && e.message));
    }
    traces[variant] = trace.join("  ");
  }
  const base = traces.handwritten;
  for (const [variant, trace] of Object.entries(traces)) {
    const same = trace === base;
    if (!same) failed = true;
    console.log(`${same ? "ok  " : "DIFF"} ${scenario.name}/${variant}: ${trace}`);
  }
}
process.exit(failed ? 1 : 0);
