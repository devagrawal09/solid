import { $, createSignal } from "solid-js";

export function View(props) {
  const [count] = createSignal(1);
  // JSX yields are compiler-only: after lowering, `{_$perform(count)}` is a
  // fine-grained read owned by the JSX, not by the enclosing block.
  return $(function* () {
    return <div class={yield* props.theme}>Count: {yield* count}</div>;
  });
}
