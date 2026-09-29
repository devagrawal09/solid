// examples/effect's App, written with generator blocks v2
// (documentation/plans/generator-blocks-v2.md). `solid-effect.ts`, `api.ts`
// and `log.ts` are the integration and data layer, copied unchanged.
import {
  $component,
  $event,
  $signal,
  Errored,
  For,
  readStore,
  Show,
  type TypedProps
} from "solid-js";
import type { JSX } from "@solidjs/web";
import { Typeahead } from "./typeahead";
import { Checkout } from "./checkout";
import { clearLog, logEntries } from "./log";
import { createRuntime, RuntimeContext } from "./solid-effect";
import { SearchConfigLive } from "./api";

type Tab = "typeahead" | "checkout";

const LogPanel = $component(function* () {
  const clear = $event(function* () {
    clearLog();
  });
  return function* () {
    return (
      <aside class="log-panel">
        <header>
          <h2>Fiber events</h2>
          <button onClick={clear}>Clear</button>
        </header>
        <Show
          when={(yield* readStore(logEntries, l => l.length)) > 0}
          fallback={<p class="empty">Interact to see fiber lifecycle events.</p>}
        >
          <ul>
            {/* A plain render callback: its store reads are ordinary
                property reads (a render-callback block would make them
                `yield* entry.kind`). */}
            <For each={yield* readStore(logEntries, l => [...l].reverse())}>
              {entry => (
                <li class={`log-${entry.kind}`}>
                  <span class="log-time">{entry.time}</span>
                  <span class="log-kind">{entry.kind}</span>
                  <span class="log-msg">{entry.message}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </aside>
    );
  };
});

/**
 * The original evaluates `<RuntimeContext value={createRuntime(…)}>` in App's
 * JSX, under the `<Errored>` boundary. A v2 view may not create or clean up
 * (`createRuntime` registers an `onCleanup`), so the runtime is created in the
 * setup of this provider component, which keeps it under the boundary.
 */
const RuntimeProvider = $component(function* (props: TypedProps<{ children: JSX.Element }>) {
  // Effect's R channel rides Solid context: this ManagedRuntime provides
  // SearchConfig to every Effect forked below it, and its Layer scope is
  // disposed when this subtree unmounts.
  const runtime = createRuntime(SearchConfigLive);
  return function* () {
    return <RuntimeContext value={runtime}>{props.children}</RuntimeContext>;
  };
});

export const App = $component(function* () {
  const [tab, setTab] = yield* $signal<Tab>("typeahead");
  const showTypeahead = $event(function* () {
    yield* setTab("typeahead");
  });
  const showCheckout = $event(function* () {
    yield* setTab("checkout");
  });
  return function* () {
    return (
      <Errored
        fallback={(err, reset) => (
          <div class="error-box app-error">
            <p>Something went wrong: {String(err())}</p>
            <button onClick={reset}>Reset</button>
          </div>
        )}
      >
        <RuntimeProvider>
          <div class="app">
            <header class="app-header">
              <h1>
                Solid 2.0 <span class="times">×</span> Effect
              </h1>
              <p>
                Two demos, one tiny integration (<code>src/solid-effect.ts</code>): Effects as
                interruptible async sources on the read path, Effect sagas as transaction steps on
                the action path, services provided through Solid context.
              </p>
              <nav class="tabs">
                <button class={{ selected: (yield* tab) === "typeahead" }} onClick={showTypeahead}>
                  Typeahead <small>read path</small>
                </button>
                <button class={{ selected: (yield* tab) === "checkout" }} onClick={showCheckout}>
                  Checkout <small>action path</small>
                </button>
              </nav>
            </header>
            <main>
              <Show when={(yield* tab) === "typeahead"} fallback={<Checkout />}>
                <Typeahead />
              </Show>
              <LogPanel />
            </main>
          </div>
        </RuntimeProvider>
      </Errored>
    );
  };
});
