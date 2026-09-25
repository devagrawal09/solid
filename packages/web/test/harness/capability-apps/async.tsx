/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts). Each graph is its own module so the delegated
 * event types a client registers are exactly that graph's.
 */
import { createSignal, createMemo, Errored } from "solid-js";
import { sleep, Thrower } from "./shared.jsx";

export default function AsyncApp() {
  const [count, setCount] = createSignal(1);
  const total = createMemo(async () => {
    await sleep(5);
    return 40;
  });
  return (
    <main>
      <button id="inc" onClick={() => setCount(c => c + 1)}>
        inc
      </button>
      <p>total {total() + count()}</p>
      <Errored fallback={(e: any) => <b>caught {e().message}</b>}>
        <Thrower />
      </Errored>
    </main>
  );
}
