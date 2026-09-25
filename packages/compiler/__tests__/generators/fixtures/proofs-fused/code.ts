import { $, createEffect, createMemo, createSignal } from "solid-js";

export function counter() {
  const [count, setCount] = createSignal(1);
  const [label] = createSignal("items");
  const [anything] = createSignal<unknown>(null);

  // Typed primitive reads: total arithmetic and templates — sync-only; non-throwing fact retained.
  const double = createMemo(
    $(function* () {
      return (yield* count) * 2;
    })
  );
  const text = createMemo(
    $(function* () {
      return `${yield* double} ${yield* label}`;
    })
  );
  // `===` never throws; a read of an untyped signal is total — sync-only; non-throwing fact retained.
  const isNull = createMemo(
    $(function* () {
      return (yield* anything) === null;
    })
  );
  // A bare read of an untyped value may be a Promise: NOTHROW only.
  const raw = createMemo(
    $(function* () {
      return yield* anything;
    })
  );
  // An unknown call: refused (no metadata).
  const formatted = createMemo(
    $(function* () {
      return format(yield* count);
    })
  );
  // A member access can throw (SYNC only); the effect gets `syncOnly`.
  createEffect(
    $(function* () {
      return (yield* text).length === 0 ? "empty" : "full";
    }),
    value => console.log(value)
  );
  return [double, text, isNull, raw, formatted, setCount];
}

declare function format(value: number): string;
