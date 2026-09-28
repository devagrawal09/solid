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
 */
// @ts-nocheck
import {
  $,
  $component,
  $memo,
  $signal,
  $cleanup,
  attempt,
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
// V4. A run-once effect block (`onSettled(function* …)`) in a component body,
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
  }
];
