import { $, createMemo, createSignal, createStore, readStore, write } from "solid-js";
import type { BlockReads, PropRead, StoreRead } from "solid-js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

interface Item {
  id: number;
  name: string;
}
const [store, setStore] = createStore({
  user: { name: "Ada", address: { city: "London" } },
  items: [{ id: 1, name: "one" }] as Item[]
});
const [index] = createSignal(0);

// Stores: root plus static path, selected value inferred.
export const summary = createMemo(
  $(function* () {
    const i = yield* index;
    const name = yield* store.user.name;
    const city = yield* store.user.address.city;
    const first = yield* store.items[0].name;
    const current = yield* store.items[i];
    const count = yield* store.items.length;
    return { name, city, first, current, count };
  })
);
type _summaryValue = Expect<
  Equal<
    ReturnType<typeof summary>,
    { name: string; city: string; first: string; current: Item; count: number }
  >
>;
const block = $(function* () {
  return yield* store.user.name;
});
type _reads = Expect<
  Equal<BlockReads<typeof block>, StoreRead<typeof store, readonly ["user", "name"]>>
>;

// Props: a component's first parameter.
export function Counter(props: { count: number; user: { name: string }; items: Item[] }) {
  const doubledBlock = $(function* () {
    const n: number = yield* props.count;
    const label: string = yield* props.user.name;
    const size: number = yield* props.items.length;
    return `${label}:${n * 2}:${size}`;
  });
  const doubled = createMemo(doubledBlock);
  type _propReads = Expect<
    Equal<
      BlockReads<typeof doubledBlock>,
      | PropRead<typeof props, readonly ["count"]>
      | PropRead<typeof props, readonly ["user", "name"]>
      | PropRead<typeof props, readonly ["items", "length"]>
    >
  >;
  return $(function* () {
    return <p>{yield* doubled}</p>;
  });
}

// Aliases are their own roots; structural reads stay `readStore`.
export const structural = createMemo(
  $(function* () {
    const items = store.items;
    const n = yield* items.length;
    const names = yield* readStore(store, s => s.items.map(item => item.name));
    return `${n}:${names.join(",")}`;
  })
);

// Event blocks write with `write(setStore, …)`.
export const add = $(function* (_event: MouseEvent) {
  const count = yield* store.items.length;
  yield* write(setStore, s => {
    s.items.push({ id: count + 1, name: `item${count + 1}` });
  });
});
