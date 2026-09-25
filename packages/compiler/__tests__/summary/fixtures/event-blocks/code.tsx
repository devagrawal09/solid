import { $, attempt, call, createSignal, write } from "solid-js";
import { track } from "./analytics";
import { validate } from "./validate";

let counter = 0;
const LIMIT = 10;

function format(value: string) {
  return value.trim().slice(0, LIMIT);
}

export function Form(props: { onDone: () => void }) {
  const [draft, setDraft] = createSignal("");
  // Event-only, prelude covers propagation control.
  const submit = $(function* (e: SubmitEvent) {
    e.preventDefault();
    if (e.defaultPrevented === false) return;
    const value = yield* draft;
    yield* attempt(() => validate(format(value)));
    yield* write(setDraft, "");
    track("submit");
  });
  // Propagation control after a read: not expressible as a prelude.
  const guarded = $(function* (e: MouseEvent) {
    const value = yield* draft;
    if (value) e.stopPropagation();
  });
  // The event object escapes to a call.
  const escaping = $(function* (e: MouseEvent) {
    track(e);
  });
  // Assigns a captured binding.
  const bump = $(function* () {
    counter++;
  });
  // Uses `this` and a method call on the event.
  const odd = $(function* (e: MouseEvent) {
    const path = e.composedPath();
    return [this, path];
  });
  // Delegated to by another block: not event-only.
  const inner = $(function* (e: MouseEvent) {
    yield* write(setDraft, String(e.clientX));
  });
  const outer = $(function* (e: MouseEvent) {
    yield* call(inner, e);
  });
  return (
    <form onSubmit={submit}>
      <button onClick={guarded} />
      <button onClick={escaping} />
      <button onClick={bump} />
      <button onClick={odd} />
      <button onClick={outer} />
      <button oncapture:click={[outer, 1]} />
      <button on:custom={props.onDone} />
    </form>
  );
}
