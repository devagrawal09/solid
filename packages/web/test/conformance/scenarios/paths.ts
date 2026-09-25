/**
 * Store and prop path scenarios, plus JSX blocks returned from components.
 */
import { forModes } from "../harness/expect.js";
import type { Scenario } from "../harness/types.js";

const DIRECT_READ =
  "Error([DIRECT_READ_IN_BLOCK] Reading a signal directly inside a `$` block is not allowed. Every reactive read in a block must go through `yield* signal` so the block's type records it. (reading signal))";

export const storePaths: Scenario = {
  name: "store-paths",
  covers: [
    "store property paths",
    "store index paths",
    "array length",
    "structural selector (readStore)",
    "unrelated store writes do not rerun"
  ],
  entry: { root: "setup" },
  sources: {
    reference: `
import { createStore, createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setStore;
export function setup() {
  const [store, ss] = createStore({
    user: { name: "ada", age: 36 },
    items: [{ name: "a" }, { name: "b" }]
  });
  setStore = ss;
  const name = createMemo(() => {
    h.run("name");
    return store.user.name;
  });
  const second = createMemo(() => {
    h.run("second");
    return store.items[1].name;
  });
  const count = createMemo(() => {
    h.run("count");
    return store.items.length;
  });
  const names = createMemo(() => {
    h.run("names");
    return store.items.map(item => item.name).join(",");
  });
  createEffect(name, v => h.value("name", v));
  createEffect(second, v => h.value("second", v));
  createEffect(count, v => h.value("count", v));
  createEffect(names, v => h.value("names", v));
}
`,
    generator: `
import { $, createStore, createMemo, createEffect, readStore } from "solid-js";
import { h } from "conformance";
export let setStore;
export function setup() {
  const [store, ss] = createStore({
    user: { name: "ada", age: 36 },
    items: [{ name: "a" }, { name: "b" }]
  });
  setStore = ss;
  const name = createMemo(
    $(function* () {
      h.run("name");
      return yield* store.user.name;
    })
  );
  const second = createMemo(
    $(function* () {
      h.run("second");
      return yield* store.items[1].name;
    })
  );
  const count = createMemo(
    $(function* () {
      h.run("count");
      return yield* store.items.length;
    })
  );
  const names = createMemo(
    $(function* () {
      h.run("names");
      return yield* readStore(store, s => s.items.map(item => item.name).join(","));
    })
  );
  createEffect(name, v => h.value("name", v));
  createEffect(second, v => h.value("second", v));
  createEffect(count, v => h.value("count", v));
  createEffect(names, v => h.value("names", v));
}
`
  },
  steps: [
    {
      name: "unrelated write (user.age)",
      run: ({ app, flush }) => {
        app.setStore((s: any) => {
          s.user.age = 37;
        });
        flush();
      }
    },
    {
      name: "user.name",
      run: ({ app, flush }) => {
        app.setStore((s: any) => {
          s.user.name = "grace";
        });
        flush();
      }
    },
    {
      name: "items[0].name (not items[1])",
      run: ({ app, flush }) => {
        app.setStore((s: any) => {
          s.items[0].name = "A";
        });
        flush();
      }
    },
    {
      name: "push",
      run: ({ app, flush }) => {
        app.setStore((s: any) => {
          s.items.push({ name: "c" });
        });
        flush();
      }
    },
    {
      name: "items[1].name",
      run: ({ app, flush }) => {
        app.setStore((s: any) => {
          s.items[1].name = "B";
        });
        flush();
      }
    }
  ]
};

export const storeDynamicIndex: Scenario = {
  name: "store-dynamic-index",
  covers: ["dynamic index key", "index resubscription"],
  entry: { root: "setup" },
  sources: {
    reference: `
import { createStore, createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setStore, setIndex;
export function setup() {
  const [store, ss] = createStore({ items: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  const [index, si] = h.signal("index", 0);
  setStore = ss;
  setIndex = si;
  const picked = createMemo(() => {
    h.run("picked");
    const i = index();
    return store.items[i].name;
  });
  createEffect(picked, v => h.value("picked", v));
}
`,
    generator: `
import { $, createStore, createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setStore, setIndex;
export function setup() {
  const [store, ss] = createStore({ items: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  const [index, si] = h.signal("index", 0);
  setStore = ss;
  setIndex = si;
  const picked = createMemo(
    $(function* () {
      h.run("picked");
      const i = yield* index;
      return yield* store.items[i].name;
    })
  );
  createEffect(picked, v => h.value("picked", v));
}
`
  },
  steps: [
    {
      name: "move index to 2",
      run: ({ app, flush }) => {
        app.setIndex(2);
        flush();
      }
    },
    {
      name: "write old index (no rerun)",
      run: ({ app, flush }) => {
        app.setStore((s: any) => {
          s.items[0].name = "A";
        });
        flush();
      }
    },
    {
      name: "write new index",
      run: ({ app, flush }) => {
        app.setStore((s: any) => {
          s.items[2].name = "C";
        });
        flush();
      }
    }
  ]
};

export const propPaths: Scenario = {
  name: "prop-paths",
  covers: ["prop paths", "prop subscriptions through getters"],
  entry: { component: "App" },
  ssr: {},
  sources: {
    reference: `
import { createMemo } from "solid-js";
import { h } from "conformance";
export let setLabel, setOther;
function Child(props) {
  const shown = createMemo(() => {
    h.run("shown");
    return "[" + props.label + "]";
  });
  return <p class="child">{shown()}</p>;
}
export function App() {
  const [label, sl] = h.signal("label", "a");
  const [other, so] = h.signal("other", 0);
  setLabel = sl;
  setOther = so;
  return (
    <div>
      <Child label={label()} other={other()} />
    </div>
  );
}
`,
    generator: `
import { $, createMemo } from "solid-js";
import { h } from "conformance";
export let setLabel, setOther;
function Child(props) {
  const shown = createMemo(
    $(function* () {
      h.run("shown");
      return "[" + (yield* props.label) + "]";
    })
  );
  return <p class="child">{shown()}</p>;
}
export function App() {
  const [label, sl] = h.signal("label", "a");
  const [other, so] = h.signal("other", 0);
  setLabel = sl;
  setOther = so;
  return (
    <div>
      <Child label={label()} other={other()} />
    </div>
  );
}
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "unrelated prop",
      run: ({ app, flush, html }) => {
        app.setOther(1);
        flush();
        html();
      }
    },
    {
      name: "label",
      run: ({ app, flush, html }) => {
        app.setLabel("b");
        flush();
        html();
      }
    }
  ],
  modes: {
    ...forModes(
      {
        status: "differs",
        reason:
          "documented limit of the uncompiled driver (generator.ts module notes): props are plain getters, not proxies, so `yield* props.label` without lowering runs the getter's signal read under the strict guard and fails loudly with [DIRECT_READ_IN_BLOCK]",
        trace: [
          "## mount",
          "run shown",
          `read label ! ${DIRECT_READ}`,
          `console.error = [REACTIVITY_HALTED] An uncaught error halted the reactive system. No further updates will be processed. Handle errors with createErrorBoundary/<Errored> or treat this as a crash. ${DIRECT_READ}`,
          `uncaught mount = ${DIRECT_READ}`
        ]
      },
      { only: ["runtime"], environments: ["client"] }
    ),
    "server/runtime": {
      status: "differs",
      reason:
        "the same documented limit on the server: the server runtime has no strict read guard, so uncompiled `yield* props.label` delegates to the prop's string value and the driver refuses the yielded characters",
      trace: [
        "## render",
        "run shown",
        'read label = "a"',
        "uncaught render = TypeError([INVALID_YIELD] `$` blocks may only yield operations (`yield* signal`, `yield* wait(...)`, `yield* raise(...)`, `yield* attempt(...)`, `yield* write(...)`, `yield* call(...)`, `yield* block`); received a string)",
        "markup = ",
        "hydration-keys = []",
        "serialized = []"
      ]
    },
    "hydrate/runtime": {
      status: "not-applicable",
      reason: "server/runtime cannot render this scenario (see its declared difference)"
    }
  }
};

const JSX_BLOCK_ORACLE_SSR = [
  'markup = <main _hk=0><!--$--><p _hk=1 class="count">n=<!--$-->1<!--/--></p><!--/--><!--$--><b _hk=3 class="label">x</b><!--/--><span class="after">after</span><!--$--><b _hk=4 class="label">y</b><!--/--></main>',
  'hydration-keys = ["0","1","3","4"]'
];

const JSX_BLOCK_RUNTIME_SSR = [
  'markup = <main _hk=0><!--$--><p _hk=3 class="count">n=<!--$-->1<!--/--></p><!--/--><!--$--><b _hk=1 class="label">x</b><!--/--><span class="after">after</span><!--$--><b _hk=2 class="label">y</b><!--/--></main>',
  'hydration-keys = ["0","3","1","2"]'
];

const JSX_BLOCK_SCOPED_SSR = [
  'markup = <main _hk=0><!--$--><p _hk=10 class="count">n=<!--$-->1<!--/--></p><!--/--><!--$--><b _hk=2 class="label">x</b><!--/--><span class="after">after</span><!--$--><b _hk=3 class="label">y</b><!--/--></main>',
  'hydration-keys = ["0","10","2","3"]'
];

const JSX_BLOCK_ORACLE_HYDRATE = [
  'html = <main _hk="0"><!--$--><p _hk="1" class="count">n=<!--$-->1<!--/--></p><!--/--><!--$--><b _hk="3" class="label">x</b><!--/--><span class="after">after</span><!--$--><b _hk="4" class="label">y</b><!--/--></main>',
  'html = <main _hk="0"><!--$--><p _hk="1" class="count">n=<!--$-->2<!--/--></p><!--/--><!--$--><b _hk="3" class="label">x</b><!--/--><span class="after">after</span><!--$--><b _hk="4" class="label">y</b><!--/--></main>'
];

const JSX_BLOCK_SCOPED_HYDRATE = [
  'html = <main _hk="0"><!--$--><p _hk="10" class="count">n=<!--$-->1<!--/--></p><!--/--><!--$--><b _hk="2" class="label">x</b><!--/--><span class="after">after</span><!--$--><b _hk="3" class="label">y</b><!--/--></main>',
  'html = <main _hk="0"><!--$--><p _hk="10" class="count">n=<!--$-->2<!--/--></p><!--/--><!--$--><b _hk="2" class="label">x</b><!--/--><span class="after">after</span><!--$--><b _hk="3" class="label">y</b><!--/--></main>'
];

export const jsxBlock: Scenario = {
  name: "jsx-block",
  covers: ["JSX block returned from a component", "fine-grained JSX reads", "hydration-ID parity"],
  entry: { component: "App" },
  ssr: {},
  sources: {
    reference: `
import { h } from "conformance";
export let setCount;
function Counter() {
  const [count, sc] = h.signal("count", 1);
  setCount = sc;
  h.run("Counter");
  return (
    <p class="count">
      n={count()}
    </p>
  );
}
function Label(props) {
  return <b class="label">{props.text}</b>;
}
export function App() {
  return (
    <main>
      <Counter />
      <Label text="x" />
      <span class="after">after</span>
      <Label text="y" />
    </main>
  );
}
`,
    generator: `
import { $ } from "solid-js";
import { h } from "conformance";
export let setCount;
function Counter() {
  const [count, sc] = h.signal("count", 1);
  setCount = sc;
  return $(function* () {
    h.run("Counter");
    return (
      <p class="count">
        n={yield* count}
      </p>
    );
  });
}
function Label(props) {
  return <b class="label">{props.text}</b>;
}
export function App() {
  return (
    <main>
      <Counter />
      <Label text="x" />
      <span class="after">after</span>
      <Label text="y" />
    </main>
  );
}
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "update",
      run: ({ app, flush, html }) => {
        app.setCount(2);
        flush();
        html();
      }
    }
  ],
  modes: {
    ...forModes(
      {
        status: "differs",
        reason:
          "JSX `yield*` is a compiler-only spelling (generators-fixtures.test.js: a JSX yield is not a usable program without the pass): uncompiled, the child read is taken once per block run, so the whole block re-executes instead of a fine-grained insert",
        insert: [{ after: "write count = 2", lines: ["run Counter"] }]
      },
      { only: ["runtime"], environments: ["client"] }
    ),
    "server/runtime": {
      status: "differs",
      reason:
        "without the generator compiler, the server driver reads the accessor correctly but no creation-anchored blockScope is emitted; the deferred block therefore claims its element ID after its siblings",
      remove: JSX_BLOCK_ORACLE_SSR,
      insert: [{ after: "read count = 1", lines: JSX_BLOCK_RUNTIME_SSR }]
    },
    "hydrate/runtime": {
      status: "not-applicable",
      reason:
        "generators:false deliberately omits the compiler-emitted blockScope, so server/runtime's deferred ID layout has no matching hydration scope"
    },
    ...forModes(
      {
        status: "differs",
        reason:
          "blockScope reserves the block's source-order slot and allocates its JSX in that child namespace; the IDs intentionally differ from an ordinary component while matching the hydrating client",
        remove: JSX_BLOCK_ORACLE_SSR,
        insert: [{ after: "read count = 1", lines: JSX_BLOCK_SCOPED_SSR }]
      },
      { environments: ["server"], only: ["compiled", "fused"] }
    ),
    ...forModes(
      {
        status: "differs",
        reason:
          "hydration preserves the server's scoped block ID namespace, so the keyed HTML differs from an ordinary component while node reuse, reads and updates remain equivalent",
        remove: JSX_BLOCK_ORACLE_HYDRATE,
        insert: [
          { after: "## initial", lines: [JSX_BLOCK_SCOPED_HYDRATE[0]] },
          { after: "read count = 2", lines: [JSX_BLOCK_SCOPED_HYDRATE[1]] }
        ]
      },
      { environments: ["hydrate"], only: ["compiled", "fused"] }
    )
  }
};

export const pathScenarios: Scenario[] = [storePaths, storeDynamicIndex, propPaths, jsxBlock];
