import { $, attempt, call, createSignal, raise, write } from "solid-js";
import { formatTitle } from "ui-kit";
import { legacyFormat } from "legacy-lib";
import { track } from "../utils/analytics";
import { beacon } from "../utils/telemetry";
import { ValidationError, validate } from "../utils/validate";
import { countWords, LIMIT } from "./stats";

let clears = 0;

// Only extracted handlers use this: it moves to the residue module.
function resetMessage(words: number) {
  return `cleared ${words}/${LIMIT} words`;
}

export function Editor() {
  const [title, setTitle] = createSignal("");
  const [message, setMessage] = createSignal("");
  // Event-only; `preventDefault()` and the guard form a replayable prelude.
  const submit = $(function* (e: SubmitEvent & { currentTarget: HTMLFormElement }) {
    e.preventDefault();
    if (!e.currentTarget) return;
    const value = yield* title;
    const result = yield* attempt(() => validate(formatTitle(value)), ValidationError);
    beacon("submit");
    track("submit");
    yield* write(setMessage, `${result} (${e.currentTarget.id})`);
  });
  const clear = $(function* () {
    const value = yield* title;
    yield* write(setMessage, resetMessage(countWords(value)));
    yield* write(setTitle, "");
  });
  const legacy = $(function* (e: MouseEvent) {
    yield* write(setMessage, legacyFormat(String(e.button)));
  });
  const fail = $(function* () {
    yield* raise(new Error("handler failed"));
  });
  // Hot: propagation control after a read cannot be replayed synchronously.
  const sensitive = $(function* (e: MouseEvent) {
    const value = yield* title;
    if (value) e.stopPropagation();
  });
  // Hot: the event object escapes.
  const escaping = $(function* (e: MouseEvent) {
    track("raw", e);
  });
  // Hot: assigns module state.
  const counted = $(function* () {
    clears++;
  });
  // Hot: delegated to (not only a DOM sink); its delegator is cold.
  const inner = $(function* (e: MouseEvent) {
    yield* write(setMessage, `inner ${e.button}`);
  });
  const outer = $(function* (e: MouseEvent) {
    yield* call(inner, e);
  });
  return $(function* () {
    return (
      <form id="editor" onSubmit={submit}>
        <input
          id="title"
          value={yield* title}
          onInput={$(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
            yield* write(setTitle, e.currentTarget.value);
          })}
        />
        <span id="words">{countWords(yield* title)}</span>
        <output id="message">{yield* message}</output>
        <button id="clear" type="button" onClick={clear} />
        <button id="legacy" type="button" onClick={legacy} />
        <button id="fail" type="button" onClick={fail} />
        <button id="sensitive" type="button" onClick={sensitive} />
        <button id="escaping" type="button" onClick={escaping} />
        <button id="counted" type="button" onClick={counted} />
        <button id="outer" type="button" onClick={outer} />
      </form>
    );
  });
}
