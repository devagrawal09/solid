import { $, createStore } from "solid-js";

const [store] = createStore({ user: { name: "Ada" }, items: [1, 2, 3] });

export const misspelled = $(function* () {
  // A wrong path is a type error on the authored line and column.
  return yield* store.user.nope;
});

export const misuse = $(function* () {
  const n: string = yield* store.items.length;
  return n;
});

export const refused = $(function* () {
  // Optional chains are not projected: stock TypeScript's error stays. A
  // string operand is iterable, so the error is that the block yields
  // strings (TS2345 at the block argument, line 15)…
  return yield* store.user?.name;
});

export const refusedNumber = $(function* () {
  // …and a non-iterable operand is TS2488 at the operand itself.
  return yield* store.items?.length;
});
