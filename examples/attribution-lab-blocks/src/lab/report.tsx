/**
 * The evidence panel (examples/attribution-lab's Report, written with
 * generator blocks v2).
 *
 * Everything it renders comes from `engine.ts`'s buffered line list, so this
 * component never subscribes to a dev channel itself and never writes
 * reactive state from one. Text is rendered volatile-stripped
 * (`stripVolatile`), so what a reader sees is byte-identical to what the
 * tests assert.
 *
 * The original's `newestFirst = () => lines().slice().reverse()` is a plain
 * derived function, not a node; a `$memo` would add a node to the graph the
 * panel reports on, so the view reads `lines` inline instead.
 */
import { $component, $event, For, Show, type TypedProps } from "solid-js";
import { lines, type DiagLine, type Line, type RunLine } from "./engine";

const severityClass = (severity: string) =>
  severity === "warn" || severity === "error" ? "warn" : "info";

const DiagRow = $component(function* (props: TypedProps<{ line: DiagLine }>) {
  return function* () {
    const severity = severityClass(yield* props.line.severity);
    return (
      <li class="diag">
        <div class={`diag-body ${severity}`}>
          <div class="diag-head">
            <span class={`badge ${severity}`}>{yield* props.line.severity}</span>
            <code class="code">{yield* props.line.code}</code>
            <Show when={yield* props.line.nodeName}>
              <span class="muted">{yield* props.line.nodeName}</span>
            </Show>
          </div>
          <p class="diag-text">{yield* props.line.text}</p>
        </div>
      </li>
    );
  };
});

const RunRow = $component(function* (props: TypedProps<{ line: RunLine }>) {
  return function* () {
    return (
      <li class="run">
        <div class={(yield* props.line.external) ? "run-body external" : "run-body"}>
          <div class="run-head">
            <code class="code">{yield* props.line.nodeName}</code>
            <span class="muted">{yield* props.line.origin}</span>
            <span class="ms">{`${(yield* props.line.ms).toFixed(2)}ms`}</span>
          </div>
          <pre>{yield* props.line.text}</pre>
          <Show when={yield* props.line.external}>
            <p class="run-flag">
              No imperative frame: this write left the reactive system before it landed.
            </p>
          </Show>
        </div>
      </li>
    );
  };
});

export const Report = $component(function* (
  props: TypedProps<{ onClear: (event: MouseEvent) => void; watching: readonly string[] }>
) {
  const clear = $event(function* (event: MouseEvent) {
    const onClear = yield* props.onClear;
    onClear(event);
  });

  return function* () {
    return (
      <aside class="panel report" aria-label="Diagnostic evidence">
        <header class="report-head">
          <h2>Evidence</h2>
          <button class="ghost" id="clear-report" onClick={clear}>
            Clear &amp; re-arm
          </button>
        </header>
        <p class="report-watch">
          <span class="muted">watching</span>{" "}
          <For each={yield* props.watching}>{name => <code class="code">{name}</code>}</For>{" "}
          <span class="muted">· diagnostics channel: every code</span>
        </p>

        <Show
          when={(yield* lines).length > 0}
          fallback={
            <p class="lab-empty">
              Nothing yet. Drive the card on the left — every diagnostic and every watched re-run
              lands here.
            </p>
          }
        >
          <ol class="report-lines">
            {/* Newest first: the last thing you did is the first thing you read. */}
            <For each={(yield* lines).slice().reverse()}>
              {(line: Line) =>
                line.kind === "diag" ? <DiagRow line={line} /> : <RunRow line={line} />
              }
            </For>
          </ol>
        </Show>
      </aside>
    );
  };
});
