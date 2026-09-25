import { $, createMemo, createStore } from "solid-js";

function Counter(props) {
  const [store] = createStore({ user: { name: "Ada" }, items: [{ name: "one" }], "data-x": 1 });
  const i = 0;

  // A store path and a prop path: the member chain is the tracked walk;
  // `readValue` reads through an accessor or block found at the path.
  const name = createMemo(
    $(function* () {
      return yield* store.user.name;
    })
  );
  const label = createMemo(
    $(function* () {
      return yield* props.count;
    })
  );

  // An index, a dynamic key, `length`, and a key that is not an identifier.
  const summary = createMemo(
    $(function* () {
      return `${yield* store.items[0].name} ${yield* store.items[i]} ${yield* store.items.length} ${yield* store["data-x"]}`;
    })
  );

  return [name, label, summary];
}
