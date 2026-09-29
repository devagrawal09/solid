// Read path: an Effect program consumed directly by a memo — examples/effect's
// typeahead, written with generator blocks v2.
//
// The memo block returns the AsyncIterable `runEffect` builds, exactly as the
// original's plain memo does, so Solid still closes a superseded flight's
// iterator and `runEffect` interrupts the fiber. `yield* attempt(…)` would
// not do: it only awaits a promise, and a superseded run is closed without
// telling the producer, so the fiber (and its retries) would run on.
import {
  $component,
  $event,
  $memo,
  $signal,
  Errored,
  For,
  isPending,
  latest,
  Loading,
  Show,
  type TypedProps
} from "solid-js";
import { searchPackages, type Package } from "./api";
import { runEffect } from "./solid-effect";

function formatDownloads(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

/**
 * `results` is a plain function, not the memo accessor itself: `latest` and
 * `isPending` take a function to call, and a prop holding an accessor is
 * read through (`yield* props.results` would be the list, not the accessor).
 */
const Results = $component(function* (
  props: TypedProps<{ results: () => Package[]; query: string }>
) {
  return function* () {
    const results = yield* props.results;
    return (
      <div class={{ results: true, stale: isPending(results) }}>
        <Show
          when={latest(results).length > 0}
          fallback={
            <p class="empty">
              {isPending(results) ? "Searching…" : `No packages match “${yield* props.query}”.`}
            </p>
          }
        >
          <ul>
            <For each={latest(results)}>
              {pkg => (
                <li>
                  <div>
                    <span class="pkg-name">{pkg.name}</span>
                    <span class="pkg-desc">{pkg.description}</span>
                  </div>
                  <span class="pkg-downloads">{formatDownloads(pkg.downloads)}/wk</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    );
  };
});

export const Typeahead = $component(function* () {
  const [query, setQuery] = yield* $signal("");

  // The whole data layer. searchPackages carries retry w/ backoff, timeout,
  // typed transient errors, and interruption finalizers — declared over
  // there, invisible here.
  const results = yield* $memo(function* () {
    const q = (yield* query).trim();
    if (!q) return [] as Package[];
    // The memo resolves the AsyncIterable; the block's return type does not
    // model that (`$memo` types its value as the generator's return), hence
    // the cast.
    return runEffect(searchPackages(q)) as unknown as Package[];
  });
  const readResults = () => results();

  const input = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    yield* setQuery(e.currentTarget.value);
  });

  return function* () {
    return (
      <section class="panel">
        <header>
          <h2>Typeahead search</h2>
          <p>
            Each keystroke starts an Effect fiber (retry ×3 w/ exponential backoff, 4s timeout, ~35%
            transient failure rate). Superseded flights are <em>interrupted</em>, not ignored —
            Solid closes the stale iterator, <code>runEffect</code> interrupts the fiber.
          </p>
        </header>
        <input
          type="search"
          placeholder="Search packages… (try typing “solid” quickly)"
          value={yield* query}
          onInput={input}
          autofocus
        />
        <Show when={(yield* query).trim()}>
          {q => (
            <Errored
              fallback={(err, reset) => (
                <div class="error-box">
                  <p>Search gave up after retries: {String(err())}</p>
                  <button onClick={reset}>Try again</button>
                </div>
              )}
            >
              <Loading fallback={<p class="loading">Searching…</p>}>
                <Results results={readResults} query={q()} />
              </Loading>
            </Errored>
          )}
        </Show>
      </section>
    );
  };
});
