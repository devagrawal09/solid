import { $, $component, $event, $signal, Errored, For, paths, Show } from "@solidjs/blocks";
import { Typeahead } from "./typeahead";
import { Checkout } from "./checkout";
import { clearLog, logEntries } from "./log";
import { createRuntime, RuntimeContext } from "./solid-effect";
import { SearchConfigLive } from "./api";

type Tab = "typeahead" | "checkout";

// The fiber log is a plain Solid store (written from inside Effect programs):
// blocks read it through `paths`.
const log = paths(logEntries);

const LogPanel = $component(function* LogPanel() {
  const clear = $event(function* () {
    clearLog();
  });
  const newestFirst = $(function* () {
    return [...(yield* log)].reverse();
  });
  return function* () {
    return (
      <aside class="log-panel">
        <header>
          <h2>Fiber events</h2>
          <button onClick={clear}>Clear</button>
        </header>
        <Show
          when={(yield* log.length) > 0}
          fallback={<p class="empty">Interact to see fiber lifecycle events.</p>}
        >
          <ul>
            <For each={yield* newestFirst}>
              {function* (entry) {
                return function* () {
                  return (
                    <li class={`log-${yield* entry.kind}`}>
                      <span class="log-time">{yield* entry.time}</span>
                      <span class="log-kind">{yield* entry.kind}</span>
                      <span class="log-msg">{yield* entry.message}</span>
                    </li>
                  );
                };
              }}
            </For>
          </ul>
        </Show>
      </aside>
    );
  };
});

export const App = $component(function* App() {
  const [tab, setTab] = yield* $signal<Tab>("typeahead");
  const showTypeahead = $event(function* () {
    setTab("typeahead");
  });
  const showCheckout = $event(function* () {
    setTab("checkout");
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
        {/* Effect's R channel rides Solid context: this ManagedRuntime provides
            SearchConfig to every Effect forked below it, and its Layer scope is
            disposed when this subtree unmounts. */}
        <RuntimeContext value={createRuntime(SearchConfigLive)}>
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
        </RuntimeContext>
      </Errored>
    );
  };
});
