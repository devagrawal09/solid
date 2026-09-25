import {
  $,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  dispatchBlock,
  flush,
  perform,
  readStore,
  renderBlock,
  wait,
  write
} from "../src/index.js";

afterEach(() => flush());

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
    const direct = createRoot(() =>
      createMemo(
        $(function* () {
          return store.user.name;
        })
      )
    );
    expect(() => direct()).toThrow(/\[DIRECT_READ_IN_BLOCK\]/);
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
