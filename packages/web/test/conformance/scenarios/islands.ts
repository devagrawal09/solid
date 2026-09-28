/**
 * Compiled islands (documentation/plans/ssr-hydration-redesign.md, "Compiler
 * emission"): a list island — a keyed `For` over an immutable array, a `Show`,
 * memos, a text hole sharing its element (a marker pair), row handlers
 * reaching the parent's actions through props, and a setter escaping to a
 * module binding (driven from the test). The reference is ordinary Solid;
 * the `islands` source is the same program as blocks v2, which
 * `islands.spec.ts` compiles with `compileIslands` and activates on the
 * server markup at the tier the compiler chooses (tier 1: memos, dynamic
 * structure, shared state), and on the core as the tier-2 control.
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

export const islandsList: Scenario = {
  name: "islands-list",
  covers: [
    "keyed For over an immutable array: rows adopted, created, removed",
    "Show opening from a later write",
    "memos over the list and a filter",
    "text hole sharing its element",
    "row handlers calling the parent's actions through props"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, For, Show } from "solid-js";
import { h } from "conformance";
export let add;
function Row(props) {
  return (
    <li class={{ done: props.item.done }}>
      <span>{props.item.title}</span>
      <button class="toggle" onClick={() => props.toggle(props.item.id)} />
      <button class="remove" onClick={() => props.remove(props.item.id)} />
    </li>
  );
}
export function App() {
  const [items, setItems] = h.signal("items", [
    { id: 1, title: "a", done: false },
    { id: 2, title: "b", done: true }
  ]);
  const [filter, setFilter] = h.signal("filter", "all");
  const shown = createMemo(() => {
    h.run("shown");
    const f = filter();
    const list = items();
    return f === "all" ? list : list.filter(i => i.done === (f === "done"));
  });
  const left = createMemo(() => items().filter(i => !i.done).length);
  let next = 3;
  const toggle = id => setItems(list => list.map(i => (i.id === id ? { ...i, done: !i.done } : i)));
  const remove = id => setItems(list => list.filter(i => i.id !== id));
  add = title => setItems(list => [...list, { id: next++, title, done: false }]);
  return (
    <div>
      <p class="left"><strong>{left()}</strong> {left() === 1 ? "item" : "items"} left</p>
      <ul>
        <For each={shown()}>{item => <Row item={item} toggle={toggle} remove={remove} />}</For>
      </ul>
      <Show when={items().length > 2}>
        <p class="many">many</p>
      </Show>
      <button class="all" onClick={() => setFilter("all")} />
      <button class="done" onClick={() => setFilter("done")} />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $memo, For, Show } from "solid-js";
import { h } from "conformance";
export let add;
const Row = $component(function* (props) {
  const toggle = $event(function* () { props.toggle(yield* props.item.id); });
  const remove = $event(function* () { props.remove(yield* props.item.id); });
  return function* () {
    return (
      <li class={{ done: yield* props.item.done }}>
        <span>{yield* props.item.title}</span>
        <button class="toggle" onClick={toggle} />
        <button class="remove" onClick={remove} />
      </li>
    );
  };
});
export const App = $component(function* () {
  const [items, setItems] = h.signal("items", [
    { id: 1, title: "a", done: false },
    { id: 2, title: "b", done: true }
  ]);
  const [filter, setFilter] = h.signal("filter", "all");
  const shown = yield* $memo(function* () {
    h.run("shown");
    const f = yield* filter;
    const list = yield* items;
    return f === "all" ? list : list.filter(i => i.done === (f === "done"));
  });
  const left = yield* $memo(function* () {
    return (yield* items).filter(i => !i.done).length;
  });
  let next = 3;
  const toggle = id => setItems(list => list.map(i => (i.id === id ? { ...i, done: !i.done } : i)));
  const remove = id => setItems(list => list.filter(i => i.id !== id));
  add = title => setItems(list => [...list, { id: next++, title, done: false }]);
  const all = $event(function* () { setFilter("all"); });
  const done = $event(function* () { setFilter("done"); });
  return function* () {
    return (
      <div>
        <p class="left"><strong>{yield* left}</strong> {(yield* left) === 1 ? "item" : "items"} left</p>
        <ul>
          <For each={yield* shown}>{item => <Row item={item} toggle={toggle} remove={remove} />}</For>
        </ul>
        <Show when={(yield* items).length > 2}>
          <p class="many">many</p>
        </Show>
        <button class="all" onClick={all} />
        <button class="done" onClick={done} />
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("toggle row a (the row is replaced)", ctx => ctx.click("li .toggle")),
    step("filter done (rows leave)", ctx => ctx.click(".done")),
    step("filter all (rows return)", ctx => ctx.click(".all")),
    step("add c (a row is created, the Show opens)", ctx => ctx.app.add("c")),
    step("remove the second row", ctx => {
      const buttons = ctx.app && document.querySelectorAll("li .remove");
      (buttons[1] as HTMLElement).click();
    })
  ]
};

/**
 * Streaming: a `Loading` over a server-authoritative async memo streams its
 * content as an out-of-order chunk (the shell carries the fallback). Two
 * islands meet the boundary: `Counter` (tier 0) lives inside the streamed
 * content and activates when it lands; `App`'s island spans it (its button is
 * in the shell, its member `Data` reads `props.n` inside the boundary), so it
 * `waits`: it activates once the boundary it crosses has landed.
 */
export const islandsStream: Scenario = {
  name: "islands-stream",
  covers: [
    "Loading over server data streams as a chunk",
    "an island inside a streamed boundary activates when it lands",
    "an island spanning a streamed boundary waits for it"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, createSignal, Loading } from "solid-js";
import { h } from "conformance";
function Counter() {
  const [c, setC] = createSignal(0);
  return <button class="count" onClick={() => setC(x => x + 1)}>{c()}</button>;
}
function Data(props) {
  const info = createMemo(() => h.task("load"));
  return (
    <section>
      <h2>{info().title}</h2>
      <span class="n">{props.n}</span>
      <Counter />
    </section>
  );
}
export function App() {
  const [n, setN] = createSignal(0);
  return (
    <div>
      <button class="inc" onClick={() => setN(x => x + 1)}>inc</button>
      <Loading fallback={<p class="loading">loading</p>}>
        <Data n={n()} />
      </Loading>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $memo, $signal, attempt, Loading } from "solid-js";
import { h } from "conformance";
const Counter = $component(function* () {
  const [c, setC] = yield* $signal(0);
  const inc = $event(function* () { setC(x => x + 1); });
  return function* () {
    return <button class="count" onClick={inc}>{yield* c}</button>;
  };
});
const Data = $component(function* (props) {
  const info = yield* $memo(function* () {
    return yield* attempt(() => h.task("load"));
  });
  return function* () {
    return (
      <section>
        <h2>{(yield* info).title}</h2>
        <span class="n">{yield* props.n}</span>
        <Counter />
      </section>
    );
  };
});
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <div>
        <button class="inc" onClick={inc}>inc</button>
        <Loading fallback={<p class="loading">loading</p>}>
          <Data n={yield* n} />
        </Loading>
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "resolve (the chunk lands)",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("load#1", { title: "T" });
        await settle();
        html();
      }
    },
    step("inc (the spanning island is active)", ctx => ctx.click(".inc")),
    step("count (the island inside the chunk is active)", ctx => ctx.click(".count")),
    step("count again", ctx => ctx.click(".count"))
  ]
};

export const islandsScenarios = [islandsList, islandsStream];
