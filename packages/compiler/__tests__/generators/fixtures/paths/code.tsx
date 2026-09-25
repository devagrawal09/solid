import { $, createMemo, createSignal, readStore } from "solid-js";

// Direct property syntax: `yield* root.a[0][k]` lowers to a path read
// (`readPath`; `readProp` when the root is a component's props parameter).
export function Counter(props: { count: number; user: { name: string } }) {
  const [index] = createSignal(0);
  const total = createMemo(
    $(function* () {
      const i = yield* index;
      return `${yield* store.user.name} ${yield* store.items[0].name} ${yield* store.items[i].name} ${yield* store.items.length}`;
    })
  );
  return $(function* () {
    return (
      <p>
        {yield* props.count} {yield* props.user.name} {yield* total}
      </p>
    );
  });
}

// Unsupported operands leave the whole block to the runtime driver.
export const optional = $(function* () {
  return yield* store.user?.name;
});
export const computed = $(function* () {
  return yield* store.items[i + 1];
});
export const structural = $(function* () {
  return yield* readStore(store, s => s.items.map(item => item.name));
});
