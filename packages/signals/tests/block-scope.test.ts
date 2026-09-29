/**
 * Render callbacks as blocks (generator-blocks-v2.md, "Render callbacks as
 * blocks"), uncompiled: a flow control's render callback that is a block —
 * a generator function, a `$(function* (row) …)` block or `$scope(…)` — runs
 * its setup once per row under that row's owner, its `$cleanup`s run when the
 * row is disposed, and the view it returns is rendered like a component view.
 * Rows are mapped with `mapArray` (what `<For>` runs) through
 * `renderCallback` (what the flow controls hand it).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  $,
  $cleanup,
  $component,
  $event,
  $memo,
  $scope,
  $signal,
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  mapArray,
  renderBlock,
  renderCallback,
  resetErrorHalt,
  SCOPE_CALLBACK
} from "../src/index.js";

afterEach(() => resetErrorHalt());

type Row = { id: number; label: string };

/** Map `list` with `callback` as `<For>` does and record the rendered rows. */
function mountList(list: () => Row[], callback: unknown) {
  const out: string[][] = [];
  let dispose!: () => void;
  createRoot(d => {
    dispose = d;
    const rows = mapArray(list, renderCallback(callback) as any);
    createRenderEffect(
      () => rows().map(view => renderBlock(view as any) as string),
      v => void out.push(v)
    );
  });
  flush();
  return { out, dispose };
}

describe("row blocks", () => {
  it("a generator render callback becomes a scope callback; plain callbacks pass through", () => {
    // Building one block installs the driver's hook (an app with row blocks
    // always builds blocks first: its components).
    $(function* () {});
    const plain = (x: number) => x;
    expect(renderCallback(plain)).toBe(plain);
    const scoped = renderCallback(function* (_row: Row) {
      return function* () {
        return "";
      };
    }) as any;
    expect(scoped[SCOPE_CALLBACK]).toBe(true);
    expect(scoped.length).toBe(1);
    const indexed = renderCallback(function* (_row: Row, _i: () => number) {
      return function* () {
        return "";
      };
    }) as any;
    expect(indexed.length).toBe(2);
    // A parameterless `$` block is a JSX block, rendered as a child as before.
    const jsxBlock = $(function* () {
      return "x";
    });
    expect(renderCallback(jsxBlock)).toBe(jsxBlock);
  });

  it("setup runs once per row; each row keeps its own state; rows added, removed, reordered", () => {
    const [list, setList] = createSignal<Row[]>([
      { id: 1, label: "a" },
      { id: 2, label: "b" }
    ]);
    const setups: number[] = [];
    const setters = new Map<number, (v: boolean) => unknown>();
    const { out } = mountList(list, function* (row: Row) {
      setups.push(row.id);
      const [open, setOpen] = yield* $signal(true);
      setters.set(row.id, setOpen);
      return function* () {
        return `${row.label}:${(yield* open) ? "-" : "+"}`;
      };
    });
    expect(out.at(-1)).toEqual(["a:-", "b:-"]);
    setters.get(2)!(false);
    flush();
    expect(out.at(-1)).toEqual(["a:-", "b:+"]);
    const [a, b] = list();
    const c = { id: 3, label: "c" };
    setList([b, c, a]);
    flush();
    // Reordered rows keep their state; only the new row runs its setup.
    expect(out.at(-1)).toEqual(["b:+", "c:-", "a:-"]);
    expect(setups).toEqual([1, 2, 3]);
    setList([c]);
    flush();
    expect(out.at(-1)).toEqual(["c:-"]);
    setList([c, a]);
    flush();
    // A removed row's state is gone: re-adding it runs a fresh setup.
    expect(out.at(-1)).toEqual(["c:-", "a:-"]);
    expect(setups).toEqual([1, 2, 3, 1]);
  });

  // Unwind order (later registrations first), the core's onCleanup rule
  // since upstream #3572: a row's `$cleanup`s register on the row's owner.
  it("a row's cleanups run when the row is disposed, in unwind order", () => {
    const [list, setList] = createSignal<Row[]>([
      { id: 1, label: "a" },
      { id: 2, label: "b" }
    ]);
    const log: string[] = [];
    const { dispose } = mountList(list, function* (row: Row) {
      log.push(`setup ${row.id}`);
      yield* $cleanup(() => log.push(`cleanup ${row.id} first`));
      yield* $cleanup(() => log.push(`cleanup ${row.id} second`));
      return function* () {
        return row.label;
      };
    });
    expect(log).toEqual(["setup 1", "setup 2"]);
    setList([list()[1]]);
    flush();
    expect(log).toEqual(["setup 1", "setup 2", "cleanup 1 second", "cleanup 1 first"]);
    dispose();
    expect(log.slice(4)).toEqual(["cleanup 2 second", "cleanup 2 first"]);
  });

  it("the setup is untracked; the view tracks its reads", () => {
    const [scale, setScale] = createSignal(1);
    const [list] = createSignal<Row[]>([{ id: 1, label: "a" }]);
    let setups = 0;
    const { out } = mountList(list, function* (row: Row) {
      setups++;
      const size = yield* $memo(function* () {
        return row.label.length * (yield* scale);
      });
      return function* () {
        return `${row.label}${yield* size}`;
      };
    });
    setScale(3);
    flush();
    expect(out).toEqual([["a1"], ["a3"]]);
    expect(setups).toBe(1);
  });

  it("the index argument is the row's index accessor", () => {
    const [list, setList] = createSignal<Row[]>([
      { id: 1, label: "a" },
      { id: 2, label: "b" }
    ]);
    const { out } = mountList(list, function* (row: Row, index: () => number) {
      return function* () {
        return `${yield* index}${row.label}`;
      };
    });
    expect(out.at(-1)).toEqual(["0a", "1b"]);
    setList([...list()].reverse());
    flush();
    expect(out.at(-1)).toEqual(["0b", "1a"]);
  });

  it("an event in a row writes the row's own state", () => {
    const [list] = createSignal<Row[]>([
      { id: 1, label: "a" },
      { id: 2, label: "b" }
    ]);
    const toggles: ((e?: unknown) => void)[] = [];
    const { out } = mountList(list, function* (row: Row) {
      const [open, setOpen] = yield* $signal(true);
      toggles.push(
        $event(function* () {
          setOpen(o => !o);
        })
      );
      return function* () {
        return `${row.id}${(yield* open) ? "o" : "c"}`;
      };
    });
    toggles[0]();
    flush();
    expect(out.at(-1)).toEqual(["1c", "2o"]);
  });

  it("`$(function* (row) …)` and `$scope(…)` are the same callback", () => {
    const [list] = createSignal<Row[]>([{ id: 1, label: "a" }]);
    const viaBlock = mountList(
      list,
      $(function* (row: Row) {
        const [n] = yield* $signal(row.id);
        return function* () {
          return `block${yield* n}`;
        };
      } as any)
    );
    expect(viaBlock.out.at(-1)).toEqual(["block1"]);
    const viaScope = mountList(
      list,
      $scope(function* (row: Row) {
        const [n] = yield* $signal(row.id * 10);
        return function* () {
          return `scope${yield* n}`;
        };
      })
    );
    expect(viaScope.out.at(-1)).toEqual(["scope10"]);
  });

  it("a named row block can render itself (recursion)", () => {
    type Node = { id: number; kids: Node[] };
    const tree: Node[] = [{ id: 1, kids: [{ id: 2, kids: [{ id: 3, kids: [] }] }] }];
    const setups: number[] = [];
    function* node(n: Node): Generator<any, () => Generator<any, string, any>, any> {
      setups.push(n.id);
      const [open] = yield* $signal(true);
      const kids = mapArray(() => n.kids, renderCallback(node) as any);
      return function* () {
        const views = yield* kids;
        return `${n.id}${(yield* open) ? "(" + views.map(v => renderBlock(v as any)).join(",") + ")" : ""}`;
      };
    }
    const { out } = mountList(() => tree as any, node);
    expect(out.at(-1)).toEqual(["1(2(3()))"]);
    expect(setups).toEqual([1, 2, 3]);
  });

  it("a setup that does not return its view is a clear error", () => {
    const [list] = createSignal<Row[]>([{ id: 1, label: "a" }]);
    expect(() =>
      mountList(list, function* (_row: Row) {
        return "not a view" as any;
      })
    ).toThrow("[SCOPE_VIEW]");
  });

  it("creation outside the setup is refused by the driver", () => {
    const [list] = createSignal<Row[]>([{ id: 1, label: "a" }]);
    expect(() =>
      mountList(list, function* (_row: Row) {
        return function* () {
          const [x] = yield* $signal(1);
          return `${yield* x}`;
        };
      })
    ).toThrow();
  });

  it("a component rendered inside a row block's view renders under the row", () => {
    const [list, setList] = createSignal<Row[]>([{ id: 1, label: "a" }]);
    const log: string[] = [];
    const Child = $component(function* () {
      yield* $cleanup(() => log.push("child cleanup"));
      return function* () {
        return "child";
      };
    });
    const { out } = mountList(list, function* (row: Row) {
      yield* $cleanup(() => log.push(`row ${row.id} cleanup`));
      return function* () {
        return `${row.label}:${renderBlock(Child({}) as any)}`;
      };
    });
    expect(out.at(-1)).toEqual(["a:child"]);
    setList([]);
    flush();
    expect(log).toContain("row 1 cleanup");
  });
});
