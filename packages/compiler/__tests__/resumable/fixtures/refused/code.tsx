import { $, createSignal, createMemo, createStore, createEffect } from "solid-js";
import { helper } from "./helper";

function local() {
  return 1;
}

// Every handler here stays hydrated, each for one reason code; the sound
// handler at the end is refused with its scope.
export function Refused(props: { onDone: () => void }) {
  let clicks = 0;
  const [count, setCount] = createSignal(0);
  const [store, setStore] = createStore({ n: 1 });
  const double = createMemo(() => count() * 2);
  return (
    <div>
      <button
        class="mutable"
        onClick={$(() => {
          clicks++;
        })}
      >
        a
      </button>
      <button class="escape" onClick={$((e: MouseEvent) => console.log(e))}>
        b
      </button>
      <button class="fn" onClick={$(() => local())}>
        c
      </button>
      <button class="memo" onClick={$(() => console.log(double()))}>
        d
      </button>
      <button class="import" onClick={$(() => helper(1))}>
        e
      </button>
      <button class="field" onClick={$((e: MouseEvent) => console.log(e.relatedTarget))}>
        f
      </button>
      <button
        class="late"
        onClick={$((e: MouseEvent) => {
          console.log(1);
          e.preventDefault();
        })}
      >
        g
      </button>
      <button class="store" onClick={$(() => setStore("n", 2))}>
        h
      </button>
      <button class="ok" onClick={$(() => setCount(count() + 1))}>
        {count()}
      </button>
    </div>
  );
}

// A scope refused for its template: a component child.
export function Dynamic() {
  const [count, setCount] = createSignal(0);
  return (
    <div onClick={$(() => setCount(count() + 1))}>
      <Refused onDone={() => {}} />
    </div>
  );
}

// A scope refused because the signal escapes into an effect the client
// never runs.
export function Escapes() {
  const [count, setCount] = createSignal(0);
  createEffect(
    () => count(),
    () => {}
  );
  return <button onClick={$(() => setCount(count() + 1))}>{count()}</button>;
}
