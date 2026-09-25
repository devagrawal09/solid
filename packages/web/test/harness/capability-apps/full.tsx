/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts). Each graph is its own module so the delegated
 * event types a client registers are exactly that graph's.
 */
import { createSignal, createMemo, createStore, For, Errored, Loading } from "solid-js";
import { sleep, Thrower, Slow, LazyPage } from "./shared.jsx";

export default function FullApp() {
  const [count, setCount] = createSignal(1);
  const [text, setText] = createSignal("");
  const [remote] = createStore(
    async () => {
      await sleep(5);
      return [{ id: 1, label: "remote" }];
    },
    [] as { id: number; label: string }[]
  );
  const total = createMemo(async () => {
    await sleep(5);
    return 40;
  });
  const clientOnly = createMemo(() => "client", { ssrSource: "client", loadingValue: "seed" });
  const hybrid = createMemo(
    async () => {
      await sleep(5);
      return "hybrid";
    },
    { ssrSource: "hybrid" }
  );
  return (
    <main>
      <button id="inc" onClick={() => setCount(c => c + 1)}>
        inc
      </button>
      <input id="field" onInput={e => setText(e.currentTarget.value)} />
      <p>
        count {count()} text {text()} total {total()} {clientOnly()} {hybrid()}
      </p>
      <ol>
        <For each={remote}>{row => <li>{row.label}</li>}</For>
      </ol>
      <Errored fallback={(e: any) => <b>caught {e().message}</b>}>
        <Thrower />
      </Errored>
      <Loading fallback={<i>waiting</i>}>
        <Slow n={count()} />
      </Loading>
      <LazyPage />
    </main>
  );
}
