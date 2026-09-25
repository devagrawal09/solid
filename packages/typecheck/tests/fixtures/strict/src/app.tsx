import { $, createEffect, createMemo, createSignal, createStore } from "solid-js";
import type { StrictCallback } from "solid-js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

interface Item {
  id: number;
  name: string;
}

// Strict markers are ordinary TypeScript: `count()` is a read, `setCount` a
// write, `await` an await. Stock TypeScript types the callback; `solid-tsc`
// adds the compiler's graph summary and strict diagnostics.
const [count, setCount] = createSignal(1);
const [store, setStore] = createStore({ user: { name: "Ada" }, items: [] as Item[] });

export const doubled = createMemo($(() => count() * 2));
type _doubled = Expect<Equal<ReturnType<typeof doubled>, number>>;

export const user = createMemo(
  $(async () => {
    const name = store.user.name;
    const loaded = await Promise.resolve({ name, size: store.items.length });
    return `${loaded.name}:${loaded.size}`;
  })
);
type _user = Expect<Equal<ReturnType<typeof user>, string>>;

createEffect(
  $(() => count()),
  value => {
    const _n: number = value;
  }
);

export function Counter(props: { step: number; selected: Item }) {
  const selected = props.selected;
  const label = createMemo($(() => `${selected.name}+${props.step * count()}`));
  type _label = Expect<Equal<ReturnType<typeof label>, string>>;

  // The event parameter is typed at the callback (the marker keeps the host
  // from pinning the input type).
  const increment = $((event: MouseEvent) => {
    event.preventDefault();
    setCount(value => value + props.step);
    setStore(state => {
      state.items.push({ id: state.items.length, name: label() });
    });
  });
  type _increment = Expect<Equal<typeof increment, StrictCallback<MouseEvent, void>>>;

  return (
    <button onClick={increment} onDblClick={$(() => setCount(0))}>
      {label()}
    </button>
  );
}
