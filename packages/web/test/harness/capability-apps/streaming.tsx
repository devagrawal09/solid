/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts). Each graph is its own module so the delegated
 * event types a client registers are exactly that graph's.
 */
import { createSignal, Loading } from "solid-js";
import { Slow } from "./shared.jsx";

export default function StreamingApp() {
  const [count, setCount] = createSignal(1);
  return (
    <main>
      <button id="inc" onClick={() => setCount(c => c + 1)}>
        inc {count()}
      </button>
      <Loading fallback={<i>waiting</i>}>
        <Slow n={count()} />
      </Loading>
    </main>
  );
}
