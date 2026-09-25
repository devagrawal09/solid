// Proxy-free strict store paths (optimization Track B, slice 2, stage 1).
//
// The compiler lowers `yield* root.a.b` to `readPath2(root, "a", "b")` (fixed
// arities 1–4, `readPathN(root, keys)` beyond). Each reader walks the path
// through store HANDLES — the store's `get` trap executed as a plain call,
// children passed hop to hop as their targets — instead of Proxy [[Get]]s,
// and allocates nothing. The contract is exact equivalence with the two
// spellings it replaces:
//
//   handwritten   store.a.b                       (the proxy walk)
//   rewalk        perform(readPath(store, [a, b])) (the previous lowering)
//
// Every scenario below runs all three side by side and asserts the same
// values, the same identities, and the same re-run counts (the tracking
// fingerprint) across a sequence of writes.
//
// The `$(function () { … })` bodies here are the lowered call form the
// compiler emits, which the `$` overloads do not type (they type the
// generator spelling); the package's `tsc` run skips this file, as it does
// `path-blocks.test.ts`. The readers' own types are in `block.type-tests.ts`.
// @ts-nocheck
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
  flush,
  isPending,
  merge,
  NotReadyError,
  perform,
  readPath,
  readPath1,
  readPath2,
  readPath3,
  readPath4,
  readPathN,
  snapshot,
  untrack
} from "../src/index.js";

afterEach(() => flush());

type Key = string | number;

/** The reader the compiler emits for a path of this depth. */
function lowered(root: any, keys: Key[]): any {
  switch (keys.length) {
    case 1:
      return readPath1(root, keys[0]);
    case 2:
      return readPath2(root, keys[0], keys[1]);
    case 3:
      return readPath3(root, keys[0], keys[1], keys[2]);
    case 4:
      return readPath4(root, keys[0], keys[1], keys[2], keys[3]);
    default:
      return readPathN(root, keys);
  }
}

function proxyWalk(root: any, keys: Key[]): any {
  let v = root;
  for (const k of keys) v = v[k];
  return v;
}

interface Probe {
  values: () => unknown[];
  runs: () => number[];
}

/**
 * Three memos over one path spelling each: handwritten proxy access (plain
 * compute), the previous lowering inside a `$` block, and the handle reader
 * inside a `$` block. A fourth runs the handle reader in a plain compute (the
 * host-fused form, strict guard down).
 */
/** A signal read in the spelling of the context: `perform` inside a block. */
type Read = <T>(accessor: () => T) => T;
const direct: Read = accessor => accessor();
const performed: Read = accessor => perform(accessor as any) as any;

function probe(root: () => any, keys: (read: Read) => Key[]): Probe {
  const runs = [0, 0, 0, 0];
  const memos = createRoot(() => [
    createMemo(() => {
      runs[0]++;
      return proxyWalk(root(), keys(direct));
    }),
    createMemo(
      $(function () {
        runs[1]++;
        return perform(readPath(root(), keys(performed)));
      })
    ),
    createMemo(
      $(function () {
        runs[2]++;
        return lowered(root(), keys(performed));
      })
    ),
    createMemo(() => {
      runs[3]++;
      return lowered(root(), keys(direct));
    })
  ]);
  return { values: () => memos.map(m => m()), runs: () => [...runs] };
}

/**
 * All spellings agree on value (by identity) and on how often they ran.
 * `from` = 1 compares the lowered spellings only (read-through, below, is a
 * `yield*` behavior the bare proxy walk does not have).
 */
function agree(p: Probe, from = 0): unknown {
  const values = p.values();
  for (let i = from + 1; i < values.length; i++) expect(values[i]).toBe(values[from]);
  const runs = p.runs();
  for (let i = from + 1; i < runs.length; i++) expect(runs[i]).toBe(runs[from]);
  return values[from];
}

describe("handle path readers: exact equivalence with the proxy walk", () => {
  it("deep object paths: values, identities and re-runs", () => {
    const [store, setStore] = createStore({
      user: { name: "Ada", address: { city: "London", zip: "N1" } },
      other: 1
    });
    const city = probe(
      () => store,
      () => ["user", "address", "city"]
    );
    const address = probe(
      () => store,
      () => ["user", "address"]
    );
    expect(agree(city)).toBe("London");
    expect(agree(address)).toBe(store.user.address);
    expect(city.runs()[0]).toBe(1);

    setStore(s => {
      s.other = 2; // not read
      s.user.address.zip = "N2"; // sibling of the read leaf
    });
    flush();
    expect(agree(city)).toBe("London");
    expect(city.runs()[0]).toBe(1);

    setStore(s => {
      s.user.address.city = "Paris";
    });
    flush();
    expect(agree(city)).toBe("Paris");
    expect(city.runs()[0]).toBe(2);
    expect(address.runs()[0]).toBe(1); // the container slot did not change

    setStore(s => {
      s.user.address = { city: "Rome", zip: "00100" };
    });
    flush();
    expect(agree(city)).toBe("Rome");
    expect(agree(address)).toBe(store.user.address);
    expect(address.runs()[0]).toBe(2);

    setStore(s => {
      s.user = { name: "Grace", address: { city: "Rome", zip: "x" } };
    });
    flush();
    expect(agree(city)).toBe("Rome");
    expect(agree(address)).toBe(store.user.address);
  });

  it("array index, length, and a dynamic key (numbers coerce like a Proxy key)", () => {
    const [store, setStore] = createStore({
      items: [
        { id: 1, name: "one" },
        { id: 2, name: "two" }
      ]
    });
    const [index, setIndex] = createSignal(0);
    const current = probe(
      () => store,
      read => ["items", read(index), "name"]
    );
    const length = probe(
      () => store,
      () => ["items", "length"]
    );
    const byString = probe(
      () => store,
      read => ["items", String(read(index)), "name"]
    );
    expect(agree(current)).toBe("one");
    expect(agree(byString)).toBe("one");
    expect(agree(length)).toBe(2);

    setStore(s => {
      s.items[1].name = "dos"; // not the current index
    });
    flush();
    expect(agree(current)).toBe("one");
    expect(current.runs()[0]).toBe(1);

    setIndex(1);
    flush();
    expect(agree(current)).toBe("dos");
    expect(agree(byString)).toBe("dos");

    setStore(s => {
      s.items.push({ id: 3, name: "three" });
    });
    flush();
    expect(agree(length)).toBe(3);
    expect(agree(current)).toBe("dos");

    setStore(s => {
      s.items.reverse();
    });
    flush();
    expect(agree(current)).toBe("dos");
    setIndex(0);
    flush();
    expect(agree(current)).toBe("three");
  });

  it("absent keys subscribe (R12) and pick up a later insertion", () => {
    const [store, setStore] = createStore<{ byId: Record<string, { label: string }> }>({
      byId: {}
    });
    const missing = probe(
      () => store,
      () => ["byId", "k1"]
    );
    expect(agree(missing)).toBe(undefined);
    setStore(s => {
      s.byId.k2 = { label: "two" };
    });
    flush();
    expect(missing.runs()[0]).toBe(1);
    setStore(s => {
      s.byId.k1 = { label: "one" };
    });
    flush();
    expect(agree(missing)).toBe(store.byId.k1);
    expect(missing.runs()[0]).toBe(2);
  });

  it("own getters run with the proxy receiver and track what they read", () => {
    const [store, setStore] = createStore({
      person: {
        first: "Ada",
        last: "Lovelace",
        get full() {
          return `${this.first} ${this.last}`;
        }
      }
    });
    const full = probe(
      () => store,
      () => ["person", "full"]
    );
    expect(agree(full)).toBe("Ada Lovelace");
    setStore(s => {
      s.person.last = "Byron";
    });
    flush();
    expect(agree(full)).toBe("Ada Byron");
    expect(full.runs()[0]).toBe(2);
  });

  it("class instances: prototype getters, prototype methods, and pollution keys", () => {
    class Point {
      x = 1;
      y = 2;
      get sum() {
        return this.x + this.y;
      }
      scaled(n: number) {
        return this.x * n;
      }
    }
    const [store, setStore] = createStore({ p: new Point(), items: [1, 2] });
    const sum = probe(
      () => store,
      () => ["p", "sum"]
    );
    const method = probe(
      () => store,
      () => ["p", "scaled"]
    );
    const arrayMethod = probe(
      () => store,
      () => ["items", "map"]
    );
    const ctor = probe(
      () => store,
      () => ["p", "constructor"]
    );
    expect(agree(sum)).toBe(3);
    expect(agree(method)).toBe(Point.prototype.scaled);
    expect(agree(arrayMethod)).toBe(Array.prototype.map);
    expect(agree(ctor)).toBe(undefined); // inherited pollution keys never serve
    setStore(s => {
      s.p.x = 10;
    });
    flush();
    expect(agree(sum)).toBe(12);
    expect(agree(method)).toBe(Point.prototype.scaled);
  });

  it("shallow stores: children served raw, root keys tracked", () => {
    const rows = [{ label: "a" }, { label: "b" }];
    const [store, setStore] = createStore({ rows }, { shallow: true });
    const label = probe(
      () => store,
      () => ["rows", 0, "label"]
    );
    const row = probe(
      () => store,
      () => ["rows", 1]
    );
    expect(agree(label)).toBe("a");
    expect(agree(row)).toBe(rows[1]); // raw, by reference
    setStore(s => {
      s.rows = [{ label: "c" }];
    });
    flush();
    expect(agree(label)).toBe("c");
    expect(agree(row)).toBe(undefined);
  });

  it("platform objects stay raw; their properties read natively", () => {
    const [store, setStore] = createStore({ when: new Date(0), tags: new Map([["a", 1]]) });
    const size = probe(
      () => store,
      () => ["tags", "size"]
    );
    expect(agree(size)).toBe(1);
    setStore(s => {
      s.tags = new Map([
        ["a", 1],
        ["b", 2]
      ]);
    });
    flush();
    expect(agree(size)).toBe(2);
  });

  it("paths through a store held in another store, and store-valued roots of any depth", () => {
    const [inner, setInner] = createStore({ deep: { v: 1 } });
    const [outer] = createStore({ ref: inner as { deep: { v: number } } });
    const v = probe(
      () => outer,
      () => ["ref", "deep", "v"]
    );
    const fromChild = probe(
      () => outer.ref,
      () => ["deep", "v"]
    );
    expect(agree(v)).toBe(1);
    expect(agree(fromChild)).toBe(1);
    setInner(s => {
      s.deep.v = 2;
    });
    flush();
    expect(agree(v)).toBe(2);
    expect(agree(fromChild)).toBe(2);
  });

  it("five-key paths use the generic reader", () => {
    const [store, setStore] = createStore({ a: { b: { c: { d: { e: 1 } } } } });
    const e = probe(
      () => store,
      () => ["a", "b", "c", "d", "e"]
    );
    expect(agree(e)).toBe(1);
    setStore(s => {
      s.a.b.c.d.e = 2;
    });
    flush();
    expect(agree(e)).toBe(2);
  });

  it("merge() props over a store: the foreign proxy is read, never probed", () => {
    const [store, setStore] = createStore({ user: { name: "Ada" } });
    const [fallback, setFallback] = createSignal({ other: 1 });
    const props = merge(() => fallback(), store);
    const name = probe(
      () => props,
      () => ["user", "name"]
    );
    expect(agree(name)).toBe("Ada");
    setStore(s => {
      s.user.name = "Grace";
    });
    flush();
    expect(agree(name)).toBe("Grace");
    setFallback({ other: 2 });
    flush();
    expect(agree(name)).toBe("Grace");
  });

  it("plain objects and props getters: ordinary access with the guard lowered", () => {
    const [count, setCount] = createSignal(1);
    const [store, setStore] = createStore({ row: { title: "t" } });
    const props = {
      get count() {
        return count();
      },
      get row() {
        return store.row;
      }
    };
    const c = probe(
      () => props,
      () => ["count"]
    );
    const title = probe(
      () => props,
      () => ["row", "title"]
    );
    expect(agree(c)).toBe(1);
    expect(agree(title)).toBe("t");
    setCount(2);
    setStore(s => {
      s.row.title = "u";
    });
    flush();
    expect(agree(c)).toBe(2);
    expect(agree(title)).toBe("u");
  });

  it("reads through an accessor or block found at the path", () => {
    const [n, setN] = createSignal(1);
    const doubled = $(function () {
      return perform(n) * 2;
    });
    const [store] = createStore({ holder: { n, doubled } });
    const viaAccessor = probe(
      () => store,
      () => ["holder", "n"]
    );
    const viaBlock = probe(
      () => store,
      () => ["holder", "doubled"]
    );
    expect(agree(viaAccessor, 1)).toBe(1);
    expect(agree(viaBlock, 1)).toBe(2);
    expect(viaAccessor.values()[0]).toBe(n); // the bare walk hands back the accessor
    setN(5);
    flush();
    expect(agree(viaAccessor, 1)).toBe(5);
    expect(agree(viaBlock, 1)).toBe(10);
  });

  it("throws exactly where the proxy walk throws", () => {
    const [store] = createStore<{ user?: { name: string } }>({});
    const messages = [
      () => proxyWalk(store, ["user", "name"]),
      () => readPath2(store, "user", "name"),
      () => createRoot(() => createMemo($(() => readPath2(store, "user", "name"))))()
    ].map(f => {
      try {
        f();
      } catch (e) {
        return (e as Error).message;
      }
      return "no throw";
    });
    expect(messages[1]).toBe(messages[0]);
    expect(messages[2]).toBe(messages[0]);
  });
});

describe("handle path readers: identity", () => {
  it("serve the same proxies as the trap, and leave no handle behind", () => {
    const [store] = createStore({
      user: { profile: { tags: ["a"] } },
      rows: [{ id: 1 }, { id: 2 }]
    });
    expect(readPath1(store, "user")).toBe(store.user);
    expect(readPath2(store, "user", "profile")).toBe(store.user.profile);
    expect(readPath3(store, "user", "profile", "tags")).toBe(store.user.profile.tags);
    expect(readPath2(store, "rows", 1)).toBe(store.rows[1]);
    expect(readPathN(store, ["rows", 0])).toBe(store.rows[0]);
    // Every object a reader hands out is a real store proxy (snapshot unwraps it).
    expect(snapshot(readPath2(store, "rows", 1))).toEqual({ id: 2 });
    // Repeat reads are stable (the wrap cache holds targets, not proxies).
    const first = readPath2(store, "user", "profile");
    expect(readPath2(store, "user", "profile")).toBe(first);
  });

  it("a nested read inside a getter cannot confuse the walk", () => {
    const [other] = createStore({ x: { y: 1 } });
    const [store] = createStore({
      a: {
        get b() {
          // Serves `other.x` (a different child) in the middle of the hop.
          return other.x.y + 1;
        },
        c: { d: 3 }
      }
    });
    expect(readPath2(store, "a", "b")).toBe(2);
    expect(readPath3(store, "a", "c", "d")).toBe(3);
    expect(readPath2(store, "a", "c")).toBe(store.a.c);
  });
});

describe("handle path readers: aliases, drafts, guard", () => {
  it("an in-block alias is a path token: the reader consumes it", () => {
    const [store, setStore] = createStore({ user: { address: { city: "London" } } });
    let runs = 0;
    const city = createRoot(() =>
      createMemo(
        $(function () {
          runs++;
          const u = store.user; // guard raised: a token
          return readPath2(u, "address", "city");
        })
      )
    );
    expect(city()).toBe("London");
    setStore(s => {
      s.user.address.city = "Rome";
    });
    flush();
    expect(city()).toBe("Rome");
    expect(runs).toBe(2);
  });

  it("restores the strict guard, also when the read throws", () => {
    const [store] = createStore<{ a?: { b: number } }>({});
    const [n] = createSignal(1);
    const block = createRoot(() =>
      createMemo(
        $(function () {
          try {
            readPath2(store, "a", "b");
          } catch {}
          // Still inside the block: a direct read is refused as before.
          return n();
        })
      )
    );
    expect(() => block()).toThrow(/\[DIRECT_READ_IN_BLOCK\]/);
  });

  it("inside a setter, a draft path read sees the draft's own writes", () => {
    const [store, setStore] = createStore({ user: { name: "Ada" } });
    let seen: unknown;
    setStore(s => {
      s.user.name = "Grace";
      seen = readPath2(s, "user", "name");
    });
    expect(seen).toBe("Grace");
    flush();
    expect(readPath2(store, "user", "name")).toBe("Grace");
  });

  it("a child reached through a draft is writable (draft admission)", () => {
    const [inner] = createStore({ v: 1 });
    const [store, setStore] = createStore({ ref: inner as { v: number } });
    setStore(s => {
      const ref = readPath1(s, "ref");
      ref.v = 2;
    });
    flush();
    expect(inner.v).toBe(2);
  });

  it("untracked reads outside any owner serve committed values", () => {
    const [store, setStore] = createStore({ a: { b: 1 } });
    setStore(s => {
      s.a.b = 2;
    });
    // Not flushed: context-free readers see committed state, as the proxy does.
    expect(readPath2(store, "a", "b")).toBe(store.a.b);
    flush();
    expect(untrack(() => readPath2(store, "a", "b"))).toBe(2);
  });
});

describe("handle path readers: pending and optimistic visibility", () => {
  it("an async projection: pending reads throw like the proxy, then serve", async () => {
    let resolve!: (v: { user: { name: string } }) => void;
    const [id, setId] = createSignal(1);
    const proj = createProjection<{ user: { name: string } }>(
      async draft => {
        const i = id();
        const value = await new Promise<{ user: { name: string } }>(r => (resolve = r));
        draft.user = { name: `${value.user.name}#${i}` };
      },
      { user: { name: "seed" } }
    );
    const outcome = (read: () => unknown) => {
      try {
        return read();
      } catch (e) {
        return e instanceof NotReadyError ? "not-ready" : e;
      }
    };
    expect(outcome(() => readPath2(proj, "user", "name"))).toBe(outcome(() => proj.user.name));
    const name = probe(
      () => proj,
      () => ["user", "name"]
    );
    createRoot(() =>
      createRenderEffect(
        () => name.values(),
        () => {}
      )
    );
    flush();
    resolve({ user: { name: "Ada" } });
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(agree(name)).toBe("Ada#1");
    setId(2);
    flush();
    expect(isPending(() => readPath2(proj, "user", "name"))).toBe(isPending(() => proj.user.name));
    resolve({ user: { name: "Grace" } });
    await Promise.resolve();
    await Promise.resolve();
    flush();
    expect(agree(name)).toBe("Grace#2");
  });

  it("optimistic stores: the override is visible through the reader during the action", async () => {
    let finish!: () => void;
    const [todos, setTodos] = createOptimisticStore([{ id: 1, title: "a", done: false }]);
    const done = probe(
      () => todos,
      () => [0, "done"]
    );
    const seen: unknown[] = [];
    createRoot(() =>
      createRenderEffect(
        () => [done.values(), readPath2(todos, 0, "done"), todos[0].done],
        v => {
          seen.push(v);
        }
      )
    );
    flush();
    expect(agree(done)).toBe(false);
    const toggle = action(function* () {
      setTodos(t => {
        t[0].done = true;
      });
      yield new Promise<void>(r => (finish = r));
    });
    toggle();
    flush();
    expect(agree(done)).toBe(true);
    expect(readPath2(todos, 0, "done")).toBe(todos[0].done);
    finish();
    await new Promise(r => setTimeout(r, 0));
    flush();
    expect(agree(done)).toBe(false); // reverted at settle (no refetch)
    for (const [values, handle, proxy] of seen as [unknown[], unknown, unknown][]) {
      expect(handle).toBe(proxy);
      for (const v of values) expect(v).toBe(proxy);
    }
  });
});
