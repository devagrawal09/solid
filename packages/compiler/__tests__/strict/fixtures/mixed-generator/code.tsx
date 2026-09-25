import { $, createMemo, createSignal, readStore, write } from "solid-js";

const [count, setCount] = createSignal(1);

// A generator block keeps the existing lowering (`$` stays, reads become
// `perform`); the strict marker next to it is erased for its host.
export const viaGenerator = createMemo(
  $(function* () {
    return (yield* count) * 2;
  })
);
export const viaStrict = createMemo($(() => count() * 2));

// An event block (generator) and a strict event handler side by side.
export const eventBlock = $(function* (event: MouseEvent) {
  const c = yield* count;
  yield* write(setCount, c + event.button);
});
export function View(props: { store: { items: string[] } }) {
  return (
    <div>
      <button onClick={eventBlock}>block</button>
      <button onClick={$(() => setCount(0))}>strict</button>
      {$(function* () {
        return <p>{yield* readStore(props.store, s => s.items.join(","))}</p>;
      })}
    </div>
  );
}
