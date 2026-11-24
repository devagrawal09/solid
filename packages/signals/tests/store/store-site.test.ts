import {
  $TARGET,
  createEffect,
  createProjection,
  createRoot,
  createSignal,
  createStore,
  flush,
  isStoreTarget,
  storeGet,
  storeGetAt,
  storeSite
} from "../../src/index.js";

// `storeGetAt(site, target, key)`: `storeGet` from a read site that keeps the
// node it resolved. A site that no longer holds reads as `storeGet` does.

describe("store read sites", () => {
  it("serves the node it kept, and the trap's answer otherwise", () => {
    const [s, set] = createStore({ a: { x: 1 }, b: { x: 10 } });
    const t = (s as any)[$TARGET];
    const site = storeSite();
    const seen: number[] = [];
    const [which, setWhich] = createSignal<"a" | "b">("a");
    createRoot(() => {
      createEffect(
        () => storeGetAt(site, storeGet(t, which()), "x") as number,
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    expect(site.t).toBe(storeGet(t, "a"));
    set(d => {
      d.a.x = 2;
    });
    flush();
    // Another target through the same site: the site misses and refills.
    setWhich("b");
    flush();
    expect(site.t).toBe(storeGet(t, "b"));
    set(d => {
      d.b.x = 11;
      d.a.x = 3;
    });
    flush();
    expect(seen).toEqual([1, 2, 10, 11]);
  });

  it("misses a node released since it was kept", () => {
    const [s, set] = createStore({ a: { x: 1 } });
    const a = storeGet((s as any)[$TARGET], "a");
    const site = storeSite();
    const seen: number[] = [];
    let dispose!: () => void;
    createRoot(d => {
      dispose = d;
      createEffect(
        () => storeGetAt(site, a, "x") as number,
        () => {}
      );
    });
    flush();
    const kept = site.n;
    expect(kept).not.toBe(null);
    dispose();
    flush();
    // The key's node was released with its last reader: a new reader gets a
    // new node, and the site follows it.
    expect(a.n).toBe(null);
    createRoot(() => {
      createEffect(
        () => storeGetAt(site, a, "x") as number,
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    expect(site.n).not.toBe(kept);
    set(d => {
      d.a.x = 2;
    });
    flush();
    expect(seen).toEqual([1, 2]);
  });

  it("serves a child as its target and follows a replaced child", () => {
    const [s, set] = createStore({ a: { b: { x: 1 } } });
    const a = storeGet((s as any)[$TARGET], "a");
    const site = storeSite();
    const inner = storeSite();
    const seen: number[] = [];
    createRoot(() => {
      createEffect(
        () => {
          const b = storeGetAt(site, a, "b");
          expect(isStoreTarget(b)).toBe(true);
          return storeGetAt(inner, b, "x") as number;
        },
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    set(d => {
      d.a.b = { x: 5 };
    });
    flush();
    set(d => {
      d.a.b.x = 6;
    });
    flush();
    expect(seen).toEqual([1, 5, 6]);
  });

  it("leaves a derived store's reads to the trap", () => {
    const [src, setSrc] = createStore({ n: 1 });
    const site = storeSite();
    const seen: number[] = [];
    createRoot(() => {
      const p = createProjection(
        (d: { n: number }) => {
          d.n = src.n * 2;
        },
        { n: 0 }
      );
      const pt = (p as any)[$TARGET];
      createEffect(
        () => storeGetAt(site, pt, "n") as number,
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    expect(site.t).toBe(null);
    setSrc(d => {
      d.n = 2;
    });
    flush();
    expect(seen).toEqual([2, 4]);
  });
});
