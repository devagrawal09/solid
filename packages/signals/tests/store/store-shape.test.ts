import {
  $TARGET,
  createEffect,
  createRoot,
  createStore,
  flush,
  storeGet,
  storeGetShaped,
  storeShape
} from "../../src/index.js";

// `storeShape` / `storeGetShaped`: a record of a known shape keeps its nodes
// in an object with a slot per field. An alternate layout of the node map —
// the same lazy nodes, the same reads.

describe("shaped records", () => {
  it("reads and tracks like a keyed record, and keeps its layout when a node is released", () => {
    const shape = storeShape(["id", "label"]);
    const [s, set] = createStore({ rows: [{ id: 1, label: "a" }] });
    const row = storeGet(storeGet((s as any)[$TARGET], "rows"), 0);
    const seen: string[] = [];
    let dispose!: () => void;
    createRoot(d => {
      dispose = d;
      createEffect(
        () => storeGetShaped(row, shape, "label") as string,
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    expect(Object.keys(row.n)).toEqual(["id", "label"]);
    expect(row.n.id).toBe(undefined);
    set(d => {
      d.rows[0].label = "b";
      d.rows[0].id = 2;
    });
    flush();
    expect(seen).toEqual(["a", "b"]);
    dispose();
    flush();
    // The last node released: the map is dropped, as a keyed map is (#5024).
    expect(row.n).toBe(null);
    expect(storeGetShaped(row, shape, "id")).toBe(2);
  });

  it("takes a key outside its shape", () => {
    const shape = storeShape(["a"]);
    const [s, set] = createStore<{ o: { a: number; b?: number } }>({ o: { a: 1 } });
    const o = storeGet((s as any)[$TARGET], "o");
    const seen: any[] = [];
    createRoot(() => {
      createEffect(
        () => [storeGetShaped(o, shape, "a"), storeGetShaped(o, shape, "b")],
        v => {
          seen.push(v);
        }
      );
    });
    flush();
    set(d => {
      d.o.b = 2;
    });
    flush();
    expect(seen).toEqual([
      [1, undefined],
      [1, 2]
    ]);
  });
});
