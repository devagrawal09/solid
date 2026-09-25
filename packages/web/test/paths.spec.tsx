/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
// Direct property syntax in components, compiled by the native compiler:
// `yield* props.count` lowers to `perform(readProp(props, ["count"]))` (the
// prop getter runs with the strict guard lowered — exact getter tracking),
// `yield* row.title` on a store row to `perform(readPath(row, ["title"]))`.
//
// This file's authored `yield*` operands are values, which stock TypeScript
// cannot type; the package's `tsc` run skips it (`@ts-nocheck`) and the
// spelling is checked by `solid-tsc` (`packages/typecheck`).
// @ts-nocheck
import { describe, expect, test } from "vitest";
import { $, createSignal, createStore, flush } from "solid-js";
import { render } from "@solidjs/web";

describe("direct property syntax in components", () => {
  test("props: getters track exactly, and the JSX block runs once", () => {
    const [count, setCount] = createSignal(1);
    const [label, setLabel] = createSignal("a");
    let childRuns = 0;
    let doubledRuns = 0;
    function Child(props: { count: number; label: string; fixed: number }) {
      const doubled = $(function* () {
        doubledRuns++;
        return (yield* props.count) * 2;
      });
      return $(function* () {
        childRuns++;
        return (
          <p>
            {yield* props.label}:{yield* props.fixed}:{yield* doubled}
          </p>
        );
      });
    }
    const container = document.createElement("div");
    const dispose = render(() => <Child count={count()} label={label()} fixed={7} />, container);
    flush();
    expect(container.textContent).toBe("a:7:2");
    setCount(5);
    flush();
    expect(container.textContent).toBe("a:7:10");
    setLabel("b");
    flush();
    expect(container.textContent).toBe("b:7:10");
    // Fine-grained: the JSX block ran once; `doubled` re-ran only for count.
    expect(childRuns).toBe(1);
    expect(doubledRuns).toBe(2);
    dispose();
  });

  test("a store row passed as a prop: `yield* row.field` tracks that node only", () => {
    const [store, setStore] = createStore({
      todos: [
        { id: 1, title: "one", done: false },
        { id: 2, title: "two", done: true }
      ]
    });
    let runs = 0;
    function Row(props: { todo: { id: number; title: string; done: boolean } }) {
      const todo = props.todo;
      return $(function* () {
        runs++;
        return (
          <li class={{ done: yield* todo.done }}>
            {yield* todo.title} ({yield* store.todos.length})
          </li>
        );
      });
    }
    const container = document.createElement("div");
    const dispose = render(
      () => (
        <ul>
          {store.todos.map(todo => (
            <Row todo={todo} />
          ))}
        </ul>
      ),
      container
    );
    flush();
    expect(container.innerHTML).toBe(
      '<ul><li>one (2<!---->)</li><li class="done">two (2<!---->)</li></ul>'
    );
    setStore(s => {
      s.todos[0].title = "uno";
      s.todos[0].done = true;
    });
    flush();
    expect(container.innerHTML).toBe(
      '<ul><li class="done">uno (2<!---->)</li><li class="done">two (2<!---->)</li></ul>'
    );
    expect(runs).toBe(2);
    dispose();
  });
});
