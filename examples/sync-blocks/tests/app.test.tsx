/**
 * @vitest-environment jsdom
 */
// The async-free example's user flows, driven through the real DOM. The same
// assertions run on both runtimes: with the capability linker (default: the
// graph is proven async-free and `@solidjs/signals` resolves to the
// async-free entry) and without it (`SOLID_CAPABILITIES=0`: the full
// runtime). The first test pins which runtime the run selected.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import * as runtime from "@solidjs/signals";
import { App } from "../src/app";

const linker = process.env.SOLID_CAPABILITIES !== "0";

let container: HTMLDivElement;
let dispose: () => void;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  dispose = render(() => <App />, container);
  flush();
});

afterEach(() => {
  dispose();
  container.remove();
});

const $ = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;
const items = () => [...container.querySelectorAll("li")].map(li => li.textContent);

function add(title: string) {
  const draft = $<HTMLInputElement>("input.draft");
  draft.value = title;
  draft.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  $<HTMLFormElement>("form.add").dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true })
  );
  flush();
}

function click(selector: string) {
  $<HTMLElement>(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flush();
}

describe("async-free example", () => {
  it(`runs on the ${linker ? "async-free" : "full"} runtime`, () => {
    expect("ASYNC_CAPABILITIES" in runtime).toBe(linker);
  });

  it("adds items and counts the open ones", () => {
    expect(items()).toEqual([]);
    expect(container.querySelector(".count")).toBeNull();
    add("write proofs");
    add("measure");
    expect(items()).toEqual(["write proofs", "measure"]);
    expect($(".count").textContent).toBe("2 items left");
    expect($<HTMLInputElement>("input.draft").value).toBe("");
  });

  it("toggles and filters", () => {
    add("a");
    add("b");
    add("c");
    const labels = container.querySelectorAll("li label");
    labels[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    flush();
    expect($(".count").textContent).toBe("2 items left");
    expect(container.querySelectorAll("li.done")).toHaveLength(1);
    click("button.show-done");
    expect(items()).toEqual(["b"]);
    click("button.show-open");
    expect(items()).toEqual(["a", "c"]);
    click("button.show-all");
    expect(items()).toEqual(["a", "b", "c"]);
  });

  it("recomputes typed arithmetic", () => {
    expect($(".converter span").textContent).toBe("20°C = 68°F");
    click("button.warmer");
    expect($(".converter span").textContent).toBe("25°C = 77°F");
  });

  it("ignores empty submissions", () => {
    add("   ");
    expect(items()).toEqual([]);
  });
});
