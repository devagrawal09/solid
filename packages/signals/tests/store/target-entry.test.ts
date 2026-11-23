import {
  $TARGET,
  createEffect,
  createMemo,
  createOptimisticStore,
  createProjection,
  createRoot,
  createStore,
  flush,
  isStoreTarget,
  mapArray,
  storeDelete,
  storeGet,
  storeHas,
  storeKeys,
  storeProxy,
  storeSet
} from "../../src/index.js";

// The store read and written on its targets (`storeGet` and the rest): the
// same traps, called with no proxy between the caller and the store.

const targetOf = (proxy: any) => proxy[$TARGET];

describe("store targets", () => {
  it("serves a child as its target and makes its proxy only when asked", () => {
    const [s] = createStore({ a: { b: { c: 1 } }, n: 2 });
    const t = targetOf(s);
    const a = storeGet(t, "a");
    expect(isStoreTarget(a)).toBe(true);
    expect(a.px).toBe(null);
    const b = storeGet(a, "b");
    expect(storeGet(b, "c")).toBe(1);
    expect(storeGet(t, "n")).toBe(2);
    expect(a.px).toBe(null);
    expect(b.px).toBe(null);
    // The proxy made later is the one the proxy path serves.
    expect(storeProxy(a)).toBe(s.a);
    expect(storeProxy(b)).toBe(s.a.b);
    expect(targetOf(s.a)).toBe(a);
  });

  it("tracks a read by key, like the proxy's", () => {
    const [s, set] = createStore({ a: { x: 1, y: 1 } });
    const t = targetOf(s);
    const seen: number[] = [];
    createRoot(() => {
      createEffect(
        () => storeGet(storeGet(t, "a"), "x"),
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    set(d => {
      d.a.y = 2;
    });
    flush();
    expect(seen).toEqual([1]);
    set(d => {
      d.a.x = 2;
    });
    flush();
    expect(seen).toEqual([1, 2]);
  });

  it("writes and deletes inside the store's setter", () => {
    const [s, set] = createStore<{ a: { x?: number; y: number }; list: number[] }>({
      a: { x: 1, y: 1 },
      list: [1]
    });
    const t = targetOf(s);
    const seen: any[] = [];
    createRoot(() => {
      createEffect(
        () => [storeGet(storeGet(t, "a"), "x"), storeHas(storeGet(t, "a"), "x")],
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    set(() => {
      storeSet(storeGet(t, "a"), "x", 5);
      const list = storeGet(t, "list");
      storeSet(list, storeGet(list, "length"), 2);
    });
    flush();
    expect(s.a.x).toBe(5);
    expect(s.list).toEqual([1, 2]);
    set(() => {
      storeDelete(storeGet(t, "a"), "x");
    });
    flush();
    expect("x" in s.a).toBe(false);
    expect(seen).toEqual([
      [1, true],
      [5, true],
      [undefined, false]
    ]);
    // Outside a setter a write is ignored, as on the proxy.
    storeSet(storeGet(t, "a"), "y", 9);
    flush();
    expect(s.a.y).toBe(1);
  });

  it("answers keys and numeric keys as the proxy does", () => {
    const [s, set] = createStore<{ rows: { id: number }[]; o: Record<string, number> }>({
      rows: [{ id: 1 }, { id: 2 }],
      o: { a: 1 }
    });
    const t = targetOf(s);
    const rows = storeGet(t, "rows");
    expect(storeGet(rows, "length")).toBe(2);
    expect(storeGet(storeGet(rows, 1), "id")).toBe(2);
    expect(storeHas(rows, 1)).toBe(true);
    expect(storeHas(rows, 2)).toBe(false);
    const keys: string[][] = [];
    createRoot(() => {
      createEffect(
        () => storeKeys(storeGet(t, "o")),
        v => {
          keys.push(v);
        }
      );
    });
    flush();
    set(d => {
      d.o.b = 2;
    });
    flush();
    expect(keys).toEqual([["a"], ["a", "b"]]);
    expect(storeKeys(rows)).toEqual(Object.keys(s.rows));
  });

  it("maps a list given as its target, each row as its target", () => {
    const [s, set] = createStore({ rows: [{ id: 1 }, { id: 2 }] });
    const t = targetOf(s);
    const rows: any[] = [];
    let out: number[] = [];
    createRoot(() => {
      const mapped = mapArray(
        () => storeGet(t, "rows"),
        (row: any) => {
          rows.push(row);
          return createMemo(() => storeGet(row, "id") as number);
        }
      );
      createEffect(
        () => mapped().map(m => m()),
        v => {
          out = v;
        }
      );
    });
    flush();
    expect(out).toEqual([1, 2]);
    expect(rows.every(isStoreTarget)).toBe(true);
    expect(rows.every(r => r.px === null)).toBe(true);
    set(d => {
      d.rows.push({ id: 3 });
      d.rows[0].id = 10;
    });
    flush();
    expect(out).toEqual([10, 2, 3]);
    expect(rows.length).toBe(3);
    set(d => {
      const [a, b, c] = d.rows;
      d.rows[0] = c;
      d.rows[2] = a;
      void b;
    });
    flush();
    expect(out).toEqual([3, 2, 10]);
    expect(rows.length).toBe(3);
  });

  it("writes a target as the value it stands for", () => {
    const [s, set] = createStore({ rows: [{ id: 1 }, { id: 2 }] });
    const rows = storeGet(targetOf(s), "rows");
    set(() => {
      const a = storeGet(rows, 0);
      const b = storeGet(rows, 1);
      storeSet(rows, 0, b);
      storeSet(rows, 1, a);
    });
    flush();
    expect(s.rows.map(r => r.id)).toEqual([2, 1]);
  });

  it("reads a projection and an optimistic store on their targets", () => {
    const [src, setSrc] = createStore({ list: [{ id: 1, n: 1 }] });
    let seenP = 0;
    let seenO = 0;
    createRoot(() => {
      const p = createProjection(
        (draft: any) => {
          draft.total = src.list.reduce((a, r) => a + r.n, 0);
        },
        {} as { total: number }
      );
      const [o] = createOptimisticStore(() => src.list, [] as { id: number; n: number }[]);
      const pt = targetOf(p);
      const ot = targetOf(o);
      createEffect(
        () => storeGet(pt, "total"),
        v => {
          seenP = v;
        }
      );
      createEffect(
        () => storeGet(storeGet(ot, 0), "n"),
        v => {
          seenO = v;
        }
      );
    });
    flush();
    expect([seenP, seenO]).toEqual([1, 1]);
    setSrc(d => {
      d.list[0].n = 4;
    });
    flush();
    expect([seenP, seenO]).toEqual([4, 4]);
  });
});
