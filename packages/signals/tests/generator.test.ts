import {
  $,
  attempt,
  call,
  createEffect,
  createErrorBoundary,
  createMemo,
  createRoot,
  createSignal,
  dispatchBlock,
  errored,
  flush,
  getOwner,
  isPending,
  loading,
  NotReadyError,
  perform,
  raise,
  renderBlock,
  resolve,
  untrack,
  wait,
  write,
  type EventBlock,
  type Owner
} from "../src/index.js";

afterEach(() => flush());

class NotFound extends Error {}
class Forbidden extends Error {}
class HttpError extends Error {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settled<T>(read: () => T): Promise<T> {
  // Let a wait's continuation land, then flush the resulting update.
  await Promise.resolve();
  await Promise.resolve();
  flush();
  return read();
}

/** The typed error behind a memo read: Solid wraps it in a status error. */
function thrown(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return (error as { cause?: unknown }).cause ?? error;
  }
  throw new Error("expected the read to throw");
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    error => (error as { cause?: unknown }).cause ?? error
  );
}

describe("strict block scope", () => {
  it("a direct signal read inside a block fails; yield* reads succeed", () => {
    const [count] = createSignal(1);
    // TypeScript cannot see that `count()` is a reactive read (it is an
    // ordinary call); the dev runtime is what rejects it.
    const [direct, viaYield, viaUntrack] = createRoot(() => [
      createMemo(
        $(function* () {
          return count() * 2;
        })
      ),
      createMemo(
        $(function* () {
          return (yield* count) * 2;
        })
      ),
      createMemo(
        $(function* () {
          // untrack does not lift the rule either
          return untrack(() => count());
        })
      )
    ]);
    expect(() => direct()).toThrow(/\[DIRECT_READ_IN_BLOCK\]/);
    expect(viaYield()).toBe(2);
    expect(() => viaUntrack()).toThrow(/\[DIRECT_READ_IN_BLOCK\]/);
    // The guard is restored after a failing block: ordinary reads work.
    expect(count()).toBe(1);
  });

  it("nested blocks, upstream pulls and effect phases do not leak the guard", () => {
    const [count, setCount] = createSignal(1);
    const effectLog: number[] = [];
    const [plain, inner, outer] = createRoot(() => {
      const plain = createMemo(() => count() + 1);
      const inner = createMemo(
        $(function* () {
          return (yield* plain) * 10;
        })
      );
      const outer = createMemo(
        $(function* () {
          return (yield* inner) + (yield* count);
        })
      );
      createEffect(
        $(function* () {
          return yield* outer;
        }),
        value => {
          // The effect phase runs outside the block: direct reads are fine.
          effectLog.push(value + count());
        }
      );
      return [plain, inner, outer];
    });
    expect(outer()).toBe(21);
    flush();
    expect(effectLog).toEqual([22]);
    setCount(2);
    flush();
    expect([plain(), inner(), outer()]).toEqual([3, 30, 32]);
    expect(effectLog).toEqual([22, 34]);
    expect(count()).toBe(2);
  });
});

describe("operations", () => {
  it("reads heterogeneous signals, receives prev, and keeps conditional tracking", () => {
    const [count, setCount] = createSignal(2);
    const [label, setLabel] = createSignal("items");
    const [useLabel, setUseLabel] = createSignal(true);
    let runs = 0;
    const summary = createRoot(() =>
      createMemo(
        $(function* (prev: string[] | undefined) {
          runs++;
          const c = yield* count;
          const text = (yield* useLabel) ? `${c} ${yield* label}` : `${c}`;
          return [...(prev ?? []), text];
        })
      )
    );
    expect(summary()).toEqual(["2 items"]);
    setLabel("things");
    flush();
    expect(summary()).toEqual(["2 items", "2 things"]);
    setUseLabel(false);
    flush();
    expect(summary()).toEqual(["2 items", "2 things", "2"]);
    setLabel("ignored");
    flush();
    expect(runs).toBe(3);
    setCount(3);
    flush();
    expect(summary().at(-1)).toBe("3");
  });

  it("a bare yield or a non-operation yield fails with a useful error", () => {
    const [count] = createSignal(1);
    const bareSignal = createMemo(
      // @ts-expect-error — an accessor is not an operation
      $(function* () {
        yield count;
        return 0;
      })
    );
    expect(() => bareSignal()).toThrow(/\[PLAIN_YIELD_IN_BLOCK\].*yield\*/);

    const bareOp = createMemo(
      $(function* () {
        yield raise(new Error("x"));
        return 0;
      })
    );
    expect(() => bareOp()).toThrow(/\[PLAIN_YIELD_IN_BLOCK\].*yield\*/);

    const bareCall = createMemo(
      $(function* () {
        yield call(
          $(function* () {
            return 1;
          }),
          undefined
        );
        return 0;
      })
    );
    expect(() => bareCall()).toThrow(/\[PLAIN_YIELD_IN_BLOCK\].*call/);

    const number = createMemo(
      // @ts-expect-error — not an operation
      $(function* () {
        yield 42;
        return 0;
      })
    );
    expect(() => number()).toThrow(/\[INVALID_YIELD\].*received a number/);

    const promise = createMemo(
      // @ts-expect-error — a promise must go through wait()
      $(function* () {
        yield Promise.resolve(1);
        return 0;
      })
    );
    expect(() => promise()).toThrow(/\[INVALID_YIELD\].*received a Promise/);
  });

  it("rejects async generators (await)", () => {
    const viaAwait = createMemo(
      // @ts-expect-error — no async generators
      $(async function* () {
        return 1;
      })
    );
    expect(() => viaAwait()).toThrow(/\[ASYNC_GENERATOR\].*yield\* wait/);
  });

  it("raise is a typed throw: the error propagates and finally blocks run", () => {
    const [flag, setFlag] = createSignal(false);
    let finalized = 0;
    const guarded = createRoot(() =>
      createMemo(
        $(function* () {
          try {
            if (yield* flag) yield* raise(new NotFound("missing"));
            return "ok";
          } finally {
            finalized++;
          }
        })
      )
    );
    expect(guarded()).toBe("ok");
    expect(finalized).toBe(1);
    setFlag(true);
    flush();
    expect(thrown(guarded)).toBeInstanceOf(NotFound);
    expect(finalized).toBe(2);
  });

  it("attempt runs a fallible step: success returns, failure propagates", () => {
    const [raw, setRaw] = createSignal('{"a":1}');
    const parsed = createRoot(() =>
      createMemo(
        $(function* () {
          const text = yield* raw;
          return yield* attempt(() => JSON.parse(text) as { a: number }, SyntaxError);
        })
      )
    );
    expect(parsed()).toEqual({ a: 1 });
    setRaw("{");
    flush();
    expect(thrown(parsed)).toBeInstanceOf(SyntaxError);
  });

  it("wait suspends the block and lands through Solid's async model", async () => {
    const [userId, setUserId] = createSignal(1);
    const flights: Record<number, ReturnType<typeof deferred<{ name: string }>>> = {};
    const name = createRoot(() =>
      createMemo(
        $(function* () {
          const id = yield* userId;
          const user = yield* wait((flights[id] = deferred<{ name: string }>()).promise, HttpError);
          return user.name;
        })
      )
    );
    expect(() => name()).toThrow(NotReadyError);
    flights[1].resolve({ name: "Ada" });
    expect(await settled(name)).toBe("Ada");
    expect(isPending(name)).toBe(false);

    setUserId(2);
    flush();
    expect(isPending(name)).toBe(true);
    flights[2].resolve({ name: "Bob" });
    expect(await resolve(name)).toBe("Bob");
  });

  it("a rejected wait propagates as the block's error", async () => {
    const flight = deferred<string>();
    const name = createRoot(() =>
      createMemo(
        $(function* () {
          return yield* wait(flight.promise, HttpError);
        })
      )
    );
    expect(() => name()).toThrow(NotReadyError);
    flight.reject(new HttpError("503"));
    expect(await rejected(settled(name))).toBeInstanceOf(HttpError);
  });

  it("reads after the first wait are refused (they would be untracked)", async () => {
    const [count] = createSignal(1);
    const flight = deferred<number>();
    const late = createRoot(() =>
      createMemo(
        $(function* () {
          const base = yield* wait(flight.promise);
          return base + (yield* count);
        })
      )
    );
    expect(() => late()).toThrow(NotReadyError);
    flight.resolve(10);
    expect(String(await rejected(settled(late)))).toMatch(/\[READ_AFTER_WAIT\]/);
  });

  it("a superseded run is cancelled: its generator closes and never resumes", async () => {
    const [userId, setUserId] = createSignal(1);
    const flights: Record<number, ReturnType<typeof deferred<string>>> = {};
    const log: string[] = [];
    const name = createRoot(() =>
      createMemo(
        $(function* () {
          const id = yield* userId;
          try {
            const value = yield* wait((flights[id] = deferred<string>()).promise);
            log.push(`resumed:${id}`);
            return value;
          } finally {
            log.push(`closed:${id}`);
          }
        })
      )
    );
    expect(() => name()).toThrow(NotReadyError);
    // Supersede run 1 before its flight lands.
    setUserId(2);
    flush();
    flights[1].resolve("stale");
    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(["closed:1"]);
    flights[2].resolve("fresh");
    expect(await settled(name)).toBe("fresh");
    expect(log).toEqual(["closed:1", "resumed:2", "closed:2"]);
  });

  it("delegating to another block composes its operations and tracking", () => {
    const [first, setFirst] = createSignal("Ada");
    const [last] = createSignal("Lovelace");
    const [flag, setFlag] = createSignal(false);
    const fullName = $(function* () {
      if (yield* flag) yield* raise(new Forbidden());
      return `${yield* first} ${yield* last}`;
    });
    const greeting = createRoot(() =>
      createMemo(
        $(function* () {
          return `Hi ${yield* fullName}`;
        })
      )
    );
    expect(greeting()).toBe("Hi Ada Lovelace");
    setFirst("Grace");
    flush();
    expect(greeting()).toBe("Hi Grace Lovelace");
    setFlag(true);
    flush();
    expect(thrown(greeting)).toBeInstanceOf(Forbidden);
  });

  it("createEffect accepts both an ordinary callback and a block", () => {
    const [count, setCount] = createSignal(1);
    const plainLog: number[] = [];
    const blockLog: number[] = [];
    createRoot(() => {
      createEffect(
        () => count() * 10,
        v => {
          plainLog.push(v);
        }
      );
      createEffect(
        $(function* () {
          return (yield* count) * 10;
        }),
        v => {
          blockLog.push(v);
        }
      );
    });
    flush();
    setCount(2);
    flush();
    expect(plainLog).toEqual([10, 20]);
    expect(blockLog).toEqual([10, 20]);
  });
});

describe("hosts", () => {
  it("a reactive host admits reads, tasks and failures but refuses writes", () => {
    const [count, setCount] = createSignal(1);
    const writer = $(function* () {
      yield* write(setCount, 5);
      return yield* count;
    });
    // @ts-expect-error — a reactive host admits no Writes
    const memo = createRoot(() => createMemo(writer));
    expect(() => memo()).toThrow(/\[WRITE_IN_REACTIVE_BLOCK\]/);
    expect(count()).toBe(1);
  });

  it("a JSX host admits reads only, at runtime too", () => {
    const [count] = createSignal(1);
    const flight = deferred<number>();
    const reads = $(function* () {
      return { tag: "p", text: `${yield* count}` };
    });
    const waits = $(function* () {
      return yield* wait(flight.promise);
    });
    const raises = $(function* () {
      if (yield* count) yield* raise(new NotFound());
      return 1;
    });
    const attempts = $(function* () {
      return yield* attempt(() => 1);
    });
    const [, setCount2] = createSignal(0);
    const writes = $(function* () {
      yield* write(setCount2, 1);
      return 1;
    });
    createRoot(() => {
      expect(renderBlock(reads)).toEqual({ tag: "p", text: "1" });
      expect(() => renderBlock(waits)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`wait`/);
      expect(() => renderBlock(raises)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`raise`/);
      expect(() => renderBlock(attempts)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`attempt`/);
      expect(() => renderBlock(writes)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`write`/);
    });
  });

  it("a JSX host inherits pending and error state through its reads", async () => {
    const [userId, setUserId] = createSignal(1);
    const flights: Record<number, ReturnType<typeof deferred<{ name: string }>>> = {};
    const [user, view] = createRoot(() => {
      const user = createMemo(
        $(function* () {
          const id = yield* userId;
          if (id === 3) yield* raise(new NotFound());
          const loaded = yield* wait((flights[id] = deferred<{ name: string }>()).promise);
          return loaded;
        })
      );
      // Reads only — yet pending / error-typed through `user`.
      const view = $(function* () {
        return { tag: "p", text: (yield* user).name };
      });
      return [user, view] as const;
    });
    createRoot(() => {
      expect(() => renderBlock(view)).toThrow(NotReadyError);
    });
    flights[1].resolve({ name: "Ada" });
    await settled(user);
    createRoot(() => {
      expect(renderBlock(view)).toEqual({ tag: "p", text: "Ada" });
    });
    setUserId(3);
    flush();
    createRoot(() => {
      expect(thrown(() => renderBlock(view))).toBeInstanceOf(NotFound);
    });
  });

  it("an event host admits everything: reads, writes, tasks, and typed failures", async () => {
    const [count, setCount] = createSignal(1);
    const [status, setStatus] = createSignal("idle");
    const flight = deferred<string>();
    const handler = $(function* (event: { type: string }) {
      const c = yield* count;
      yield* write(setCount, c + 1);
      yield* write(setStatus, `${event.type}:pending`);
      const answer = yield* wait(flight.promise, HttpError);
      yield* write(setStatus, `${event.type}:${answer}`);
      return answer;
    });
    createRoot(() => {
      dispatchBlock(handler, { type: "click" });
    });
    flush();
    expect(count()).toBe(2);
    expect(status()).toBe("click:pending");
    flight.resolve("done");
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(status()).toBe("click:done");
  });

  it("an event block's failures route to the error boundary above its owner", async () => {
    const [mode, setMode] = createSignal<"sync" | "async">("sync");
    const flight = deferred<string>();
    let owner: Owner | null = null;
    let handler!: EventBlock<{ type: string }>;
    const view = createRoot(() =>
      createErrorBoundary(
        () => {
          owner = getOwner();
          // Created inside the boundary: the block captures this owner.
          handler = $(function* (_event: { type: string }) {
            if ((yield* mode) === "sync") yield* raise(new Forbidden("no"));
            yield* wait(flight.promise, HttpError);
          });
          return "content";
        },
        (error, reset) => `caught:${(error() as Error).constructor.name}:${typeof reset}`
      )
    );
    expect(view()).toBe("content");
    expect(owner).not.toBeNull();
    // Synchronous failure: not thrown at the dispatcher, delivered to the boundary.
    expect(() => dispatchBlock(handler, { type: "click" })).not.toThrow();
    flush();
    expect(view()).toBe("caught:Forbidden:function");

    // Without a boundary above the owner, a failure propagates as from an
    // ordinary handler.
    const loose = $(function* (_event: { type: string }) {
      yield* raise(new Forbidden("loose"));
    });
    expect(() => dispatchBlock(loose, { type: "click" }, null)).toThrow(Forbidden);

    // Asynchronous failure (rejected wait) takes the same route.
    setMode("async");
    flush();
    const asyncView = createRoot(() =>
      createErrorBoundary(
        () => {
          handler = $(function* (_event: { type: string }) {
            yield* wait(flight.promise, HttpError);
          });
          return "content";
        },
        error => `caught:${(error() as Error).constructor.name}`
      )
    );
    dispatchBlock(handler, { type: "click" });
    flight.reject(new HttpError("503"));
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(asyncView()).toBe("caught:HttpError");
  });

  it("a wrapping event block delegates to the parent with call() and composes", () => {
    const [log, setLog] = createSignal<string[]>([]);
    const parent = $(function* (event: { type: string }) {
      yield* write(setLog, l => [...l, `parent:${event.type}`]);
      return "parent-result";
    });
    const child = $(function* (event: { type: string }) {
      yield* write(setLog, l => [...l, `child:${event.type}`]);
      const result = yield* call(parent, event);
      return `child(${result})`;
    });
    createRoot(() => dispatchBlock(child, { type: "click" }));
    flush();
    expect(log()).toEqual(["child:click", "parent:click"]);
  });
});

describe("runtime driver vs lowered (call-form) blocks", () => {
  it("the sync subset behaves identically in both forms", () => {
    // The compiler lowers `$(function* () { const c = yield* count; ... })`
    // to `$(function () { const c = perform(count); ... })`.
    const [count, setCount] = createSignal(1);
    const [gate, setGate] = createSignal(false);
    const [raw, setRaw] = createSignal("1");
    let generatorRuns = 0;
    let loweredRuns = 0;
    const [viaGenerator, viaLowered] = createRoot(() => [
      createMemo(
        $(function* () {
          generatorRuns++;
          const c = yield* count;
          const text = yield* raw;
          const n = yield* attempt(() => JSON.parse(text) as number, SyntaxError);
          if (n < 0) yield* raise(new RangeError("negative"));
          return (yield* gate) ? c * 10 + n : c + n;
        })
      ),
      createMemo(
        // The call form is compiler output; TypeScript only accepts generators.
        $(function () {
          loweredRuns++;
          const c = perform(count);
          const text = perform(raw);
          const n = perform(attempt(() => JSON.parse(text) as number, SyntaxError));
          if (n < 0) perform(raise(new RangeError("negative")));
          return perform(gate) ? c * 10 + n : c + n;
        } as any) as any
      )
    ]);
    const same = () => {
      expect(viaLowered()).toBe(viaGenerator());
      expect(loweredRuns).toBe(generatorRuns);
    };
    same();
    setGate(true);
    flush();
    same();
    setRaw("5");
    flush();
    same();
    expect(viaGenerator()).toBe(15);
    setRaw("-1");
    flush();
    expect(thrown(viaGenerator)).toBeInstanceOf(RangeError);
    expect(thrown(viaLowered)).toBeInstanceOf(RangeError);
    setRaw("{");
    flush();
    expect(thrown(viaGenerator)).toBeInstanceOf(SyntaxError);
    expect(thrown(viaLowered)).toBeInstanceOf(SyntaxError);
    setCount(2);
    setRaw("1");
    flush();
    same();
    expect(loweredRuns).toBe(generatorRuns);
  });

  it("lowered event blocks write and delegate under the same host rules", () => {
    const [log, setLog] = createSignal<string[]>([]);
    const parent = $(function* (event: { type: string }) {
      yield* write(setLog, l => [...l, `parent:${event.type}`]);
      return 1;
    });
    // `$(function (event) { perform(write(...)); perform(call(parent, event)) })`
    const loweredChild = $(function (event: { type: string }) {
      perform(write(setLog, l => [...l, `child:${event.type}`]));
      return perform(call(parent, event)) + 1;
    } as any);
    createRoot(() => dispatchBlock(loweredChild, { type: "click" }));
    flush();
    expect(log()).toEqual(["child:click", "parent:click"]);
    // The same lowered block refuses to write under a reactive host.
    const memo = createRoot(() => createMemo(loweredChild as any));
    expect(() => memo()).toThrow(/\[WRITE_IN_REACTIVE_BLOCK\]/);
  });

  it("a lowered body is still strict, and async operations refuse call form", () => {
    const [count] = createSignal(1);
    const direct = createRoot(() => createMemo($((() => count() + 1) as any) as any));
    expect(() => direct()).toThrow(/\[DIRECT_READ_IN_BLOCK\]/);

    const flight = deferred<number>();
    const asyncOp = createRoot(() =>
      createMemo($((() => perform(wait(flight.promise))) as any) as any)
    );
    expect(() => asyncOp()).toThrow(/\[ASYNC_OP_OUTSIDE_DRIVER\]/);

    const asyncBlock = $(function* () {
      return yield* wait(flight.promise);
    });
    const delegatedInCallForm = createRoot(() =>
      createMemo($((() => perform(asyncBlock)) as any) as any)
    );
    expect(() => delegatedInCallForm()).toThrow(/\[ASYNC_BLOCK_OUTSIDE_DRIVER\]/);
  });
});

describe("block boundaries", () => {
  it("loading consumes an async block and yields a non-async block", async () => {
    const [userId, setUserId] = createSignal(1);
    const flights: Record<number, ReturnType<typeof deferred<{ name: string }>>> = {};
    const view = createRoot(() => {
      const profile = $(function* () {
        const id = yield* userId;
        const user = yield* wait((flights[id] = deferred<{ name: string }>()).promise);
        return { tag: "p", text: user.name };
      });
      return createMemo(loading(profile, () => ({ tag: "p", text: "loading…" })));
    });
    // Never throws NotReadyError: the fallback is the value while pending.
    expect(view()).toEqual({ tag: "p", text: "loading…" });
    flights[1].resolve({ name: "Ada" });
    expect(await settled(view)).toEqual({ tag: "p", text: "Ada" });
    setUserId(2);
    flush();
    expect(view()).toEqual({ tag: "p", text: "Ada" });
    flights[2].resolve({ name: "Bob" });
    expect(await settled(view)).toEqual({ tag: "p", text: "Bob" });
  });

  it("errored handles the listed errors and propagates the rest", () => {
    const [mode, setMode] = createSignal<"ok" | "missing" | "denied">("ok");
    let resetOuter!: () => void;
    const [view, all] = createRoot(() => {
      const page = $(function* () {
        const m = yield* mode;
        if (m === "missing") yield* raise(new NotFound());
        if (m === "denied") yield* raise(new Forbidden());
        return { tag: "p", text: "page" };
      });
      const handled = errored(page, [NotFound], () => ({ tag: "p", text: "not found" }));
      const all = errored(handled, [Forbidden], (error, reset) => {
        expect(error).toBeInstanceOf(Forbidden);
        resetOuter = reset;
        return { tag: "p", text: "denied" };
      });
      return [createMemo(handled), createMemo(all)];
    });
    expect(view()).toEqual({ tag: "p", text: "page" });
    setMode("missing");
    flush();
    expect(view()).toEqual({ tag: "p", text: "not found" });
    expect(all()).toEqual({ tag: "p", text: "not found" });
    setMode("denied");
    flush();
    // Unmatched by the inner boundary: propagates to the outer one.
    expect(thrown(view)).toBeInstanceOf(Forbidden);
    expect(all()).toEqual({ tag: "p", text: "denied" });
    // Recovery follows Solid's error-boundary semantics: a boundary that
    // caught an error keeps its fallback until `reset()`.
    setMode("ok");
    flush();
    expect(view()).toEqual({ tag: "p", text: "page" });
    expect(all()).toEqual({ tag: "p", text: "denied" });
    resetOuter();
    flush();
    expect(all()).toEqual({ tag: "p", text: "page" });
  });
});
