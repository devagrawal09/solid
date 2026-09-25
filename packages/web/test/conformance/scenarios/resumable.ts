/**
 * Resumable-event scenarios (experimental, private prototype): a strict
 * `$(fn)` handler whose captures are a signal the same component declares,
 * plus an exact text binding. The resume modes must run the first click
 * exactly once after the event module loads, later clicks synchronously,
 * and never run the component; the timing difference is declared exactly.
 */
import type { Scenario } from "../harness/types.js";

export const resumableCounter: Scenario = {
  name: "resumable-counter",
  covers: [
    "resumable scope: signal + exact text binding reconstructed without running the component",
    "first interaction runs exactly once after the event module loads (declared timing difference)",
    "later interactions run synchronously in the dispatch, like a delegated handler"
  ],
  entry: { component: "App" },
  ssr: {},
  sources: {
    reference: `
import { createSignal } from "solid-js";
import { h } from "conformance";
export function App() {
  h.run("App");
  const [count, setCount] = createSignal(0);
  const inc = () => {
    h.run("inc");
    h.where("inc handler");
    setCount(count() + 1);
  };
  return (
    <div>
      <button class="inc" onClick={inc}>
        +
      </button>
      <p class="count">{count()}</p>
    </div>
  );
}
`,
    generator: `
import { $, write, createSignal } from "solid-js";
import { h } from "conformance";
export function App() {
  h.run("App");
  const [count, setCount] = createSignal(0);
  const inc = $(function* () {
    h.run("inc");
    h.where("inc handler");
    const c = yield* count;
    yield* write(setCount, c + 1);
  });
  return (
    <div>
      <button class="inc" onClick={inc}>
        +
      </button>
      <p class="count">{count()}</p>
    </div>
  );
}
`,
    strict: `
import { $, createSignal } from "solid-js";
import { h } from "conformance";
export function App() {
  h.run("App");
  const [count, setCount] = createSignal(0);
  return (
    <div>
      <button
        class="inc"
        onClick={$(() => {
          h.run("inc");
          h.where("inc handler");
          setCount(count() + 1);
        })}
      >
        +
      </button>
      <p class="count">{count()}</p>
    </div>
  );
}
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "first click, then settle",
      run: async ({ click, flush, html, settle }) => {
        click(".inc");
        flush();
        html();
        await settle();
        flush();
        html();
      }
    },
    {
      name: "second click",
      run: ({ click, flush, html }) => {
        click(".inc");
        flush();
        html();
      }
    }
  ],
  modes: {
    "server/resumable": {
      status: "differs",
      reason:
        "the server emits the resume coordinate (`data-sr`) on the handler element and one instance record (`sr:<key>`) per scope through the hydration serializer; the component itself renders identically",
      trace: [
        "## render",
        "run App",
        'markup = <div _hk=0><button class="inc" data-sr="0/0">+</button><p class="count">0</p></div>',
        'hydration-keys = ["0"]',
        'serialized = ["sr:0"]'
      ]
    },
    "hydrate/resumable": {
      status: "differs",
      reason:
        "no hydration and no component run (`run App` never happens); the first click is cold: the prelude runs live, the handler runs exactly once after the event module loads (here: after `settle`), so the html recorded inside the same dispatch still shows 0; the second click is warm and synchronous",
      trace: [
        "## resume",
        "resume manifest = 1 scope(s), 1 handler(s), 0 hydrated",
        "resume server-nodes 1 kept, 0 client-inserted, component runs 0",
        "## initial",
        'html = <div _hk="0"><button class="inc" data-sr="0/0">+</button><p class="count">0</p></div>',
        "## first click, then settle",
        "resume dispatch = .inc",
        "resume dispatched = .inc cold",
        'html = <div _hk="0"><button class="inc" data-sr="0/0">+</button><p class="count">0</p></div>',
        "run inc",
        "owner inc handler = none",
        'html = <div _hk="0"><button class="inc" data-sr="0/0">+</button><p class="count">1</p></div>',
        "## second click",
        "resume dispatch = .inc",
        "run inc",
        "owner inc handler = none",
        "resume dispatched = .inc warm",
        'html = <div _hk="0"><button class="inc" data-sr="0/0">+</button><p class="count">2</p></div>',
        "## teardown"
      ]
    }
  }
};

export const resumableScenarios: Scenario[] = [resumableCounter];
