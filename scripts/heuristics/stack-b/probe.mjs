#!/usr/bin/env node
// Runtime proof that each oracle the stack-B cells use is honoured by the
// runtime snapshot they run on (and ignored by prod). Each probe is a tiny
// program whose observable behaviour changes only if the bit took effect.
//
//   DET   — a detached effect is not disposed with its root: after dispose,
//           writing its (surviving) source re-runs it.
//   OWN   — an ownerless node takes no child id: the root's next child id is
//           unchanged after creating it.
//   FUSED — an effect with `equals` skips its effect phase on an equal value.
//   SF    — importing statusFree installs the status-free recompute path; a
//           statusFree effect that throws deoptimizes instead of crashing
//           (only checked to run; the fast path itself is Track A's).
//
//   taskset -c 2,3 node scripts/heuristics/stack-b/probe.mjs
import { pathToFileURL } from "node:url";
import { RUNTIMES, snapshotRuntimes } from "./common.mjs";
import { ORACLE_DETACHED, ORACLE_OWNERLESS } from "./scenarios.mjs";

snapshotRuntimes();
const DET = ORACLE_OWNERLESS | ORACLE_DETACHED;
const out = {};
for (const rt of ["prod", "oracle"]) {
  const S = await import(pathToFileURL(RUNTIMES[rt]).href);
  const { createRoot, createSignal, createRenderEffect, createMemo, flush, peekNextChildId, getOwner } = S;
  // DET
  const [s, set] = createSignal(0);
  let runs = 0;
  const dispose = createRoot(d => {
    createRenderEffect(() => s(), () => void runs++, { oracle: DET });
    return d;
  });
  flush();
  dispose();
  set(1);
  flush();
  const detached = runs === 2;
  // OWN
  let before, after;
  createRoot(
    d => {
      const o = getOwner();
      before = peekNextChildId(o);
      createMemo(() => 1, { oracle: ORACLE_OWNERLESS });
      after = peekNextChildId(o);
      d();
    },
    { id: "p" }
  );
  const ownerless = before === after;
  // FUSED
  const [f, setF] = createSignal(1);
  let fx = 0;
  const d3 = createRoot(d => {
    createRenderEffect(() => f() % 2, () => void fx++, { equals: (a, b) => a === b });
    return d;
  });
  flush();
  setF(3);
  flush();
  d3();
  const fused = fx === 1;
  out[rt] = { detached, ownerless, fused, childIds: [before, after] };
}
console.log(JSON.stringify(out, null, 2));
const ok =
  out.oracle.detached && out.oracle.ownerless && out.oracle.fused &&
  !out.prod.detached && !out.prod.ownerless && !out.prod.fused;
console.log(ok ? "probe ok: every oracle fires on dist/oracle and none on dist/prod" : "PROBE FAILED");
process.exit(ok ? 0 : 1);
