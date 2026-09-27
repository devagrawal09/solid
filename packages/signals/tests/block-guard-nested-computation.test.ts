// A computation created and run inside a `$` block body reads for itself,
// not for the block: its run lowers the block's strict guard. The guard is
// raised by the block driver and honoured by store proxies (path tokens) in
// every build tier, so lowering it must not be dev-only — otherwise, in
// production, a Show / For / render effect created inside a component view
// block gets path tokens from direct store reads and the block fails with
// [UNREAD_PATH] (examples/todos-blocks' production build rendered its
// <Errored> fallback).
//
// Also run under the production tier:
//   SIGNALS_TIER=prod npx vitest run tests/block-guard-nested-computation.test.ts
import { $, createMemo, createRoot, createStore, flush, renderBlock } from "../src/index.js";

afterEach(() => flush());

describe("strict guard and computations created inside a block", () => {
  it("a memo created in a block body reads a store directly", () => {
    const [s] = createStore({ items: [1, 2, 3] });
    let inner!: () => number;
    const outer = createRoot(() =>
      createMemo(
        $(function* () {
          inner = createMemo(() => s.items.length);
          return yield* inner;
        })
      )
    );
    expect(outer()).toBe(3);
    expect(inner()).toBe(3);
  });

  it("a view block's nested computation tracks the store", () => {
    const [s, set] = createStore({ items: [1, 2, 3] });
    let inner!: () => number;
    createRoot(() =>
      renderBlock(
        $(function* () {
          inner = createMemo(() => s.items.length);
          return null;
        })
      )
    );
    expect(inner()).toBe(3);
    set(d => {
      d.items.push(4);
    });
    flush();
    expect(inner()).toBe(4);
  });
});
