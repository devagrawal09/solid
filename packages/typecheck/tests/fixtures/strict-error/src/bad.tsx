import { $, createMemo, createSignal, createStore } from "solid-js";

const [count, setCount] = createSignal(1);
const [store] = createStore({ user: { name: "Ada" } });

// A type error inside a strict callback is TypeScript's own, at its column.
export const typed = createMemo(
  $(() => {
    const label: string = count();
    return label + store.user.name;
  })
);

// A strict diagnostic: an accessor handed to an unsummarized helper.
export const escaped = createMemo($(() => register(count)));

// A strict diagnostic: a write inside a reactive host.
export const writes = createMemo(
  $(() => {
    setCount(2);
    return count();
  })
);

// A strict diagnostic: no statically known host.
const lonely = $(() => count());

declare function register(accessor: unknown): number;
