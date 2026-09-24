/**
 * The evidence panel.
 *
 * Everything it renders comes from `engine.ts`'s buffered line list, so this
 * component never subscribes to a dev channel itself and never writes
 * reactive state from one. It is also mounted normally — inside the app it
 * watches — which is exactly why `engine.ts` hands the list's root to
 * `OBSERVE.exclude`.
 *
 * Text is rendered volatile-stripped (`stripVolatile`), so what a reader sees
 * is byte-identical to what `tests/*.test.tsx` assert. Real timings live in a
 * muted column beside the text rather than inside it.
 */
import { For, Show } from "solid-js";
import { lines, type DiagLine, type Line, type RunLine } from "./engine";

const severityClass = (severity: string) =>
  severity === "warn" || severity === "error" ? "warn" : "info";

function DiagRow(props: { line: DiagLine }) {
  return (
    <li class="diag">
      <div class={`diag-body ${severityClass(props.line.severity)}`}>
        <div class="diag-head">
          <span class={`badge ${severityClass(props.line.severity)}`}>{props.line.severity}</span>
          <code class="code">{props.line.code}</code>
          <Show when={props.line.nodeName}>
            <span class="muted">{props.line.nodeName}</span>
          </Show>
        </div>
        <p class="diag-text">{props.line.text}</p>
      </div>
    </li>
  );
}

function RunRow(props: { line: RunLine }) {
  return (
    <li class="run">
      <div class={props.line.external ? "run-body external" : "run-body"}>
        <div class="run-head">
          <code class="code">{props.line.nodeName}</code>
          <span class="muted">{props.line.origin}</span>
          <span class="ms">{`${props.line.ms.toFixed(2)}ms`}</span>
        </div>
        <pre>{props.line.text}</pre>
        <Show when={props.line.external}>
          <p class="run-flag">
            No imperative frame: this write left the reactive system before it landed.
          </p>
        </Show>
      </div>
    </li>
  );
}

export function Report(props: { onClear: () => void; watching: readonly string[] }) {
  // Newest first: the last thing you did is the first thing you read.
  const newestFirst = () => lines().slice().reverse();

  return (
    <aside class="panel report" aria-label="Diagnostic evidence">
      <header class="report-head">
        <h2>Evidence</h2>
        <button class="ghost" id="clear-report" onClick={() => props.onClear()}>
          Clear &amp; re-arm
        </button>
      </header>
      <p class="report-watch">
        <span class="muted">watching</span>{" "}
        <For each={props.watching}>{name => <code class="code">{name}</code>}</For>{" "}
        <span class="muted">· diagnostics channel: every code</span>
      </p>

      <Show
        when={newestFirst().length > 0}
        fallback={
          <p class="lab-empty">
            Nothing yet. Drive the card on the left — every diagnostic and every watched re-run
            lands here.
          </p>
        }
      >
        <ol class="report-lines">
          <For each={newestFirst()}>
            {(line: Line) =>
              line.kind === "diag" ? <DiagRow line={line} /> : <RunRow line={line} />
            }
          </For>
        </ol>
      </Show>
    </aside>
  );
}
