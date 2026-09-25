/**
 * @vitest-environment jsdom
 */
// The important user flows of the `$`-block TodoMVC, driven through the
// real DOM (jsdom) with the app compiled by the native compiler — i.e. every
// block in `src/app.tsx` runs in lowered (call-form) mode. The last test
// exercises the runtime generator driver on the same store, for a block the
// compiler leaves alone (it waits).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/web";
import { $, createMemo, createRoot, flush, readStore, wait } from "solid-js";
import { App } from "../src/app";
import { createTodos } from "../src/todos";

// Ids shaped like the app's own (`Date.now()`-prefixed): the mock API keeps
// todos in id order, so a todo added during a test sorts last.
const seed = [
  { id: "1700000000000-a", title: "write blocks", completed: false },
  { id: "1700000000001-b", title: "ship blocks", completed: true }
];

let container: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  // The mock API fails ~33% of saves at random; the flows here are the
  // success paths. (`Math.random` also feeds new ids — a constant is fine.)
  vi.spyOn(Math, "random").mockReturnValue(0.9);
  localStorage.setItem("TODOS", JSON.stringify(seed));
  location.hash = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <App />, container);
  flush();
});

afterEach(() => {
  dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Let the mock API's delays elapse and the reactive graph settle: a write is
 * a 400 ms save followed by a 400 ms re-fetch (`refresh(todos)`).
 */
async function settle() {
  await vi.advanceTimersByTimeAsync(1000);
  flush();
}

const titles = () => [...container.querySelectorAll("li.todo label")].map(l => l.textContent);
const count = () => container.querySelector(".todo-count")?.textContent?.replace(/\s+/g, " ");
function input(selector: string) {
  return container.querySelector<HTMLInputElement>(selector)!;
}
function press(el: HTMLInputElement, key: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}
function check(el: HTMLInputElement, checked: boolean) {
  el.checked = checked;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function click(selector: string) {
  container.querySelector<HTMLElement>(selector)!.click();
}

describe("todos with $ blocks", () => {
  it("shows the loading fallback, then the persisted todos", async () => {
    expect(container.querySelector(".loading")?.textContent).toBe("Loading…");
    await settle();
    expect(container.querySelector(".loading")).toBeNull();
    expect(titles()).toEqual(["write blocks", "ship blocks"]);
    expect(count()).toBe("1 item left");
    const rows = container.querySelectorAll("li.todo");
    expect(rows[0].classList.contains("completed")).toBe(false);
    expect(rows[1].classList.contains("completed")).toBe(true);
    expect(input("#toggle-all").checked).toBe(false);
    expect(container.querySelector(".clear-completed")).not.toBeNull();
  });

  it("adds a todo from the header input (optimistic, then persisted)", async () => {
    await settle();
    const field = input(".new-todo");
    field.value = "  test blocks ";
    press(field, "a");
    expect(titles()).toEqual(["write blocks", "ship blocks"]);
    press(field, "Enter");
    flush();
    // Optimistic row, pending until the API settles; input cleared.
    expect(titles()).toEqual(["write blocks", "ship blocks", "test blocks"]);
    expect(container.querySelectorAll("li.todo")[2].classList.contains("pending")).toBe(true);
    expect(field.value).toBe("");
    expect(count()).toBe("2 items left");
    await settle();
    expect(container.querySelectorAll("li.todo")[2].classList.contains("pending")).toBe(false);
    expect(JSON.parse(localStorage.getItem("TODOS")!).map((t: any) => t.title)).toEqual([
      "write blocks",
      "ship blocks",
      "test blocks"
    ]);

    // An empty title is ignored.
    field.value = "   ";
    press(field, "Enter");
    flush();
    expect(titles()).toHaveLength(3);
  });

  it("toggles an item and mark-all, updating classes and the count", async () => {
    await settle();
    check(container.querySelectorAll<HTMLInputElement>(".toggle")[0], true);
    flush();
    expect(container.querySelectorAll("li.todo")[0].classList.contains("completed")).toBe(true);
    expect(count()).toBe("0 items left");
    expect(input("#toggle-all").checked).toBe(true);
    await settle();
    expect(JSON.parse(localStorage.getItem("TODOS")!).every((t: any) => t.completed)).toBe(true);

    // Mark all as incomplete.
    check(input("#toggle-all"), false);
    flush();
    expect(count()).toBe("2 items left");
    expect(
      [...container.querySelectorAll("li.todo")].map(li => li.classList.contains("completed"))
    ).toEqual([false, false]);
    await settle();
    expect(JSON.parse(localStorage.getItem("TODOS")!).some((t: any) => t.completed)).toBe(false);
  });

  it("filters through the hash and clears completed items", async () => {
    await settle();
    location.hash = "#/active";
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(titles()).toEqual(["write blocks"]);
    expect(container.querySelector("a.selected")?.getAttribute("href")).toBe("#/active");

    location.hash = "#/completed";
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(titles()).toEqual(["ship blocks"]);

    click(".clear-completed");
    flush();
    expect(titles()).toEqual([]);
    await settle();
    expect(container.querySelector(".clear-completed")).toBeNull();
    location.hash = "#/";
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(titles()).toEqual(["write blocks"]);
    expect(count()).toBe("1 item left");
  });

  it("removes an item; the list and footer disappear when empty", async () => {
    await settle();
    click("li.todo .destroy");
    flush();
    expect(titles()).toEqual(["ship blocks"]);
    click("li.todo .destroy");
    flush();
    expect(container.querySelector(".main")).toBeNull();
    expect(container.querySelector(".footer")).toBeNull();
    await settle();
    expect(JSON.parse(localStorage.getItem("TODOS")!)).toEqual([]);
  });

  it("runtime driver: a block the compiler leaves alone reads the same store", async () => {
    // `wait` makes this block unlowerable, so it runs on the generator
    // driver; its store read tracks like the compiled blocks in the app.
    await settle();
    let summary!: () => string;
    createRoot(() => {
      const [todos] = createTodos();
      summary = createMemo(
        $(function* () {
          const remaining = yield* readStore(todos, t => t.filter(x => !x.completed).length);
          const prefix = yield* wait(Promise.resolve("left:"));
          return `${prefix}${remaining}`;
        })
      );
    });
    await settle();
    expect(summary()).toBe("left:1");
  });
});
