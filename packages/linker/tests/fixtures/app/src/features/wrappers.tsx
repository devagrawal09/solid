// Wrappers and forwarding the linker must refuse (the handlers stay inline):
// - a component that delegates to its prop from its own block
//   (`yield* call(props.onPress, e)`): the prop is not only a DOM sink;
// - a handler passed through a function (`onClick={wrap(handler)}`): the
//   function could do anything with it.
import { $, call, createSignal, write, type EventBlock } from "solid-js";

export function Confirm(props: { onPress: EventBlock<MouseEvent> }) {
  const confirm = $(function* (e: MouseEvent) {
    yield* call(props.onPress, e);
  });
  return <button id="confirm" onClick={confirm} />;
}

function wrap<T>(handler: T): T {
  return handler;
}

export function Wrappers() {
  const [choice, setChoice] = createSignal("none");
  const viaConfirm = $(function* (_e: MouseEvent) {
    yield* write(setChoice, "confirmed");
  });
  const viaWrap = $(function* (_e: MouseEvent) {
    yield* write(setChoice, "wrapped");
  });
  return $(function* () {
    return (
      <div>
        <Confirm onPress={viaConfirm} />
        <button id="wrapped" onClick={wrap(viaWrap)} />
        <span id="choice">{yield* choice}</span>
      </div>
    );
  });
}
