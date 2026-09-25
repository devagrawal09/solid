import { $, createMemo } from "solid-js";

function Counter(props) {
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

  return [name, label];
}
