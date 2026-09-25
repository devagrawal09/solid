/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  $,
  call,
  createErrorBoundary,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  flush,
  loading,
  perform,
  raise,
  readStore,
  renderBlock,
  wait,
  write,
  type EventBlock
} from "solid-js";
import type { JSX } from "../src/index.js";
import { Errored, Loading, render } from "@solidjs/web";

class NotFound extends Error {}
class Forbidden extends Error {}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function landed() {
  await Promise.resolve();
  await Promise.resolve();
  flush();
}

// Delegated events need the container in the document.
const mounted: HTMLElement[] = [];
function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  mounted.push(container);
  return container;
}
afterEach(() => {
  for (const c of mounted.splice(0)) c.remove();
});

// `$` blocks compiled by the native compiler: `yield*` inside JSX is lowered
// ahead of JSX compilation to `_$perform(signal)`, the same fine-grained read
// as `{signal()}`. (Without the compiler pass this spelling is not
// compilable — JSX hoists the child into an arrow function; the runtime
// driver only covers non-JSX bodies.)
describe("JSX host", () => {
  test("a block with an inline yield* read compiles, renders, and updates in place", () => {
    const [count, setCount] = createSignal(1);
    let runs = 0;
    const container = mount();
    const dispose = render(
      () =>
        $(function* () {
          runs++;
          return <p>Count: {yield* count}</p>;
        }),
      container
    );
    flush();
    expect(container.textContent).toBe("Count: 1");
    expect(runs).toBe(1);
    setCount(2);
    flush();
    expect(container.textContent).toBe("Count: 2");
    // The read belongs to the JSX insert effect, not to the block.
    expect(runs).toBe(1);
    dispose();
  });

  test("a direct read inside a compiled block body still fails (strict scope)", () => {
    const [count] = createSignal(1);
    const bodyRead = createRoot(() =>
      createMemo(
        $(function* () {
          const c = count();
          return <p>{c}</p>;
        })
      )
    );
    expect(() => bodyRead()).toThrow(/\[DIRECT_READ_IN_BLOCK\]/);
  });

  test("a reads-only JSX block inherits pending and error state from what it reads", async () => {
    const [userId, setUserId] = createSignal(1);
    const flights: Record<number, ReturnType<typeof deferred<{ name: string }>>> = {};
    const container = mount();
    const dispose = render(() => {
      // Async + error-colored source: tasks and raises live here, in a
      // reactive host.
      const user = createMemo(
        $(function* () {
          const id = yield* userId;
          if (id === 3) yield* raise(new NotFound());
          return yield* wait((flights[id] = deferred<{ name: string }>()).promise);
        })
      );
      // The JSX block only reads — no raw promise appears inside JSX — yet
      // it is pending while `user` loads and errors when `user` fails, so
      // the ordinary boundaries consume it. (Nested boundaries under a
      // render root must nest by tree: the function-style `loading` /
      // `errored` are created where they are called.)
      const view = $(function* () {
        return <p class="user">{(yield* user).name}</p>;
      });
      return (
        <Loading fallback={<p class="fallback">loading…</p>}>
          <Errored fallback={() => <p class="missing">no such user</p>}>{view}</Errored>
        </Loading>
      );
    }, container);
    flush();
    expect(container.innerHTML).toBe('<p class="fallback">loading…</p>');
    flights[1].resolve({ name: "Ada" });
    await landed();
    expect(container.innerHTML).toBe('<p class="user">Ada</p>');
    setUserId(3);
    flush();
    expect(container.innerHTML).toBe('<p class="missing">no such user</p>');
    dispose();
  });

  test("a block with a task, raise or write is refused at the insertion sink", () => {
    const flight = deferred<number>();
    const [, setCount] = createSignal(0);
    // (A `yield* wait` *inside* JSX is a compile error — the block cannot be
    // lowered — so the wait sits outside the JSX here; the host still refuses it.)
    const waits = $(function* () {
      const n = yield* wait(flight.promise);
      return <p>{n}</p>;
    });
    const writes = $(function* () {
      yield* write(setCount, 1);
      return <p />;
    });
    createRoot(() => {
      expect(() => renderBlock(waits)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`wait`/);
      expect(() => renderBlock(writes)).toThrow(/\[OP_NOT_ALLOWED_IN_JSX\] .*`write`/);
    });
  });
});

describe("stores", () => {
  test("a JSX block reads a store through readStore inline and updates in place", () => {
    const [store, setStore] = createStore({
      user: { name: "Ada" },
      items: [
        { id: 1, name: "one" },
        { id: 2, name: "two" }
      ]
    });
    let runs = 0;
    const container = mount();
    const dispose = render(
      () =>
        $(function* () {
          runs++;
          return (
            <div>
              <p>{yield* readStore(store, s => s.user.name)}</p>
              <ul>{yield* readStore(store, s => s.items.map(item => <li>{item.name}</li>))}</ul>
            </div>
          );
        }),
      container
    );
    flush();
    expect(container.innerHTML).toBe("<div><p>Ada</p><ul><li>one</li><li>two</li></ul></div>");
    setStore(s => {
      s.user.name = "Grace";
      s.items[1].name = "dos";
      s.items.push({ id: 3, name: "three" });
    });
    flush();
    expect(container.innerHTML).toBe(
      "<div><p>Grace</p><ul><li>one</li><li>dos</li><li>three</li></ul></div>"
    );
    // The reads belong to the JSX insert effects: the block ran once.
    expect(runs).toBe(1);
    dispose();
  });

  test("an event block writes the store with write(setStore, updater)", () => {
    const [store, setStore] = createStore({ items: [{ id: 1, name: "one" }] });
    const container = mount();
    const dispose = render(() => {
      const add = $(function* (_event: MouseEvent) {
        const count = yield* readStore(store, s => s.items.length);
        yield* write(setStore, s => {
          s.items.push({ id: count + 1, name: `item${count + 1}` });
        });
      });
      return (
        <button onClick={add}>
          {$(function* () {
            return yield* readStore(store, s => s.items.map(item => item.name).join(","));
          })}
        </button>
      );
    }, container);
    flush();
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("one");
    button.click();
    flush();
    expect(button.textContent).toBe("one,item2");
    dispose();
  });
});

describe("event host", () => {
  test("a typed event block bound to a delegated event reads, writes and updates the DOM", () => {
    const [count, setCount] = createSignal(0);
    const container = mount();
    let received: Event | undefined;
    const dispose = render(() => {
      const increment = $(function* (event: MouseEvent) {
        received = event;
        const c = yield* count;
        yield* write(setCount, c + 1);
      });
      return (
        <button onClick={increment}>
          {$(function* () {
            return `clicked ${yield* count}`;
          })}
        </button>
      );
    }, container);
    flush();
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("clicked 0");
    button.click();
    flush();
    expect(count()).toBe(1);
    expect(button.textContent).toBe("clicked 1");
    expect(received?.type).toBe("click");
    dispose();
  });

  test("a block passed through component props reaches the DOM sink unchanged", () => {
    const [log, setLog] = createSignal<string[]>([]);
    const container = mount();
    let bound: unknown;
    function Leaf(props: { onClick: EventBlock<MouseEvent> }) {
      bound = props.onClick;
      return <button onClick={props.onClick}>leaf</button>;
    }
    function Middle(props: { onClick: EventBlock<MouseEvent> }) {
      return <Leaf onClick={props.onClick} />;
    }
    let authored: unknown;
    const dispose = render(() => {
      const handler = $(function* (event: MouseEvent) {
        yield* write(setLog, l => [...l, `parent:${event.type}`]);
      });
      authored = handler;
      return <Middle onClick={handler} />;
    }, container);
    flush();
    expect(bound).toBe(authored);
    container.querySelector("button")!.click();
    flush();
    expect(log()).toEqual(["parent:click"]);
    dispose();
  });

  test("a wrapping child delegates to the parent's block with call() and composes effects", () => {
    const [log, setLog] = createSignal<string[]>([]);
    const container = mount();
    function Child(props: { onClick: EventBlock<MouseEvent, string> }) {
      // The child's block is itself typed: its Writes and the parent's
      // accumulate (see the type tests); at runtime both run, in order.
      const wrapped = $(function* (event: MouseEvent) {
        yield* write(setLog, l => [...l, "child:before"]);
        const result = yield* call(props.onClick, event);
        yield* write(setLog, l => [...l, `child:after:${result}`]);
      });
      return <button onClick={wrapped}>child</button>;
    }
    const dispose = render(() => {
      const parent = $(function* (event: MouseEvent) {
        yield* write(setLog, l => [...l, `parent:${event.type}`]);
        return "done";
      });
      return <Child onClick={parent} />;
    }, container);
    flush();
    container.querySelector("button")!.click();
    flush();
    expect(log()).toEqual(["child:before", "parent:click", "child:after:done"]);
    dispose();
  });

  test("an ordinary event callback keeps working, with no effect claims", () => {
    const [count, setCount] = createSignal(0);
    const container = mount();
    const dispose = render(() => {
      const plain = (e: MouseEvent) => setCount(c => c + e.detail + 1);
      return (
        <div>
          <button class="plain" onClick={plain}>
            plain
          </button>
          <button class="tuple" onClick={[(n: number) => setCount(c => c + n), 10]}>
            tuple
          </button>
        </div>
      );
    }, container);
    flush();
    container.querySelector<HTMLButtonElement>(".plain")!.click();
    container.querySelector<HTMLButtonElement>(".tuple")!.click();
    flush();
    expect(count()).toBe(11);
    dispose();
  });

  test("an event block that waits then fails routes the failure to the enclosing boundary", async () => {
    const flight = deferred<string>();
    const [status, setStatus] = createSignal("idle");
    const container = mount();
    const dispose = render(
      () =>
        createErrorBoundary(
          () => {
            // Created under the boundary: the block captures this owner.
            const save = $(function* (_event: MouseEvent) {
              yield* write(setStatus, "saving");
              const answer = yield* wait(flight.promise, Forbidden);
              yield* write(setStatus, answer);
            });
            return <button onClick={save}>{status()}</button>;
          },
          error => <p class="error">{(error() as Error).constructor.name}</p>
        ) as unknown as JSX.Element,
      container
    );
    flush();
    container.querySelector("button")!.click();
    flush();
    expect(status()).toBe("saving");
    flight.reject(new Forbidden("denied"));
    await landed();
    expect(container.innerHTML).toBe('<p class="error">Forbidden</p>');
    dispose();
  });

  test("the compiled (call-form) event block and a hand-written driver block agree", () => {
    const [count, setCount] = createSignal(0);
    const container = mount();
    const dispose = render(() => {
      // Compiled by the native compiler to `perform(write(...))`.
      const lowered = $(function* (event: MouseEvent) {
        const c = yield* count;
        yield* write(setCount, c + event.detail + 1);
      });
      // The same block, written in the form the compiler emits.
      const handWritten = $(function (event: MouseEvent) {
        const c = perform(count);
        perform(write(setCount, c + event.detail + 1));
      } as any);
      return (
        <div>
          <button class="a" onClick={lowered}>
            a
          </button>
          <button class="b" onClick={handWritten}>
            b
          </button>
        </div>
      );
    }, container);
    flush();
    container.querySelector<HTMLButtonElement>(".a")!.click();
    flush();
    expect(count()).toBe(1);
    container.querySelector<HTMLButtonElement>(".b")!.click();
    flush();
    expect(count()).toBe(2);
    dispose();
  });
});
