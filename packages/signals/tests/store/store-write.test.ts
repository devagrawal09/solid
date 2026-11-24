import {
  $TARGET,
  action,
  createEffect,
  createOptimisticStore,
  createRoot,
  createStore,
  flush,
  storeWrite
} from "../../src/index.js";

// `storeWrite(target, path, value)`: the setter's scope around one path
// write, with no callback and no draft proxy.

describe("storeWrite", () => {
  it("writes a path as the setter does", () => {
    const [a, setA] = createStore({ user: { prefs: { size: 1 } }, rows: [{ id: 1, n: 1 }] });
    const [b] = createStore({ user: { prefs: { size: 1 } }, rows: [{ id: 1, n: 1 }] });
    const seenA: number[] = [];
    const seenB: number[] = [];
    createRoot(() => {
      createEffect(
        () => a.user.prefs.size + a.rows[0].n,
        v => {
          seenA.push(v);
        }
      );
      createEffect(
        () => b.user.prefs.size + b.rows[0].n,
        v => {
          seenB.push(v);
        }
      );
    });
    flush();
    setA(d => {
      d.user.prefs.size = 2;
    });
    storeWrite((b as any)[$TARGET], ["user", "prefs", "size"], 2);
    flush();
    setA(d => {
      d.rows[0].n = 5;
    });
    storeWrite((b as any)[$TARGET], ["rows", 0, "n"], 5);
    flush();
    // An equal write notifies no one.
    storeWrite((b as any)[$TARGET], ["rows", 0, "n"], 5);
    flush();
    expect(seenB).toEqual(seenA);
    expect(seenB).toEqual([2, 3, 7]);
    expect(b).toEqual(a);
  });

  it("throws as the setter does on a path through nothing", () => {
    const [a, setA] = createStore<{ rows: { n: number }[] }>({ rows: [] });
    const viaSetter = (() => {
      try {
        setA(d => {
          d.rows[3].n = 1;
        });
      } catch (e) {
        return (e as Error).constructor;
      }
    })();
    const viaWrite = (() => {
      try {
        storeWrite((a as any)[$TARGET], ["rows", 3, "n"], 1);
      } catch (e) {
        return (e as Error).constructor;
      }
    })();
    expect(viaSetter).toBe(TypeError);
    expect(viaWrite).toBe(TypeError);
    // The scope closed: the next write lands.
    storeWrite((a as any)[$TARGET], ["rows", 0], { n: 2 });
    flush();
    expect(a.rows[0].n).toBe(2);
  });

  it("writes a guess on an optimistic store, reverted with its action", async () => {
    const [src] = createStore({ list: [{ id: 1, n: 1 }] });
    let seen: number[] = [];
    let ot: any;
    let release!: () => void;
    createRoot(() => {
      const [o] = createOptimisticStore(() => src.list, [] as { id: number; n: number }[]);
      ot = (o as any)[$TARGET];
      createEffect(
        () => o[0]?.n,
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    const run = action(function* () {
      storeWrite(ot, [0, "n"], 9);
      yield new Promise<void>(r => (release = r));
    });
    const done = run();
    flush();
    expect(seen).toEqual([1, 9]);
    release();
    await done;
    flush();
    expect(seen).toEqual([1, 9, 1]);
  });
});
