/**
 * Track A, stage 1 — the status-free recompute path (core/status-free.ts).
 *
 * Every scenario runs twice, once with plain options and once with the
 * compiler's `statusFree` options, and the two traces must match: the path
 * is an implementation detail of a node whose proof holds, and a wrong proof
 * must deoptimize without changing behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  $,
  action,
  BLOCK_NOTHROW,
  BLOCK_SYNC,
  blockFlags,
  createEffect,
  createErrorBoundary,
  createLoadingBoundary,
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  getOwner,
  onCleanup,
  OBSERVE,
  perform,
  resetErrorHalt,
  statusFree
} from "../src/index.js";
import { CONFIG_NOTHROW } from "../src/core/constants.js";
import { GlobalQueue } from "../src/core/scheduler.js";

afterEach(() => {
  resetErrorHalt();
  flush();
  vi.restoreAllMocks();
});

/** Count status-free runs taken (vs. declined) while `fn` runs. */
function countFastRuns<T>(fn: () => T): { result: T; taken: number; declined: number } {
  const original = GlobalQueue._recomputeStatusFree!;
  const counts = { taken: 0, declined: 0 };
  GlobalQueue._recomputeStatusFree = (el, create) => {
    const ran = original(el, create);
    ran ? counts.taken++ : counts.declined++;
    return ran;
  };
  try {
    const result = fn();
    return { result, ...counts };
  } finally {
    GlobalQueue._recomputeStatusFree = original;
  }
}

type Options = typeof statusFree | undefined;
const VARIANTS: Options[] = [undefined, statusFree];

/** Run the scenario under both variants and require identical traces. */
function sameTrace(run: (options: Options, log: unknown[]) => void): unknown[] {
  const [plain, fast] = VARIANTS.map(options => {
    const log: unknown[] = [];
    run(options, log);
    return log;
  });
  expect(fast).toEqual(plain);
  return plain;
}

describe("status-free recompute", () => {
  it("is installed by importing statusFree", () => {
    expect(GlobalQueue._recomputeStatusFree).toBeTypeOf("function");
    expect(statusFree).toEqual({ sync: true, noThrow: true });
    expect(Object.isFrozen(statusFree)).toBe(true);
  });

  it("takes the fast path for memos and effects in the plain world", () => {
    const { taken, declined } = countFastRuns(() => {
      const [count, setCount] = createSignal(1);
      const dispose = createRoot(dispose => {
        const double = createMemo(() => count() * 2, statusFree);
        createRenderEffect(
          () => double() + 1,
          () => {},
          statusFree
        );
        createEffect(
          () => double(),
          () => {},
          statusFree
        );
        return dispose;
      });
      flush();
      setCount(2);
      flush();
      dispose();
    });
    // Three creations plus three re-runs.
    expect(taken).toBe(6);
    expect(declined).toBe(0);
  });

  it("matches a plain memo: values, equality skips, dynamic dependencies", () => {
    const log = sameTrace((options, log) => {
      const [a, setA] = createSignal(1);
      const [b, setB] = createSignal(10);
      const [useB, setUseB] = createSignal(false);
      let parityRuns = 0;
      const dispose = createRoot(dispose => {
        const parity = createMemo(() => a() % 2, options);
        const pick = createMemo(() => (useB() ? b() : a()), options);
        createEffect(
          () => parity(),
          v => {
            parityRuns++;
            log.push(["parity", v]);
          },
          options
        );
        createEffect(
          () => pick(),
          v => {
            log.push(["pick", v]);
          },
          options
        );
        return dispose;
      });
      flush();
      setA(3); // parity unchanged (1): its effect must not re-run
      flush();
      log.push(["parityRuns", parityRuns]);
      setB(11); // not a dependency yet
      flush();
      setUseB(true);
      flush();
      setA(4); // no longer a dependency of pick
      setB(12);
      flush();
      dispose();
    });
    expect(log).toEqual([
      ["parity", 1],
      ["pick", 1],
      ["pick", 3],
      ["parityRuns", 1],
      ["pick", 11],
      ["parity", 0],
      ["pick", 12]
    ]);
  });

  it("matches a plain memo for mid-batch pulls (staged memo values)", () => {
    const log = sameTrace((options, log) => {
      const [count, setCount] = createSignal(1);
      const { double, dispose } = createRoot(dispose => ({
        double: createMemo(() => count() * 2, options),
        dispose
      }));
      flush();
      setCount(5);
      log.push(double());
      flush();
      log.push(double());
      dispose();
    });
    // An unobserved read outside tracking serves the committed value until
    // the flush — identically on both paths.
    expect(log).toEqual([2, 10]);
  });

  it("keeps ownership: children and cleanups fall back to the full path and dispose", () => {
    const log = sameTrace((options, log) => {
      const [count, setCount] = createSignal(0);
      const dispose = createRoot(dispose => {
        const outer = createMemo(() => {
          const c = count();
          onCleanup(() => log.push(["cleanup", c]));
          const child = createMemo(() => c * 10);
          return child();
        }, options);
        createRenderEffect(
          () => outer(),
          v => {
            log.push(["value", v]);
          }
        );
        return dispose;
      });
      flush();
      setCount(1);
      flush();
      dispose();
      log.push("disposed");
    });
    expect(log).toEqual([["value", 0], ["cleanup", 0], ["value", 10], ["cleanup", 1], "disposed"]);
  });

  it("deoptimizes a node whose noThrow proof is wrong, routing the error normally", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const capture = OBSERVE!.diagnostics.capture();
    const log = sameTrace((options, log) => {
      const [fail, setFail] = createSignal(false);
      const dispose = createRoot(dispose => {
        const value = createMemo(() => {
          if (fail()) throw new Error("boom");
          return "ok";
        }, options);
        const shown = createErrorBoundary(
          () => value(),
          err => `caught:${(err() as Error).message}`
        );
        createRenderEffect(
          () => shown(),
          v => {
            log.push(v);
          }
        );
        return dispose;
      });
      flush();
      setFail(true);
      flush();
      dispose();
    });
    expect(log).toEqual(["ok", "caught:boom"]);
    const events = capture.stop();
    // Only the statusFree variant claimed the proof.
    expect(events.filter(e => e.code === "NOTHROW_NODE_THREW")).toHaveLength(1);
  });

  it("clears CONFIG_NOTHROW after a throw so later runs take the full path", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [fail, setFail] = createSignal(false);
    let node: any;
    const { value, dispose } = createRoot(dispose => {
      const value = createMemo(() => {
        node = getOwner();
        if (fail()) throw new Error("boom");
        return 1;
      }, statusFree);
      createErrorBoundary(
        () => value(),
        () => null
      );
      return { value, dispose };
    });
    flush();
    expect(node._config & CONFIG_NOTHROW).toBe(CONFIG_NOTHROW);
    setFail(true);
    flush();
    expect(node._config & CONFIG_NOTHROW).toBe(0);
    const { taken } = countFastRuns(() => {
      setFail(false);
      flush();
    });
    expect(taken).toBe(0);
    expect(value()).toBe(1);
    dispose();
  });

  it("treats a read of a pending source as a wrong proof and suspends like a plain memo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const logs: unknown[][] = [];
    for (const options of VARIANTS) {
      const log: unknown[] = [];
      let resolveFetch!: (v: number) => void;
      const dispose = createRoot(dispose => {
        const source = createMemo(() => new Promise<number>(res => (resolveFetch = res)));
        const plus = createMemo(() => source() + 1, options);
        const view = createLoadingBoundary(
          () => plus(),
          () => "loading"
        );
        createRenderEffect(
          () => view(),
          v => {
            log.push(v);
          }
        );
        return dispose;
      });
      flush();
      resolveFetch(41);
      await Promise.resolve();
      await Promise.resolve();
      flush();
      dispose();
      logs.push(log);
    }
    expect(logs[1]).toEqual(logs[0]);
    expect(logs[0]).toEqual(["loading", 42]);
  });

  it("declines under a transition and matches a plain memo", async () => {
    const results: { log: unknown[]; declined: number }[] = [];
    for (const options of VARIANTS) {
      const log: unknown[] = [];
      const [count, setCount] = createSignal(1);
      const dispose = createRoot(dispose => {
        const double = createMemo(() => count() * 2, options);
        createRenderEffect(
          () => double(),
          v => {
            log.push(v);
          }
        );
        return dispose;
      });
      flush();
      const run = action(function* () {
        setCount(2);
        yield Promise.resolve();
        setCount(3);
      });
      const counted = countFastRuns(() => {
        const done = run();
        flush();
        return done;
      });
      await counted.result;
      flush();
      log.push(count());
      dispose();
      results.push({ log, declined: counted.declined });
    }
    expect(results[1].log).toEqual(results[0].log);
    expect(results[0].log.at(-1)).toBe(3);
    // The status-free variant saw the transaction and declined.
    expect(results[1].declined).toBeGreaterThan(0);
  });

  it("verifies the sync proof in dev (SYNC_NODE_RECEIVED_ASYNC)", () => {
    const capture = OBSERVE!.diagnostics.capture();
    // As for `sync: true` on the full path: the violation errors the node,
    // and the read surfaces it.
    expect(() =>
      createRoot(() => {
        createMemo(() => Promise.resolve(1) as any, statusFree)();
      })
    ).toThrow(/SYNC_NODE_RECEIVED_ASYNC/);
    expect(capture.stop().some(e => e.code === "SYNC_NODE_RECEIVED_ASYNC")).toBe(true);
  });

  it("runs user and render effects identically, including cleanups", () => {
    sameTrace((options, log) => {
      const [count, setCount] = createSignal(0);
      const dispose = createRoot(dispose => {
        createRenderEffect(
          () => count() * 10,
          v => {
            log.push(["render", v]);
            return () => log.push(["render-cleanup", v]);
          },
          options
        );
        createEffect(
          () => count() + 1,
          v => {
            log.push(["user", v]);
            return () => log.push(["user-cleanup", v]);
          },
          options
        );
        return dispose;
      });
      flush();
      setCount(1);
      flush();
      setCount(1); // equal write: nothing re-runs
      flush();
      dispose();
    });
  });
});

describe("block metadata flags", () => {
  it("records compiler flags on the block", () => {
    const plain = $(function () {
      return 1;
    } as any);
    const proven = $(
      function () {
        return 1;
      } as any,
      BLOCK_SYNC | BLOCK_NOTHROW
    );
    expect(blockFlags(plain)).toBe(0);
    expect(blockFlags(proven)).toBe(BLOCK_SYNC | BLOCK_NOTHROW);
    expect(blockFlags(() => 1)).toBe(0);
  });

  it("a BLOCK_SYNC block computes like an unflagged one under a reactive host", () => {
    const log = sameTrace((options, log) => {
      const [count, setCount] = createSignal(2);
      const flags = options ? BLOCK_SYNC | BLOCK_NOTHROW : 0;
      const dispose = createRoot(dispose => {
        const square = createMemo(
          $(
            function () {
              const c = perform(count);
              return { c, sq: c * c };
            } as any,
            flags
          ) as any,
          options
        );
        createRenderEffect(
          () => (square() as any).sq,
          v => {
            log.push(v);
          }
        );
        return dispose;
      });
      flush();
      setCount(3);
      flush();
      dispose();
    });
    expect(log).toEqual([4, 9]);
  });

  it("verifies BLOCK_SYNC in dev: a generator or thenable result is a violated proof", () => {
    const lying = $(
      function () {
        return Promise.resolve(1);
      } as any,
      BLOCK_SYNC
    );
    expect(() => createRoot(() => createMemo(lying as any)())).toThrow(/BLOCK_SYNC_VIOLATED/);
    const uncompiled = $(function* () {
      return 1;
    }, BLOCK_SYNC);
    expect(() => createRoot(() => createMemo(uncompiled as any)())).toThrow(/BLOCK_SYNC_VIOLATED/);
  });
});
