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
  raise,
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
            } finally {
              _$a.f();
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
            } finally {
              _$a.f();
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
                      } finally {
                        _$a.f();
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
              } finally {
                _$a.f();
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
                } finally {
                  _$a.f();
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

  it("the path readers read an accessor without its iterator (ITERABLE off)", () => {
    // The generator-free slice installs no iterator on accessors; a compiled
    // app still reads one found at a path through its refresh brand.
    const [n] = createSignal("all");
    delete (n as any)[Symbol.iterator];
    expect(Symbol.iterator in n).toBe(false);
    expect(readPath1({ filter: n }, "filter")).toBe("all");
    // A plain function at a path is a value, as before.
    const handler = () => "clicked";
    expect(readPath1({ onClick: handler }, "onClick")).toBe(handler);
  });

  it("an iterable function found at a path is stepped operation by operation", () => {
    // Reads and context reads are run by the path reader itself; any other
    // operation through the operation switch its constructor installed.
    const [n] = createSignal(5);
    const reads = Object.assign(() => -1, {
      *[Symbol.iterator]() {
        return ((yield* n) as number) + 1;
      }
    });
    expect(readPath1({ x: reads }, "x")).toBe(6);
    const raises = Object.assign(() => -1, {
      *[Symbol.iterator]() {
        return yield* raise(new Bad("at a path"));
      }
    });
    expect(() => readPath1({ x: raises }, "x")).toThrow(Bad);
  });
});

/**
 * Several suspensions: the result promise of a compiled body settles in the
 * same microtask as the driver's (the driver's `then` promise adopts each
 * later step's promise, one reaction per level; `AsyncRun` rebuilds that
 * chain). Each program logs its continuations and the result's settlement
 * against a microtask clock started just before the last wait settles.
 */
describe("asyncBody: several suspensions, microtask for microtask", () => {
  type Waits = ReturnType<typeof deferred<unknown>>[];
  type Program = (log: (e: string) => void, w: Waits) => (input: unknown) => unknown;

  async function trace(make: Program, waits: number, settle: (w: Waits, i: number) => void) {
    const events: string[] = [];
    let clock = -1;
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      clock++;
      queueMicrotask(loop);
    };
    const log = (e: string) => events.push(`${e}@${clock}`);
    const w: Waits = Array.from({ length: waits }, () => deferred<unknown>());
    let result: unknown;
    try {
      result = make(log, w)(undefined);
    } catch (error) {
      log(`threw ${(error as Error).message}`);
    }
    if (result && typeof (result as any).then === "function") {
      (result as Promise<unknown>).then(
        v => {
          log(`fulfilled ${String(v)}`);
          stopped = true;
        },
        e => {
          log(`rejected ${(e as Error).message}`);
          stopped = true;
        }
      );
    } else log(`sync ${String(result)}`);
    for (let i = 0; i < waits; i++) {
      if (i === waits - 1) {
        clock = 0;
        queueMicrotask(loop);
      }
      settle(w, i);
      await tick();
    }
    stopped = true;
    return events;
  }

  function both(driver: Program, compiled: Program) {
    return async (
      waits: number,
      settle: (w: Waits, i: number) => void = (w, i) => w[i].resolve(i)
    ) => {
      const a = await createRoot(() => trace(driver, waits, settle));
      const b = await createRoot(() => trace(compiled, waits, settle));
      expect(b).toEqual(a);
      return a;
    };
  }

  it("two and three suspensions settle the result in the driver's microtask", async () => {
    for (const waits of [2, 3]) {
      const run = both(
        (log, w) =>
          $(function* () {
            let sum = 0;
            for (let i = 0; i < waits; i++) {
              sum += (yield* attempt(() => w[i].promise)) as number;
              log(`resumed ${i}`);
            }
            return sum;
          }) as any,
        (log, w) =>
          asyncBody(async function (_$i, _$a) {
            try {
              let sum = 0;
              for (let i = 0; i < waits; i++) {
                sum += (_$a.t(() => w[i].promise) ? _$a.r(await _$a.p) : _$a.v) as number;
                log(`resumed ${i}`);
              }
              return _$a.ret(sum);
            } catch (_$e) {
              _$a.x(_$e);
            } finally {
              _$a.f();
            }
          })
      );
      const events = await run(waits);
      // The driver's shape itself: one reaction per extra level.
      expect(events.at(-1)).toBe(`fulfilled ${waits === 2 ? 1 : 3}@${waits + 1}`);
    }
  });

  it("a rejection after the second suspension, and a body that falls off its end", async () => {
    await both(
      (log, w) =>
        $(function* () {
          yield* attempt(() => w[0].promise);
          log("first");
          yield* attempt(() => w[1].promise);
          log("never");
        }) as any,
      (log, w) =>
        asyncBody(async function (_$i, _$a) {
          try {
            _$a.t(() => w[0].promise) ? _$a.r(await _$a.p) : _$a.v;
            log("first");
            _$a.t(() => w[1].promise) ? _$a.r(await _$a.p) : _$a.v;
            log("never");
          } catch (_$e) {
            _$a.x(_$e);
          } finally {
            _$a.f();
          }
        })
    )(2, (w, i) => (i === 0 ? w[0].resolve(0) : w[1].reject(new Bad("second"))));
    const events = await both(
      (log, w) =>
        $(function* () {
          yield* attempt(() => w[0].promise);
          yield* attempt(() => w[1].promise);
          log("done");
        }) as any,
      (log, w) =>
        asyncBody(async function (_$i, _$a) {
          try {
            _$a.t(() => w[0].promise) ? _$a.r(await _$a.p) : _$a.v;
            _$a.t(() => w[1].promise) ? _$a.r(await _$a.p) : _$a.v;
            log("done");
          } catch (_$e) {
            _$a.x(_$e);
          } finally {
            _$a.f();
          }
        })
    )(2);
    expect(events).toEqual(["done@1", "fulfilled undefined@3"]);
  });

  it("a returned thenable is adopted by the innermost level; a user `finally` runs before the result settles", async () => {
    let late!: ReturnType<typeof deferred<string>>;
    await both(
      (log, w) =>
        $(function* () {
          yield* attempt(() => w[0].promise);
          yield* attempt(() => w[1].promise);
          late = deferred<string>();
          queueMicrotask(() => late.resolve("late"));
          return late.promise;
        }) as any,
      (log, w) =>
        asyncBody(async function (_$i, _$a) {
          try {
            _$a.t(() => w[0].promise) ? _$a.r(await _$a.p) : _$a.v;
            _$a.t(() => w[1].promise) ? _$a.r(await _$a.p) : _$a.v;
            late = deferred<string>();
            queueMicrotask(() => late.resolve("late"));
            return _$a.ret(late.promise);
          } catch (_$e) {
            _$a.x(_$e);
          } finally {
            _$a.f();
          }
        })
    )(2);
    const events = await both(
      (log, w) =>
        $(function* () {
          try {
            const a = (yield* attempt(() => w[0].promise)) as number;
            const b = (yield* attempt(() => w[1].promise)) as number;
            return a + b;
          } finally {
            log("finally");
          }
        }) as any,
      (log, w) =>
        asyncBody(async function (_$i, _$a) {
          try {
            try {
              const a = (_$a.t(() => w[0].promise) ? _$a.r(await _$a.p) : _$a.v) as number;
              const b = (_$a.t(() => w[1].promise) ? _$a.r(await _$a.p) : _$a.v) as number;
              return _$a.ret(a + b);
            } finally {
              log("finally");
            }
          } catch (_$e) {
            _$a.x(_$e);
          } finally {
            _$a.f();
          }
        })
    )(2);
    expect(events).toEqual(["finally@1", "fulfilled 1@3"]);
  });

  it("a memo superseded at its second suspension rejects as the driver's does", async () => {
    const traces = await Promise.all(
      [false, true].map(async compiledForm => {
        const [key, setKey] = createSignal("a");
        const log: string[] = [];
        const waits: ReturnType<typeof deferred<string>>[] = [];
        const wait = () => {
          const d = deferred<string>();
          waits.push(d);
          return d.promise;
        };
        let m!: () => unknown;
        createRoot(() => {
          m = compiledForm
            ? createMemo(
                asyncBody(async function (_$i: unknown, _$a) {
                  try {
                    const k = key();
                    const a = _$a.t(wait) ? _$a.r(await _$a.p) : _$a.v;
                    log.push(`${k} first`);
                    const b = _$a.t(wait) ? _$a.r(await _$a.p) : _$a.v;
                    return _$a.ret(`${k}:${a}${b}`);
                  } catch (_$e) {
                    _$a.x(_$e);
                  } finally {
                    _$a.f();
                  }
                }) as any
              )
            : createMemo(
                $(function* () {
                  const k = yield* key;
                  const a = yield* attempt(wait);
                  log.push(`${k} first`);
                  const b = yield* attempt(wait);
                  return `${k}:${a}${b}`;
                }) as any
              );
          createRenderEffect(
            () => m(),
            v => void log.push(`value ${String(v)}`)
          );
        });
        flush();
        waits[0].resolve("1");
        await tick();
        setKey("b");
        flush();
        waits[1].resolve("2");
        await tick();
        waits[2].resolve("3");
        await tick();
        waits[3].resolve("4");
        await tick();
        flush();
        return log;
      })
    );
    expect(traces[1]).toEqual(traces[0]);
    expect(traces[0].at(-1)).toBe("value b:34");
  });
});
