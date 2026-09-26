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
  CONFIG_ORACLE_OWNERLESS,
  CONFIG_ORACLE_STATUSLESS
} from "../src/core/constants.js";
import {
  action,
  createLoadingBoundary,
  createOptimistic,
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  createStore,
  flush,
  getNextChildId,
  getOwner,
  isPending,
  latest,
  onCleanup,
  untrack
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

describe("H9 statusless: pass pending status through a memo nobody inspects", () => {
  // One async source (a manual thenable, resolved synchronously), a row memo
  // over it, a render effect under a Loading boundary. `refetch` bumps the
  // source; `probe` runs while the new flight is in flight.
  const run = (
    statusless: boolean,
    probe: (row: () => number) => unknown,
    answer: (v: number) => number = v => v * 10
  ) => {
    const log: unknown[] = [];
    let resolve: ((v: number) => void) | null = null;
    const [ver, setVer] = createSignal(0);
    let row!: () => number;
    const dispose = createRoot(d => {
      const data = createMemo(() => {
        const v = ver();
        return { then: (res: (v: number) => void) => void (resolve = () => res(answer(v))) } as any;
      });
      const view = createLoadingBoundary(
        () => {
          row = createMemo(() => (data() as number) + 1, {
            oracle: statusless ? CONFIG_ORACLE_STATUSLESS : 0
          } as any);
          createRenderEffect(row, v => void log.push(`effect ${v}`));
          return "ready";
        },
        () => "loading"
      );
      createRenderEffect(view, v => void log.push(`view ${v}`));
      return d;
    });
    flush();
    resolve!(0);
    flush();
    setVer(1);
    flush();
    log.push(probe(row));
    resolve!(0);
    flush();
    dispose();
    return log;
  };

  it("is equivalent when only the boundary and the effect observe status", () => {
    const reference = run(false, () => "-");
    expect(run(true, () => "-")).toEqual(reference);
    expect(reference).toEqual(["view loading", "view ready", "effect 1", "-", "effect 11"]);
  });

  it("settles the effect when the refetch lands on an equal value", () => {
    const probe = () => "-";
    const constant = () => 7;
    const reference = run(false, probe, constant);
    expect(run(true, probe, constant)).toEqual(reference);
  });

  it("changes isPending() on the transparent memo mid-flight", () => {
    const probe = (row: () => number) => isPending(row);
    expect(run(false, probe)).toEqual([
      "view loading",
      "view ready",
      "effect 1",
      true,
      "effect 11"
    ]);
    expect(run(true, probe)).toEqual([
      "view loading",
      "view ready",
      "effect 1",
      false,
      "effect 11"
    ]);
  });
});

describe("A1 sync action: a body with no yield runs as a plain batch", () => {
  // The compiled form of `action(function* () { body })` when the body has no
  // yield and no await: the writes as a plain batch, the call returning a
  // settled promise. These pin the equivalence; the runtime cannot choose it
  // by itself because it learns the body is synchronous only after running
  // it, and adopting the first slice into a transaction afterwards breaks
  // store, optimistic and until() tests (scripts/heuristics/rspec, R5).
  const call = (asAction: boolean, body: () => void) =>
    asAction
      ? action(function* () {
          body();
        })()
      : (body(), Promise.resolve());

  it("is equivalent with an optimistic write in the body", async () => {
    const run = async (asAction: boolean) => {
      const log: unknown[] = [];
      const [a, setA] = createSignal(0);
      const [o, setO] = createOptimistic(0);
      createRoot(() =>
        createRenderEffect(
          () => [a(), o()],
          v => void log.push(JSON.stringify(v))
        )
      );
      flush();
      const p = call(asAction, () => {
        setA(1);
        setO(5);
        log.push(`inside a=${a()} o=${o()}`);
      });
      log.push(`after-call a=${a()} o=${o()}`);
      flush();
      await p;
      flush();
      log.push(`settled a=${a()} o=${o()}`);
      return log;
    };
    expect(await run(false)).toEqual(await run(true));
  });

  it("is equivalent when it writes a node an in-flight action holds", async () => {
    const run = async (asAction: boolean) => {
      const log: unknown[] = [];
      const [x, setX] = createSignal(0);
      const [y, setY] = createSignal(0);
      createRoot(() =>
        createRenderEffect(
          () => [x(), y()],
          v => void log.push(JSON.stringify(v))
        )
      );
      flush();
      let release!: () => void;
      const slow = action(function* () {
        setX(1);
        yield new Promise<void>(r => (release = r));
        setX(2);
      });
      const p1 = slow();
      await Promise.resolve();
      flush();
      const p2 = call(asAction, () => {
        setX(10);
        setY(10);
      });
      flush();
      await Promise.resolve();
      flush();
      log.push(`after x=${x()} y=${y()}`);
      release();
      await p1;
      await p2;
      await Promise.resolve();
      flush();
      log.push(`settled x=${x()} y=${y()}`);
      return log;
    };
    const reference = await run(true);
    expect(await run(false)).toEqual(reference);
    expect(reference).toEqual(["[0,0]", "after x=0 y=0", "[2,10]", "settled x=2 y=10"]);
  });
});

describe("S4 static store path: a field no writer reaches is read once", () => {
  const run = (isStatic: boolean, writeId: boolean) => {
    const log: unknown[] = [];
    const [state, setState] = createStore({ rows: [{ id: 1, label: "a" }] });
    const dispose = createRoot(d => {
      const row = untrack(() => state.rows[0]);
      if (isStatic) log.push(`id ${untrack(() => row.id)}`);
      else
        createRenderEffect(
          () => row.id,
          v => void log.push(`id ${v}`)
        );
      createRenderEffect(
        () => row.label,
        v => void log.push(`label ${v}`)
      );
      return d;
    });
    flush();
    setState(s => {
      s.rows[0].label = "b";
      if (writeId) s.rows[0].id = 2;
    });
    flush();
    dispose();
    return log;
  };

  it("is equivalent when the program never writes the field", () => {
    expect(run(true, false)).toEqual(run(false, false));
  });

  it("goes stale on one write to the field anywhere in the program", () => {
    expect(run(false, true)).toEqual(["id 1", "label a", "label b", "id 2"]);
    expect(run(true, true)).toEqual(["id 1", "label a", "label b"]);
  });
});
