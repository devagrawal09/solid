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

export const islandsScenarios = [islandsList];
