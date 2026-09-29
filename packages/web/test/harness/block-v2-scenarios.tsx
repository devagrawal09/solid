/**
 * @jsxImportSource @solidjs/web
 *
 * Hydration-parity scenarios for generator blocks v2 (`$component`), the
 * shapes of examples/todos-blocks and the v2 HackerNews story page
 * (scripts/ssr-redesign/apps/hn-blocks). Consumed through
 * test/harness/scenarios.tsx by both harness halves, like block-scenarios.
 *
 * - v2-view-then-boundary: a `$component` whose view is plain DOM, followed
 *   by a sibling `<Loading>` (todos-blocks' `<Header />` then `<Loading>`).
 *   The view (`$(fn, BLOCK_SYNC)`) was not id-scoped: the server resolved it
 *   at `ssr()` time, after `Loading` had taken the next slot, while the client
 *   rendered it first (104 key misses in todos-blocks).
 * - v2-view-returns-loading: a view whose root is `<Loading>` over a
 *   component with an async `$memo` + `attempt` (the HN story page). The
 *   deferred boundary took one id level less on the server than on the
 *   client, so every key under it missed and the client re-ran the fetch
 *   instead of adopting the serialized value (the `isServer` probe flips the
 *   text if it re-runs). Streamed, the view returning the boundary also
 *   re-rendered on every settle when it was the hydration root: the root
 *   insert rendered the view in its inner unwrapping effect, which the
 *   settling boundary re-runs — a fresh boundary and fetch each time.
 * - v2-forwarded-children: `{props.children}` forwarded into a view without
 *   `yield*` (the HN Toggle) under `<Show>`: the server resolved the prop
 *   read's proxy as a template object (the boundary then handed the page to
 *   the client as "client-only content"), and a component called inside a
 *   server memo was deferred on the server only.
 * - v2-helpers: helper generators (blocks-v2-performance.md section 11) —
 *   a setup helper that reads context through a nested helper and creates a
 *   signal and a memo, and a read helper called from a memo and from the
 *   view. Compiled, every helper is a plain function on both sides, the
 *   setup and the memos lose their blocks, and hydration ids still agree.
 * - v2-static-*: static views (`BLOCK_STATIC`, blocks-v2-performance.md
 *   section 12). `insert` renders a view proven static once, untracked, while
 *   hydrating too; its ids come from its `blockScope` alone, so the server
 *   and the client must agree without the render effect it used to get:
 *   static views nested, as siblings (mixed with a re-running view), under
 *   `<Loading>` beside an async sibling, under `<Show>` and `<For>`, and with
 *   components (plain, `$component` with a re-running view, a `<Show>`)
 *   inside.
 */
// @ts-nocheck
import {
  $,
  $component,
  $memo,
  $signal,
  $cleanup,
  attempt,
  createContext,
  onSettled,
  createSignal,
  For,
  Loading,
  Show,
  type TypedProps
} from "solid-js";
import { isServer } from "@solidjs/web";
import type { Scenario } from "./scenarios.jsx";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// V1. A plain-DOM view, then a boundary sibling.
const V2Header = $component(function* () {
  return function* () {
    return (
      <header>
        <h1>todos</h1>
      </header>
    );
  };
});
const V2Count = $component(function* (props: TypedProps<{ n: number }>) {
  return function* () {
    return <b>{yield* props.n}</b>;
  };
});
let setV2Count!: (v: number) => void;
function V2ViewThenBoundary() {
  const [n, set] = createSignal(1);
  setV2Count = set;
  return (
    <section>
      <V2Header />
      <Loading fallback={<p>loading</p>}>
        <V2Count n={n} />
      </Loading>
      <span>tail</span>
    </section>
  );
}

// ---------------------------------------------------------------------------
// V2. A view returning `<Loading>` over an async `$memo`.
const V2Row = $component(function* (props: TypedProps<{ row: { id: number; text: string } }>) {
  return function* () {
    return <li>{yield* props.row.text}</li>;
  };
});
const V2Story = $component(function* () {
  const story = yield* $memo(function* () {
    return yield* attempt(async () => {
      await sleep(5);
      return {
        title: isServer ? "fromServer" : "fromClient",
        rows: [
          { id: 1, text: "r1" },
          { id: 2, text: "r2" }
        ]
      };
    });
  });
  return function* () {
    return (
      <div>
        <h2>{(yield* story).title}</h2>
        <ul>
          <For each={(yield* story).rows}>{row => <V2Row row={row} />}</For>
        </ul>
      </div>
    );
  };
});
const V2Page = $component(function* () {
  return function* () {
    return (
      <Loading fallback={<p>loading</p>}>
        <V2Story />
      </Loading>
    );
  };
});
// The same boundary returned by a `$` block at the hydration root.
function BlockRootLoading() {
  return $(function* () {
    return (
      <Loading fallback={<p>loading</p>}>
        <V2Story />
      </Loading>
    );
  });
}
function V2ViewReturnsLoading() {
  return <V2Page />;
}

// ---------------------------------------------------------------------------
// V3. `{props.children}` forwarded into a view, under `<Show>`.
let setV2Open!: (v: boolean) => void;
const V2Toggle = $component(function* (props: TypedProps<{ children: any }>) {
  const [open, setOpen] = yield* $signal(true);
  setV2Open = setOpen;
  return function* () {
    return (
      <div class={{ open: yield* open }}>
        <ul>{props.children}</ul>
      </div>
    );
  };
});
const V2Comment = $component(function* (props: TypedProps<{ c: { by: string; kids: string[] } }>) {
  return function* () {
    return (
      <li>
        <b>{yield* props.c.by}</b>
        <Show when={(yield* props.c.kids).length}>
          <V2Toggle>
            <For each={yield* props.c.kids}>{k => <i>{k}</i>}</For>
          </V2Toggle>
        </Show>
      </li>
    );
  };
});
function V2ForwardedChildren() {
  return (
    <ol>
      <V2Comment c={{ by: "ann", kids: ["k1", "k2"] }} />
      <V2Comment c={{ by: "bob", kids: [] }} />
    </ol>
  );
}

// ---------------------------------------------------------------------------
// V4. Helper generators.
const V2Theme = createContext("plain");
function* useV2Theme() {
  return yield* V2Theme;
}
let setV2Base!: (v: number) => void;
function* useV2Counter(start: number) {
  const theme = yield* useV2Theme();
  const [n, setN] = yield* $signal(start);
  const doubled = yield* $memo(function* () {
    return (yield* n) * 2;
  });
  setV2Base = setN;
  return { theme, doubled };
}
const [v2Suffix, setV2Suffix] = createSignal("!");
function* v2SuffixText() {
  return yield* v2Suffix;
}
const V2Helpers = $component(function* () {
  const counter = yield* useV2Counter(1);
  const label = yield* $memo(function* () {
    return `${yield* counter.doubled}${yield* v2SuffixText()}`;
  });
  return function* () {
    return (
      <p>
        <b>{counter.theme}</b>
        <i>{yield* label}</i>
        <u>{yield* v2SuffixText()}</u>
      </p>
    );
  };
});
function V2HelpersApp() {
  return (
    <V2Theme value="dark">
      <V2Helpers />
    </V2Theme>
  );
}

// ---------------------------------------------------------------------------
// V5. A run-once effect block (`onSettled(function* …)`) in a component body,
// after a `$component` sibling (todos-blocks' `createHashFilter`). The client
// lowers the body to a plain `onSettled(fn)`; it must still run once the
// hydrated graph settles.
function V2SettledProbe() {
  const [state, setState] = createSignal("pending");
  onSettled(function* () {
    setState("ran");
    yield* $cleanup(() => {});
  });
  return <p>{state()}</p>;
}
function V2SettledAfterComponent() {
  return (
    <main>
      <V2Header />
      <V2SettledProbe />
    </main>
  );
}

// ---------------------------------------------------------------------------
// V6. Static views under hydration (`BLOCK_STATIC`).
const StLeaf = $component(function* (props: TypedProps<{ label: string }>) {
  return function* () {
    return <em>{yield* props.label}</em>;
  };
});
const StInner = $component(function* () {
  return function* () {
    return (
      <span>
        in
        <StLeaf label="leaf" />
      </span>
    );
  };
});
const [stOuterText, setStOuterText] = createSignal("x");
const StOuter = $component(function* (props: TypedProps<{ text: string }>) {
  return function* () {
    return (
      <div>
        <StInner />
        <p>{yield* props.text}</p>
        <StInner />
      </div>
    );
  };
});
function V2StaticNested() {
  return <StOuter text={stOuterText()} />;
}

// A view with a top-level read (not static): it keeps its render effect.
const StDynamic = $component(function* (props: TypedProps<{ mode: string }>) {
  return function* () {
    const mode = yield* props.mode;
    return mode === "a" ? <b>A</b> : <i>B</i>;
  };
});
const [stMode, setStMode] = createSignal("a");
function V2StaticSiblings() {
  return (
    <section>
      <StLeaf label="1" />
      <StInner />
      <StDynamic mode={stMode()} />
      t
      <StLeaf label="2" />
      <StOuter text="o" />
    </section>
  );
}

const StAsync = $component(function* () {
  const value = yield* $memo(function* () {
    return yield* attempt(async () => {
      await sleep(5);
      return isServer ? "srv" : "cli";
    });
  });
  return function* () {
    return <strong>{yield* value}</strong>;
  };
});
function V2StaticUnderLoading() {
  return (
    <main>
      <StLeaf label="h" />
      <Loading fallback={<p>loading</p>}>
        <StInner />
        <StAsync />
        <StLeaf label="z" />
      </Loading>
      <StLeaf label="t" />
    </main>
  );
}

const [stShow, setStShow] = createSignal(true);
function V2StaticUnderShow() {
  return (
    <article>
      <h3>s</h3>
      <Show when={stShow()} fallback={<StLeaf label="off" />}>
        <StInner />
        <StLeaf label="on" />
      </Show>
      <footer>f</footer>
    </article>
  );
}

const [stItems, setStItems] = createSignal(["a", "b"]);
const StRow = $component(function* (props: TypedProps<{ item: string }>) {
  return function* () {
    return (
      <li>
        <StLeaf label={yield* props.item} />
        <StInner />
      </li>
    );
  };
});
function V2StaticUnderFor() {
  return (
    <ul>
      <For each={stItems()}>{item => <StRow item={item} />}</For>
    </ul>
  );
}

function StPlain(props: { n: string }) {
  return <kbd>{props.n}</kbd>;
}
const [stInnerShow, setStInnerShow] = createSignal(true);
const [stHostMode, setStHostMode] = createSignal("a");
const StHost = $component(function* () {
  return function* () {
    return (
      <div>
        <StPlain n="p" />
        <StDynamic mode={stHostMode()} />
        <Show when={stInnerShow()}>
          <StLeaf label="s" />
        </Show>
        <For each={["f1", "f2"]}>{f => <StPlain n={f} />}</For>
        <StInner />
      </div>
    );
  };
});
function V2StaticWithComponents() {
  return (
    <aside>
      <StHost />
      <StHost />
    </aside>
  );
}

export const blockV2Scenarios: Scenario[] = [
  {
    name: "v2-settled-after-hydration",
    App: V2SettledAfterComponent,
    expectedText: "todosran",
    serverText: "todospending",
    stableSelector: "main, header, h1, p"
  },
  {
    name: "v2-view-then-boundary",
    App: V2ViewThenBoundary,
    expectedText: "todos1tail",
    update: () => setV2Count(2),
    expectedTextAfterUpdate: "todos2tail",
    stableSelector: "section, header, h1, span"
  },
  {
    name: "v2-view-returns-loading",
    App: V2ViewReturnsLoading,
    async: true,
    expectedText: "fromServerr1r2",
    stableSelector: "div, h2, li"
  },
  {
    name: "v2-block-root-loading",
    App: BlockRootLoading,
    async: true,
    expectedText: "fromServerr1r2",
    stableSelector: "div, h2, li"
  },
  {
    name: "v2-forwarded-children",
    App: V2ForwardedChildren,
    expectedText: "annk1k2bob",
    update: () => setV2Open(false),
    expectedTextAfterUpdate: "annk1k2bob",
    stableSelector: "ol, li, b, i, div"
  },
  {
    name: "v2-helpers",
    App: V2HelpersApp,
    expectedText: "dark2!!",
    update: () => {
      setV2Base(2);
      setV2Suffix("?");
    },
    expectedTextAfterUpdate: "dark4??",
    stableSelector: "p, b, i, u"
  },
  {
    name: "v2-static-nested",
    App: V2StaticNested,
    expectedText: "inleafxinleaf",
    update: () => setStOuterText("y"),
    expectedTextAfterUpdate: "inleafyinleaf",
    stableSelector: "div, span, em"
  },
  {
    name: "v2-static-siblings",
    App: V2StaticSiblings,
    expectedText: "1inleafAt2inleafoinleaf",
    update: () => setStMode("b"),
    expectedTextAfterUpdate: "1inleafBt2inleafoinleaf",
    stableSelector: "section, span, em, div, p"
  },
  {
    name: "v2-static-under-loading",
    App: V2StaticUnderLoading,
    async: true,
    expectedText: "hinleafsrvzt",
    serverText: "h inleafsrvz t",
    stableSelector: "main, span, em, strong"
  },
  {
    name: "v2-static-under-show",
    App: V2StaticUnderShow,
    expectedText: "sinleafonf",
    update: () => setStShow(false),
    expectedTextAfterUpdate: "sofff",
    stableSelector: "article, h3, footer"
  },
  {
    name: "v2-static-under-for",
    App: V2StaticUnderFor,
    expectedText: "ainleafbinleaf",
    update: () => setStItems(["a", "b", "c"]),
    expectedTextAfterUpdate: "ainleafbinleafcinleaf",
    stableSelector: "ul"
  },
  {
    name: "v2-static-with-components",
    App: V2StaticWithComponents,
    expectedText: "pAsf1f2inleafpAsf1f2inleaf",
    update: () => {
      setStInnerShow(false);
      setStHostMode("b");
    },
    expectedTextAfterUpdate: "pBf1f2inleafpBf1f2inleaf",
    stableSelector: "aside, div, kbd, span"
  }
];
