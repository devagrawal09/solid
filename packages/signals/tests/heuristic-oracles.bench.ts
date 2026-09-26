// Tier-1 benches for the heuristic oracles (documentation/plans/
// heuristic-oracles.md). Each group runs the same program as written
// (baseline), with a compiler-licensed shortcut applied by hand (an `oracle`
// node option or a compiled-output rewrite), and — where one exists — the
// runtime-only alternative. Deltas within a group are the signal; absolute
// numbers are dev-tier source (run `SIGNALS_TIER=prod pnpm vitest bench --run
// tests/heuristic-oracles.bench.ts` for the prod tier). The instruction-count
// and Chromium data live in documentation/plans/heuristic-oracles/.
import { bench, describe } from "vitest";
import {
  actions,
  asyncRows,
  chain,
  N,
  rows,
  storeRows,
  type RowsKind
} from "./heuristic-oracles.programs.js";

// Longer samples than the default: mount benches allocate ~1k nodes per
// iteration and GC dominates their spread at the default 500 ms.
const OPTS = { time: 3000, warmupTime: 1000 };
// ---------------------------------------------------------------------------
// H1 memo fusion (+ H8b detached) — rows: label effect + per-row selection.

const ROWS: RowsKind[] = ["baseline", "H1-fuse", "H1+H8b", "R-projection"];
describe(`rows ${N}: mount + dispose`, () => {
  for (const k of ROWS) bench(k, () => rows(k).dispose(), OPTS);
});
describe(`rows ${N}: select`, () => {
  for (const k of ROWS) {
    const app = rows(k);
    bench(k, () => app.select(), OPTS);
  }
});

// ---------------------------------------------------------------------------
// H1 on a memo chain — chain update.
describe(`chain ${N / 10}: update`, () => {
  for (const [k, fused] of [
    ["baseline", false],
    ["H1-fuse", true]
  ] as const) {
    const app = chain(fused);
    bench(k, () => app.update(), OPTS);
  }
});

// ---------------------------------------------------------------------------
// H9 status pass-through — one async source, N row memos, a Loading boundary.
describe(`async rows ${N}: refetch`, () => {
  for (const k of ["baseline", "H9-statusless", "H9-direct"] as const) {
    const app = asyncRows(k);
    bench(k, () => app.refetch(), OPTS);
  }
});

// ---------------------------------------------------------------------------
// S2 store scalar replacement, S4 static store field.
describe(`store rows ${N}: mount + dispose`, () => {
  for (const k of ["store", "S4-static-id", "S2-scalar"] as const)
    bench(k, () => storeRows(k).dispose(), OPTS);
});
describe(`store rows ${N}: update10th`, () => {
  for (const k of ["store", "S4-static-id", "S2-scalar"] as const) {
    const app = storeRows(k);
    bench(k, () => app.update10th(), OPTS);
  }
});

// ---------------------------------------------------------------------------
// A1 synchronous action compiled to a plain batch.
describe(`action: two writes, ${(2 * N) / 5} readers`, () => {
  bench("baseline (action)", actions(true), OPTS);
  bench("A1-batch", actions(false), OPTS);
});
