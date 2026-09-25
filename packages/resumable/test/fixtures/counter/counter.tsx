import { $, createSignal } from "solid-js";

// Fixture 2: a minimal local counter. The scope the server serializes is
// the signal's current value; the client reconstructs the signal and the
// text binding without invoking `Counter` or re-creating its template.
export function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button type="button" class="counter" onClick={$(() => setCount(count() + 1))}>
      {count()}
    </button>
  );
}

// The same counter with the text binding as a marked hole (`<!--$-->`)
// inside a sibling element, plus a second handler on the same signal.
export function Labeled(props: { start: number }) {
  const [count, setCount] = createSignal(props.start);
  return (
    <div class="labeled">
      <button type="button" class="inc" onClick={$(() => setCount(count() + 1))}>
        +
      </button>
      <button type="button" class="dec" onClick={$(() => setCount(count() - 1))}>
        -
      </button>
      <p class="count">Count: {count()}</p>
    </div>
  );
}

export function Page() {
  return (
    <main>
      <Counter />
      <Counter />
      <Labeled start={10} />
    </main>
  );
}
