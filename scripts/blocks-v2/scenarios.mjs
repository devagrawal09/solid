// Generator blocks v2 benchmark scenarios (documentation/plans/blocks-v2-performance.md).
//
// Every scenario is one program written three ways:
//
//   handwritten  plain Solid: createSignal / createMemo / createEffect, plain
//                components, `{x()}` JSX holes
//   v2           generator blocks v2: $component / $memo / $effect / $event,
//                `{yield* x}` JSX holes — compiled by the native compiler
//                (default lowering, or with `hostFusion`)
//   uncompiled   the same v2 program as it must be written WITHOUT the
//                compiler's generator pass (a `yield*` cannot sit inside a
//                JSX hole, so a view reads into a `const` first — or passes
//                a bare accessor, which keeps hole granularity), run on the
//                runtime generator driver (`generators: false`)
//
// Only JSX is compiled for `handwritten` and `uncompiled`. JSX output targets
// `scripts/blocks-v2/fake-web.mjs` (a jsdom-free stand-in for `@solidjs/web`),
// so what is measured is the reactive and block machinery.
//
// Module shape: `make(n)` → `{ mount(), update(), unmount(), snapshot() }`.
// `update()` performs one operation (a write + flush, a dispatch round, an
// async settle) and may return a promise.

const WEB = `import { insert, createComponent, resetListeners, dispatchAll, snapshot } from "@solidjs/web";`;
const H = `import { createSignal, createMemo, createEffect, createRoot, createStore, flush, onCleanup } from "@solidjs/signals";\n${WEB}`;
const V = `import { $component, $memo, $effect, $event, $signal, $cleanup, attempt, createSignal, createStore, createRoot, flush } from "@solidjs/signals";\n${WEB}`;

/** The shared shell: n `Item`s rendered as one list; `update` is the scenario's op. */
function shell(header, { state = "", components, update, props = `{ id: i, label: "l" + i }` }) {
  return `${header}
export function make(n) {
  const sink = { v: 0, c: 0 };
  ${state}
  ${components}
  const App = () => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(createComponent(Item, ${props}));
    return out;
  };
  const container = { v: null };
  let dispose, r = 0;
  return {
    mount() {
      dispose = createRoot(d => { insert(container, App()); return d; });
      flush();
    },
    update() { ${update} },
    unmount() { dispose(); resetListeners(); },
    snapshot() { return snapshot(container) + "#" + sink.v + "/" + sink.c; }
  };
}`;
}

function scenario(name, description, modes, parts) {
  const { state, update, props } = parts;
  const common = { state, update, props };
  return {
    name,
    description,
    modes,
    filename: `${name}.jsx`,
    handwritten: shell(H, { ...common, components: parts.handwritten }),
    v2: shell(V, { ...common, components: parts.v2 }),
    uncompiled: shell(V, { ...common, components: parts.uncompiled ?? parts.v2 })
  };
}

export const SCENARIOS = [
  scenario(
    "memo",
    "n components each owning a memo of a shared signal, shown in one JSX hole; update: write the signal (n memo recomputes + n hole updates)",
    ["update"],
    {
      state: `const [src, setSrc] = createSignal(0);`,
      update: `setSrc(++r); flush();`,
      handwritten: `function Item() {
    const d = createMemo(() => src() * 2);
    return <i>{d()}</i>;
  }`,
      v2: `const Item = $component(function* () {
    const d = yield* $memo(function* () { return (yield* src) * 2; });
    return function* () { return <i>{yield* d}</i>; };
  });`,
      uncompiled: `const Item = $component(function* () {
    const d = yield* $memo(function* () { return (yield* src) * 2; });
    return function* () { return <i>{d}</i>; };
  });`
    }
  ),
  scenario(
    "create",
    "mount + unmount n components, each: a signal, a memo, an event handler, a view with two holes (the memo, a prop)",
    ["mount"],
    {
      update: `flush();`,
      handwritten: `function Item(props) {
    const [c, setC] = createSignal(0);
    const d = createMemo(() => c() * 2);
    const inc = () => setC(c() + 1);
    return <p onClick={inc}>{d()}{props.label}</p>;
  }`,
      v2: `const Item = $component(function* (props) {
    const [c, setC] = yield* $signal(0);
    const d = yield* $memo(function* () { return (yield* c) * 2; });
    const inc = $event(function* () { yield* setC((yield* c) + 1); });
    return function* () { return <p onClick={inc}>{yield* d}{yield* props.label}</p>; };
  });`,
      uncompiled: `const Item = $component(function* (props) {
    const [c, setC] = yield* $signal(0);
    const d = yield* $memo(function* () { return (yield* c) * 2; });
    const inc = $event(function* () { yield* setC((yield* c) + 1); });
    return function* () { const label = yield* props.label; return <p onClick={inc}>{d}{label}</p>; };
  });`
    }
  ),
  scenario(
    "view",
    "n views whose body reads a shared signal outside any hole; update: write it (n whole-view re-runs, each building a fresh node)",
    ["update"],
    {
      state: `const [sel, setSel] = createSignal(0);`,
      update: `setSel(++r); flush();`,
      handwritten: `function Item(props) {
    return () => { const s = sel(); return <i>{s}</i>; };
  }`,
      v2: `const Item = $component(function* () {
    return function* () { const s = yield* sel; return <i>{s}</i>; };
  });`
    }
  ),
  scenario(
    "holes",
    "n views with three JSX holes reading a shared signal; update: write it (3n hole updates)",
    ["update"],
    {
      state: `const [src, setSrc] = createSignal(0);`,
      update: `setSrc(++r); flush();`,
      handwritten: `function Item() {
    return <p>{src()}{src()}{src()}</p>;
  }`,
      v2: `const Item = $component(function* () {
    return function* () { return <p>{yield* src}{yield* src}{yield* src}</p>; };
  });`,
      uncompiled: `const Item = $component(function* () {
    return function* () { return <p>{src}{src}{src}</p>; };
  });`
    }
  ),
  scenario(
    "event",
    "n components with a click handler that reads and increments its own signal (shown in a hole); update: dispatch to all n handlers, then flush",
    ["update"],
    {
      update: `dispatchAll(); flush();`,
      handwritten: `function Item() {
    const [c, setC] = createSignal(0);
    const inc = () => setC(c() + 1);
    return <p onClick={inc}>{c()}</p>;
  }`,
      v2: `const Item = $component(function* () {
    const [c, setC] = yield* $signal(0);
    const inc = $event(function* () { yield* setC((yield* c) + 1); });
    return function* () { return <p onClick={inc}>{yield* c}</p>; };
  });`,
      uncompiled: `const Item = $component(function* () {
    const [c, setC] = yield* $signal(0);
    const inc = $event(function* () { yield* setC((yield* c) + 1); });
    return function* () { return <p onClick={inc}>{c}</p>; };
  });`
    }
  ),
  scenario(
    "effect",
    "n components each with an effect reading a shared signal and a prop, writing a sink and registering a cleanup; update: write the signal (n effect runs + n cleanups)",
    ["update"],
    {
      state: `const [src, setSrc] = createSignal(0);`,
      update: `setSrc(++r); flush();`,
      handwritten: `function Item(props) {
    createEffect(() => [src(), props.id], ([v, id]) => {
      sink.v += v + id;
      return () => { sink.c++; };
    });
    return <i />;
  }`,
      v2: `const Item = $component(function* (props) {
    yield* $effect(function* () {
      const v = yield* src;
      const id = yield* props.id;
      sink.v += v + id;
      yield* $cleanup(() => { sink.c++; });
    });
    return function* () { return <i />; };
  });`
    }
  ),
  scenario(
    "paths",
    "n rows reading two store fields through a prop (`props.item.label`, `props.item.done`); update: toggle every row's `done` (n path-read hole updates)",
    ["update"],
    {
      state: `const [store, setStore] = createStore({ items: Array.from({ length: n }, (_, i) => ({ label: "l" + i, done: false })) });`,
      props: `{ get item() { return store.items[i]; } }`,
      update: `const on = (++r & 1) === 1; setStore(s => { for (let i = 0; i < n; i++) s.items[i].done = on; }); flush();`,
      handwritten: `function Item(props) {
    return <li>{props.item.label}{props.item.done ? "y" : "n"}</li>;
  }`,
      v2: `const Item = $component(function* (props) {
    return function* () { return <li>{yield* props.item.label}{(yield* props.item.done) ? "y" : "n"}</li>; };
  });`,
      uncompiled: `const Item = $component(function* (props) {
    return function* () {
      const label = yield* props.item.label;
      const done = yield* props.item.done;
      return <li>{label}{done ? "y" : "n"}</li>;
    };
  });`
    }
  ),
  scenario(
    "async",
    "n async memos (read a shared signal, then resolve a promise) shown in holes; update: write the signal, flush, let every memo settle, flush",
    ["update"],
    {
      state: `const [src, setSrc] = createSignal(0);`,
      update: `setSrc(++r); flush(); return new Promise(res => setTimeout(res, 0)).then(() => flush());`,
      handwritten: `function Item() {
    const d = createMemo(() => { const v = src(); return Promise.resolve(v * 2); });
    return <i>{d()}</i>;
  }`,
      v2: `const Item = $component(function* () {
    const d = yield* $memo(function* () {
      const v = yield* src;
      return yield* attempt(() => Promise.resolve(v * 2));
    });
    return function* () { return <i>{yield* d}</i>; };
  });`,
      uncompiled: `const Item = $component(function* () {
    const d = yield* $memo(function* () {
      const v = yield* src;
      return yield* attempt(() => Promise.resolve(v * 2));
    });
    return function* () { return <i>{d}</i>; };
  });`
    }
  )
];

/** Variant → (source, compiler options). */
export const VARIANTS = {
  handwritten: { source: "handwritten", options: {} },
  compiled: { source: "v2", options: {} },
  fused: { source: "v2", options: { hostFusion: true } },
  uncompiled: { source: "uncompiled", options: { generators: false } }
};
