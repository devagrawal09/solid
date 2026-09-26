/**
 * Heuristic oracles (documentation/plans/heuristic-oracles.md).
 *
 * Each oracle is a shortcut the runtime takes when a node ASSUMES a fact
 * (`oracle` bits, or an effect `equals` for a fused memo). The harness in
 * scripts/heuristics measures the shortcut on graphs where the fact holds.
 * This file pins the other half of the argument: on ordinary Solid code the
 * fact can be false, and taking the shortcut there changes behavior. That is
 * why the runtime cannot apply these heuristics by itself and a compiler
 * proof has to license them.
 *
 * Every test runs the same program twice — without the oracle (reference)
 * and with it — and asserts the traces differ in the documented way. A test
 * starting to pass "equal" means the shortcut became safe (or stopped firing)
 * and the write-up must be revisited.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIG_ORACLE_DETACHED,
  CONFIG_ORACLE_DIRECT,
  CONFIG_ORACLE_LOCAL,
  CONFIG_ORACLE_OWNERLESS
} from "../src/core/constants.js";
import {
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  getNextChildId,
  getOwner,
  latest,
  onCleanup
} from "../src/index.js";

const same = (a: unknown, b: unknown) => a === b;

describe("H1 fuse: inline a memo into its render effect", () => {
  it("is equivalent when the effect is the memo's only reader", () => {
    const run = (fused: boolean) => {
      const [a, setA] = createSignal(1);
      const log: number[] = [];
      createRoot(() => {
        if (fused)
          createRenderEffect(
            () => a() > 2,
            v => void log.push(+v),
            { equals: same } as any
          );
        else {
          const big = createMemo(() => a() > 2);
          createRenderEffect(
            () => big(),
            v => void log.push(+v)
          );
        }
      });
      flush();
      for (const v of [2, 3, 4, 1]) {
        setA(v);
        flush();
      }
      return log;
    };
    expect(run(true)).toEqual(run(false));
    expect(run(false)).toEqual([0, 1, 0]);
  });

  it("changes behavior when the memo has a second reader: its compute runs per reader", () => {
    const run = (fused: boolean) => {
      const [a, setA] = createSignal(1);
      let computes = 0;
      const compute = () => (computes++, a() * 2);
      createRoot(() => {
        if (fused) {
          createRenderEffect(compute, () => {}, { equals: same } as any);
          createRenderEffect(compute, () => {}, { equals: same } as any);
        } else {
          const doubled = createMemo(compute);
          createRenderEffect(
            () => doubled(),
            () => {}
          );
          createRenderEffect(
            () => doubled(),
            () => {}
          );
        }
      });
      flush();
      setA(2);
      flush();
      return computes;
    };
    expect(run(false)).toBe(2);
    // A side-effecting or expensive compute (a fetch, a log) runs twice.
    expect(run(true)).toBe(4);
  });

  it("without the memo's equality the effect phase fires on unchanged values", () => {
    const run = (withEquals: boolean) => {
      const [a, setA] = createSignal(1);
      let effects = 0;
      createRoot(() =>
        createRenderEffect(
          () => a() > 2,
          () => void effects++,
          (withEquals ? { equals: same } : undefined) as any
        )
      );
      flush();
      setA(2); // a() > 2 stays false
      flush();
      return effects;
    };
    expect(run(true)).toBe(1);
    expect(run(false)).toBe(2);
  });
});

describe("H2 direct: commit a memo without the staging round-trip", () => {
  const program = (direct: boolean) => {
    const [a, setA] = createSignal(1);
    let doubled!: () => number;
    createRoot(() => {
      doubled = createMemo(() => a() * 2, (direct ? { oracle: CONFIG_ORACLE_DIRECT } : {}) as any);
      createRenderEffect(
        () => doubled(),
        () => {}
      );
    });
    flush();
    return { a, setA, doubled };
  };

  it("is equivalent for tracked readers across a flush", () => {
    for (const direct of [false, true]) {
      const { setA, doubled } = program(direct);
      setA(5);
      flush();
      expect(doubled()).toBe(10);
    }
  });

  it("tears for a plain read after a mid-batch pull (latest() in an event handler)", () => {
    const frame = (direct: boolean) => {
      const { a, setA, doubled } = program(direct);
      setA(2);
      // An event handler peeks at the fresh derivation (latest() pulls the
      // memo's recompute before the flush), then reads plainly.
      const fresh = latest(doubled);
      return [fresh, a(), doubled()];
    };
    // Reference: latest() sees the fresh value, plain reads stay on the
    // committed frame until the flush — source and derivation agree.
    expect(frame(false)).toEqual([4, 1, 2]);
    // Direct commit publishes the pulled derivation into the committed slot
    // before its source: a torn frame (a = 1, doubled = 4) ordinary Solid
    // never shows.
    expect(frame(true)).toEqual([4, 1, 4]);
  });
});

describe("H3 local: skip unlinking at disposal", () => {
  const program = (local: boolean) => {
    const [shared, setShared] = createSignal(0);
    let computes = 0;
    const dispose = createRoot(d => {
      createRenderEffect(
        () => (computes++, shared()),
        () => {},
        (local ? { oracle: CONFIG_ORACLE_LOCAL } : {}) as any
      );
      return d;
    });
    flush();
    return { setShared, dispose, computes: () => computes };
  };

  it("changes behavior when a source outlives the node: the dead effect stays subscribed", () => {
    const after = (local: boolean) => {
      const p = program(local);
      p.dispose();
      const before = p.computes();
      p.setShared(1);
      flush();
      return p.computes() - before;
    };
    expect(after(false)).toBe(0);
    // The surviving source still holds the disposed node: it is retained
    // (a leak) and its compute re-runs on the next write.
    expect(after(true)).toBeGreaterThan(0);
  });
});

describe("H8 ownerless / detached: memos and effects that own nothing", () => {
  const OWNERLESS = CONFIG_ORACLE_OWNERLESS;
  const DETACHED = CONFIG_ORACLE_OWNERLESS | CONFIG_ORACLE_DETACHED;

  it("ownerless: a compute that does create primitives loses its id scope (hydration keys)", () => {
    const run = (ownerless: boolean) => {
      let childId: string | undefined;
      let error: unknown;
      createRoot(
        () => {
          createMemo(
            () => {
              // A compute that renders (or calls createUniqueId) mints ids
              // from its own node.
              try {
                childId = getNextChildId(getOwner()!);
              } catch (e) {
                error = e;
              }
            },
            (ownerless ? { oracle: OWNERLESS } : {}) as any
          );
        },
        { id: "r" }
      );
      return { childId, error };
    };
    expect(run(false).childId).toBe("r00"); // first child of the memo "r0"
    // The node took no id, so nothing under it can be keyed for hydration.
    expect(run(true).childId).toBeUndefined();
    expect(run(true).error).toBeInstanceOf(Error);
  });

  it("detached: an effect cleanup registered in the compute never runs at disposal", () => {
    const run = (detached: boolean) => {
      let cleaned = 0;
      const dispose = createRoot(d => {
        createRenderEffect(
          () => void onCleanup(() => void cleaned++),
          () => {},
          (detached ? { oracle: DETACHED } : {}) as any
        );
        return d;
      });
      flush();
      dispose();
      return cleaned;
    };
    expect(run(false)).toBe(1);
    expect(run(true)).toBe(0);
  });

  it("detached: a node reading a surviving source keeps running after its owner is disposed", () => {
    const run = (detached: boolean) => {
      const [shared, setShared] = createSignal(0);
      let computes = 0;
      const dispose = createRoot(d => {
        createRenderEffect(
          () => (computes++, shared()),
          () => {},
          (detached ? { oracle: DETACHED } : {}) as any
        );
        return d;
      });
      flush();
      dispose();
      const before = computes;
      setShared(1);
      flush();
      return computes - before;
    };
    expect(run(false)).toBe(0);
    expect(run(true)).toBeGreaterThan(0);
  });
});
