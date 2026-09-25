/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts). Each graph is its own module so the delegated
 * event types a client registers are exactly that graph's.
 */
import { createSignal, createMemo, For, Show } from "solid-js";

export default function SyncApp() {
  const [count, setCount] = createSignal(1);
  const double = createMemo(() => count() * 2);
  return (
    <main>
      <button id="inc" onClick={() => setCount(c => c + 1)}>
        inc
      </button>
      <p>
        count {count()} double {double()}
      </p>
      <Show when={count() % 2 === 0} fallback={<i>odd</i>}>
        <b>even</b>
      </Show>
      <ul>
        <For each={["a", "b"]}>{item => <li>{item}</li>}</For>
      </ul>
    </main>
  );
}
