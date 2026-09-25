import { $, createMemo, readStore } from "solid-js";

// `yield* readStore(store, selector)` lowers to one selector invocation
// through `perform` — no generator is involved in compiled output.
export function View() {
  const name = createMemo(
    $(function* () {
      return yield* readStore(store, state => state.user.name);
    })
  );
  return $(function* () {
    return (
      <div>
        <p>{yield* readStore(store, state => state.user.name)}</p>
        <ul>{yield* readStore(store, state => state.items.map(item => <li>{item.name}</li>))}</ul>
      </div>
    );
  });
}
