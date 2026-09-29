/**
 * Compiler-derived server components (documentation/plans/
 * ssr-hydration-redesign.md, "Compiler-derived server components"), in the
 * islands mode:
 *
 * - **client-environment reads are client-live**: a view hole reading the
 *   browser environment (`window`, `navigator`, …) is an island hole the
 *   client re-applies at activation, whatever the server rendered;
 * - **serialization is pruned to read paths**: an island receiving a server
 *   object serializes only the prop paths its client code reads;
 * - **a frame refetch keeps keyed island state**: a memo whose value is one
 *   server call over island state is cut as a frame — the server renders the
 *   region, the island drives a refetch of it when the call's arguments
 *   change, and the keyed morph hands each keyed island's state to its new
 *   anchor (the row keyed by its item's id keeps its toggle open across
 *   pages, as the oracle's keyed `For` keeps the row).
 *
 * The frame scenario runs its data function as a registered server function
 * (`islandsServer`: the server half of `./data`), the region refetch through
 * the real server-functions handler (a `fetch` stub routes to it) and the
 * real frames applier (`@solidjs/compiler/frames-client`).
 */
import type { DriverContext, Scenario } from "../harness/types.js";

/** Run, let the page settle (a frame refetch is a fetch and a morph), record the DOM. */
const step = (name: string, run: (ctx: DriverContext) => void | Promise<void>) => ({
  name,
  run: async (ctx: DriverContext) => {
    await run(ctx);
    for (let i = 0; i < 5; i++) await ctx.settle();
    ctx.html();
  }
});

// --- client-environment reads -------------------------------------------------------------

export const islandsFramesEnv: Scenario = {
  name: "islands-frames-env",
  covers: [
    "a view hole reading the browser environment is live: the client applies it at activation",
    "a handler next to it keeps working"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal } from "solid-js";
export function App() {
  const [n, setN] = createSignal(0);
  return (
    <div>
      <p class="env">{typeof window === "undefined" ? "server" : "width " + window.innerWidth}</p>
      <button onClick={() => setN(x => x + 1)}>{n()}</button>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $signal } from "solid-js";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () {
    return (
      <div>
        <p class="env">{typeof window === "undefined" ? "server" : "width " + window.innerWidth}</p>
        <button onClick={inc}>{yield* n}</button>
      </div>
    );
  };
});
`
  },
  islandsManifest: manifest => {
    // Two islands at App: the counter, and the environment hole (no cell,
    // applied once at activation).
    const env = manifest.islands.filter((i: any) =>
      i.why.some((w: string) => /reads the client environment/.test(w))
    );
    if (env.length !== 1 || env[0].cells.length || env[0].tier !== 0)
      throw new Error(`env islands: ${JSON.stringify(manifest.islands)}`);
  },
  steps: [{ name: "initial", run: ctx => ctx.html() }, step("click", ctx => ctx.click("button"))]
};

// --- serialization pruned to the paths client code reads ----------------------------------

export const islandsFramesPrune: Scenario = {
  name: "islands-frames-prune",
  covers: [
    "an island given a server object serializes only the prop path its handler reads",
    "the handler reads it on the client"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createSignal } from "solid-js";
function Row(props) {
  const [shown, setShown] = createSignal("");
  return (
    <li>
      <button onClick={() => setShown(props.item.title)}>show</button>
      <span>{shown()}</span>
    </li>
  );
}
export function App() {
  const item = { id: 1, title: "first", body: "a long body the client never reads", tags: ["a", "b"] };
  return <ul><Row item={item} /></ul>;
}
`,
    islands: `
import { $component, $event, $signal } from "solid-js";
const Row = $component(function* (props) {
  const [shown, setShown] = yield* $signal("");
  const show = $event(function* () { setShown(props.item.title); });
  return function* () {
    return (
      <li>
        <button onClick={show}>show</button>
        <span>{yield* shown}</span>
      </li>
    );
  };
});
export const App = $component(function* () {
  const item = { id: 1, title: "first", body: "a long body the client never reads", tags: ["a", "b"] };
  return function* () {
    return <ul><Row item={item} /></ul>;
  };
});
`
  },
  islandsManifest: manifest => {
    const row = manifest.islands.find((i: any) => i.root === "Row");
    if (JSON.stringify(row?.serialized) !== JSON.stringify(["props.item.title"]))
      throw new Error(`Row serializes ${JSON.stringify(row?.serialized)}`);
  },
  steps: [
    { name: "initial", run: ctx => ctx.html() },
    step("show the title (read on the client)", ctx => ctx.click("button"))
  ]
};

// --- a frame refetch over island state keeps keyed state -----------------------------------

const ROWS = `{
  a: { id: "a", title: "A" },
  b: { id: "b", title: "B" },
  c: { id: "c", title: "C" }
}`;
const PAGES = `{ 1: ["a", "b"], 2: ["b", "c"], 3: ["c"] }`;

export const islandsFramesRefetch: Scenario = {
  name: "islands-frames-refetch",
  covers: [
    "a memo whose value is one server call over island state is a frame (no client memo, no rows code)",
    "changing the call's argument refetches the region from the server and morphs it",
    "a keyed island in the region keeps its state across the refetch (the row keyed by its item's id)",
    "a new row's island activates when the region lands"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, createSignal, For } from "solid-js";
const rows = ${ROWS};
const pages = ${PAGES};
async function getPage(p) { return pages[p].map(k => rows[k]); }
function Toggle(props) {
  const [open, setOpen] = createSignal(false);
  return <li><button onClick={() => setOpen(o => !o)}>{props.title}</button>{open() ? "open" : "closed"}</li>;
}
export function App() {
  const [page, setPage] = createSignal(1);
  const items = createMemo(() => getPage(page()));
  return (
    <div>
      <button class="next" onClick={() => setPage(p => p + 1)}>next</button>
      <ul class="items"><For each={items()}>{it => <Toggle title={it.title} />}</For></ul>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $memo, $signal, attempt, For } from "solid-js";
import { getPage } from "./data";
const Toggle = $component(function* (props) {
  const [open, setOpen] = yield* $signal(false);
  const flip = $event(function* () { setOpen(o => !o); });
  return function* () {
    return <li><button onClick={flip}>{props.title}</button>{(yield* open) ? "open" : "closed"}</li>;
  };
});
export const App = $component(function* () {
  const [page, setPage] = yield* $signal(1);
  const items = yield* $memo(function* () {
    const p = yield* page;
    return yield* attempt(() => getPage(p));
  });
  const next = $event(function* () { setPage(p => p + 1); });
  return function* () {
    return (
      <div>
        <button class="next" onClick={next}>next</button>
        <ul class="items"><For each={yield* items}>{it => <Toggle title={it.title} />}</For></ul>
      </div>
    );
  };
});
`
  },
  islandsOptions: {
    serverImports: [{ specifier: "./data" }],
    serverFunctionsModule: "server-functions",
    framesModule: "frames-client",
    keyedState: true
  },
  islandsServer: {
    "./data": (() => {
      const rows: Record<string, { id: string; title: string }> = {
        a: { id: "a", title: "A" },
        b: { id: "b", title: "B" },
        c: { id: "c", title: "C" }
      };
      const pages: Record<number, string[]> = { 1: ["a", "b"], 2: ["b", "c"], 3: ["c"] };
      return { getPage: async (p: number) => pages[p].map(k => rows[k]) };
    })()
  },
  islandsManifest: manifest => {
    const [frame] = manifest.frames;
    if (!frame || frame.driver !== "island" || frame.arguments.join() !== "p")
      throw new Error(`no island frame over p: ${JSON.stringify(manifest.frames)}`);
    const toggle = frame.islands.find((i: any) => i.root === "Toggle");
    const island = manifest.islands.find((i: any) => i.id === toggle?.id);
    if (!toggle || toggle.key !== "row item id" || !island?.transplant)
      throw new Error(`Toggle is not keyed by its row: ${JSON.stringify(frame.islands)}`);
  },
  steps: [
    step("initial", () => {}),
    step("open B", ctx => ctx.click(".items li:nth-child(2) button")),
    step("next page: the region refetches, B keeps its state", ctx => ctx.click(".next")),
    step("open C (activated when the region landed)", ctx =>
      ctx.click(".items li:nth-child(2) button")
    ),
    step("next page: only C is left, open", ctx => ctx.click(".next"))
  ]
};

export const islandsFramesScenarios: Scenario[] = [
  islandsFramesEnv,
  islandsFramesPrune,
  islandsFramesRefetch
];
