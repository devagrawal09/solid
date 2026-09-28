/**
 * The entries of the v2 client lowering's second pass
 * (packages/compiler/src/blocks_v2_lower.rs, generators.rs "async v2
 * bodies"): `asyncBody` (a memo / event body that waits, compiled to an
 * `async function`), `readAccessor` / `readSelected` (view reads the JSX
 * transform may evaluate with the guard up), `readContext` (setup context
 * reads) and the path readers without `perform`. Each program is written the
 * way the compiler emits it and compared, event by event and microtask by
 * microtask, with the same program on the generator driver.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  $,
  $eventCompiled,
  asyncBody,
  attempt,
  createContext,
  createErrorBoundary,
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  createStore,
  flush,
  perform,
  readAccessor,
  readContext,
  readPath1,
  readSelected,
  readStore,
  resetErrorHalt,
  setContext
} from "../src/index.js";

afterEach(() => resetErrorHalt());

const tick = () => new Promise<void>(r => setTimeout(r, 0));

class Bad extends Error {}

/** A deferred whose settlement the test drives. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Handler = (e: unknown) => void;

/** The same event on the driver (`$`) and compiled (`asyncBody`). */
function events(
  driver: (log: string[], d: ReturnType<typeof deferred<number>>) => Handler,
  compiled: (log: string[], d: ReturnType<typeof deferred<number>>) => Handler
) {
  const runs = [driver, compiled].map(make => {
    const log: string[] = [];
    const d = deferred<number>();
    const handler = createRoot(() => make(log, d));
    return { log, d, handler };
  });
  return runs;
}

describe("asyncBody: events", () => {
  it("waits, resumes in the same microtask, and routes a sync failure synchronously", async () => {
    const [driver, compiled] = events(
      (log, d) =>
        $eventCompiled(
          $(function* (e: any) {
            log.push("start");
            if (e === "fail") throw new Bad("sync");
            const v = yield* attempt(() => d.promise);
            log.push(`resumed ${v}`);
          })
        ),
      (log, d) =>
        $eventCompiled(
          asyncBody(async function (e: any, _$a) {
            try {
              log.push("start");
              if (e === "fail") throw new Bad("sync");
              const v = _$a.t(() => d.promise) ? _$a.r(await _$a.p) : _$a.v;
              log.push(`resumed ${v}`);
            } catch (_$e) {
              _$a.x(_$e);
            }
          })
        )
    );
    for (const run of [driver, compiled]) {
      expect(() => run.handler("fail")).toThrow(Bad);
      run.handler("go");
      run.log.push("after dispatch");
    }
    expect(compiled.log).toEqual(driver.log);
    // Settle both, then interleave a marker microtask: the continuation runs
    // in the settled promise's reaction on both sides.
    for (const run of [driver, compiled]) {
      run.d.resolve(7);
      queueMicrotask(() => run.log.push("marker"));
    }
    await tick();
    expect(compiled.log).toEqual(driver.log);
    expect(driver.log).toEqual(["start", "start", "after dispatch", "resumed 7", "marker"]);
  });

  it("an attempt that returns a plain value never suspends", () => {
    const [driver, compiled] = events(
      log =>
        $eventCompiled(
          $(function* () {
            const v = yield* attempt(() => 5);
            log.push(`value ${v}`);
          })
        ),
      log =>
        $eventCompiled(
          asyncBody(async function (_$i, _$a) {
            try {
              const v = _$a.t(() => 5) ? _$a.r(await _$a.p) : _$a.v;
              log.push(`value ${v}`);
            } catch (_$e) {
              _$a.x(_$e);
            }
          })
        )
    );
    for (const run of [driver, compiled]) {
      run.handler(undefined);
      run.log.push("after");
    }
    expect(driver.log).toEqual(["value 5", "after"]);
    expect(compiled.log).toEqual(driver.log);
  });

  it("a rejection reaches the boundary above the handler's creation owner", async () => {
    const results = await Promise.all(
      [false, true].map(async compiledForm => {
        const d = deferred<number>();
        let handler!: Handler;
        const view = createRoot(() =>
          createErrorBoundary(
            () => {
              handler = compiledForm
                ? $eventCompiled(
                    asyncBody(async function (_$i, _$a) {
                      try {
                        _$a.t(() => d.promise) ? _$a.r(await _$a.p) : _$a.v;
                      } catch (_$e) {
                        _$a.x(_$e);
                      }
                    })
                  )
                : $eventCompiled(
                    $(function* () {
                      yield* attempt(() => d.promise);
                    })
                  );
              return "content";
            },
            error => `caught:${(error() as Error).message}`
          )
        );
        handler(undefined);
        d.reject(new Bad("late"));
        await tick();
        flush();
        return view();
      })
    );
    expect(results).toEqual(["caught:late", "caught:late"]);
  });
});

describe("asyncBody: memos", () => {
  function memo(compiledForm: boolean, log: string[], pending: ReturnType<typeof deferred>[]) {
    const [id, setId] = createSignal("a");
    const out: unknown[] = [];
    createRoot(() => {
      const m = compiledForm
        ? createMemo(
            asyncBody(async function (_$i: unknown, _$a) {
              try {
                const key = id();
                log.push(`run ${key}`);
                const d = deferred<string>();
                pending.push(d);
                return _$a.ret(`${key}:${_$a.t(() => d.promise) ? _$a.r(await _$a.p) : _$a.v}`);
              } catch (_$e) {
                _$a.x(_$e);
              }
            }) as any
          )
        : createMemo(
            $(function* () {
              const key = yield* id;
              log.push(`run ${key}`);
              const d = deferred<string>();
              pending.push(d);
              return `${key}:${yield* attempt(() => d.promise)}`;
            }) as any
          );
      createRenderEffect(
        () => m(),
        v => void out.push(v)
      );
    });
    flush();
    return { setId, out };
  }

  it("pending, superseded and resolved runs match the driver", async () => {
    const traces = await Promise.all(
      [false, true].map(async compiledForm => {
        const log: string[] = [];
        const pending: ReturnType<typeof deferred<string>>[] = [];
        const { setId, out } = memo(compiledForm, log, pending as any);
        setId("b");
        flush();
        // The first run is superseded: its settlement never lands.
        pending[0].resolve("stale");
        await tick();
        flush();
        pending[1].resolve("fresh");
        await tick();
        flush();
        return { log, out };
      })
    );
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[0].out).toEqual(["b:fresh"]);
  });

  it("a memo whose attempt returns a plain value is synchronous", () => {
    const [n, setN] = createSignal(1);
    const values = [false, true].map(compiledForm =>
      createRoot(() => {
        const m = compiledForm
          ? createMemo(
              asyncBody(async function (_$i: unknown, _$a) {
                try {
                  const v = n();
                  return _$a.ret(_$a.t(() => v * 2) ? _$a.r(await _$a.p) : _$a.v);
                } catch (_$e) {
                  _$a.x(_$e);
                }
              }) as any
            )
          : createMemo(
              $(function* () {
                const v = yield* n;
                return yield* attempt(() => v * 2);
              }) as any
            );
        return m as () => unknown;
      })
    );
    expect(values.map(m => m())).toEqual([2, 2]);
    setN(3);
    flush();
    expect(values.map(m => m())).toEqual([6, 6]);
  });
});

describe("compiled reads", () => {
  it("readAccessor, readSelected and readContext are perform's results", () => {
    const [n] = createSignal(4);
    const [store] = createStore({ items: [1, 2, 3] });
    expect(readAccessor(n)).toBe(perform(n));
    // Inside a running block (guard up) as well.
    const block = $(function () {
      return [
        readAccessor(n),
        perform(n),
        readSelected(store, s => s.items.length),
        perform(readStore(store, s => s.items.length))
      ];
    } as any);
    expect((block as any)()).toEqual([4, 4, 3, 3]);
    const Ctx = createContext("default");
    // (`perform(Ctx)` itself needs the setup host, which the compile-time
    // rules guarantee where `readContext` is emitted.)
    createRoot(() => {
      expect(readContext(Ctx)).toBe("default");
      setContext(Ctx, "provided");
      expect(readContext(Ctx)).toBe("provided");
    });
  });

  it("the path readers read through accessors without perform", () => {
    const [n] = createSignal(9);
    const props = { count: n, plain: 1 };
    expect(readPath1(props, "count")).toBe(9);
    expect(readPath1(props, "plain")).toBe(1);
  });
});
