#!/usr/bin/env node
// Behavioral gate for the oracle variants: each variant must leave the same
// sink state (last values and effect-phase run count) as the baseline after
// mount and after every op, on a graph where its assumed fact actually holds.
// An oracle that fails here is measuring a different program.
//
//   node scripts/heuristics/equivalence.mjs [--n 50] [--rounds 7]
import { join } from "node:path";
import { cells, parseArgs, ROOT, snapshotRuntimes, writeModule } from "./common.mjs";
import { SCENARIOS } from "./scenarios.mjs";

snapshotRuntimes();

const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 50);
const ROUNDS = Number(args.rounds ?? 7);
const dir = join(ROOT, "node_modules/.cache/heuristics/equivalence");

async function trace(file) {
  const { make } = await import(file);
  const app = make(N);
  const out = [];
  app.mount();
  out.push(JSON.stringify(app.sink));
  for (let r = 0; r < ROUNDS; r++)
    for (const [name, op] of Object.entries(app.ops)) {
      op();
      out.push(`${name}:${JSON.stringify(app.sink)}`);
    }
  app.unmount();
  return out;
}

let failed = 0;
for (const scenario of SCENARIOS) {
  const reference = await trace(
    writeModule(dir, `${scenario.name}.baseline.prod`, scenario.variants.baseline, "prod")
  );
  for (const cell of cells(scenario)) {
    const got = await trace(
      writeModule(
        dir,
        `${scenario.name}.${cell.variant}.${cell.runtime}`,
        scenario.variants[cell.variant],
        cell.runtime
      )
    );
    const at = got.findIndex((s, i) => s !== reference[i]);
    if (at === -1) console.log(`ok    ${scenario.name} ${cell.label}`);
    else {
      failed++;
      console.log(`FAIL  ${scenario.name} ${cell.label} at step ${at}`);
      console.log(`      expected ${reference[at]}\n      received ${got[at]}`);
    }
  }
}
process.exit(failed ? 1 : 0);
