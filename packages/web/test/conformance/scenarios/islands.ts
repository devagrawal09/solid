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

/**
 * A stateful island over a store (tier 2: the core's plain store): its
 * initial value comes from server data (the caller's props), so the anchor
 * serializes it — only the keys the island's code reads or writes (`items`,
 * `label`; not `other`). Rows of a `For` over the store read their item's
 * fields through the proxy, so they bind: a toggle writes in place.
 */
export const islandsStore: Scenario = {
  name: "islands-store",
  covers: [
    "store island rebuilt from serialized server data (live keys only)",
    "readStore selectors and draft setters",
    "For rows over a store bind their item's fields"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, createStore, For } from "solid-js";
function List(props) {
  const [state, setState] = createStore({ items: props.items.slice(), label: props.label, other: props.other });
  const remaining = createMemo(() => state.items.filter(i => !i.done).length);
  const add = () => setState(s => { s.items.push({ id: s.items.length + 1, title: "new", done: false }); });
  const toggle = id => setState(s => { const it = s.items.find(x => x.id === id); if (it) it.done = !it.done; });
  return (
    <section>
      <h2>{state.label}</h2>
      <ul>
        <For each={state.items}>
          {item => <li class={item.done ? "done" : ""} onClick={() => toggle(item.id)}>{item.title}</li>}
        </For>
      </ul>
      <p class="left">{remaining()} left</p>
      <button class="add" onClick={add}>add</button>
    </section>
  );
}
export function App() {
  return (
    <main>
      <List
        label="todo"
        items={[{ id: 1, title: "a", done: false }, { id: 2, title: "b", done: true }]}
        other={{ secret: "x" }}
      />
    </main>
  );
}
`,
    islands: `
import { $component, $event, $memo, $store, For, readStore } from "solid-js";
const List = $component(function* (props) {
  const [state, setState] = yield* $store({
    items: (yield* props.items).slice(),
    label: yield* props.label,
    other: yield* props.other
  });
  const remaining = yield* $memo(function* () {
    return yield* readStore(state, s => s.items.filter(i => !i.done).length);
  });
  const add = $event(function* () {
    setState(s => { s.items.push({ id: s.items.length + 1, title: "new", done: false }); });
  });
  const toggle = id => setState(s => { const it = s.items.find(x => x.id === id); if (it) it.done = !it.done; });
  return function* () {
    return (
      <section>
        <h2>{yield* state.label}</h2>
        <ul>
          <For each={yield* state.items}>
            {item => <li class={item.done ? "done" : ""} onClick={() => toggle(item.id)}>{item.title}</li>}
          </For>
        </ul>
        <p class="left">{yield* remaining} left</p>
        <button class="add" onClick={add}>add</button>
      </section>
    );
  };
});
export const App = $component(function* () {
  return function* () {
    return (
      <main>
        <List
          label="todo"
          items={[{ id: 1, title: "a", done: false }, { id: 2, title: "b", done: true }]}
          other={{ secret: "x" }}
        />
      </main>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("toggle a (a row binds its item)", ctx => ctx.click("li")),
    step("add (a row is created)", ctx => ctx.click(".add")),
    step("toggle the new row", ctx => ctx.click("li:nth-child(3)"))
  ]
};

/**
 * Async inside a live island (tier 2): a live async memo is adopted (P2) —
 * its first run subscribes to what it reads before its `attempt` and takes
 * the server's settled value from the anchor, never calling the attempt
 * (the task for id 1 is never started on the client); a later write re-runs
 * it asynchronously. An `$event` that `attempt`s awaits its work (an async
 * handler), then writes.
 */
export const islandsAsync: Scenario = {
  name: "islands-async",
  covers: [
    "live async memo adopted from the server value (no re-run)",
    "a write re-runs the adopted memo asynchronously",
    "an $event awaiting an attempt, then writing"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, createSignal } from "solid-js";
import { h } from "conformance";
export function App() {
  const [id, setId] = createSignal(1);
  const [saved, setSaved] = createSignal("no");
  const user = createMemo(() => {
    const i = id();
    return i === 1 ? Promise.resolve({ name: "Ada" }) : h.task("load", i);
  });
  const save = async () => {
    const r = await h.task("save", id());
    setSaved(r);
  };
  return (
    <div>
      <p class="name">{user().name}</p>
      <button class="next" onClick={() => setId(x => x + 1)}>next</button>
      <button class="save" onClick={save}>save</button>
      <span class="saved">{saved()}</span>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $memo, $signal, attempt } from "solid-js";
import { h } from "conformance";
export const App = $component(function* () {
  const [id, setId] = yield* $signal(1);
  const [saved, setSaved] = yield* $signal("no");
  const user = yield* $memo(function* () {
    const i = yield* id;
    return yield* attempt(() => (i === 1 ? Promise.resolve({ name: "Ada" }) : h.task("load", i)));
  });
  const next = $event(function* () { setId(x => x + 1); });
  const save = $event(function* () {
    const i = yield* id;
    const r = yield* attempt(() => h.task("save", i));
    setSaved(r);
  });
  return function* () {
    return (
      <div>
        <p class="name">{(yield* user).name}</p>
        <button class="next" onClick={next}>next</button>
        <button class="save" onClick={save}>save</button>
        <span class="saved">{yield* saved}</span>
      </div>
    );
  };
});
`
  },
  steps: [
    {
      name: "initial",
      run: async ({ settle, html }) => {
        await settle();
        html();
      }
    },
    step("next (the adopted memo re-runs)", ctx => ctx.click(".next")),
    {
      name: "resolve load#1",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("load#1", { name: "Bea" });
        await settle();
        html();
      }
    },
    step("save (the handler awaits)", ctx => ctx.click(".save")),
    {
      name: "resolve save#1",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("save#1", "yes");
        await settle();
        html();
      }
    }
  ]
};

/**
 * An optimistic store over server data with actions (todos-blocks' state
 * shape, one module): the projection is adopted — the client's first run
 * returns the server's value from the anchor (the fetch is not repeated);
 * `refresh` re-runs it. A row's action writes optimistically, awaits its
 * save, refreshes; the landing replaces the overlay. A live `Show` with a
 * render callback (the row's error) opens from the refreshed data.
 */
export const islandsOptimistic: Scenario = {
  name: "islands-optimistic",
  covers: [
    "optimistic store adopted from the server value",
    "action: optimistic write, await, refresh, landing",
    "live Show with a render callback (its parameter is the when accessor)"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { action, createOptimisticStore, For, refresh, Show } from "solid-js";
import { h } from "conformance";
const initial = () => [
  { id: 1, title: "a", done: false },
  { id: 2, title: "b", done: false }
];
function Row(props) {
  return (
    <li class={{ done: props.item.done, pending: !!props.item.pending }}>
      <button class="toggle" onClick={() => props.toggle(props.item.id)} />
      <span>{props.item.title}</span>
      <Show when={props.item.error}>{error => <em class="err">{error().msg}</em>}</Show>
    </li>
  );
}
export function App() {
  const [items, setItems] = createOptimisticStore(
    async draft => (draft.length ? await h.task("fetch") : initial()),
    []
  );
  const toggle = action(function* (id) {
    setItems(t => {
      const x = t.find(i => i.id === id);
      x.done = !x.done;
      x.pending = true;
    });
    yield h.task("save", id);
    refresh(items);
  });
  return (
    <ul>
      <For each={items}>{item => <Row item={item} toggle={toggle} />}</For>
    </ul>
  );
}
`,
    islands: `
import { $component, $event, action, attempt, createOptimisticStore, For, refresh, Show } from "solid-js";
import { h } from "conformance";
const initial = () => [
  { id: 1, title: "a", done: false },
  { id: 2, title: "b", done: false }
];
const Row = $component(function* (props) {
  const flip = $event(function* () {
    const id = yield* props.item.id;
    yield* attempt(() => props.toggle(id));
  });
  return function* () {
    return (
      <li class={{ done: yield* props.item.done, pending: !!(yield* props.item.pending) }}>
        <button class="toggle" onClick={flip} />
        <span>{yield* props.item.title}</span>
        <Show when={yield* props.item.error}>{error => <em class="err">{error().msg}</em>}</Show>
      </li>
    );
  };
});
export function App() {
  const [items, setItems] = createOptimisticStore(
    async draft => (draft.length ? await h.task("fetch") : initial()),
    []
  );
  const toggle = action(function* (id) {
    setItems(t => {
      const x = t.find(i => i.id === id);
      x.done = !x.done;
      x.pending = true;
    });
    yield h.task("save", id);
    refresh(items);
  });
  return (
    <ul>
      <For each={items}>{item => <Row item={item} toggle={toggle} />}</For>
    </ul>
  );
}
`
  },
  steps: [
    {
      name: "initial",
      run: async ({ settle, html }) => {
        await settle();
        html();
      }
    },
    {
      name: "toggle a (optimistic)",
      run: async ({ click, settle, html }) => {
        click("li .toggle");
        await settle();
        html();
      }
    },
    {
      name: "save lands (refresh starts)",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("save#1");
        await settle();
        html();
      }
    },
    {
      name: "fetch lands (b errored)",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("fetch#1", [
          { id: 1, title: "a", done: true },
          { id: 2, title: "b", done: false, error: { msg: "nope" } }
        ]);
        await settle();
        html();
      }
    }
  ]
};

/**
 * Islands spanning modules: the page calls a factory from `./counter`
 * (a signal, a memo and a closure that writes) and renders `Row` from
 * `./row` with live props and a callback. The compiler reads the imported
 * modules' sources (what the bundler plugin passes from its per-module
 * summaries) and inlines them: the factory's state is the island's, and
 * `Row` becomes a member of the page's island (it receives live state).
 * The reference is the same program in one module.
 */
export const islandsModules: Scenario = {
  name: "islands-modules",
  covers: [
    "a factory imported from another module (inlined into the setup)",
    "an imported component receiving live props joins the island",
    "a helper generator imported from another module"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createContext, createMemo, createSignal, useContext } from "solid-js";
const Label = createContext("count");
function createCounter(start) {
  const [n, setN] = createSignal(start);
  const double = createMemo(() => n() * 2);
  return { n, double, inc: () => setN(x => x + 1) };
}
function Row(props) {
  const label = useContext(Label);
  return (
    <li>
      <span class="v">{label}: {props.value}</span>
      <button class="bump" onClick={() => props.onBump()}>+</button>
    </li>
  );
}
export function App() {
  const c = createCounter(1);
  return (
    <Label value="double">
      <ul>
        <Row value={c.double()} onBump={c.inc} />
        <li class="n">{c.n()}</li>
      </ul>
    </Label>
  );
}
`,
    islands: `
import { $component } from "solid-js";
import { createCounter } from "./counter";
import { Row, Label } from "./row";
export const App = $component(function* () {
  const c = createCounter(1);
  return function* () {
    return (
      <Label value="double">
        <ul>
          <Row value={yield* c.double} onBump={c.inc} />
          <li class="n">{yield* c.n}</li>
        </ul>
      </Label>
    );
  };
});
`
  },
  modules: {
    "./counter": `
import { createMemo, createSignal } from "solid-js";
export function createCounter(start) {
  const [n, setN] = createSignal(start);
  const double = createMemo(() => n() * 2);
  return { n, double, inc: () => setN(x => x + 1) };
}
`,
    "./row": `
import { $component, $event, createContext } from "solid-js";
export const Label = createContext("count");
function* useLabel() {
  const label = yield* Label;
  return label;
}
export const Row = $component(function* (props) {
  const label = yield* useLabel();
  const bump = $event(function* () { props.onBump(); });
  return function* () {
    return (
      <li>
        <span class="v">{label}: {yield* props.value}</span>
        <button class="bump" onClick={bump}>+</button>
      </li>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("bump (the imported component calls the factory's closure)", ctx => ctx.click(".bump")),
    step("bump again", ctx => ctx.click(".bump"))
  ]
};

export const islandsScenarios = [
  islandsList,
  islandsStream,
  islandsStore,
  islandsAsync,
  islandsOptimistic,
  islandsModules
];
