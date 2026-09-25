import {
  $,
  action,
  createMemo,
  createOptimisticStore,
  createProjection,
  createRenderEffect,
  createRoot,
  createSignal,
  createStore,
  dispatchBlock,
  flush,
  isPending,
  NotReadyError,
  perform,
  raise,
  readStore,
  renderBlock,
  wait,
  write
} from "../src/index.js";

afterEach(() => flush());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => (resolve = res));
  return { promise, resolve };
}

/** The typed error behind a read: Solid may wrap it in a status error. */
function thrown(read: () => unknown): unknown {
  try {
    read();
  } catch (error) {
    return (error as { cause?: unknown }).cause ?? error;
  }
  throw new Error("expected the read to throw");
}

async function settled<T>(read: () => T): Promise<T> {
  // Let a wait's continuation land, then flush the resulting update.
  await Promise.resolve();
  await Promise.resolve();
  flush();
  return read();
}

interface Item {
  id: number;
  name: string;
}
interface State {
  user: { name: string; address: { city: string } };
  items: Item[];
  index: number;
}
function state(): State {
  return {
    user: { name: "Ada", address: { city: "London" } },
    items: [
      { id: 1, name: "one" },
      { id: 2, name: "two" }
    ],
    index: 0
  };
}

describe("readStore in reactive blocks", () => {
  it("reads an object property and updates", () => {
    const [store, setStore] = createStore(state());
    let runs = 0;
    const name = createRoot(() =>
      createMemo(
        $(function* () {
          runs++;
          return yield* readStore(store, s => s.user.name);
        })
      )
    );
    expect(name()).toBe("Ada");
    setStore(s => {
      s.user.name = "Grace";
    });
    flush();
    expect(name()).toBe("Grace");
    // Unrelated properties do not re-run the block: the proxy tracks exactly
    // what the selector touched.
    setStore(s => {
      s.index = 1;
    });
    flush();
    expect(runs).toBe(2);
  });

  it("reads a nested property", () => {
    const [store, setStore] = createStore(state());
    const city = createRoot(() =>
      createMemo(
        $(function* () {
          return `${yield* readStore(store, s => s.user.address.city)}!`;
        })
      )
    );
    expect(city()).toBe("London!");
    setStore(s => {
      s.user.address.city = "Paris";
    });
    flush();
    expect(city()).toBe("Paris!");
  });

  it("reads array index, length, map (structural) and a dynamic index", () => {
    const [store, setStore] = createStore(state());
    const [first, count, names, current] = createRoot(() => [
      createMemo(
        $(function* () {
          return yield* readStore(store, s => s.items[0].name);
        })
      ),
      createMemo(
        $(function* () {
          return yield* readStore(store, s => s.items.length);
        })
      ),
      createMemo(
        $(function* () {
          return yield* readStore(store, s => s.items.map(item => item.name).join(","));
        })
      ),
      createMemo(
        $(function* () {
          // Dynamic index: the selector reads `index` and then the item.
          return yield* readStore(store, s => s.items[s.index]?.name);
        })
      )
    ]);
    expect([first(), count(), names(), current()]).toEqual(["one", 2, "one,two", "one"]);
    setStore(s => {
      s.items[0].name = "uno";
    });
    flush();
    expect([first(), names(), current()]).toEqual(["uno", "uno,two", "uno"]);
    setStore(s => {
      s.items.push({ id: 3, name: "three" });
    });
    flush();
    expect([count(), names()]).toEqual([3, "uno,two,three"]);
    setStore(s => {
      s.index = 2;
    });
    flush();
    expect(current()).toBe("three");
    setStore(s => {
      s.items.splice(0, 1);
    });
    flush();
    expect([first(), count(), names(), current()]).toEqual(["two", 2, "two,three", undefined]);
  });

  it("a direct store read inside a block body is still refused by the strict scope", () => {
    const [store] = createStore(state());
    // A bare access is a deferred path token; a run that never reads it with
    // `yield*` fails (the direct-syntax contract's loud failure).
    const direct = createRoot(() =>
      createMemo(
        $(function* () {
          return store.user.name;
        })
      )
    );
    expect(() => direct()).toThrow(/\[UNREAD_PATH\] `<root>\.user\.name`/);
    // The guard is restored: ordinary reads work outside the block.
    expect(store.user.name).toBe("Ada");
  });

  it("runtime driver and lowered call form agree", () => {
    const [store, setStore] = createStore(state());
    let generatorRuns = 0;
    let loweredRuns = 0;
    const [viaGenerator, viaLowered] = createRoot(() => [
      createMemo(
        $(function* () {
          generatorRuns++;
          const name = yield* readStore(store, s => s.user.name);
          const total = yield* readStore(store, s => s.items.length);
          return `${name}:${total}`;
        })
      ),
      createMemo(
        // What the compiler emits for the block above.
        $(function () {
          loweredRuns++;
          const name = perform(readStore(store, s => s.user.name));
          const total = perform(readStore(store, s => s.items.length));
          return `${name}:${total}`;
        } as any) as any
      )
    ]);
    const same = () => {
      expect(viaLowered()).toBe(viaGenerator());
      expect(loweredRuns).toBe(generatorRuns);
    };
    same();
    setStore(s => {
      s.user.name = "Grace";
    });
    flush();
    same();
    setStore(s => {
      s.items.push({ id: 9, name: "nine" });
    });
    flush();
    same();
    setStore(s => {
      s.index = 5; // not read by either
    });
    flush();
    same();
    expect(viaGenerator()).toBe("Grace:3");
  });

  it("a block may return a store proxy itself (regression: result-shape probes)", () => {
    // The driver probes a block's result for generator/promise shape; on a
    // store proxy those probes are `has`/`get` traps, i.e. tracked reads, and
    // they used to trip the strict guard after the body returned.
    const [store, setStore] = createStore(state());
    const [viaGenerator, viaLowered] = createRoot(() => {
      const generator = createMemo(
        $(function* () {
          return yield* readStore(store, s => s.items);
        })
      );
      const lowered = createMemo(
        $(function () {
          return perform(readStore(store, s => s.items));
        } as any) as any
      ) as typeof generator;
      return [generator, lowered] as const;
    });
    expect(viaGenerator().length).toBe(2);
    expect(viaLowered()).toBe(viaGenerator());
    createRoot(() => {
      const items: Item[] = renderBlock(
        $(function* () {
          return yield* readStore(store, s => s.items);
        })
      );
      expect(items.length).toBe(2);
    });
    setStore(s => {
      s.items.push({ id: 3, name: "three" });
    });
    flush();
    expect(viaGenerator().length).toBe(3);
  });

  it("shared references between stores track as before", () => {
    // A sub-object placed in two stores is one reactive node: a read through
    // either root sees a write through the other (existing store behavior).
    const shared = { name: "shared" };
    const [a, setA] = createStore({ node: shared });
    const [b] = createStore({ node: shared });
    const [viaA, viaB] = createRoot(() => [
      createMemo(
        $(function* () {
          return yield* readStore(a, s => s.node.name);
        })
      ),
      createMemo(
        $(function* () {
          return yield* readStore(b, s => s.node.name);
        })
      )
    ]);
    expect([viaA(), viaB()]).toEqual(["shared", "shared"]);
    setA(s => {
      s.node.name = "changed";
    });
    flush();
    expect([viaA(), viaB()]).toEqual(["changed", "changed"]);
    expect(b.node.name).toBe("changed");
  });
});

describe("readStore across hosts", () => {
  it("a JSX host accepts readStore and still refuses tasks, failures and writes", () => {
    const [store, setStore] = createStore(state());
    const flight = Promise.resolve(1);
    const reads = $(function* () {
      return { tag: "ul", items: yield* readStore(store, s => s.items.map(item => item.name)) };
    });
    const waits = $(function* () {
      const n = yield* wait(flight);
      return yield* readStore(store, s => s.items[n]);
    });
    const writes = $(function* () {
      yield* write(setStore, s => {
        s.index = 1;
      });
      return yield* readStore(store, s => s.index);
    });
    createRoot(() => {
      expect(renderBlock(reads)).toEqual({ tag: "ul", items: ["one", "two"] });
      expect(() => renderBlock(waits)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`wait`/);
      expect(() => renderBlock(writes)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`write`/);
    });
    expect(store.index).toBe(0);
  });

  it("an event block writes a store with write(setStore, updater); reactive hosts refuse it", () => {
    const [store, setStore] = createStore(state());
    const [clicks, setClicks] = createSignal(0);
    const add = $(function* (event: { type: string; name: string }) {
      const count = yield* readStore(store, s => s.items.length);
      yield* write(setStore, s => {
        s.items.push({ id: count + 1, name: `${event.name}#${count + 1}` });
      });
      yield* write(setClicks, c => c + 1);
    });
    const names = createRoot(() =>
      createMemo(
        $(function* () {
          return yield* readStore(store, s => s.items.map(item => item.name).join(","));
        })
      )
    );
    expect(names()).toBe("one,two");
    dispatchBlock(add, { type: "click", name: "added" });
    flush();
    expect(names()).toBe("one,two,added#3");
    expect(clicks()).toBe(1);

    // The same block under a reactive host: refused before any write lands.
    // @ts-expect-error — a reactive host admits no Writes
    const asMemo = createRoot(() => createMemo(add));
    expect(() => asMemo()).toThrow(/\[WRITE_IN_REACTIVE_BLOCK\]/);
    expect(store.items.length).toBe(3);
  });
});

describe("block-derived stores", () => {
  interface Summary {
    total: number;
    names: string;
    runs: number;
  }

  it("createProjection runs a block as the derive (mutation form): yields track, the draft is plain", () => {
    const [count, setCount] = createSignal(1);
    const [source, setSource] = createStore(state());
    let runs = 0;
    const summary = createRoot(() =>
      createProjection(
        $(function* (draft: Summary) {
          runs++;
          const names = yield* readStore(source, s => s.items.map(item => item.name).join(","));
          draft.total = yield* count;
          draft.names = names;
          // The draft is the block's input, not a reactive source: reading it
          // back is an ordinary read of the projection's own state.
          draft.runs = draft.runs + 1;
        }),
        { total: 0, names: "", runs: 0 }
      )
    );
    expect([summary.total, summary.names, summary.runs]).toEqual([1, "one,two", 1]);
    setCount(2);
    flush();
    expect([summary.total, summary.runs]).toEqual([2, 2]);
    setSource(s => {
      s.items.push({ id: 3, name: "three" });
    });
    flush();
    expect([summary.names, summary.runs]).toEqual(["one,two,three", 3]);
    // Only what the selector touched is a dependency.
    setSource(s => {
      s.index = 1;
    });
    flush();
    expect(runs).toBe(3);
    expect(summary.runs).toBe(3);
  });

  it("return form: a parameterless block's value is the shape, reconciled by key", () => {
    const [source, setSource] = createStore(state());
    const [hidden, setHidden] = createSignal(0);
    const visible = createRoot(() =>
      createProjection(
        $(function* () {
          const items = yield* readStore(source, s => s.items.map(item => ({ ...item })));
          const skip = yield* hidden;
          return items.filter(item => item.id !== skip);
        }),
        [] as Item[]
      )
    );
    expect(visible.map(item => item.name)).toEqual(["one", "two"]);
    const second = visible[1];
    setHidden(1);
    flush();
    expect(visible.map(item => item.name)).toEqual(["two"]);
    // Keyed by `id` (the default): the surviving row keeps its identity.
    expect(visible[0]).toBe(second);
    setSource(s => {
      s.items[1].name = "dos";
    });
    flush();
    expect(visible[0].name).toBe("dos");
  });

  it("derived createStore: the block recomputes and the setter writes", () => {
    const [count, setCount] = createSignal(1);
    const [doubled, setDoubled] = createRoot(() =>
      createStore(
        $(function* (draft: { value: number }) {
          draft.value = (yield* count) * 2;
        }),
        { value: 0 }
      )
    );
    expect(doubled.value).toBe(2);
    setCount(2);
    flush();
    expect(doubled.value).toBe(4);
    setDoubled(s => {
      s.value = 100;
    });
    flush();
    expect(doubled.value).toBe(100);
    setCount(3);
    flush();
    expect(doubled.value).toBe(6);
  });

  it("derived createOptimisticStore: an action's write shows at once and reverts to the block's truth", async () => {
    const [count, setCount] = createSignal(1);
    const seen: number[] = [];
    const [store, setStore] = createRoot(() => {
      const pair = createOptimisticStore(
        $(function* (draft: { value: number }) {
          draft.value = yield* count;
        }),
        { value: 0 }
      );
      // A live tracked reader, as in a rendered app.
      createRenderEffect(
        () => pair[0].value,
        value => {
          seen.push(value);
        }
      );
      return pair;
    });
    flush();
    expect(store.value).toBe(1);

    let release!: () => void;
    const act = action(function* () {
      setStore(s => {
        s.value = 42;
      });
      yield new Promise<void>(resolve => (release = resolve));
    });
    const done = act();
    flush();
    expect(store.value).toBe(42);

    release();
    await done;
    await new Promise(resolve => setTimeout(resolve, 0));
    flush();
    expect(store.value).toBe(1);

    setCount(5);
    flush();
    expect(store.value).toBe(5);
    expect(seen).toEqual([1, 42, 1, 5]);
  });

  it("an async block projection is pending until its wait settles, then refetches on its reads", async () => {
    const [count, setCount] = createSignal(1);
    const gate = deferred<string>();
    const [proj, view] = createRoot(() => {
      const proj = createProjection(
        $(function* (draft: { name: string }) {
          const n = yield* count;
          draft.name = `${yield* wait(gate.promise)}#${n}`;
        }),
        { name: "" }
      );
      const view = createMemo(() => proj.name);
      return [proj, view] as const;
    });
    // An uninitialized async derive: the seed is unobservable.
    expect(thrown(() => proj.name)).toBeInstanceOf(NotReadyError);
    expect(thrown(() => view())).toBeInstanceOf(NotReadyError);
    gate.resolve("Ada");
    expect(await settled(() => proj.name)).toBe("Ada#1");
    expect(view()).toBe("Ada#1");

    setCount(2);
    flush();
    // A refetch: the last value serves while the block is pending again.
    expect(isPending(() => proj.name)).toBe(true);
    expect(proj.name).toBe("Ada#1");
    expect(await settled(() => proj.name)).toBe("Ada#2");
    expect(isPending(() => proj.name)).toBe(false);
  });

  it("a raised failure surfaces through reads of the projected store and recovers", () => {
    class Boom extends Error {}
    const [count, setCount] = createSignal(1);
    const proj = createRoot(() =>
      createProjection(
        $(function* (draft: { value: number }) {
          const c = yield* count;
          if (c > 1) yield* raise(new Boom("too many"));
          draft.value = c;
        }),
        { value: 0 }
      )
    );
    expect(proj.value).toBe(1);
    setCount(2);
    flush();
    expect(thrown(() => proj.value)).toBeInstanceOf(Boom);
    setCount(1);
    flush();
    expect(proj.value).toBe(1);
  });

  it("runtime driver and lowered call form agree for a projection block", () => {
    const [count, setCount] = createSignal(1);
    const [source, setSource] = createStore(state());
    const [viaGenerator, viaLowered] = createRoot(() => [
      createProjection(
        $(function* (draft: { label: string }) {
          draft.label = `${yield* readStore(source, s => s.user.name)}:${yield* count}`;
        }),
        { label: "" }
      ),
      createProjection(
        // What the compiler emits for the block above.
        $(function (draft: { label: string }) {
          draft.label = `${perform(readStore(source, s => s.user.name))}:${perform(count)}`;
        } as any) as any,
        { label: "" }
      ) as { label: string }
    ]);
    const same = () => expect(viaLowered.label).toBe(viaGenerator.label);
    same();
    setCount(2);
    flush();
    same();
    setSource(s => {
      s.user.name = "Grace";
    });
    flush();
    same();
    expect(viaGenerator.label).toBe("Grace:2");
  });

  it("store hosts refuse a block that writes, before the write lands", () => {
    const [count, setCount] = createSignal(0);
    // The types refuse this block at every store host (block.type-tests.ts);
    // the cast reaches the runtime check.
    const writes = $(function* (draft: { value: number }) {
      yield* write(setCount, 1);
      draft.value = 1;
    }) as unknown as (draft: { value: number }) => void;
    createRoot(() => {
      const proj = createProjection(writes, { value: 0 });
      expect(() => proj.value).toThrow(/\[WRITE_IN_REACTIVE_BLOCK\]/);
      const [derived] = createStore(writes, { value: 0 });
      expect(() => derived.value).toThrow(/\[WRITE_IN_REACTIVE_BLOCK\]/);
      const [optimistic] = createOptimisticStore(writes, { value: 0 });
      expect(() => optimistic.value).toThrow(/\[WRITE_IN_REACTIVE_BLOCK\]/);
    });
    expect(count()).toBe(0);
  });
});
