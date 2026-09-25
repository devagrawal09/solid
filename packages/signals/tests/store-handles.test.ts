// Store handles (optimization Track B, slice 2, stage 2).
//
// Compiled code that proved a store's uses holds the store as a HANDLE (its
// internal target): `createStoreHandle` creates it without a proxy,
// `readHandleK` reads paths from it with no Proxy [[Get]], and every other
// use goes through `storeProxy`, which materializes the compatibility proxy
// on first escape. These tests pin that (1) handle reads equal proxy reads
// in value, identity and tracking, (2) no proxy exists until an escape needs
// one, and (3) every escape hands out the one proxy the store would have
// had all along.
//
// Internals are inspected on purpose: a handle IS the store target, and
// `px` is its (lazily created) proxy slot.
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
  createStoreHandle,
  flush,
  OBSERVE,
  perform,
  readBorrowed,
  readHandle1,
  readHandle2,
  readHandle3,
  readHandle4,
  readHandleChild,
  readHandleN,
  readPath2,
  reconcile,
  snapshot,
  storeHandle,
  storeProxy
} from "../src/index.js";

afterEach(() => flush());

const proxyOf = (h: any) => h.px;
// Development and observability builds register a store's graph under its
// creating owner at creation, with its proxy, so there a handle ROOT is
// materialized eagerly; production builds (no OBSERVE) keep it lazy. Children
// a handle walk creates are lazy in every build.
const rootLazy = OBSERVE === undefined;

function data() {
  return {
    user: { name: "Ada", address: { city: "London" } },
    rows: [
      { id: 1, title: "one", meta: { done: false } },
      { id: 2, title: "two", meta: { done: true } }
    ],
    count: 0
  };
}

describe("createStoreHandle: reads without a proxy", () => {
  it("reads every depth, tracks exactly, and never creates a proxy", () => {
    const [h, set] = createStoreHandle(data());
    let cityRuns = 0;
    let titleRuns = 0;
    const [city, title, count, deep, n] = createRoot(() => [
      createMemo(() => (cityRuns++, readHandle3(h, "user", "address", "city"))),
      createMemo(() => (titleRuns++, readHandle3(h, "rows", 1, "title"))),
      createMemo(() => readHandle1(h, "count")),
      createMemo(() => readHandle4(h, "rows", 0, "meta", "done")),
      createMemo(() => readHandleN(h, ["rows", "length"]))
    ]);
    expect([city(), title(), count(), deep(), n()]).toEqual(["London", "two", 0, false, 2]);
    // Nothing escaped: no proxy for any child (nor the root in production).
    if (rootLazy) expect(proxyOf(h)).toBe(null);
    const child = readHandleChild(h, ["rows", 1]);
    expect(proxyOf(child)).toBe(null);

    // A sparse path update: only the reader of that leaf re-runs. The setter
    // is an escape of the root draft; it materializes the root proxy only.
    set(s => {
      s.rows[1].title = "dos";
    });
    flush();
    expect([title(), city()]).toEqual(["dos", "London"]);
    expect([titleRuns, cityRuns]).toEqual([2, 1]);
    set(s => {
      s.user.address.city = "Paris";
    });
    flush();
    expect(city()).toBe("Paris");
    expect([titleRuns, cityRuns]).toEqual([2, 2]);
  });

  it("agrees with the proxy walk on the same store, in value and re-runs", () => {
    const [h, set] = createStoreHandle(data());
    const [index, setIndex] = createSignal(0);
    const runs = [0, 0];
    const [viaHandle, viaProxy] = createRoot(() => [
      createMemo(() => (runs[0]++, readHandle3(h, "rows", index(), "title"))),
      createMemo(() => (runs[1]++, storeProxy(h).rows[index()].title))
    ]);
    const same = () => {
      expect(viaHandle()).toBe(viaProxy());
      expect(runs[0]).toBe(runs[1]);
    };
    same();
    set(s => {
      s.rows[0].title = "uno";
    });
    flush();
    same();
    setIndex(1);
    flush();
    same();
    set(s => {
      s.rows.reverse();
    });
    flush();
    same();
    set(s => {
      s.count = 5; // read by neither
    });
    flush();
    same();
  });

  it("absent keys subscribe and pick up a later insertion", () => {
    const [h, set] = createStoreHandle<{ byId: Record<string, { v: number }> }>({ byId: {} });
    const v = createRoot(() => createMemo(() => readHandle3(h, "byId", "k", "v")?.valueOf()));
    let missing = 0;
    const m = createRoot(() => createMemo(() => (missing++, readHandle2(h, "byId", "k"))));
    expect(m()).toBe(undefined);
    set(s => {
      s.byId.k = { v: 1 };
    });
    flush();
    expect(missing).toBe(2);
    expect(m()).toBe(storeProxy(h).byId.k);
    void v;
  });
});

describe("escapes materialize the one compatibility proxy, lazily", () => {
  it("storeProxy: first call creates it, later calls and trap reads agree", () => {
    const [h] = createStoreHandle(data());
    if (rootLazy) expect(proxyOf(h)).toBe(null);
    const child = readHandleChild(h, ["user", "address"]);
    expect(proxyOf(child)).toBe(null);
    const p = storeProxy(h);
    expect(proxyOf(h)).toBe(p);
    expect(storeProxy(h)).toBe(p);
    expect(p.user.name).toBe("Ada");
    // A child read through a handle and through the proxy is the same proxy.
    const viaHandle = readHandle1(h, "user");
    expect(viaHandle).toBe(p.user);
    const childHandle = readHandleChild(h, ["user", "address"]);
    expect(storeProxy(childHandle)).toBe(p.user.address);
    expect(snapshot(p)).toEqual(data());
  });

  it("a walk that ENDS on a child hands out its proxy (materialized there)", () => {
    const [h] = createStoreHandle(data());
    const row = readHandle2(h, "rows", 0);
    expect(typeof row).toBe("object");
    expect(row.title).toBe("one"); // a real store proxy
    if (rootLazy) expect(proxyOf(h)).toBe(null); // the root never escaped
    expect(proxyOf(readHandleChild(h, ["rows"]))).toBe(null); // nor the array
    expect(readHandle2(h, "rows", 0)).toBe(row);
  });

  it("getters run with the proxy receiver (an escape) and track what they read", () => {
    const [h, set] = createStoreHandle({
      person: {
        first: "Ada",
        last: "Lovelace",
        get full() {
          return `${this.first} ${this.last}`;
        }
      }
    });
    let runs = 0;
    const full = createRoot(() => createMemo(() => (runs++, readHandle2(h, "person", "full"))));
    expect(full()).toBe("Ada Lovelace");
    expect(proxyOf(readHandleChild(h, ["person"]))).not.toBe(null);
    set(s => {
      s.person.last = "Byron";
    });
    flush();
    expect(full()).toBe("Ada Byron");
    expect(runs).toBe(2);
  });

  it("class prototypes and platform objects behave as through the proxy", () => {
    class Point {
      x = 1;
      get double() {
        return this.x * 2;
      }
    }
    const [h] = createStoreHandle({ p: new Point(), tags: new Map([["a", 1]]), when: new Date(0) });
    const p = new Point();
    expect(readHandle2(h, "p", "double")).toBe(p.double);
    expect(readHandle2(h, "tags", "size")).toBe(1);
    expect(readHandle1(h, "tags")).toBeInstanceOf(Map);
    expect(readHandle2(h, "p", "constructor")).toBe(undefined); // pollution keys never serve
  });
});

describe("writes, reconciliation and identity through handles", () => {
  it("setter drafts, returned replacements and reconcile keep handle reads live", () => {
    const [h, set] = createStoreHandle(data());
    const firstRow = readHandleChild(h, ["rows", 0]);
    const title = createRoot(() => createMemo(() => readHandle3(h, "rows", 0, "title")));
    set(
      reconcile(
        {
          ...data(),
          rows: [
            { id: 1, title: "ONE", meta: { done: true } },
            { id: 3, title: "three", meta: { done: false } }
          ]
        },
        "id"
      )
    );
    flush();
    expect(title()).toBe("ONE");
    // Keyed reconciliation kept row 1's identity: the handle is still it.
    expect(readHandleChild(h, ["rows", 0])).toBe(firstRow);
    set(s => ({ ...s, count: 9 }));
    flush();
    expect(readHandle1(h, "count")).toBe(9);
  });

  it("shallow handles serve children raw", () => {
    const rows = [{ label: "a" }];
    const [h, set] = createStoreHandle({ rows }, { shallow: true });
    expect(readHandle1(h, "rows")).toBe(rows);
    expect(readHandle3(h, "rows", 0, "label")).toBe("a");
    const label = createRoot(() => createMemo(() => readHandle3(h, "rows", 0, "label")));
    set(s => {
      s.rows = [{ label: "b" }];
    });
    flush();
    expect(label()).toBe("b");
  });
});

describe("storeHandle over existing stores and non-stores", () => {
  it("a projection's handle sees what its proxy sees, including pending", async () => {
    let resolve!: (v: string) => void;
    const [id, setId] = createSignal(1);
    const proj = createProjection<{ label: { text: string } }>(
      async draft => {
        const i = id();
        const text = await new Promise<string>(r => (resolve = r));
        draft.label = { text: `${text}#${i}` };
      },
      { label: { text: "seed" } }
    );
    const h = storeHandle(proj);
    // (Compare identities directly: a matcher would inspect the pending proxy.)
    expect(h === proj).toBe(false);
    const seen: unknown[] = [];
    createRoot(() =>
      createRenderEffect(
        () => [readHandle2(h, "label", "text"), proj.label.text],
        v => {
          seen.push(v);
        }
      )
    );
    flush();
    resolve("a");
    await Promise.resolve();
    await Promise.resolve();
    flush();
    setId(2);
    flush();
    resolve("b");
    await Promise.resolve();
    await Promise.resolve();
    flush();
    for (const [a, b] of seen as [unknown, unknown][]) expect(a).toBe(b);
    expect(seen.at(-1)).toEqual(["b#2", "b#2"]);
  });

  it("an optimistic store's handle sees the override during the action", async () => {
    let finish!: () => void;
    const [todos, setTodos] = createOptimisticStore([{ id: 1, done: false }]);
    const h = storeHandle(todos);
    const seen: unknown[] = [];
    createRoot(() =>
      createRenderEffect(
        () => [readHandle2(h, 0, "done"), todos[0].done],
        v => {
          seen.push(v);
        }
      )
    );
    flush();
    action(function* () {
      setTodos(t => {
        t[0].done = true;
      });
      yield new Promise<void>(r => (finish = r));
    })();
    flush();
    expect(readHandle2(h, 0, "done")).toBe(true);
    finish();
    await new Promise(r => setTimeout(r, 0));
    flush();
    expect(readHandle2(h, 0, "done")).toBe(false);
    for (const [a, b] of seen as [unknown, unknown][]) expect(a).toBe(b);
  });

  it("a non-store gets a plain handle, walked as an ordinary object", () => {
    const plain = { a: { b: 1 } };
    const h = storeHandle(plain);
    expect(readHandle2(h, "a", "b")).toBe(1);
    expect(storeProxy(h)).toBe(plain);
    expect(readHandleChild(h, ["a"])).toBe(plain.a);
  });
});

describe("Borrowed props: a handle from a compiled caller, anything from others", () => {
  it("reads the same through a handle, a proxy, or a plain object", () => {
    const [h, set] = createStoreHandle(data());
    const proxy = storeProxy(createStoreHandle(data())[0]);
    const plain = data();
    const [which, setWhich] = createSignal<"handle" | "proxy" | "plain">("handle");
    const props = {
      get todo() {
        const w = which();
        return w === "handle"
          ? readHandleChild(h, ["rows", 0])
          : w === "proxy"
            ? proxy.rows[0]
            : plain.rows[0];
      }
    };
    let runs = 0;
    const title = createRoot(() =>
      createMemo(
        $(function () {
          runs++;
          return `${readBorrowed(props, ["todo", "title"])}:${readBorrowed(props, ["todo", "meta", "done"])}`;
        })
      )
    );
    expect(title()).toBe("one:false");
    set(s => {
      s.rows[0].title = "uno";
    });
    flush();
    expect(title()).toBe("uno:false");
    setWhich("proxy");
    flush();
    expect(title()).toBe("one:false");
    setWhich("plain");
    flush();
    expect(title()).toBe("one:false");
    expect(runs).toBe(4);
  });

  it("reading the borrowed prop itself hands out the proxy (an escape)", () => {
    const [h] = createStoreHandle(data());
    const props = {
      get todo() {
        return readHandleChild(h, ["rows", 1]);
      }
    };
    const todo = readBorrowed(props, ["todo"]);
    expect(todo).toBe(storeProxy(h).rows[1]);
    expect(todo.title).toBe("two");
  });

  it("the lowered caller/callee pair tracks like the proxy spelling", () => {
    // What the compiler emits for
    //   <Row todo={store.rows[i]} />  with  Row(props: { todo: Borrowed<Row> })
    // against the handwritten proxy spelling of the same component.
    const [h, set] = createStoreHandle(data());
    const [i, setI] = createSignal(0);
    const loweredProps = {
      get todo() {
        return readHandleChild(h, ["rows", i()]);
      }
    };
    const proxyProps = {
      get todo() {
        return storeProxy(h).rows[i()];
      }
    };
    const runs = [0, 0];
    const [lowered, handwritten] = createRoot(() => [
      createMemo(() => (runs[0]++, readBorrowed(loweredProps, ["todo", "title"]))),
      createMemo(() => (runs[1]++, proxyProps.todo.title))
    ]);
    const same = () => {
      expect(lowered()).toBe(handwritten());
      expect(runs[0]).toBe(runs[1]);
    };
    same();
    set(s => {
      s.rows[1].title = "dos"; // not the current row
    });
    flush();
    same();
    setI(1);
    flush();
    same();
    set(s => {
      s.rows[1].title = "DOS";
    });
    flush();
    same();
    expect(lowered()).toBe("DOS");
  });
});

describe("handle readers under the strict guard", () => {
  it("lower the guard inside a block and restore it", () => {
    const [h] = createStoreHandle(data());
    const [n] = createSignal(1);
    const ok = createRoot(() =>
      createMemo(
        $(function () {
          return `${readHandle2(h, "user", "name")}${perform(n)}`;
        })
      )
    );
    expect(ok()).toBe("Ada1");
    const direct = createRoot(() =>
      createMemo(
        $(function () {
          readHandle2(h, "user", "name");
          return n();
        })
      )
    );
    expect(() => direct()).toThrow(/\[DIRECT_READ_IN_BLOCK\]/);
  });

  it("proxy-root readers never materialize intermediate children", () => {
    const [store] = createStore({ a: { b: { c: { d: 1 } } } });
    expect(readPath2(store, "a", "b")).toBe(store.a.b);
    // `a` was served by the trap (it has a proxy); `b`..`c` walked as handles.
    const h = storeHandle(store);
    const c = readHandleChild(h, ["a", "b", "c"]);
    expect(c.px).toBe(null);
    expect(readHandle4(h, "a", "b", "c", "d")).toBe(1);
  });
});
