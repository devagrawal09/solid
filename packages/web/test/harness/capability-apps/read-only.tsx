/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts): READ-ONLY. Reactive values render, nothing writes
 * and nothing listens — the graph needs no hydration capability at all.
 */
import { createSignal, createMemo, For, Show } from "solid-js";

export default function ReadOnlyApp() {
  const [items] = createSignal(["alpha", "beta", "gamma"]);
  const count = createMemo(() => items().length);
  return (
    <article>
      <h1>catalog</h1>
      <p>items {count()}</p>
      <Show when={count() > 2}>
        <b>many</b>
      </Show>
      <ul>
        <For each={items()}>{item => <li>{item}</li>}</For>
      </ul>
    </article>
  );
}
