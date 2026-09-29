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

/**
 * An `<Errored>` around a tier-2 island's live content keeps a client error
 * boundary: a memo that throws after a write shows the fallback (built on the
 * client, with the error and `reset`); the content is kept, still bound, and
 * a reset that recovers puts it back.
 */
export const islandsErrored: Scenario = {
  name: "islands-errored",
  covers: [
    "client error boundary around adopted live content",
    "the fallback built on the client with err / reset",
    "reset recovers the same content"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, createStore, Errored } from "solid-js";
function Child(props) {
  const v = createMemo(() => {
    if (props.n > 1) throw new Error("too big");
    return props.n;
  });
  return <span class="v">{v()}</span>;
}
export function App() {
  const [s, setS] = createStore({ n: 0 });
  return (
    <main>
      <button class="inc" onClick={() => setS(d => { d.n++; })}>inc</button>
      <Errored
        fallback={(err, reset) => (
          <p class="err">
            {String(err())}
            <button class="reset" onClick={() => { setS(d => { d.n = 0; }); reset(); }}>reset</button>
          </p>
        )}
      >
        <Child n={s.n} />
      </Errored>
    </main>
  );
}
`,
    islands: `
import { $component, $event, $memo, $store, Errored } from "solid-js";
const Child = $component(function* (props) {
  const v = yield* $memo(function* () {
    const n = yield* props.n;
    if (n > 1) throw new Error("too big");
    return n;
  });
  return function* () {
    return <span class="v">{yield* v}</span>;
  };
});
export const App = $component(function* () {
  const [s, setS] = yield* $store({ n: 0 });
  const inc = $event(function* () { setS(d => { d.n++; }); });
  return function* () {
    return (
      <main>
        <button class="inc" onClick={inc}>inc</button>
        <Errored
          fallback={(err, reset) => (
            <p class="err">
              {String(err())}
              <button class="reset" onClick={() => { setS(d => { d.n = 0; }); reset(); }}>reset</button>
            </p>
          )}
        >
          <Child n={yield* s.n} />
        </Errored>
      </main>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("inc (1)", ctx => ctx.click(".inc")),
    step("inc (2: the memo throws, the fallback shows)", ctx => ctx.click(".inc")),
    step("reset (the content comes back)", ctx => ctx.click(".reset")),
    step("inc (the content is live again)", ctx => ctx.click(".inc"))
  ]
};

/**
 * An `<Errored>` inside a live region: each row of a `For` over a store keeps
 * its own client boundary, adopted for the server's rows and created with a
 * row the client adds (a row created failing shows its fallback at once); a
 * later write that makes the failing source succeed brings the content back.
 */
export const islandsErroredRows: Scenario = {
  name: "islands-errored-rows",
  covers: [
    "client error boundaries inside a live region (adopted and fresh rows)",
    "a row created failing shows its fallback",
    "a recovering source restores the row's content"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, createStore, Errored, For } from "solid-js";
function Cell(props) {
  const v = createMemo(() => {
    if (props.v < 0) throw new Error("negative " + props.v);
    return props.v;
  });
  return <b>{v()}</b>;
}
export function App() {
  const [s, setS] = createStore({ items: [{ id: 1, v: 1 }, { id: 2, v: 2 }] });
  return (
    <main>
      <ul>
        <For each={s.items}>
          {item => (
            <li>
              <Errored fallback={err => <em>{String(err())}</em>}>
                <Cell v={item.v} />
              </Errored>
            </li>
          )}
        </For>
      </ul>
      <button class="neg" onClick={() => setS(d => { d.items[0].v = -1; })}>neg</button>
      <button class="add" onClick={() => setS(d => { d.items.push({ id: 3, v: -3 }); })}>add</button>
      <button class="fix" onClick={() => setS(d => { d.items[0].v = 5; })}>fix</button>
    </main>
  );
}
`,
    islands: `
import { $component, $event, $memo, $store, Errored, For } from "solid-js";
const Cell = $component(function* (props) {
  const v = yield* $memo(function* () {
    const n = yield* props.v;
    if (n < 0) throw new Error("negative " + n);
    return n;
  });
  return function* () {
    return <b>{yield* v}</b>;
  };
});
export const App = $component(function* () {
  const [s, setS] = yield* $store({ items: [{ id: 1, v: 1 }, { id: 2, v: 2 }] });
  const neg = $event(function* () { setS(d => { d.items[0].v = -1; }); });
  const add = $event(function* () { setS(d => { d.items.push({ id: 3, v: -3 }); }); });
  const fix = $event(function* () { setS(d => { d.items[0].v = 5; }); });
  return function* () {
    return (
      <main>
        <ul>
          <For each={yield* s.items}>
            {item => (
              <li>
                <Errored fallback={err => <em>{String(err())}</em>}>
                  <Cell v={item.v} />
                </Errored>
              </li>
            )}
          </For>
        </ul>
        <button class="neg" onClick={neg}>neg</button>
        <button class="add" onClick={add}>add</button>
        <button class="fix" onClick={fix}>fix</button>
      </main>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("neg (row 1 fails)", ctx => ctx.click(".neg")),
    step("add (a row created failing)", ctx => ctx.click(".add")),
    step("fix (row 1 recovers)", ctx => ctx.click(".fix"))
  ]
};

/**
 * Two islands sharing a component (`Badge` reads `count` and toggles `dark`):
 * `i0` = {count} over Page, AddToCart, Badge; `i1` = {dark} over Page, Badge.
 * Each chunk must carry only its own island's cells, handlers and holes: a
 * second copy of the other island's cell would go out of phase with it once
 * the islands activate at different times. The islands activate from the
 * steps, in both orders (`manualActivation`), with clicks in between; every
 * step's DOM must equal the oracle's (`islands.spec.ts` runs the chosen tier
 * and the tier-2 control).
 */
const sharedMember = (name: string, first: "i0" | "i1"): Scenario => {
  const activate = (id: string, what: string) => ({
    name: `activate ${id} (${what})`,
    run: (ctx: any) => {
      ctx.activate?.(id);
      ctx.flush();
      ctx.html();
    }
  });
  const add = step("add (count island)", ctx => ctx.click(".add"));
  const badge = step("click the badge (dark island)", ctx => ctx.click(".badge"));
  const i0 = activate("i0", "count");
  const i1 = activate("i1", "dark");
  return {
    name,
    covers: [
      "a component in two islands: each chunk carries only its island's cells, handlers and holes",
      `islands activating at different times (${first} first), with writes in between`
    ],
    entry: { component: "App" },
    manualActivation: true,
    sources: {
      reference: `
import { createSignal } from "solid-js";
function AddToCart(props) {
  return <button class="add" onClick={() => props.setCount(c => c + 1)}>Add {props.name}</button>;
}
function Badge(props) {
  return (
    <span class={{ badge: true, dark: props.dark() }} onClick={() => props.setDark(d => !d)}>
      {props.count()} items
    </span>
  );
}
function Product(props) {
  return <article><h2>{props.title}</h2></article>;
}
export function App() {
  const [count, setCount] = createSignal(0);
  const [dark, setDark] = createSignal(false);
  return (
    <div class={{ page: true, dark: dark() }}>
      <header><Badge count={count} dark={dark} setDark={setDark} /></header>
      <Product title="Mug" />
      <footer><AddToCart name="Mug" setCount={setCount} /></footer>
    </div>
  );
}
`,
      islands: `
import { $component, $event, $signal } from "solid-js";
const AddToCart = $component(function* (props) {
  const add = $event(function* () { props.setCount(c => c + 1); });
  return function* () {
    return <button class="add" onClick={add}>Add {yield* props.name}</button>;
  };
});
const Badge = $component(function* (props) {
  const flip = $event(function* () { props.setDark(d => !d); });
  return function* () {
    return (
      <span class={{ badge: true, dark: yield* props.dark }} onClick={flip}>
        {yield* props.count} items
      </span>
    );
  };
});
const Product = $component(function* (props) {
  return function* () {
    return <article><h2>{yield* props.title}</h2></article>;
  };
});
export const App = $component(function* () {
  const [count, setCount] = yield* $signal(0);
  const [dark, setDark] = yield* $signal(false);
  return function* () {
    return (
      <div class={{ page: true, dark: yield* dark }}>
        <header><Badge count={count} dark={dark} setDark={setDark} /></header>
        <Product title="Mug" />
        <footer><AddToCart name="Mug" setCount={setCount} /></footer>
      </div>
    );
  };
});
`
    },
    steps: [
      { name: "initial", run: ({ html }) => html() },
      ...(first === "i0"
        ? [i0, add, i1, badge, add, badge, add]
        : [i1, badge, i0, add, badge, add, badge])
    ]
  };
};

export const islandsSharedMember = sharedMember("islands-shared-member", "i0");
export const islandsSharedMemberReversed = sharedMember("islands-shared-member-reversed", "i1");

/**
 * `ref` on intrinsic elements: a ref that assigns a setup local joins the
 * island whose handler reads it (activated lazily, the local assigned at
 * activation); a ref callback is client code that runs when the element is
 * created, so its island activates at load.
 */
export const islandsRef: Scenario = {
  name: "islands-ref",
  covers: [
    "ref assigning a setup local read by a handler",
    "ref callback run at activation (load)"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal } from "solid-js";
export let seen = "none";
export function App() {
  let input;
  const [text, setText] = createSignal("");
  return (
    <div>
      <input ref={input} value="abc" />
      <button class="read" onClick={() => setText(input.value.toUpperCase())}>read</button>
      <p class="out">{text()}</p>
      <span class="cb" ref={el => { seen = el.className; }}>cb</span>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal } from "solid-js";
export let seen = "none";
export const App = $component(function* () {
  let input;
  const [text, setText] = yield* $signal("");
  const read = $event(function* () { setText(input.value.toUpperCase()); });
  return function* () {
    return (
      <div>
        <input ref={input} value="abc" />
        <button class="read" onClick={read}>read</button>
        <p class="out">{yield* text}</p>
        <span class="cb" ref={el => { seen = el.className; }}>cb</span>
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    { name: "the ref callback ran", run: ctx => ctx.observe("seen", ctx.app.seen) },
    step("read the input through its ref", ctx => ctx.click(".read")),
    step("edit and read again", ctx => {
      (document.querySelector("input") as HTMLInputElement).value = "xyz";
      ctx.click(".read");
    })
  ]
};

/**
 * Spread attributes: a component forwarding its props to an element
 * (`<button {...props}>`, every caller in the module) and an object-literal
 * spread are compiled as the attributes they stand for — a forwarded
 * handler, a live attribute, a caller that leaves attributes out, children.
 */
export const islandsSpread: Scenario = {
  name: "islands-spread",
  covers: [
    "props spread onto an element (handler, live attribute, children forwarded)",
    "a caller passing fewer attributes",
    "object-literal spread with a live value"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal } from "solid-js";
function Button(props) {
  return <button {...props} />;
}
export function App() {
  const [n, setN] = createSignal(0);
  return (
    <div>
      <Button class="inc" title={"n=" + n()} onClick={() => setN(x => x + 1)}>+</Button>
      <Button class="plain" disabled>static</Button>
      <p {...{ "data-n": n(), id: "out" }}>{n()}</p>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal } from "solid-js";
function Button(props) {
  return <button {...props} />;
}
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <div>
        <Button class="inc" title={"n=" + (yield* n)} onClick={inc}>+</Button>
        <Button class="plain" disabled>static</Button>
        <p {...{ "data-n": yield* n, id: "out" }}>{yield* n}</p>
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("inc", ctx => ctx.click(".inc")),
    step("click the plain button (no handler)", ctx => ctx.click(".plain")),
    step("inc again", ctx => ctx.click(".inc"))
  ]
};

/**
 * Live `Show` / `For` with fallbacks: the fallback is adopted when the server
 * rendered it (an element with a live hole, a string), built on the client
 * when the region empties again, and disposed when content arrives.
 */
export const islandsFallback: Scenario = {
  name: "islands-fallback",
  covers: [
    "a live For's fallback (adopted, removed, rebuilt) with a live hole",
    "a live Show's string fallback",
    "fresh rows and branches after the fallback"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal, For, Show } from "solid-js";
export function App() {
  const [items, setItems] = createSignal([]);
  const [open, setOpen] = createSignal(false);
  const [n, setN] = createSignal(0);
  return (
    <div>
      <ul>
        <For each={items()} fallback={<li class="empty">no items {n()}</li>}>{item => <li>{item}</li>}</For>
      </ul>
      <Show when={open()} fallback="closed">
        <p class="open">open {n()}</p>
      </Show>
      <button class="add" onClick={() => setItems(l => [...l, "x" + l.length])} />
      <button class="clear" onClick={() => setItems([])} />
      <button class="toggle" onClick={() => setOpen(o => !o)} />
      <button class="inc" onClick={() => setN(x => x + 1)} />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal, For, Show } from "solid-js";
export const App = $component(function* () {
  const [items, setItems] = yield* $signal([]);
  const [open, setOpen] = yield* $signal(false);
  const [n, setN] = yield* $signal(0);
  const add = $event(function* () { setItems(l => [...l, "x" + l.length]); });
  const clear = $event(function* () { setItems([]); });
  const toggle = $event(function* () { setOpen(o => !o); });
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <div>
        <ul>
          <For each={yield* items} fallback={<li class="empty">no items {yield* n}</li>}>{item => <li>{item}</li>}</For>
        </ul>
        <Show when={yield* open} fallback="closed">
          <p class="open">open {yield* n}</p>
        </Show>
        <button class="add" onClick={add} />
        <button class="clear" onClick={clear} />
        <button class="toggle" onClick={toggle} />
        <button class="inc" onClick={inc} />
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("inc (the adopted fallback's hole)", ctx => ctx.click(".inc")),
    step("add (the fallback leaves)", ctx => ctx.click(".add")),
    step("add again", ctx => ctx.click(".add")),
    step("clear (the fallback is built)", ctx => ctx.click(".clear")),
    step("inc (the built fallback's hole)", ctx => ctx.click(".inc")),
    step("open (the string fallback leaves)", ctx => ctx.click(".toggle")),
    step("inc (open content)", ctx => ctx.click(".inc")),
    step("close (the string fallback is built)", ctx => ctx.click(".toggle"))
  ]
};

/**
 * `<Loading>` inside a live region: rows the client creates put a client
 * pending boundary around content that reads the adopted async memo. A row
 * created while the memo is refetching shows its fallback until the value
 * lands; rows whose boundary already settled keep their content. A
 * `<Loading>` whose content cannot be pending on the client (the `Show`
 * branch) is pass-through.
 */
export const islandsLoadingRows: Scenario = {
  name: "islands-loading-rows",
  covers: [
    "a client pending boundary in rows the client creates",
    "a row created while its async source is pending shows the fallback",
    "settled boundaries keep their content during a refetch",
    "a Loading over content that cannot be pending is pass-through"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, createSignal, For, Loading, Show } from "solid-js";
import { h } from "conformance";
export function App() {
  const [ids, setIds] = createSignal([1]);
  const [v, setV] = createSignal(0);
  const [open, setOpen] = createSignal(false);
  const info = createMemo(() => {
    const x = v();
    return x === 0 ? Promise.resolve("v0") : h.task("load", x);
  });
  return (
    <div>
      <ul>
        <For each={ids()}>{id => <li><Loading fallback={<em>wait</em>}><b>{id}:{info()}</b></Loading></li>}</For>
      </ul>
      <Show when={open()}><section><Loading fallback={<em>never</em>}><p class="plain">plain {ids().length}</p></Loading></section></Show>
      <button class="add" onClick={() => setIds(l => [...l, l.length + 1])} />
      <button class="bump" onClick={() => setV(x => x + 1)} />
      <button class="open" onClick={() => setOpen(o => !o)} />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $memo, $signal, attempt, For, Loading, Show } from "solid-js";
import { h } from "conformance";
const Info = $component(function* (props) {
  return function* () {
    return <b>{props.id}:{yield* props.info}</b>;
  };
});
export const App = $component(function* () {
  const [ids, setIds] = yield* $signal([1]);
  const [v, setV] = yield* $signal(0);
  const [open, setOpen] = yield* $signal(false);
  const info = yield* $memo(function* () {
    const x = yield* v;
    return yield* attempt(() => (x === 0 ? Promise.resolve("v0") : h.task("load", x)));
  });
  const add = $event(function* () { setIds(l => [...l, l.length + 1]); });
  const bump = $event(function* () { setV(x => x + 1); });
  const toggle = $event(function* () { setOpen(o => !o); });
  return function* () {
    return (
      <div>
        <ul>
          <For each={yield* ids}>{id => <li><Loading fallback={<em>wait</em>}><Info id={id} info={info} /></Loading></li>}</For>
        </ul>
        <Show when={yield* open}><section><Loading fallback={<em>never</em>}><p class="plain">plain {(yield* ids).length}</p></Loading></section></Show>
        <button class="add" onClick={add} />
        <button class="bump" onClick={bump} />
        <button class="open" onClick={toggle} />
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
    step("add (a row over the settled value)", ctx => ctx.click(".add")),
    step("open (a pass-through Loading)", ctx => ctx.click(".open")),
    step("bump (refetch: settled rows keep their content)", ctx => ctx.click(".bump")),
    step("add while pending", ctx => ctx.click(".add")),
    {
      name: "resolve load#1",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("load#1", "v1");
        await settle();
        html();
      }
    },
    step("add after (a row over the new value)", ctx => ctx.click(".add"))
  ]
};

/**
 * Statements before a view's `return` that read no live state run where the
 * view first renders (the server; the activation of a row the client
 * creates): locals the markup reads, and a handler the island uses.
 */
export const islandsViewStatements: Scenario = {
  name: "islands-view-statements",
  covers: [
    "view statements computing locals the markup reads",
    "a handler declared in the view",
    "view statements of a row component the client creates"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal, For } from "solid-js";
function Row(props) {
  const text = "#" + props.item;
  return <li>{text}</li>;
}
export function App() {
  const [n, setN] = createSignal(0);
  const [items, setItems] = createSignal([1]);
  const title = "count";
  const step = 2;
  const label = title.toUpperCase() + ":";
  return (
    <div>
      <h1>{label}</h1>
      <button class="inc" onClick={() => setN(x => x + step)}>{n()}</button>
      <ul><For each={items()}>{item => <Row item={item} />}</For></ul>
      <button class="add" onClick={() => setItems(l => [...l, l.length + 1])} />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal, For } from "solid-js";
const Row = $component(function* (props) {
  return function* () {
    const text = "#" + props.item;
    return <li>{text}</li>;
  };
});
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const [items, setItems] = yield* $signal([1]);
  const add = $event(function* () { setItems(l => [...l, l.length + 1]); });
  return function* () {
    const title = "count";
    const step = 2;
    const label = title.toUpperCase() + ":";
    const bump = () => setN(x => x + step);
    return (
      <div>
        <h1>{label}</h1>
        <button class="inc" onClick={bump}>{yield* n}</button>
        <ul><For each={yield* items}>{item => <Row item={item} />}</For></ul>
        <button class="add" onClick={add} />
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("inc (the view's handler, its step)", ctx => ctx.click(".inc")),
    step("add (a row's view statements run on the client)", ctx => ctx.click(".add")),
    step("inc again", ctx => ctx.click(".inc"))
  ]
};

/**
 * A live `<Switch>`: one region showing the first `<Match>` whose `when`
 * holds — markup, a render callback (its `when` accessor), the fallback —
 * adopted at activation and rebuilt when the choice changes; an inert
 * `<Switch>` renders on the server only.
 */
export const islandsSwitch: Scenario = {
  name: "islands-switch",
  covers: [
    "a live Switch adopted and rebuilt across its Matches and fallback",
    "a Match render callback reading its when accessor",
    "a live hole inside a Match branch",
    "an inert Switch (server only)"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal, Match, Switch } from "solid-js";
const KIND = "b";
export function App() {
  const [n, setN] = createSignal(0);
  const [t, setT] = createSignal(0);
  return (
    <div>
      <Switch fallback={<p class="many">many {t()}</p>}>
        <Match when={n() === 0}><p class="zero">zero {t()}</p></Match>
        <Match when={n() === 1 && "one"}>{v => <p class="one">{v()}</p>}</Match>
      </Switch>
      <Switch><Match when={KIND === "a"}><i>a</i></Match><Match when={KIND === "b"}><b>b</b></Match></Switch>
      <button class="inc" onClick={() => setN(x => x + 1)} />
      <button class="zero" onClick={() => setN(0)} />
      <button class="tick" onClick={() => setT(x => x + 1)} />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal, Match, Switch } from "solid-js";
const KIND = "b";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const [t, setT] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  const zero = $event(function* () { setN(0); });
  const tick = $event(function* () { setT(x => x + 1); });
  return function* () {
    return (
      <div>
        <Switch fallback={<p class="many">many {yield* t}</p>}>
          <Match when={(yield* n) === 0}><p class="zero">zero {yield* t}</p></Match>
          <Match when={(yield* n) === 1 && "one"}>{v => <p class="one">{v()}</p>}</Match>
        </Switch>
        <Switch><Match when={KIND === "a"}><i>a</i></Match><Match when={KIND === "b"}><b>b</b></Match></Switch>
        <button class="inc" onClick={inc} />
        <button class="zero" onClick={zero} />
        <button class="tick" onClick={tick} />
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("tick (the adopted branch's hole)", ctx => ctx.click(".tick")),
    step("inc (the callback Match)", ctx => ctx.click(".inc")),
    step("tick", ctx => ctx.click(".tick")),
    step("inc (the fallback)", ctx => ctx.click(".inc")),
    step("inc (still the fallback)", ctx => ctx.click(".inc")),
    step("tick", ctx => ctx.click(".tick")),
    step("zero (the first Match again)", ctx => ctx.click(".zero"))
  ]
};

/**
 * `<For>` rows with an index: keyed rows get an index accessor that follows
 * the row when it moves; `keyed={false}` rows are by position, with an item
 * accessor and a number index (a fallback when empty).
 */
export const islandsForIndex: Scenario = {
  name: "islands-for-index",
  covers: [
    "keyed rows with an index accessor (moved, prepended, removed)",
    "keyed={false} rows by position with an item accessor",
    "a keyed={false} list's fallback"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal, For } from "solid-js";
export function App() {
  const [l, setL] = createSignal(["a", "b"]);
  return (
    <div>
      <ul class="k"><For each={l()}>{(item, i) => <li>{i()}:{item}</li>}</For></ul>
      <ul class="u"><For each={l()} keyed={false} fallback={<li>none</li>}>{(item, i) => <li>{i}={item()}</li>}</For></ul>
      <button class="pre" onClick={() => setL(x => ["z" + x.length, ...x])} />
      <button class="rev" onClick={() => setL(x => [...x].reverse())} />
      <button class="pop" onClick={() => setL(x => x.slice(0, -1))} />
      <button class="clear" onClick={() => setL([])} />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal, For } from "solid-js";
export const App = $component(function* () {
  const [l, setL] = yield* $signal(["a", "b"]);
  const pre = $event(function* () { setL(x => ["z" + x.length, ...x]); });
  const rev = $event(function* () { setL(x => [...x].reverse()); });
  const pop = $event(function* () { setL(x => x.slice(0, -1)); });
  const clear = $event(function* () { setL([]); });
  return function* () {
    return (
      <div>
        <ul class="k"><For each={yield* l}>{(item, i) => <li>{i()}:{item}</li>}</For></ul>
        <ul class="u"><For each={yield* l} keyed={false} fallback={<li>none</li>}>{(item, i) => <li>{i}={item()}</li>}</For></ul>
        <button class="pre" onClick={pre} />
        <button class="rev" onClick={rev} />
        <button class="pop" onClick={pop} />
        <button class="clear" onClick={clear} />
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("prepend (indexes shift)", ctx => ctx.click(".pre")),
    step("reverse (rows move)", ctx => ctx.click(".rev")),
    step("pop", ctx => ctx.click(".pop")),
    step("clear (the fallback)", ctx => ctx.click(".clear")),
    step("prepend (rows again)", ctx => ctx.click(".pre")),
    step("prepend", ctx => ctx.click(".pre"))
  ]
};

/**
 * SVG inside a live region: rows the client creates are parsed in the SVG
 * namespace, and their `class` is an attribute.
 */
export const islandsSvg: Scenario = {
  name: "islands-svg",
  covers: [
    "SVG rows of a live For created in the SVG namespace",
    "a dynamic class on an SVG element",
    "a live Show inside an <svg>"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal, For, Show } from "solid-js";
function Dot(props) {
  return <circle r="1" cx={props.p} class={props.hot} />;
}
export function App() {
  const [pts, setPts] = createSignal([1]);
  const [hot, setHot] = createSignal("a");
  const [on, setOn] = createSignal(false);
  return (
    <div>
      <svg viewBox="0 0 10 10">
        <For each={pts()}>{p => <Dot p={p} hot={hot()} />}</For>
        <Show when={on()}><g class="on"><rect width="1" height="1" /></g></Show>
      </svg>
      <button class="add" onClick={() => setPts(l => [...l, l.length + 1])} />
      <button class="heat" onClick={() => setHot(h => h + "a")} />
      <button class="on" onClick={() => setOn(o => !o)} />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal, For, Show } from "solid-js";
const Dot = $component(function* (props) {
  return function* () {
    return <circle r="1" cx={props.p} class={yield* props.hot} />;
  };
});
export const App = $component(function* () {
  const [pts, setPts] = yield* $signal([1]);
  const [hot, setHot] = yield* $signal("a");
  const [on, setOn] = yield* $signal(false);
  const add = $event(function* () { setPts(l => [...l, l.length + 1]); });
  const heat = $event(function* () { setHot(h => h + "a"); });
  const toggle = $event(function* () { setOn(o => !o); });
  return function* () {
    return (
      <div>
        <svg viewBox="0 0 10 10">
          <For each={yield* pts}>{p => <Dot p={p} hot={hot} />}</For>
          <Show when={yield* on}><g class="on"><rect width="1" height="1" /></g></Show>
        </svg>
        <button class="add" onClick={add} />
        <button class="heat" onClick={heat} />
        <button class="on" onClick={toggle} />
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("add (a circle the client creates)", ctx => ctx.click(".add")),
    step("heat (every circle's class)", ctx => ctx.click(".heat")),
    step("on (a <g> the client creates)", ctx => ctx.click(".on")),
    {
      name: "namespaces",
      run: ({ observe }) => {
        const ns = [...document.querySelectorAll("circle, g.on, rect")].map(n => n.namespaceURI);
        observe("namespaces", ns.join(" "));
      }
    }
  ]
};

/**
 * `<Dynamic>` over a statically known component: a string tag and a module
 * component compile as the element they name (live content inside).
 */
export const islandsDynamic: Scenario = {
  name: "islands-dynamic",
  covers: [
    "Dynamic with a string tag",
    "Dynamic with a module component, children with a live hole"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal } from "solid-js";
import { Dynamic } from "@solidjs/web";
function Card(props) {
  return <section class={"card " + props.tone}>{props.children}</section>;
}
export function App() {
  const [n, setN] = createSignal(0);
  return (
    <div>
      <Dynamic component="h2" class="t">title</Dynamic>
      <Dynamic component={Card} tone="warm"><button class="inc" onClick={() => setN(x => x + 1)}>{n()}</button></Dynamic>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal } from "solid-js";
import { Dynamic } from "@solidjs/web";
const Card = $component(function* (props) {
  return function* () {
    return <section class={"card " + props.tone}>{props.children}</section>;
  };
});
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <div>
        <Dynamic component="h2" class="t">title</Dynamic>
        <Dynamic component={Card} tone="warm"><button class="inc" onClick={inc}>{yield* n}</button></Dynamic>
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("inc", ctx => ctx.click(".inc")),
    step("inc", ctx => ctx.click(".inc"))
  ]
};

/**
 * `<Portal>`: the server renders nothing; the island builds its content at
 * load and appends it to its mount (`document.body`), with a live hole.
 */
export const islandsPortal: Scenario = {
  name: "islands-portal",
  covers: [
    "a Portal's content built on the client and mounted in document.body",
    "a live hole inside the Portal",
    "the Portal's content removed on dispose"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal } from "solid-js";
import { Portal } from "@solidjs/web";
export function App() {
  const [n, setN] = createSignal(0);
  return (
    <div>
      <button class="inc" onClick={() => setN(x => x + 1)}>inc</button>
      <Portal><p class="modal">count {n()}</p></Portal>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal } from "solid-js";
import { Portal } from "@solidjs/web";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <div>
        <button class="inc" onClick={inc}>inc</button>
        <Portal><p class="modal">count {yield* n}</p></Portal>
      </div>
    );
  };
});
`
  },
  steps: [
    {
      name: "initial",
      run: async ({ settle, html, observe }) => {
        await settle();
        html();
        observe("portal", document.querySelector(".modal")?.textContent ?? null);
      }
    },
    {
      name: "inc",
      run: ({ click, flush, observe }) => {
        click(".inc");
        flush();
        observe("portal", document.querySelector(".modal")?.textContent ?? null);
      }
    },
    {
      name: "dispose",
      run: ({ dispose, observe }) => {
        dispose();
        observe("portal", document.querySelector(".modal")?.textContent ?? null);
      }
    }
  ]
};

/**
 * Error routing for an island that would run at tier 0: an `<Errored>`
 * around its live content puts it on the core with a client error boundary,
 * so a throw in its hole shows the fallback (and a reset brings it back).
 */
export const islandsErroredTier0: Scenario = {
  name: "islands-errored-tier0",
  covers: [
    "a throw in a hole of a would-be tier-0 island reaches its Errored fallback",
    "reset recovers the content"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal, Errored } from "solid-js";
const check = n => { if (n > 1) throw new Error("too big"); return n; };
export function App() {
  const [n, setN] = createSignal(0);
  return (
    <main>
      <button class="inc" onClick={() => setN(x => x + 1)}>inc</button>
      <Errored
        fallback={(err, reset) => (
          <p class="err">
            {String(err())}
            <button class="reset" onClick={() => { setN(0); reset(); }}>reset</button>
          </p>
        )}
      >
        <span class="v">{check(n())}</span>
      </Errored>
    </main>
  );
}
`,
    islands: `
import { $component, $event, $signal, Errored } from "solid-js";
const check = n => { if (n > 1) throw new Error("too big"); return n; };
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <main>
        <button class="inc" onClick={inc}>inc</button>
        <Errored
          fallback={(err, reset) => (
            <p class="err">
              {String(err())}
              <button class="reset" onClick={() => { setN(0); reset(); }}>reset</button>
            </p>
          )}
        >
          <span class="v">{check(yield* n)}</span>
        </Errored>
      </main>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    step("inc (1)", ctx => ctx.click(".inc")),
    step("inc (2: the hole throws, the fallback shows)", ctx => ctx.click(".inc")),
    step("reset (the content comes back)", ctx => ctx.click(".reset")),
    step("inc (the content is live again)", ctx => ctx.click(".inc"))
  ]
};

export const islandsScenarios = [
  islandsList,
  islandsSharedMember,
  islandsSharedMemberReversed,
  islandsStream,
  islandsStore,
  islandsAsync,
  islandsOptimistic,
  islandsModules,
  islandsErrored,
  islandsErroredRows,
  islandsRef,
  islandsSpread,
  islandsFallback,
  islandsLoadingRows,
  islandsViewStatements,
  islandsSwitch,
  islandsForIndex,
  islandsSvg,
  islandsDynamic,
  islandsPortal,
  islandsErroredTier0
];
