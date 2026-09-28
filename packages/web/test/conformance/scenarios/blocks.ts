/**
 * Generator blocks v2 (documentation/plans/generator-blocks-v2.md): the same
 * program written as ordinary Solid (the oracle) and with `$component` /
 * `$memo` / `$effect` / `$event`. The `blocks` source runs twice — through
 * the Solid compiler (`client/blocks-compiled`) and through a generic JSX
 * transform with no Solid compiler (`client/blocks-uncompiled`) — so the
 * matrix measures feature equivalence of the uncompiled runtime against the
 * compiler, event by event.
 */
import { NotFound } from "../harness/trace.js";
import type { Scenario } from "../harness/types.js";

const click = (selector: string) => (ctx: { click(s: string): void; flush(): void }) => {
  ctx.click(selector);
  ctx.flush();
};

export const blocksCounter: Scenario = {
  name: "blocks-counter",
  covers: ["component setup runs once", "memo in setup", "view reads", "event reads and writes"],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo } from "solid-js";
import { h } from "conformance";
export function App() {
  h.run("setup");
  const [count, setCount] = h.signal("count", 1);
  const doubled = createMemo(() => {
    h.run("doubled");
    return count() * 2;
  });
  const inc = () => {
    h.run("inc");
    setCount(count() + 1);
  };
  return (
    <button class="inc" onClick={inc}>
      {count()}:{doubled()}
    </button>
  );
}
`,
    blocks: `
import { $component, $memo, $event } from "solid-js";
import { h } from "conformance";
export const App = $component(function* () {
  h.run("setup");
  const [count, setCount] = h.signal("count", 1);
  const doubled = yield* $memo(function* () {
    h.run("doubled");
    return (yield* count) * 2;
  });
  const inc = $event(function* () {
    h.run("inc");
    setCount((yield* count) + 1);
  });
  return function* () {
    return (
      <button class="inc" onClick={inc}>
        {yield* count}:{yield* doubled}
      </button>
    );
  };
});
`
  },
  modes: {
    "client/blocks-uncompiled": {
      status: "differs",
      reason:
        "Markup only: Solid's compiled template inserts a `<!---->` marker between adjacent text expressions; @solidjs/h appends text nodes without one. Every read, write and run is identical (the uncompiled view is one computation, so both reads of `count` re-run together, as in the compiled output here).",
      trace: [
        "## mount",
        "run setup",
        "run doubled",
        "read count = 1",
        "read count = 1",
        "## initial",
        'html = <button class="inc">1:2</button>',
        "## click",
        "run inc",
        "read count = 1",
        "write count = 2",
        "run doubled",
        "read count = 2",
        "read count = 2",
        'html = <button class="inc">2:4</button>',
        "## click again",
        "run inc",
        "read count = 2",
        "write count = 3",
        "run doubled",
        "read count = 3",
        "read count = 3",
        'html = <button class="inc">3:6</button>',
        "## teardown"
      ]
    }
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "click",
      run: ctx => {
        click(".inc")(ctx);
        ctx.html();
      }
    },
    {
      name: "click again",
      run: ctx => {
        click(".inc")(ctx);
        ctx.html();
      }
    }
  ]
};

export const blocksEffect: Scenario = {
  name: "blocks-effect",
  covers: [
    "effect reads and writes",
    "effect cleanup per run and on dispose",
    "branch reads in an effect",
    "effect split (compute / effect halves)"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createEffect } from "solid-js";
import { h } from "conformance";
export let setA, setFlag, setC;
export function App() {
  const [a, sa] = h.signal("a", 1);
  const [flag, sf] = h.signal("flag", false);
  const [b, sb] = h.signal("b", 0);
  const [c, sc] = h.signal("c", 100);
  setA = sa;
  setFlag = sf;
  setC = sc;
  createEffect(
    () => {
      const v = a();
      return [v, flag(), v > 1 ? c() : undefined];
    },
    ([v, f, cv]) => {
      h.run("effect");
      sb(v * 10);
      if (f) h.value("a", v);
      if (v > 1) h.value("c", cv);
      return () => h.log("cleanup", "effect " + v);
    }
  );
  return <p class="b">{b()}</p>;
}
`,
    blocks: `
import { $component, $effect, $cleanup } from "solid-js";
import { h } from "conformance";
export let setA, setFlag, setC;
export const App = $component(function* () {
  const [a, sa] = h.signal("a", 1);
  const [flag, sf] = h.signal("flag", false);
  const [b, sb] = h.signal("b", 0);
  const [c, sc] = h.signal("c", 100);
  setA = sa;
  setFlag = sf;
  setC = sc;
  yield* $effect(function* () {
    const v = yield* a;
    const f = yield* flag;
    h.run("effect");
    sb(v * 10);
    if (f) h.value("a", v);
    if (v > 1) h.value("c", yield* c);
    yield* $cleanup(() => h.log("cleanup", "effect " + v));
  });
  return function* () {
    return <p class="b">{yield* b}</p>;
  };
});
`
  },
  modes: {
    "client/blocks-uncompiled": {
      status: "differs",
      reason:
        "Uncompiled `$effect` runs as one tracked pass (no split): on a re-run the previous cleanup runs before the new reads (not after), the branch read of `c` happens inside the effect body after the write of `b`, and the first run reads after the view's first render. Same subscriptions, values, runs and cleanups; different ordering.",
      trace: [
        "## mount",
        "read b = 0",
        "read a = 1",
        "read flag = false",
        "run effect",
        "write b = 10",
        "read b = 10",
        "## initial",
        'html = <p class="b">10</p>',
        "## write a = 2 (branch read of c starts)",
        "write a = 2",
        "cleanup effect 1",
        "read a = 2",
        "read flag = false",
        "run effect",
        "write b = 20",
        "read c = 100",
        "value c = 100",
        "read b = 20",
        'html = <p class="b">20</p>',
        "## write flag = true",
        "write flag = true",
        "cleanup effect 2",
        "read a = 2",
        "read flag = true",
        "run effect",
        "write b = 20",
        "value a = 2",
        "read c = 100",
        "value c = 100",
        "## write c = 200",
        "write c = 200",
        "cleanup effect 2",
        "read a = 2",
        "read flag = true",
        "run effect",
        "write b = 20",
        "value a = 2",
        "read c = 200",
        "value c = 200",
        "## dispose",
        "cleanup effect 2"
      ]
    }
  },
  steps: [
    { name: "initial", run: ({ flush, html }) => (flush(), html()) },
    {
      name: "write a = 2 (branch read of c starts)",
      run: ({ app, flush, html }) => {
        app.setA(2);
        flush();
        html();
      }
    },
    {
      name: "write flag = true",
      run: ({ app, flush }) => {
        app.setFlag(true);
        flush();
      }
    },
    {
      name: "write c = 200",
      run: ({ app, flush }) => {
        app.setC(200);
        flush();
      }
    },
    { name: "dispose", run: ({ dispose }) => dispose() }
  ]
};

export const blocksPropsChild: Scenario = {
  name: "blocks-props-child",
  covers: [
    "props forwarded as a source",
    "child setup runs once",
    "parent re-render does not re-create the child"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { h } from "conformance";
export let setLabel, setOther;
function Child(props) {
  h.run("child setup");
  return <span class="child">{props.label()}</span>;
}
export function App() {
  h.run("app setup");
  const [label, sl] = h.signal("label", "a");
  const [other, so] = h.signal("other", 0);
  setLabel = sl;
  setOther = so;
  return (
    <div>
      <Child label={label} />
      <i>{other()}</i>
    </div>
  );
}
`,
    blocks: `
import { $component } from "solid-js";
import { h } from "conformance";
export let setLabel, setOther;
const Child = $component(function* (props) {
  h.run("child setup");
  return function* () {
    return <span class="child">{yield* props.label}</span>;
  };
});
export const App = $component(function* () {
  h.run("app setup");
  const [label, sl] = h.signal("label", "a");
  const [other, so] = h.signal("other", 0);
  setLabel = sl;
  setOther = so;
  return function* () {
    return (
      <div>
        <Child label={label} />
        <i>{yield* other}</i>
      </div>
    );
  };
});
`
  },
  modes: {
    "client/blocks-uncompiled": {
      status: "differs",
      reason:
        "Uncompiled granularity: the parent view is one computation (a generic JSX transform cannot make each `yield*` its own effect), so its first read happens before the child is created and a write of `other` re-runs the whole parent view, which re-creates `Child` (its setup runs again). The child's own prop read stays fine-grained. Follow-up: reconcile component calls by position across view re-runs.",
      trace: [
        "## mount",
        "run app setup",
        "read other = 0",
        "run child setup",
        'read label = "a"',
        "## initial",
        'html = <div><span class="child">a</span><i>0</i></div>',
        "## write label (child re-renders)",
        'write label = "b"',
        'read label = "b"',
        'html = <div><span class="child">b</span><i>0</i></div>',
        "## write other (parent re-renders)",
        "write other = 1",
        "read other = 1",
        "run child setup",
        'read label = "b"',
        'html = <div><span class="child">b</span><i>1</i></div>',
        "## teardown"
      ]
    }
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "write label (child re-renders)",
      run: ({ app, flush, html }) => {
        app.setLabel("b");
        flush();
        html();
      }
    },
    {
      name: "write other (parent re-renders)",
      run: ({ app, flush, html }) => {
        app.setOther(1);
        flush();
        html();
      }
    }
  ]
};

const asyncReference = `
import { createMemo, Loading, Errored } from "solid-js";
import { h } from "conformance";
function User(props) {
  const user = createMemo(() => h.task("load", props.id));
  return <h3 class="user">{user().name}</h3>;
}
export function App() {
  return (
    <main>
      <Errored
        fallback={err => {
          h.caught("errored", err());
          return <p class="err">error</p>;
        }}
      >
        <Loading fallback={<p class="loading">loading</p>}>
          <User id="1" />
        </Loading>
      </Errored>
    </main>
  );
}
`;
const asyncBlocks = `
import { $component, $memo, attempt, Loading, Errored } from "solid-js";
import { h, NotFound } from "conformance";
const User = $component(function* (props) {
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    return yield* attempt(() => h.task("load", id), NotFound);
  });
  return function* () {
    return <h3 class="user">{(yield* user).name}</h3>;
  };
});
export const App = $component(function* () {
  return function* () {
    return (
      <main>
        {Errored({
          fallback: err => {
            h.caught("errored", err());
            return <p class="err">error</p>;
          },
          children: Loading({ fallback: <p class="loading">loading</p>, children: User({ id: "1" }) })
        })}
      </main>
    );
  };
});
`;

export const blocksAsyncResolve: Scenario = {
  name: "blocks-async-resolve",
  covers: ["async memo under Loading", "Loading / Errored call forms", "boundary nesting"],
  entry: { component: "App" },
  sources: { reference: asyncReference, blocks: asyncBlocks },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "resolve",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("load#1", { name: "Ada" });
        await settle();
        html();
      }
    }
  ]
};

export const blocksAsyncReject: Scenario = {
  name: "blocks-async-reject",
  covers: ["async failure reaches Errored through Loading", "typed failure"],
  entry: { component: "App" },
  sources: { reference: asyncReference, blocks: asyncBlocks },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "reject",
      run: async ({ tasks, settle, html }) => {
        tasks.reject("load#1", new NotFound("user 1"));
        await settle();
        html();
      }
    }
  ]
};

export const blocksContext: Scenario = {
  name: "blocks-context",
  covers: ["yield* Ctx in setup"],
  entry: { component: "App" },
  sources: {
    reference: `
import { createContext, useContext } from "solid-js";
import { h } from "conformance";
const Theme = createContext("light");
function Child() {
  const theme = useContext(Theme);
  h.value("theme", theme);
  return <b class="theme">{theme}</b>;
}
export function App() {
  return (
    <Theme value="dark">
      <Child />
    </Theme>
  );
}
`,
    blocks: `
import { $component, createContext } from "solid-js";
import { h } from "conformance";
const Theme = createContext("light");
const Child = $component(function* () {
  const theme = yield* Theme;
  h.value("theme", theme);
  return function* () {
    return <b class="theme">{theme}</b>;
  };
});
export function App() {
  return (
    <Theme value="dark">
      <Child />
    </Theme>
  );
}
`
  },
  steps: [{ name: "initial", run: ({ html }) => html() }]
};

export const blocksScenarios: Scenario[] = [
  blocksCounter,
  blocksEffect,
  blocksPropsChild,
  blocksAsyncResolve,
  blocksAsyncReject,
  blocksContext
];
