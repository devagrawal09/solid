import { describe, expect, test } from "vitest";
import { createRoot, getOwner, createMemo, untrack } from "@solidjs/signals";
import { observedComponent } from "../src/client/core.js";

/**
 * ID Parity Tests
 *
 * Verify that dev-mode wrappers (observedComponent) produce the same owner IDs
 * as production code (no wrapper). This is critical for SSR/hydration: the
 * server runs without wrappers, the client runs with them in dev mode.
 * Transparent owners make the wrappers invisible to the ID scheme.
 */

describe("ID Parity: observedComponent transparent wrapper", () => {
  test("observedComponent produces same child IDs as direct call", () => {
    const idsWithWrapper: string[] = [];
    const idsWithoutWrapper: string[] = [];

    // With observedComponent (dev mode, transparent wrapper)
    createRoot(
      () => {
        observedComponent(() => {
          const a = createMemo(() => {
            idsWithWrapper.push(getOwner()!.id!);
            return "a";
          });
          const b = createMemo(() => {
            idsWithWrapper.push(getOwner()!.id!);
            return "b";
          });
          untrack(() => {
            a();
            b();
          });
          return undefined as any;
        }, {} as any);
      },
      { id: "t" }
    );

    // Without wrapper (production / server)
    createRoot(
      () => {
        const Comp = () => {
          const a = createMemo(() => {
            idsWithoutWrapper.push(getOwner()!.id!);
            return "a";
          });
          const b = createMemo(() => {
            idsWithoutWrapper.push(getOwner()!.id!);
            return "b";
          });
          untrack(() => {
            a();
            b();
          });
          return undefined as any;
        };
        Comp();
      },
      { id: "t" }
    );

    expect(idsWithWrapper).toEqual(idsWithoutWrapper);
    expect(idsWithWrapper.length).toBe(2);
  });

  test("observedComponent does not shift sibling IDs", () => {
    const ids: string[] = [];

    createRoot(
      () => {
        // Component wrapped in observedComponent
        observedComponent(() => {
          const cm = createMemo(() => {
            ids.push("comp-memo:" + getOwner()!.id!);
            return "x";
          });
          untrack(cm);
          return undefined as any;
        }, {} as any);

        // Sibling memo created after the observedComponent
        createMemo(() => {
          ids.push("sibling:" + getOwner()!.id!);
          return "y";
        })();
      },
      { id: "t" }
    );

    // comp-memo should be t0, sibling should be t1
    // Without transparent, comp wrapper would be t0, comp-memo would be t00,
    // and sibling would be t1. With transparent, comp-memo is t0 and sibling is t1.
    expect(ids).toContain("comp-memo:t0");
    expect(ids).toContain("sibling:t1");
  });

  test("nested observedComponent wrappers produce correct IDs", () => {
    const ids: string[] = [];

    createRoot(
      () => {
        observedComponent(() => {
          ids.push("outer-owner:" + getOwner()!.id!);

          observedComponent(() => {
            const m = createMemo(() => {
              ids.push("inner-memo:" + getOwner()!.id!);
              return "nested";
            });
            untrack(m);
            return undefined as any;
          }, {} as any);
          return undefined as any;
        }, {} as any);
      },
      { id: "t" }
    );

    // The transparent observedComponent root has id = parent's id ("t")
    // Inner memo should get id from the root's counter (delegated through transparent wrappers)
    expect(ids).toContain("outer-owner:t");
    expect(ids).toContain("inner-memo:t0");
  });

  test("multiple components produce sequential IDs matching server", () => {
    const serverIds: string[] = [];
    const clientIds: string[] = [];

    function MyComp(props: { label: string }) {
      const m = createMemo(() => {
        return getOwner()!.id!;
      });
      return untrack(m);
    }

    // Server-style: direct calls
    createRoot(
      () => {
        serverIds.push(MyComp({ label: "A" }));
        serverIds.push(MyComp({ label: "B" }));
        serverIds.push(MyComp({ label: "C" }));
      },
      { id: "t" }
    );

    // Client dev-style: wrapped in observedComponent
    createRoot(
      () => {
        clientIds.push(observedComponent(MyComp, { label: "A" }) as any);
        clientIds.push(observedComponent(MyComp, { label: "B" }) as any);
        clientIds.push(observedComponent(MyComp, { label: "C" }) as any);
      },
      { id: "t" }
    );

    expect(clientIds).toEqual(serverIds);
    expect(serverIds).toEqual(["t0", "t1", "t2"]);
  });
});

/**
 * Ternary / Conditional ID Parity Tests
 *
 * The compiler wraps dynamic conditional tests in memo() calls:
 *   memo(() => !!condition)() ? consequent : alternate
 *
 * Each memo creates an owner and consumes a child ID. These tests verify
 * that the owner-tree structure from compiled ternaries produces consistent
 * IDs, ensuring server/client hydration alignment.
 *
 * The compiler's `memo` is: fn => createMemo(() => fn())
 */
const memo = (fn: () => any) => createMemo(() => fn());

describe("ID Parity: ternary conditional memos", () => {
  test("simple ternary: memo for condition test consumes one child ID", () => {
    const ids: string[] = [];

    createRoot(
      () => {
        // Simulates compiled: memo(() => !!state.dynamic)() ? good() : bad
        const condMemo = memo(() => !!true);
        ids.push("cond-memo:" + getOwner()!.id!);
        untrack(() => condMemo());

        // Sibling memo after the ternary
        const sibling = createMemo(() => {
          ids.push("sibling:" + getOwner()!.id!);
          return "s";
        });
        untrack(sibling);
      },
      { id: "t" }
    );

    // cond-memo should be t0, sibling should be t1
    expect(ids).toContain("cond-memo:t");
    expect(ids).toContain("sibling:t1");
  });

  test("ternary inside element child: IIFE+memo pattern produces correct IDs", () => {
    const ids: string[] = [];

    createRoot(
      () => {
        // Simulates compiled element-child ternary (non-inline / IIFE pattern):
        //   var _v$ = (() => {
        //     var _c$ = memo(() => !!state.dynamic);
        //     return () => (_c$() ? good() : bad);
        //   })();
        const _v$ = (() => {
          const _c$ = memo(() => !!true);
          ids.push("iife-cond:" + getOwner()!.id!);
          return () => (untrack(_c$) ? "good" : "bad");
        })();

        // Another element child after the ternary
        const _v$2 = createMemo(() => {
          ids.push("next-child:" + getOwner()!.id!);
          return "next";
        });
        untrack(_v$2);
      },
      { id: "t" }
    );

    // The IIFE memo gets t0, the next child memo gets t1
    expect(ids).toContain("iife-cond:t");
    expect(ids).toContain("next-child:t1");
  });

  test("nested ternary: each condition level consumes a child ID", () => {
    const ids: string[] = [];

    createRoot(
      () => {
        // Simulates compiled nested ternary:
        //   memo(() => state.count > 5)()
        //     ? memo(() => !!state.dynamic)() ? best : good()
        //     : bad
        const outerCond = memo(() => true);
        ids.push("outer-cond:" + getOwner()!.id!);

        // The inner cond is inline (deep=true in transformCondition)
        const innerCond = memo(() => true);
        ids.push("inner-cond:" + getOwner()!.id!);

        untrack(() => {
          outerCond();
          innerCond();
        });

        // Sibling after the nested ternary
        const sibling = createMemo(() => {
          ids.push("sibling:" + getOwner()!.id!);
          return "s";
        });
        untrack(sibling);
      },
      { id: "t" }
    );

    // outer-cond at t0, inner-cond at t1, sibling at t2
    expect(ids).toContain("outer-cond:t");
    expect(ids).toContain("inner-cond:t");
    expect(ids).toContain("sibling:t2");
  });

  test("ternary IDs match between direct call and observedComponent", () => {
    const serverIds: string[] = [];
    const clientIds: string[] = [];

    function MyComp() {
      const condMemo = memo(() => !!true);
      untrack(condMemo);
      const after = createMemo(() => {
        return getOwner()!.id!;
      });
      return untrack(after);
    }

    // Server-style: direct call
    createRoot(
      () => {
        serverIds.push(MyComp());
      },
      { id: "t" }
    );

    // Client dev-style: observedComponent wrapper
    createRoot(
      () => {
        clientIds.push(observedComponent(MyComp, {} as any) as any);
      },
      { id: "t" }
    );

    expect(clientIds).toEqual(serverIds);
    // condMemo is t0, after-memo is t1
    expect(serverIds).toEqual(["t1"]);
  });

  test("multiple ternaries produce sequential IDs", () => {
    const ids: string[] = [];

    createRoot(
      () => {
        // First ternary
        const c1 = memo(() => !!true);
        // Second ternary
        const c2 = memo(() => !!false);
        // Third ternary
        const c3 = memo(() => !!true);

        untrack(() => {
          c1();
          c2();
          c3();
        });

        // Trailing memo
        const trailing = createMemo(() => {
          ids.push("trailing:" + getOwner()!.id!);
          return "t";
        });
        untrack(trailing);
      },
      { id: "t" }
    );

    // Three ternary memos at t0, t1, t2; trailing at t3
    expect(ids).toContain("trailing:t3");
  });

  test("transparent memo does not consume a child-id slot (client)", () => {
    const ids: string[] = [];

    createRoot(
      () => {
        const t = createMemo(() => false, { transparent: true } as any);
        untrack(t);

        const sibling = createMemo(() => {
          ids.push("sibling:" + getOwner()!.id!);
          return "s";
        });
        untrack(sibling);
      },
      { id: "t" }
    );

    // The transparent memo shares the root's id; the sibling gets slot 0.
    expect(ids).toContain("sibling:t0");
  });

  test("server-side transparent memo does not shift sibling ids (#3012)", async () => {
    const server = await import("../src/server/signals.js");
    const ids: string[] = [];

    server.createRoot(
      () => {
        const t = server.createMemo(() => false, { transparent: true } as any);
        server.untrack(t);

        const sibling = server.createMemo(() => {
          ids.push("sibling:" + server.getOwner()!.id!);
          return "s";
        });
        server.untrack(sibling);
      },
      { id: "t" }
    );

    // Must match the client: the transparent memo consumes no slot, so the
    // sibling is t0 — not t1 (which would shift every element after it and
    // break hydration claims).
    expect(ids).toContain("sibling:t0");
  });

  test("ternary inside component child with observedComponent parity", () => {
    const serverIds: string[] = [];
    const clientIds: string[] = [];

    function Parent() {
      // Simulates: {condition() ? <A/> : <B/>}
      const condMemo = memo(() => !!true);
      untrack(condMemo);

      // Simulates a second child element
      const secondChild = createMemo(() => getOwner()!.id!);
      return untrack(secondChild);
    }

    createRoot(
      () => {
        serverIds.push(Parent());
        serverIds.push(Parent());
      },
      { id: "t" }
    );

    createRoot(
      () => {
        clientIds.push(observedComponent(Parent, {} as any) as any);
        clientIds.push(observedComponent(Parent, {} as any) as any);
      },
      { id: "t" }
    );

    expect(clientIds).toEqual(serverIds);
  });
});

/**
 * JSX block id scopes (`blockScope`, compiler-emitted as `$(blockScope(body))`
 * for every `$` block whose body contains JSX).
 *
 * A block defers its JSX to whichever sink runs it; the client and server
 * sinks run at different times under different owners. The scope reserves
 * one slot at block CREATION and runs every invocation under it with a zeroed
 * counter, so the client (`@solidjs/signals`) and server (`solid-js` server
 * runtime) twins must produce identical ids however late, often, or
 * partially each side runs the body.
 */
describe("ID Parity: JSX block scopes", () => {
  type Runtime = {
    createRoot: typeof createRoot;
    createOwner: () => { id?: string };
    createMemo: typeof createMemo;
    getOwner: typeof getOwner;
    untrack: typeof untrack;
    blockScope: <F extends (...args: any[]) => any>(body: F) => F;
  };

  async function runtimes(): Promise<Record<"client" | "server", Runtime>> {
    const client = await import("@solidjs/signals");
    const server = await import("../src/server/signals.js");
    return {
      client: client as unknown as Runtime,
      server: server as unknown as Runtime
    };
  }

  /**
   * One component-shaped scenario: a memo, a JSX block (reserving its slot),
   * a sibling memo; the block body is then run `runs` times AFTER the
   * siblings, creating owners (stand-ins for templates/memos) inside it.
   */
  function scenario(rt: Runtime, opts: { throwFirst?: boolean; runs?: number } = {}) {
    const ids: string[] = [];
    rt.createRoot(
      () => {
        rt.untrack(rt.createMemo(() => ids.push("before:" + rt.getOwner()!.id)));
        let attempt = 0;
        const body = rt.blockScope(() => {
          ids.push("content:" + rt.createOwner().id);
          if (opts.throwFirst && attempt++ === 0) throw new Error("retry");
          ids.push("content:" + rt.createOwner().id);
          return "view";
        });
        rt.untrack(rt.createMemo(() => ids.push("after:" + rt.getOwner()!.id)));
        for (let i = 0; i < (opts.runs ?? 1); i++) {
          try {
            body();
          } catch {}
        }
        if (opts.throwFirst) body();
        ids.push("next:" + rt.createOwner().id);
      },
      { id: "t" }
    );
    return ids;
  }

  test("content allocates under the slot reserved at creation, not at run time", async () => {
    const { client, server } = await runtimes();
    const expected = ["before:t0", "after:t2", "content:t10", "content:t11", "next:t3"];
    expect(scenario(client)).toEqual(expected);
    expect(scenario(server)).toEqual(expected);
  });

  test("reruns and a failed-then-retried run allocate the same ids on both sides", async () => {
    const { client, server } = await runtimes();
    expect(scenario(client, { runs: 3 })).toEqual(scenario(server, { runs: 3 }));
    const retried = [
      "before:t0",
      "after:t2",
      "content:t10",
      "content:t10",
      "content:t11",
      "next:t3"
    ];
    expect(scenario(client, { throwFirst: true })).toEqual(retried);
    expect(scenario(server, { throwFirst: true })).toEqual(retried);
  });

  test("a runtime-driven (generator) body keeps the scope across its steps", async () => {
    const { client, server } = await runtimes();
    const drive = (rt: Runtime) => {
      const ids: string[] = [];
      rt.createRoot(
        () => {
          const body = rt.blockScope(function* () {
            ids.push(rt.createOwner().id!);
            yield 1;
            ids.push(rt.createOwner().id!);
          });
          rt.createOwner();
          const it = body();
          it.next();
          rt.createOwner(); // an allocation between steps stays outside the scope
          it.next();
          ids.push("next:" + rt.createOwner().id);
        },
        { id: "t" }
      );
      return ids;
    };
    const expected = ["t00", "t01", "next:t3"];
    expect(drive(client)).toEqual(expected);
    expect(drive(server)).toEqual(expected);
  });

  test("nested block scopes nest their ids identically", async () => {
    const { client, server } = await runtimes();
    const nested = (rt: Runtime) => {
      const ids: string[] = [];
      rt.createRoot(
        () => {
          const outer = rt.blockScope(() => {
            ids.push(rt.createOwner().id!);
            const inner = rt.blockScope(() => ids.push(rt.createOwner().id!));
            ids.push(rt.createOwner().id!);
            inner();
          });
          rt.createOwner();
          outer();
        },
        { id: "t" }
      );
      return ids;
    };
    const expected = ["t00", "t02", "t010"];
    expect(nested(client)).toEqual(expected);
    expect(nested(server)).toEqual(expected);
  });

  test("outside an id-carrying tree the body is returned untouched", async () => {
    const { client, server } = await runtimes();
    for (const rt of [client, server]) {
      const body = () => 1;
      expect(rt.blockScope(body)).toBe(body);
      rt.createRoot(() => expect(rt.blockScope(body)).toBe(body));
    }
  });
});
