/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts). Each graph is its own module so the delegated
 * event types a client registers are exactly that graph's.
 */
import { createSignal } from "solid-js";
import { LazyPage } from "./shared.jsx";

export default function LazyApp() {
  const [count, setCount] = createSignal(1);
  return (
    <main>
      <button id="inc" onClick={() => setCount(c => c + 1)}>
        inc {count()}
      </button>
      <LazyPage />
    </main>
  );
}
