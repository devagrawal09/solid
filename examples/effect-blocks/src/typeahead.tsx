// Read path: an Effect program consumed directly by a memo — examples/effect's
// typeahead with @solidjs/blocks.
//
// The memo block returns the AsyncIterable `runEffect` builds, exactly as the
// original's memo does, so Solid still closes a superseded flight's iterator
// and `runEffect` interrupts the fiber. (`yield* attempt(…)` would not do: it
// awaits a promise, and a superseded run is closed without telling the
// producer, so the fiber and its retries would run on.) A memo returning an
// async iterable may be pending and may fail with anything: `Source<…,
// boolean, unknown>`.
import {
  $component,
  $event,
  $memo,
  $signal,
  attempt,
  Errored,
  For,
  isPendingOf,
  latestOf,
  Loading,
  Show,
  type Source,
  type TypedProps
} from "@solidjs/blocks";
import { searchPackages, TransientNetworkError, type Package } from "./api";
import { runEffect } from "./solid-effect";
import { SearchError } from "./errors";

function formatDownloads(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}

const Results = $component(function* Results(
  props: TypedProps<{ results: Source<Package[], boolean, unknown>; query: string }, "Results">
) {
  // Solid's `latest` / `isPending`, as sources: stale while revalidating.
  const list = latestOf(props.results);
  const searching = isPendingOf(props.results);
  return function* () {
    return (
      <div class={{ results: true, stale: yield* searching }}>
        <Show
          when={(yield* list).length > 0}
          fallback={
            <p class="empty">
              {(yield* searching) ? "Searching…" : `No packages match “${yield* props.query}”.`}
            </p>
          }
        >
          <ul>
            <For each={yield* list}>
              {function* (pkg) {
                return function* () {
                  return (
                    <li>
                      <div>
                        <span class="pkg-name">{yield* pkg.name}</span>
                        <span class="pkg-desc">{yield* pkg.description}</span>
                      </div>
                      <span class="pkg-downloads">{formatDownloads(yield* pkg.downloads)}/wk</span>
                    </li>
                  );
                };
              }}
            </For>
          </ul>
        </Show>
      </div>
    );
  };
});

export const Typeahead = $component(function* Typeahead() {
  const [query, setQuery] = yield* $signal("");

  // The whole data layer. searchPackages carries retry w/ backoff, timeout,
  // typed transient errors, and interruption finalizers — declared over
  // there, invisible here.
  const results = yield* $memo(function* () {
    const q = (yield* query).trim();
    if (!q) return [] as Package[];
    return yield* attempt(
      () => runEffect(searchPackages(q)),
      cause => (cause instanceof TransientNetworkError ? cause : new SearchError(cause))
    );
  });
  const onInput = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
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
          onInput={onInput}
          autofocus
        />
        <Show when={(yield* query).trim()}>
          {function* (q) {
            return function* () {
              // A boundary tag hands on nothing it does not handle, so the
              // Loading inside the Errored is a call; its children are a
              // getter so the results are created inside it.
              return (
                <Errored
                  fallback={(err, reset) => (
                    <div class="error-box">
                      <p>Search gave up after retries: {String(err())}</p>
                      <button onClick={reset}>Try again</button>
                    </div>
                  )}
                >
                  {Loading({
                    fallback: <p class="loading">Searching…</p>,
                    get children() {
                      return Results({ results, query: q });
                    }
                  })}
                </Errored>
              );
            };
          }}
        </Show>
      </section>
    );
  };
});
