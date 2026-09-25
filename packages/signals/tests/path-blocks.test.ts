// Direct property syntax inside `$` blocks: `yield* store.user.name`.
//
// These tests exercise the runtime driver on the generator form (what
// uncompiled code runs) and the lowered call form the compiler emits
// (`perform(readPath(root, [...]))`); both must agree. TypeScript cannot
// type the generator form's operand (a string is not the intended
// iterable), so the direct spelling in this file is checked only by the
// typecheck projection (`solid-tsc`), not by the package's `tsc` run — see
// `block.type-tests.ts` for the projected form's types.
// @ts-nocheck
import {
  $,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  dispatchBlock,
  flush,
  perform,
  readPath,
  readProp,
  readStore,
  renderBlock,
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

describe("store paths (runtime driver)", () => {
  it("reads an object property, a nested property, and re-runs only on those", () => {
    const [store, setStore] = createStore(state());
    let nameRuns = 0;
    let cityRuns = 0;
    const [name, city] = createRoot(() => [
      createMemo(
        $(function* () {
          nameRuns++;
          return yield* store.user.name;
        })
      ),
      createMemo(
        $(function* () {
          cityRuns++;
          return `${yield* store.user.address.city}!`;
        })
      )
    ]);
    expect([name(), city()]).toEqual(["Ada", "London!"]);
    setStore(s => {
      s.user.name = "Grace";
    });
    flush();
    expect([name(), city()]).toEqual(["Grace", "London!"]);
    expect([nameRuns, cityRuns]).toEqual([2, 1]);
    setStore(s => {
      s.index = 3;
    });
    flush();
    expect([nameRuns, cityRuns]).toEqual([2, 1]);
  });

  it("reads array index, length, and a dynamic identifier index", () => {
    const [store, setStore] = createStore(state());
    const [index, setIndex] = createSignal(0);
    const [first, count, current] = createRoot(() => [
      createMemo(
        $(function* () {
          return yield* store.items[0].name;
        })
      ),
      createMemo(
        $(function* () {
          return yield* store.items.length;
        })
      ),
      createMemo(
        $(function* () {
          // The dynamic key is a plain value: read the signal first.
          const i = yield* index;
          return yield* store.items[i].name;
        })
      )
    ]);
    expect([first(), count(), current()]).toEqual(["one", 2, "one"]);
    setStore(s => {
      s.items[0].name = "uno";
    });
    flush();
    expect([first(), current()]).toEqual(["uno", "uno"]);
    setStore(s => {
      s.items.push({ id: 3, name: "three" });
    });
    flush();
    expect(count()).toBe(3);
    setIndex(2);
    flush();
    expect(current()).toBe("three");
  });

  it("aliases and destructuring inside the body are paths too", () => {
    const [store, setStore] = createStore(state());
    const [viaAlias, viaDestructure] = createRoot(() => [
      createMemo(
        $(function* () {
          const user = store.user;
          return yield* user.address.city;
        })
      ),
      createMemo(
        $(function* () {
          const { items } = store;
          return yield* items.length;
        })
      )
    ]);
    expect([viaAlias(), viaDestructure()]).toEqual(["London", 2]);
    setStore(s => {
      s.user.address.city = "Paris";
      s.items.pop();
    });
    flush();
    expect([viaAlias(), viaDestructure()]).toEqual(["Paris", 1]);
  });

  it("a bare access that is never read with yield* fails the run loudly", () => {
    const [store] = createStore(state());
    const truthy = createRoot(() =>
      createMemo(
        $(function* () {
          // `if (store.user)` reads nothing: a token is truthy.
          return store.user ? "yes" : "no";
        })
      )
    );
    expect(() => truthy()).toThrow(/\[UNREAD_PATH\] `<root>\.user`/);

    const coerced = createRoot(() =>
      createMemo(
        $(function* () {
          return `${store.user.name}`;
        })
      )
    );
    expect(() => coerced()).toThrow(/\[DIRECT_READ_IN_BLOCK\] `<root>\.user\.name` was used/);

    // Signals keep their guard: a direct accessor call is still refused.
    const [count] = createSignal(1);
    const direct = createRoot(() =>
      createMemo(
        $(function* () {
          return count() + (yield* store.index);
        })
      )
    );
    expect(() => direct()).toThrow(/\[DIRECT_READ_IN_BLOCK\] Reading a signal directly/);
  });

  it("readStore over a path token and structural selectors keep working", () => {
    const [store, setStore] = createStore(state());
    const names = createRoot(() =>
      createMemo(
        $(function* () {
          // `readStore` stays the structural form; its root may be a token.
          return yield* readStore(store.items, items => items.map(i => i.name).join(","));
        })
      )
    );
    expect(names()).toBe("one,two");
    setStore(s => {
      s.items[1].name = "dos";
    });
    flush();
    expect(names()).toBe("one,dos");
  });

  it("a JSX host admits path reads; an event block writes with write(setStore)", () => {
    const [store, setStore] = createStore(state());
    createRoot(() => {
      expect(
        renderBlock(
          $(function* () {
            return { tag: "p", text: yield* store.user.name };
          })
        )
      ).toEqual({ tag: "p", text: "Ada" });
    });
    const add = $(function* (event: { name: string }) {
      const count = yield* store.items.length;
      yield* write(setStore, s => {
        s.items.push({ id: count + 1, name: event.name });
      });
    });
    dispatchBlock(add, { name: "added" });
    flush();
    expect(store.items.map(i => i.name)).toEqual(["one", "two", "added"]);
  });
});

describe("store paths (lowered call form)", () => {
  it("perform(readPath(...)) tracks exactly like the generator form", () => {
    const [store, setStore] = createStore(state());
    const [index, setIndex] = createSignal(0);
    let generatorRuns = 0;
    let loweredRuns = 0;
    const [viaGenerator, viaLowered] = createRoot(() => [
      createMemo(
        $(function* () {
          generatorRuns++;
          const i = yield* index;
          return `${yield* store.user.name}:${yield* store.items[i].name}:${yield* store.items.length}`;
        })
      ),
      createMemo(
        // What the compiler emits for the block above.
        $(function () {
          loweredRuns++;
          const i = perform(index);
          return `${perform(readPath(store, ["user", "name"]))}:${perform(
            readPath(store, ["items", i, "name"])
          )}:${perform(readPath(store, ["items", "length"]))}`;
        })
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
    setIndex(1);
    flush();
    same();
    setStore(s => {
      s.items.push({ id: 3, name: "three" });
    });
    flush();
    same();
    setStore(s => {
      s.user.address.city = "Paris"; // read by neither
    });
    flush();
    same();
    expect(viaGenerator()).toBe("Grace:two:3");
  });

  it("a lowered alias root is a token: perform(readPath(u, ...)) and perform(u) resolve it", () => {
    const [store, setStore] = createStore(state());
    const [city, user] = createRoot(() => [
      createMemo(
        $(function () {
          const u = store.user;
          return perform(readPath(u, ["address", "city"]));
        })
      ),
      createMemo(
        $(function () {
          const u = store.user.name;
          return perform(u);
        })
      )
    ]);
    expect([city(), user()]).toEqual(["London", "Ada"]);
    setStore(s => {
      s.user.address.city = "Rome";
      s.user.name = "Grace";
    });
    flush();
    expect([city(), user()]).toEqual(["Rome", "Grace"]);
  });
});

describe("prop paths (lowered call form)", () => {
  it("readProp runs the prop getter with the guard lowered: exact getter tracking", () => {
    // A compiler-emitted props object: dynamic props are getters.
    const [count, setCount] = createSignal(1);
    const [label, setLabel] = createSignal("x");
    const props = {
      get count() {
        return count();
      },
      get label() {
        return label();
      },
      fixed: 7
    };
    let runs = 0;
    const view = createRoot(() =>
      createMemo(
        $(function () {
          runs++;
          return `${perform(readProp(props, ["count"]))}/${perform(readProp(props, ["fixed"]))}`;
        })
      )
    );
    expect(view()).toBe("1/7");
    setCount(2);
    flush();
    expect(view()).toBe("2/7");
    setLabel("y"); // not read
    flush();
    expect(runs).toBe(2);
    // The getter is not a store: in the generator (uncompiled) form the
    // signal read inside it is a direct read and fails loudly.
    const uncompiled = createRoot(() =>
      createMemo(
        $(function* () {
          return yield* props.count;
        })
      )
    );
    expect(() => uncompiled()).toThrow(/\[DIRECT_READ_IN_BLOCK\] Reading a signal directly/);
  });

  it("reads through a readable held at the path (accessor or block), as `yield*` on the value does", () => {
    // `yield* props.filter` with `filter: SourceAccessor<Filter>`: in an
    // uncompiled block the plain props object hands `yield*` the accessor
    // itself (a signal read); the lowered `readProp` must agree.
    const [filter, setFilter] = createSignal("all");
    const total = $(function* () {
      return (yield* filter).length;
    });
    const props = { filter, total, plain: () => "fn" };
    let runs = 0;
    const lowered = createRoot(() =>
      createMemo(
        $(function () {
          runs++;
          return `${perform(readProp(props, ["filter"]))}:${perform(readProp(props, ["total"]))}`;
        })
      )
    );
    const uncompiled = createRoot(() =>
      createMemo(
        $(function* () {
          return `${yield* props.filter}:${yield* props.total}`;
        })
      )
    );
    expect(lowered()).toBe("all:3");
    expect(uncompiled()).toBe("all:3");
    setFilter("active");
    flush();
    expect(lowered()).toBe("active:6");
    expect(uncompiled()).toBe("active:6");
    expect(runs).toBe(2);
    // A plain function is a value, not a read.
    const fn = createRoot(() =>
      createMemo(
        $(function () {
          return perform(readProp(props, ["plain"]));
        })
      )
    );
    expect(fn()).toBe(props.plain);
    // The same through a store field and a token alias.
    const [store] = createStore({ current: filter });
    const viaStore = createRoot(() =>
      createMemo(
        $(function* () {
          const alias = store.current;
          return `${yield* store.current}/${yield* alias}`;
        })
      )
    );
    expect(viaStore()).toBe("active/active");
    setFilter("done");
    flush();
    expect(viaStore()).toBe("done/done");
  });
});
