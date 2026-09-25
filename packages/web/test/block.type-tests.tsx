/**
 * @jsxImportSource @solidjs/web
 */
// Type-level contract of `$` blocks at the JSX and event hosts (checked by
// `tsc`, never executed).
import {
  $,
  call,
  createMemo,
  createSignal,
  For,
  raise,
  wait,
  write,
  type BlockWrites,
  type EventBlock
} from "solid-js";
import type { JSX } from "../src/index.js";

class NotFound extends Error {
  readonly kind = "not-found";
}
declare function fetchUser(id: number): Promise<{ name: string }>;

const [count, setCount] = createSignal(1);

// --- JSX host: a component may return a reads-only block --------------------------
function ReadsOnly() {
  return $(function* () {
    return <p>{yield* count}</p>;
  });
}
const _readsOnly = <ReadsOnly />;

// A block that only reads an async / error-colored source is still a reads-only block.
const user = createMemo(
  $(function* () {
    const id = yield* count;
    if (id === 3) yield* raise(new NotFound());
    return yield* wait(fetchUser(id));
  })
);
function Colored() {
  return $(function* () {
    return <p>{(yield* user).name}</p>;
  });
}
const _colored = <Colored />;
const _inline: JSX.Element = $(function* () {
  return <p>{(yield* user).name}</p>;
});

// A task, an explicit failure or a write in a block returned as JSX is refused
// at the use site (TypeScript checks a function component's return type where
// it is rendered, not where it is declared).
function Waits() {
  return $(function* () {
    return <p>{(yield* wait(fetchUser(1))).name}</p>;
  });
}
// @ts-expect-error — a JSX block may not wait on a raw promise
const _waits = <Waits />;
function Raises() {
  return $(function* () {
    if (yield* count) yield* raise(new NotFound());
    return <p />;
  });
}
// @ts-expect-error — a JSX block may not raise
const _raises = <Raises />;
function Writes() {
  return $(function* () {
    yield* write(setCount, 2);
    return <p />;
  });
}
// @ts-expect-error — a JSX block may not write
const _writes = <Writes />;
// Annotating the return type moves the diagnostic into the component: it is
// reported at the `return` statement.
function Annotated(): JSX.Element {
  // @ts-expect-error — a JSX block may not wait
  return $(function* () {
    return <p>{(yield* wait(fetchUser(1))).name}</p>;
  });
}
// The same admission applies to a block used as a child expression.
const taskBlock = $(function* () {
  return <p>{(yield* wait(fetchUser(1))).name}</p>;
});
// @ts-expect-error — not admissible as a JSX child
const _child = <div>{taskBlock}</div>;

// Function-valued props keep their contextual typing (the `Element` union
// admits blocks by shape, not by call signature).
const _for = (
  <For each={[1, 2, 3]}>
    {(item, index) => (
      <li>
        {item.toFixed(1)}:{index()}
      </li>
    )}
  </For>
);

// --- Event host: DOM event props accept ordinary handlers and typed blocks ------
const increment = $(function* (event: MouseEvent) {
  const c = yield* count;
  yield* write(setCount, c + event.detail);
});
const _button = <button onClick={increment} />;
const _plain = <button onClick={(e: MouseEvent) => setCount(e.detail)} />;
const _tuple = <button onClick={[(n: number, e: MouseEvent) => setCount(n + e.detail), 1]} />;
const keyed = $(function* (event: KeyboardEvent) {
  yield* write(setCount, event.key.length);
});
// @ts-expect-error — the block expects a KeyboardEvent, not a MouseEvent
const _wrongEvent = <button onClick={keyed} />;

// Forwarding through props keeps the branded type; a wrapping child composes.
function Leaf(props: { onClick: EventBlock<MouseEvent> }) {
  return <button onClick={props.onClick} />;
}
function Middle(props: { onClick: EventBlock<MouseEvent> }) {
  const wrapped = $(function* (event: MouseEvent) {
    yield* write(setCount, 0);
    return yield* call(props.onClick, event);
  });
  type _accumulated = BlockWrites<typeof wrapped> extends typeof setCount ? true : never;
  const _ok: _accumulated = true;
  return <Leaf onClick={wrapped} />;
}
const _middle = <Middle onClick={increment} />;
// @ts-expect-error — an ordinary callback is not a typed event block
const _legacyAsBlock = <Leaf onClick={(e: MouseEvent) => setCount(e.detail)} />;

export {};
