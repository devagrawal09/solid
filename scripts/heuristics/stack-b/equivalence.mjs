#!/usr/bin/env node
// Stack-B gate (adapted from ../equivalence.mjs):
//  1. every oracle the cell claims is present in its generated module
//     (counts of fused effects / detached / ownerless / statusFree nodes);
//  2. (runtime proof that the oracle runtime honours each bit: probe.mjs);
//  3. each cell's sink trace (values + effect-phase run counts after mount
//     and after every op, 7 rounds) equals the scenario's first cell.
//
//   taskset -c 2,3 node scripts/heuristics/stack-b/equivalence.mjs [--n 50] [--rounds 7] [--out file]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CACHE, OUT_DIR, parseArgs, snapshotRuntimes, writeModule } from "./common.mjs";
import { SCENARIOS } from "./scenarios.mjs";

snapshotRuntimes();
const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 50);
const ROUNDS = Number(args.rounds ?? 7);
const dir = join(CACHE, "equivalence");

async function trace(file) {
  const { make } = await import(file);
  const app = make(N);
  const out = [];
  // Mount twice (the icount mount op re-creates the graph on shared sources).
  app.mount();
  app.unmount();
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

const count = (s, needle) => s.split(needle).length - 1;
const report = [];
let failed = 0;
for (const scenario of SCENARIOS) {
  const [refCell] = scenario.cells;
  const reference = await trace(writeModule(dir, `${scenario.name}.ref`, refCell.source, refCell.runtime));
  for (const cell of scenario.cells) {
    const file = writeModule(dir, `${scenario.name}.${cell.label.replace(/[^\w.+-]/g, "_")}`, cell.source, cell.runtime);
    const text = readFileSync(file, "utf8");
    const missing = cell.fired.filter(m => !text.includes(m));
    const markers = {
      fusedEffects: count(text, "equals: same"),
      detached: count(text, "oracle: DET"),
      ownerlessOnly: count(text, "oracle: OWN"),
      statusFree: count(text, "...statusFree"),
      projection: count(text, "createProjection("),
      rootId: count(text, 'id: "r"'),
      memos: count(text, "createMemo(")
    };
    const got = await trace(file);
    const at = got.findIndex((s, i) => s !== reference[i]);
    // Negative control: the same cell with every fused effect's `equals`
    // removed (a plain syntactic inline). Reported, not gated: it diverges
    // only where the fused compute can return an equal value.
    let brokenDiverges = null;
    if (markers.fusedEffects) {
      const broken = writeModule(dir, `${scenario.name}.${cell.label.replace(/[^\w.+-]/g, "_")}.broken`, cell.source.replaceAll("equals: same", "equals: undefined"), cell.runtime);
      const b = await trace(broken);
      brokenDiverges = b.some((s, i) => s !== reference[i]);
    }
    markers.brokenDiverges = brokenDiverges;
    const ok = at === -1 && got.length === reference.length && missing.length === 0;
    if (!ok) failed++;
    report.push({ scenario: scenario.name, cell: cell.label, runtime: cell.runtime, ok, missing, markers, steps: got.length });
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${scenario.name.padEnd(6)} ${cell.label.padEnd(22)} ${JSON.stringify(markers)}` +
        (missing.length ? `  missing ${missing}` : "") +
        (at !== -1 ? `\n      step ${at}: expected ${reference[at]}\n                received ${got[at]}` : "")
    );
  }
}
if (args.out) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, args.out), JSON.stringify({ n: N, rounds: ROUNDS, report }, null, 2) + "\n");
}
process.exit(failed ? 1 : 0);
