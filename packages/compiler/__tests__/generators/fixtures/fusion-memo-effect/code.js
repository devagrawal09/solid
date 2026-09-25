import { $, createEffect, createMemo, createSignal } from "solid-js";

export function counter() {
  const [count, setCount] = createSignal(1);
  const [label, setLabel] = createSignal("items");

  // `prev` and multiple heterogeneous reads.
  const double = createMemo(
    $(function* (prev) {
      const c = yield* count;
      return c * 2 + (prev ?? 0);
    })
  );

  // A yield inside a template literal.
  createEffect(
    $(function* () {
      return `${yield* double} ${yield* label}`;
    }),
    value => console.log(value)
  );

  // Conditional reads keep their control flow.
  const picked = createMemo(
    $(function* () {
      return (yield* count) > 1 ? yield* label : "none";
    })
  );

  return [double, picked, setCount, setLabel];
}
