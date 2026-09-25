import { $, createSignal } from "solid-js";

// Fixture 2 of the resumable-events prototype: the smallest resume scope —
// one signal, one exact text binding, one handler.
export function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button type="button" class="counter" onClick={$(() => setCount(count() + 1))}>
      {count()}
    </button>
  );
}

// A marked text hole (`<!--$-->` inside a sibling element) and two handlers.
export function Labeled(props: { start: number }) {
  const [count, setCount] = createSignal(props.start);
  const inc = $(() => setCount(count() + 1));
  return (
    <div class="labeled">
      <button type="button" onClick={inc}>
        +
      </button>
      <button type="button" onClick={$(() => setCount(count() - 1))}>
        -
      </button>
      <p class="count">Count: {count()}</p>
    </div>
  );
}
