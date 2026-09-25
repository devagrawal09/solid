import { $, createSignal, createMemo } from "solid-js";
import { helper } from "./helper";

function local() {
  return 1;
}

// Handlers the compiler must leave hydrated, each for one documented reason.
export function Refused(props: { value: () => string }) {
  let clicks = 0;
  const [count, setCount] = createSignal(0);
  const double = createMemo(() => count() * 2);
  return (
    <div>
      <button
        class="mutable"
        onClick={$(() => {
          clicks++;
        })}
      >
        mutable closure state
      </button>
      <button class="escape" onClick={$((e: MouseEvent) => console.log(e))}>
        event escapes
      </button>
      <button class="fn" onClick={$(() => local())}>
        module function
      </button>
      <button class="memo" onClick={$(() => console.log(double()))}>
        memo read
      </button>
      <button class="import" onClick={$(() => helper(1))}>
        unverified import
      </button>
      <button class="field" onClick={$((e: MouseEvent) => console.log(e.relatedTarget))}>
        unapproved field
      </button>
      <button
        class="late"
        onClick={$((e: MouseEvent) => {
          console.log(1);
          e.preventDefault();
        })}
      >
        preventDefault outside prelude
      </button>
      <button class="ok" onClick={$(() => setCount(count() + 1))}>
        {count()}
      </button>
    </div>
  );
}

// A scope whose values are only known at render: a props value that turns
// out not to be data is refused at render time (fail closed).
export function Runtime(props: { payload: unknown }) {
  const payload = props.payload;
  return (
    <button class="runtime" onClick={$(() => console.log(payload))}>
      payload
    </button>
  );
}
