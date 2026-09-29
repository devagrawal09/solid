/**
 * Render callbacks as blocks (generator-blocks-v2.md, "Render callbacks as
 * blocks"): a `<For>` render callback that is a block with its own setup and
 * view. The oracle is what the row block means — ordinary Solid with the
 * state created inside a plain `<For>` callback (`createSignal` under the
 * row's owner, `onCleanup` when the row goes). The `blocks` source runs in
 * the client modes (compiled, and uncompiled on the generator driver), in
 * SSR + hydration (`server/blocks-compiled` → `hydrate/blocks-compiled`) and
 * in the islands mode.
 */
import type { Scenario } from "../harness/types.js";

const step = (name: string, run: (ctx: any) => void) => ({
  name,
  run: (ctx: any) => {
    run(ctx);
    ctx.flush();
    ctx.html();
  }
});

export const blocksRowList: Scenario = {
  name: "blocks-row-list",
  covers: [
    "row block: setup once per row, under the row's owner",
    "row block: each row's own state (a handler in the row writes it)",
    "row block: rows added, removed and reordered keep or drop their state",
    "row block: $cleanup when the row is removed and on dispose"
  ],
  entry: { component: "App" },
  ssr: {},
  islands: {
    reason:
      "The islands keep the server's rows and bind their holes: a list update re-renders nothing that did not change. The oracle (and the client modes) render a row's view lazily, like a component's view, so a list update renders the row views again (each re-reads its `open`). Every write, run, cleanup and markup is the oracle's.",
    trace: [
      "## initial",
      'html = <ul><li class="row r1">a=open</li><li class="row r2">b=open</li></ul>',
      "## toggle row b (its own state)",
      "run toggle b",
      "read open b = true",
      "write open b = false",
      "read open b = false",
      'html = <ul><li class="row r1">a=open</li><li class="row r2">b=closed</li></ul>',
      "## reorder b, c, a (c is new: one setup; b keeps its state)",
      'write items = [{"id":2,"label":"b"},{"id":3,"label":"c"},{"id":1,"label":"a"}]',
      'read items = [{"id":2,"label":"b"},{"id":3,"label":"c"},{"id":1,"label":"a"}]',
      "run setup c",
      "read open c = true",
      'html = <ul><li class="row r2">b=closed</li><li class="row r3">c=open</li><li class="row r1">a=open</li></ul>',
      "## toggle row c",
      "run toggle c",
      "read open c = true",
      "write open c = false",
      "read open c = false",
      'html = <ul><li class="row r2">b=closed</li><li class="row r3">c=closed</li><li class="row r1">a=open</li></ul>',
      "## remove a (its cleanup runs)",
      'write items = [{"id":2,"label":"b"},{"id":3,"label":"c"}]',
      'read items = [{"id":2,"label":"b"},{"id":3,"label":"c"}]',
      "run cleanup a",
      'html = <ul><li class="row r2">b=closed</li><li class="row r3">c=closed</li></ul>',
      "## toggle row b again",
      "run toggle b",
      "read open b = false",
      "write open b = true",
      "read open b = true",
      'html = <ul><li class="row r2">b=open</li><li class="row r3">c=closed</li></ul>',
      "## dispose (every row's cleanup)",
      "run cleanup c",
      "run cleanup b"
    ]
  },
  modes: {
    "hydrate/blocks-compiled": {
      status: "differs",
      reason:
        "Hydration keys only: the server nodes keep the `_hk` values `server/blocks-compiled` rendered (a view or row block is a hydration id scope), which the `html` lines show; every node is claimed (the same kept / inserted counts as the oracle), and every read, write, run and later render is the oracle's.",
      trace: [
        "## hydrate",
        'read items = [{"id":1,"label":"a"},{"id":2,"label":"b"}]',
        "run setup a",
        "run setup b",
        "read open a = true",
        "read open b = true",
        "hydration server-nodes 3/3 kept, 0 client-inserted",
        "## initial",
        'html = <ul _hk="00"><li _hk="01000" class="row r1"><!--$-->a<!--/-->=<!--$-->open<!--/--></li><li _hk="01100" class="row r2"><!--$-->b<!--/-->=<!--$-->open<!--/--></li></ul>',
        "## toggle row b (its own state)",
        "run toggle b",
        "read open b = true",
        "write open b = false",
        "read open b = false",
        'html = <ul _hk="00"><li _hk="01000" class="row r1"><!--$-->a<!--/-->=<!--$-->open<!--/--></li><li _hk="01100" class="row r2"><!--$-->b<!--/-->=<!--$-->closed<!--/--></li></ul>',
        "## reorder b, c, a (c is new: one setup; b keeps its state)",
        'write items = [{"id":2,"label":"b"},{"id":3,"label":"c"},{"id":1,"label":"a"}]',
        'read items = [{"id":2,"label":"b"},{"id":3,"label":"c"},{"id":1,"label":"a"}]',
        "run setup c",
        "read open b = false",
        "read open c = true",
        "read open a = true",
        'html = <ul _hk="00"><li class="row r2"><!--$-->b<!--/-->=<!--$-->closed<!--/--></li><li class="row r3"><!--$-->c<!--/-->=<!--$-->open<!--/--></li><li class="row r1"><!--$-->a<!--/-->=<!--$-->open<!--/--></li></ul>',
        "## toggle row c",
        "run toggle c",
        "read open c = true",
        "write open c = false",
        "read open c = false",
        'html = <ul _hk="00"><li class="row r2"><!--$-->b<!--/-->=<!--$-->closed<!--/--></li><li class="row r3"><!--$-->c<!--/-->=<!--$-->closed<!--/--></li><li class="row r1"><!--$-->a<!--/-->=<!--$-->open<!--/--></li></ul>',
        "## remove a (its cleanup runs)",
        'write items = [{"id":2,"label":"b"},{"id":3,"label":"c"}]',
        'read items = [{"id":2,"label":"b"},{"id":3,"label":"c"}]',
        "run cleanup a",
        "read open b = false",
        "read open c = false",
        'html = <ul _hk="00"><li class="row r2"><!--$-->b<!--/-->=<!--$-->closed<!--/--></li><li class="row r3"><!--$-->c<!--/-->=<!--$-->closed<!--/--></li></ul>',
        "## toggle row b again",
        "run toggle b",
        "read open b = false",
        "write open b = true",
        "read open b = true",
        'html = <ul _hk="00"><li class="row r2"><!--$-->b<!--/-->=<!--$-->open<!--/--></li><li class="row r3"><!--$-->c<!--/-->=<!--$-->closed<!--/--></li></ul>',
        "## dispose (every row's cleanup)",
        "run cleanup c",
        "run cleanup b"
      ]
    },
    "server/blocks-compiled": {
      status: "differs",
      reason:
        "Hydration keys only: the markup is the oracle's with different `_hk` values. A `$component` view and a row block's view are hydration id scopes (`blockScope`: one slot reserved where the block is created, its content numbered inside it), where the handwritten oracle numbers its templates in its component's own sequence. The client compiled the same way claims every key (see `hydrate/blocks-compiled`).",
      trace: [
        "## render",
        'read items = [{"id":1,"label":"a"},{"id":2,"label":"b"}]',
        "run setup a",
        "run setup b",
        "read open a = true",
        "read open b = true",
        "run cleanup a",
        "run cleanup b",
        'markup = <ul _hk=00><li _hk=01000 class="row r1"><!--$-->a<!--/-->=<!--$-->open<!--/--></li><!--!$--><li _hk=01100 class="row r2"><!--$-->b<!--/-->=<!--$-->open<!--/--></li></ul>',
        'hydration-keys = ["00","01000","01100"]',
        "serialized = []"
      ]
    },
    "client/blocks-uncompiled": {
      status: "differs",
      reason:
        "Uncompiled, a view is one computation (the generic JSX transform evaluates `yield* items` while the view runs): a write to `items` re-runs App's view, which creates a new `<For>`, so every row runs a fresh setup and the old rows are cleaned up (row state resets on reorder). The list's rows render in one computation too, so a row's toggle re-reads every row's `open`. Compiled, `each` is its own getter and each hole its own computation: rows keep their state. Also the markup: @solidjs/h appends adjacent text nodes without a `<!---->` marker.",
      trace: [
        "## mount",
        'read items = [{"id":1,"label":"a"},{"id":2,"label":"b"}]',
        "run setup a",
        "run setup b",
        "read open a = true",
        "read open b = true",
        "## initial",
        'html = <ul><li class="row r1">a=open</li><li class="row r2">b=open</li></ul>',
        "## toggle row b (its own state)",
        "run toggle b",
        "read open b = true",
        "write open b = false",
        "read open a = true",
        "read open b = false",
        'html = <ul><li class="row r1">a=open</li><li class="row r2">b=closed</li></ul>',
        "## reorder b, c, a (c is new: one setup; b keeps its state)",
        'write items = [{"id":2,"label":"b"},{"id":3,"label":"c"},{"id":1,"label":"a"}]',
        'read items = [{"id":2,"label":"b"},{"id":3,"label":"c"},{"id":1,"label":"a"}]',
        "run setup b",
        "run setup c",
        "run setup a",
        "read open b = true",
        "read open c = true",
        "read open a = true",
        "run cleanup b",
        "run cleanup a",
        'html = <ul><li class="row r2">b=open</li><li class="row r3">c=open</li><li class="row r1">a=open</li></ul>',
        "## toggle row c",
        "run toggle c",
        "read open c = true",
        "write open c = false",
        "read open b = true",
        "read open c = false",
        "read open a = true",
        'html = <ul><li class="row r2">b=open</li><li class="row r3">c=closed</li><li class="row r1">a=open</li></ul>',
        "## remove a (its cleanup runs)",
        'write items = [{"id":2,"label":"b"},{"id":3,"label":"c"}]',
        'read items = [{"id":2,"label":"b"},{"id":3,"label":"c"}]',
        "run setup b",
        "run setup c",
        "read open b = true",
        "read open c = true",
        "run cleanup a",
        "run cleanup c",
        "run cleanup b",
        'html = <ul><li class="row r2">b=open</li><li class="row r3">c=open</li></ul>',
        "## toggle row b again",
        "run toggle b",
        "read open b = true",
        "write open b = false",
        "read open b = false",
        "read open c = true",
        'html = <ul><li class="row r2">b=closed</li><li class="row r3">c=open</li></ul>',
        "## dispose (every row's cleanup)",
        "run cleanup c",
        "run cleanup b"
      ]
    }
  },
  sources: {
    reference: `
import { For, onCleanup } from "solid-js";
import { h } from "conformance";
export let setItems;
export function App() {
  const [items, si] = h.signal("items", [
    { id: 1, label: "a" },
    { id: 2, label: "b" }
  ]);
  setItems = si;
  return (
    <ul>
      <For each={items()}>
        {c => {
          h.run("setup " + c.label);
          const [open, setOpen] = h.signal("open " + c.label, true);
          onCleanup(() => h.run("cleanup " + c.label));
          const toggle = () => {
            h.run("toggle " + c.label);
            setOpen(!open());
          };
          // The view: rendered where the row is inserted, like a component's.
          return () => (
            <li class={"row r" + c.id} onClick={toggle}>
              {c.label}={open() ? "open" : "closed"}
            </li>
          );
        }}
      </For>
    </ul>
  );
}
`,
    blocks: `
import { $cleanup, $component, $event, For } from "solid-js";
import { h } from "conformance";
export let setItems;
export const App = $component(function* () {
  const [items, si] = h.signal("items", [
    { id: 1, label: "a" },
    { id: 2, label: "b" }
  ]);
  setItems = si;
  return function* () {
    return (
      <ul>
        <For each={yield* items}>
          {function* (c) {
            h.run("setup " + c.label);
            const [open, setOpen] = h.signal("open " + c.label, true);
            yield* $cleanup(() => h.run("cleanup " + c.label));
            const toggle = $event(function* () {
              h.run("toggle " + c.label);
              setOpen(!(yield* open));
            });
            return function* () {
              return (
                <li class={"row r" + c.id} onClick={toggle}>
                  {c.label}={(yield* open) ? "open" : "closed"}
                </li>
              );
            };
          }}
        </For>
      </ul>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("toggle row b (its own state)", ctx => ctx.click(".r2")),
    step("reorder b, c, a (c is new: one setup; b keeps its state)", ctx =>
      ctx.app.setItems((list: any[]) => [list[1], { id: 3, label: "c" }, list[0]])
    ),
    step("toggle row c", ctx => ctx.click(".r3")),
    step("remove a (its cleanup runs)", ctx =>
      ctx.app.setItems((list: any[]) => list.filter((x: any) => x.label !== "a"))
    ),
    step("toggle row b again", ctx => ctx.click(".r2")),
    { name: "dispose (every row's cleanup)", run: ({ dispose }) => dispose() }
  ]
};

export const blocksRowRecursive: Scenario = {
  name: "blocks-row-recursive",
  covers: [
    "named row block declared in a setup",
    "recursive row block (renders itself for its children)",
    "per-instance state at every depth"
  ],
  entry: { component: "App" },
  ssr: {},
  modes: {
    "hydrate/blocks-compiled": {
      status: "differs",
      reason:
        "Hydration keys only: the server nodes keep the `_hk` values `server/blocks-compiled` rendered (a view or row block is a hydration id scope), which the `html` lines show; every node is claimed (the same kept / inserted counts as the oracle), and every read, write, run and later render is the oracle's.",
      trace: [
        "## hydrate",
        "read open a = true",
        "read open a1 = true",
        "read open a1 = true",
        "read open a = true",
        "hydration server-nodes 9/9 kept, 0 client-inserted",
        "## initial",
        'html = <ul _hk="00" class="tree"><li _hk="01000" class="n1"><span>a</span><!--$--><a _hk="010030" class="t1">[-]</a><ul _hk="010031" style="display:block"><li _hk="010032000" class="n2"><span>a1</span><!--$--><a _hk="0100320030" class="t2">[-]</a><ul _hk="0100320031" style="display:block"><li _hk="0100320032000" class="n3"><span>a1x</span><!--$--><!--/--></li></ul><!--/--></li></ul><!--/--></li><li _hk="01100" class="n4"><span>b</span><!--$--><!--/--></li></ul>',
        "## collapse a1 (a nested instance)",
        "read open a1 = true",
        "write open a1 = false",
        "read open a1 = false",
        "read open a1 = false",
        'html = <ul _hk="00" class="tree"><li _hk="01000" class="n1"><span>a</span><!--$--><a _hk="010030" class="t1">[-]</a><ul _hk="010031" style="display:block"><li _hk="010032000" class="n2"><span>a1</span><!--$--><a _hk="0100320030" class="t2">[+]</a><ul _hk="0100320031" style="display: none;"><li _hk="0100320032000" class="n3"><span>a1x</span><!--$--><!--/--></li></ul><!--/--></li></ul><!--/--></li><li _hk="01100" class="n4"><span>b</span><!--$--><!--/--></li></ul>',
        "## collapse a (the outer instance)",
        "read open a = true",
        "write open a = false",
        "read open a = false",
        "read open a = false",
        'html = <ul _hk="00" class="tree"><li _hk="01000" class="n1"><span>a</span><!--$--><a _hk="010030" class="t1">[+]</a><ul _hk="010031" style="display: none;"><li _hk="010032000" class="n2"><span>a1</span><!--$--><a _hk="0100320030" class="t2">[+]</a><ul _hk="0100320031" style="display: none;"><li _hk="0100320032000" class="n3"><span>a1x</span><!--$--><!--/--></li></ul><!--/--></li></ul><!--/--></li><li _hk="01100" class="n4"><span>b</span><!--$--><!--/--></li></ul>',
        "## expand a1 again",
        "read open a1 = false",
        "write open a1 = true",
        "read open a1 = true",
        "read open a1 = true",
        'html = <ul _hk="00" class="tree"><li _hk="01000" class="n1"><span>a</span><!--$--><a _hk="010030" class="t1">[+]</a><ul _hk="010031" style="display: none;"><li _hk="010032000" class="n2"><span>a1</span><!--$--><a _hk="0100320030" class="t2">[-]</a><ul _hk="0100320031" style="display: block;"><li _hk="0100320032000" class="n3"><span>a1x</span><!--$--><!--/--></li></ul><!--/--></li></ul><!--/--></li><li _hk="01100" class="n4"><span>b</span><!--$--><!--/--></li></ul>',
        "## teardown"
      ]
    },
    "server/blocks-compiled": {
      status: "differs",
      reason:
        "Hydration keys only: the markup is the oracle's with different `_hk` values. A `$component` view and a row block's view are hydration id scopes (`blockScope`: one slot reserved where the block is created, its content numbered inside it), where the handwritten oracle numbers its templates in its component's own sequence. The client compiled the same way claims every key (see `hydrate/blocks-compiled`).",
      trace: [
        "## render",
        "read open a = true",
        "read open a = true",
        "read open a1 = true",
        "read open a1 = true",
        'markup = <ul _hk=00 class="tree"><li _hk=01000 class="n1"><span>a</span><!--$--><a _hk=010030 class="t1">[-]</a><ul _hk=010031 style="display:block"><li _hk=010032000 class="n2"><span>a1</span><!--$--><a _hk=0100320030 class="t2">[-]</a><ul _hk=0100320031 style="display:block"><li _hk=0100320032000 class="n3"><span>a1x</span><!--$--><!--/--></li></ul><!--/--></li></ul><!--/--></li><!--!$--><li _hk=01100 class="n4"><span>b</span><!--$--><!--/--></li></ul>',
        'hydration-keys = ["00","01000","010030","010031","010032000","0100320030","0100320031","0100320032000","01100"]',
        "serialized = []"
      ]
    },
    "client/blocks-uncompiled": {
      status: "differs",
      reason:
        "Uncompiled, a row's view is one computation that evaluates its JSX eagerly (no compiler-made closures): every node reads its own `open` twice (the toggle text and the style) whether or not `<Show>` renders it, and a toggle re-runs the node's whole view, which re-creates its `<For>` and so its child rows (their state resets: after collapsing `a`, `a1` shows open again). Compiled, each hole is its own computation and nested rows keep their state.",
      trace: [
        "## mount",
        "read open a = true",
        "read open a = true",
        "read open a1 = true",
        "read open a1 = true",
        "read open a1x = true",
        "read open a1x = true",
        "read open b = true",
        "read open b = true",
        "## initial",
        'html = <ul class="tree"><li class="n1"><span>a</span><a class="t1">[-]</a><ul style="display: block;"><li class="n2"><span>a1</span><a class="t2">[-]</a><ul style="display: block;"><li class="n3"><span>a1x</span></li></ul></li></ul></li><li class="n4"><span>b</span></li></ul>',
        "## collapse a1 (a nested instance)",
        "read open a1 = true",
        "write open a1 = false",
        "read open a1 = false",
        "read open a1 = false",
        "read open a1x = true",
        "read open a1x = true",
        'html = <ul class="tree"><li class="n1"><span>a</span><a class="t1">[-]</a><ul style="display: block;"><li class="n2"><span>a1</span><a class="t2">[+]</a><ul style="display: none;"><li class="n3"><span>a1x</span></li></ul></li></ul></li><li class="n4"><span>b</span></li></ul>',
        "## collapse a (the outer instance)",
        "read open a = true",
        "write open a = false",
        "read open a = false",
        "read open a = false",
        "read open a1 = true",
        "read open a1 = true",
        "read open a1x = true",
        "read open a1x = true",
        "read open b = true",
        "read open b = true",
        'html = <ul class="tree"><li class="n1"><span>a</span><a class="t1">[+]</a><ul style="display: none;"><li class="n2"><span>a1</span><a class="t2">[-]</a><ul style="display: block;"><li class="n3"><span>a1x</span></li></ul></li></ul></li><li class="n4"><span>b</span></li></ul>',
        "## expand a1 again",
        "read open a1 = true",
        "write open a1 = false",
        "read open a1 = false",
        "read open a1 = false",
        "read open a1x = true",
        "read open a1x = true",
        'html = <ul class="tree"><li class="n1"><span>a</span><a class="t1">[+]</a><ul style="display: none;"><li class="n2"><span>a1</span><a class="t2">[+]</a><ul style="display: none;"><li class="n3"><span>a1x</span></li></ul></li></ul></li><li class="n4"><span>b</span></li></ul>',
        "## teardown"
      ]
    }
  },
  sources: {
    reference: `
import { For, Show } from "solid-js";
import { h } from "conformance";
const tree = [
  { id: 1, label: "a", kids: [{ id: 2, label: "a1", kids: [{ id: 3, label: "a1x", kids: [] }] }] },
  { id: 4, label: "b", kids: [] }
];
export function App() {
  const node = n => {
    const [open, setOpen] = h.signal("open " + n.label, true);
    const toggle = () => setOpen(!open());
    return () => (
      <li class={"n" + n.id}>
        <span>{n.label}</span>
        <Show when={n.kids.length}>
          <a class={"t" + n.id} onClick={toggle}>{open() ? "[-]" : "[+]"}</a>
          <ul style={{ display: open() ? "block" : "none" }}>
            <For each={n.kids}>{node}</For>
          </ul>
        </Show>
      </li>
    );
  };
  return (
    <ul class="tree">
      <For each={tree}>{node}</For>
    </ul>
  );
}
`,
    blocks: `
import { $component, $event, For, Show } from "solid-js";
import { h } from "conformance";
const tree = [
  { id: 1, label: "a", kids: [{ id: 2, label: "a1", kids: [{ id: 3, label: "a1x", kids: [] }] }] },
  { id: 4, label: "b", kids: [] }
];
export const App = $component(function* () {
  function* node(n) {
    const [open, setOpen] = h.signal("open " + n.label, true);
    const toggle = $event(function* () {
      setOpen(!(yield* open));
    });
    return function* () {
      return (
        <li class={"n" + n.id}>
          <span>{n.label}</span>
          <Show when={n.kids.length}>
            <a class={"t" + n.id} onClick={toggle}>{(yield* open) ? "[-]" : "[+]"}</a>
            <ul style={{ display: (yield* open) ? "block" : "none" }}>
              <For each={n.kids}>{node}</For>
            </ul>
          </Show>
        </li>
      );
    };
  }
  return function* () {
    return (
      <ul class="tree">
        <For each={tree}>{node}</For>
      </ul>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("collapse a1 (a nested instance)", ctx => ctx.click(".t2")),
    step("collapse a (the outer instance)", ctx => ctx.click(".t1")),
    step("expand a1 again", ctx => ctx.click(".t2"))
  ]
};

export const blocksRowKeyedStore: Scenario = {
  name: "blocks-row-keyed-store",
  covers: [
    "row block reading a store map by its own key",
    "a handler in the row writing the store at its own key"
  ],
  entry: { component: "App" },
  ssr: {},
  modes: {
    "hydrate/blocks-compiled": {
      status: "differs",
      reason:
        "Hydration keys only: the server nodes keep the `_hk` values `server/blocks-compiled` rendered (a view or row block is a hydration id scope), which the `html` lines show; every node is claimed (the same kept / inserted counts as the oracle), and every read, write, run and later render is the oracle's.",
      trace: [
        "## hydrate",
        "hydration server-nodes 4/4 kept, 0 client-inserted",
        "## initial",
        'html = <ul _hk="00"><li _hk="01000" class="c1"><!--$-->a<!--/-->:<!--$-->open<!--/--></li><li _hk="01100" class="c2"><!--$-->b<!--/-->:<!--$-->open<!--/--></li><li _hk="01200" class="c3"><!--$-->c<!--/-->:<!--$-->open<!--/--></li></ul>',
        "## toggle row 2",
        "run toggle 2",
        'html = <ul _hk="00"><li _hk="01000" class="c1"><!--$-->a<!--/-->:<!--$-->open<!--/--></li><li _hk="01100" class="c2"><!--$-->b<!--/-->:<!--$-->closed<!--/--></li><li _hk="01200" class="c3"><!--$-->c<!--/-->:<!--$-->open<!--/--></li></ul>',
        "## toggle row 1",
        "run toggle 1",
        'html = <ul _hk="00"><li _hk="01000" class="c1"><!--$-->a<!--/-->:<!--$-->closed<!--/--></li><li _hk="01100" class="c2"><!--$-->b<!--/-->:<!--$-->closed<!--/--></li><li _hk="01200" class="c3"><!--$-->c<!--/-->:<!--$-->open<!--/--></li></ul>',
        "## toggle row 2 back",
        "run toggle 2",
        'html = <ul _hk="00"><li _hk="01000" class="c1"><!--$-->a<!--/-->:<!--$-->closed<!--/--></li><li _hk="01100" class="c2"><!--$-->b<!--/-->:<!--$-->open<!--/--></li><li _hk="01200" class="c3"><!--$-->c<!--/-->:<!--$-->open<!--/--></li></ul>',
        "## teardown"
      ]
    },
    "server/blocks-compiled": {
      status: "differs",
      reason:
        "Hydration keys only: the markup is the oracle's with different `_hk` values. A `$component` view and a row block's view are hydration id scopes (`blockScope`: one slot reserved where the block is created, its content numbered inside it), where the handwritten oracle numbers its templates in its component's own sequence. The client compiled the same way claims every key (see `hydrate/blocks-compiled`).",
      trace: [
        "## render",
        'markup = <ul _hk=00><li _hk=01000 class="c1"><!--$-->a<!--/-->:<!--$-->open<!--/--></li><!--!$--><li _hk=01100 class="c2"><!--$-->b<!--/-->:<!--$-->open<!--/--></li><!--!$--><li _hk=01200 class="c3"><!--$-->c<!--/-->:<!--$-->open<!--/--></li></ul>',
        'hydration-keys = ["00","01000","01100","01200"]',
        "serialized = []"
      ]
    },
    "client/blocks-uncompiled": {
      status: "differs",
      reason:
        "Markup only: Solid's compiled template inserts a `<!---->` marker between adjacent text expressions; @solidjs/h appends text nodes without one. Every run is identical.",
      trace: [
        "## mount",
        "## initial",
        'html = <ul><li class="c1">a:open</li><li class="c2">b:open</li><li class="c3">c:open</li></ul>',
        "## toggle row 2",
        "run toggle 2",
        'html = <ul><li class="c1">a:open</li><li class="c2">b:closed</li><li class="c3">c:open</li></ul>',
        "## toggle row 1",
        "run toggle 1",
        'html = <ul><li class="c1">a:closed</li><li class="c2">b:closed</li><li class="c3">c:open</li></ul>',
        "## toggle row 2 back",
        "run toggle 2",
        'html = <ul><li class="c1">a:closed</li><li class="c2">b:open</li><li class="c3">c:open</li></ul>',
        "## teardown"
      ]
    }
  },
  sources: {
    reference: `
import { createStore, For } from "solid-js";
import { h } from "conformance";
const comments = [
  { id: 1, text: "a" },
  { id: 2, text: "b" },
  { id: 3, text: "c" }
];
export function App() {
  const [closed, setClosed] = createStore({ 1: false, 2: false, 3: false });
  return (
    <ul>
      <For each={comments}>
        {c => {
          const toggle = () => {
            h.run("toggle " + c.id);
            setClosed(s => {
              s[c.id] = !s[c.id];
            });
          };
          return () => (
            <li class={"c" + c.id} onClick={toggle}>
              {c.text}:{closed[c.id] ? "closed" : "open"}
            </li>
          );
        }}
      </For>
    </ul>
  );
}
`,
    blocks: `
import { $component, $event, $store, For } from "solid-js";
import { h } from "conformance";
const comments = [
  { id: 1, text: "a" },
  { id: 2, text: "b" },
  { id: 3, text: "c" }
];
export const App = $component(function* () {
  const [closed, setClosed] = yield* $store({ 1: false, 2: false, 3: false });
  return function* () {
    return (
      <ul>
        <For each={comments}>
          {function* (c) {
            const toggle = $event(function* () {
              h.run("toggle " + c.id);
              setClosed(s => {
                s[c.id] = !s[c.id];
              });
            });
            return function* () {
              return (
                <li class={"c" + c.id} onClick={toggle}>
                  {c.text}:{(yield* closed[c.id]) ? "closed" : "open"}
                </li>
              );
            };
          }}
        </For>
      </ul>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("toggle row 2", ctx => ctx.click(".c2")),
    step("toggle row 1", ctx => ctx.click(".c1")),
    step("toggle row 2 back", ctx => ctx.click(".c2"))
  ]
};

export const rowScenarios: Scenario[] = [blocksRowList, blocksRowRecursive, blocksRowKeyedStore];
