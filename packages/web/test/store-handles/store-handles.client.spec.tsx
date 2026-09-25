/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
// Store handles on the client: the handle-compiled `App` renders, updates
// and keeps DOM identity exactly as its handwritten proxy twin.
import { describe, expect, test } from "vitest";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { App, AppHandwritten, api, handwrittenApi, rowRuns } from "./app.jsx";

function mount(Component: () => any) {
  const container = document.createElement("div");
  const dispose = render(() => <Component />, container);
  flush();
  return { container, dispose };
}

describe("store handles, compiled", () => {
  test("renders and updates like the proxy spelling", () => {
    const lowered = mount(App);
    const handwritten = mount(AppHandwritten);
    // An empty `class=""` left by a class-object toggle is normalized: a `$`
    // JSX-block row under `For` re-renders without it after a push — the
    // same with or without store handles, and with the base commit's
    // compiler (pre-existing, outside this slice).
    const html = (c: HTMLElement) => c.innerHTML.replace(/ class=""/g, "");
    const same = () => expect(html(lowered.container)).toBe(html(handwritten.container));
    same();
    expect(lowered.container.querySelector("h1")!.textContent).toBe("Ada");
    const firstLi = lowered.container.querySelector("ul li")!;
    const runs = { ...rowRuns };

    const both = (fn: (s: any) => void) => {
      api.setStore!(fn);
      handwrittenApi.setStore!(fn);
      flush();
      same();
    };
    // A sparse path update: fine-grained, no row block re-runs, same nodes.
    both(s => {
      s.todos[0].title = "uno";
    });
    expect(firstLi.textContent).toBe("uno:first");
    expect(lowered.container.querySelector("ul li")).toBe(firstLi);
    both(s => {
      s.todos[1].meta.done = false;
    });
    both(s => {
      s.user.name = "Grace";
    });
    both(s => {
      s.todos.push({ id: 3, title: "three", meta: { done: true } });
    });
    both(s => {
      s.todos.splice(0, 1);
    });
    // The handed-off rows never re-ran their blocks: every update above was
    // fine-grained through the handle.
    expect(lowered.container.querySelector("ul li")).toBe(firstLi);
    expect([rowRuns.first, rowRuns.second]).toEqual([runs.first, runs.second]);
    lowered.dispose();
    handwritten.dispose();
  });

  test("escapes hand out the store's one proxy", () => {
    const lowered = mount(App);
    const store = api.store;
    expect(store.todos[0].title).toBe("one");
    expect(api.store).toBe(store);
    expect(api.snapshot!()).toEqual({
      user: { name: "Ada" },
      todos: [
        { id: 1, title: "one", meta: { done: false } },
        { id: 2, title: "two", meta: { done: true } }
      ]
    });
    api.setStore!((s: any) => {
      s.todos[0].title = "changed";
    });
    flush();
    expect(store.todos[0].title).toBe("changed");
    expect(lowered.container.querySelector("ul li")!.textContent).toBe("changed:first");
    lowered.dispose();
  });
});
