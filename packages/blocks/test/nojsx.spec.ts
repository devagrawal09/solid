/**
 * The no-JSX flavor (`h`, `html`), no build step: holes are sources and
 * blocks (a bare `function*` too), the view runs once, async suspends and
 * resolves, updates are fine-grained, and the input keeps its text.
 */
import { flush } from "solid-js";
import {
  $,
  $component,
  $event,
  $memo,
  $signal,
  $store,
  attempt,
  For,
  Loading,
  render,
  Show
} from "@solidjs/blocks";
import { h } from "@solidjs/blocks/h";
import { html } from "@solidjs/blocks/html";

const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 3; i++) {
    await tick();
    flush();
  }
}

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
});

for (const flavor of ["h", "html"] as const) {
  describe(flavor, () => {
    it("measured case: runs once, suspends, fine-grained, input kept", async () => {
      let viewRuns = 0;
      let resolve!: (u: { name: string }) => void;
      let inc!: () => void;
      const Greeting = $component(function* () {
        const [n, setN] = yield* $signal(1);
        inc = () => void setN(v => v + 1);
        const user = yield* $memo(function* () {
          return yield* attempt(() => new Promise<{ name: string }>(r => (resolve = r)));
        });
        const cls = $(function* () {
          return (yield* n) > 3 ? "big" : "";
        });
        return function* () {
          viewRuns++;
          return flavor === "h"
            ? h(
                "div",
                h(
                  "p",
                  { class: cls },
                  "Hello ",
                  function* () {
                    return (yield* user).name;
                  },
                  " ",
                  n
                ),
                h("input")
              )
            : html`<div>
                <p class=${cls}>
                  Hello ${function* () {
                    return (yield* user).name;
                  }} ${n}
                </p>
                <input />
              </div>`;
        };
      });
      dispose = render(
        () =>
          flavor === "h"
            ? h("div", Loading({ fallback: "loading", children: Greeting() }))
            : html`<${Loading} fallback="loading"><${Greeting} /><//>`,
        root
      );
      flush();
      expect(root.textContent!.trim()).toBe("loading");
      resolve({ name: "Ada" });
      await settle();
      const p = root.querySelector("p")!;
      const input = root.querySelector("input")!;
      input.value = "typed";
      expect(p.textContent!.trim()).toBe("Hello Ada 1");
      for (let i = 0; i < 3; i++) {
        inc();
        flush();
      }
      expect(p.textContent!.trim()).toBe("Hello Ada 4");
      expect(p.className).toBe("big");
      expect(root.querySelector("p")).toBe(p);
      expect(root.querySelector("input")).toBe(input);
      expect(input.value).toBe("typed");
      expect(viewRuns).toBe(1);
    });

    it("row blocks, store paths, events", () => {
      let rowSetups = 0;
      const App = $component(function* () {
        const [store, setStore] = yield* $store({ items: ["a", "b"] });
        const [show, setShow] = yield* $signal(true);
        const add = $event(function* () {
          setStore(s => {
            s.items.push("c");
          });
        });
        const hide = $event(function* () {
          setShow(false);
        });
        const row = function* (item: any) {
          rowSetups++;
          const [n, setN] = yield* $signal(0);
          const bump = $event(function* () {
            setN(v => v + 1);
          });
          return function* () {
            return flavor === "h"
              ? h("li", { onClick: bump }, item, ":", n)
              : html`<li onClick=${bump}>${item}:${n}</li>`;
          };
        };
        return function* () {
          return flavor === "h"
            ? h(
                "div",
                h("button", { id: "add", onClick: add }, "add"),
                h("ul", For({ each: store.items, children: row })),
                Show({ when: show, children: h("button", { id: "hide", onClick: hide }, "hide") })
              )
            : html`<div>
                <button id="add" onClick=${add}>add</button>
                <ul>
                  <${For} each=${store.items}>${row}<//>
                </ul>
                <${Show} when=${show}><button id="hide" onClick=${hide}>hide</button><//>
              </div>`;
        };
      });
      dispose = render(App as any, root);
      flush();
      const lis = () => [...root.querySelectorAll("li")];
      expect(lis().map(l => l.textContent)).toEqual(["a:0", "b:0"]);
      lis()[1].click();
      flush();
      expect(lis().map(l => l.textContent)).toEqual(["a:0", "b:1"]);
      (root.querySelector("#add") as HTMLButtonElement).click();
      flush();
      expect(lis().map(l => l.textContent)).toEqual(["a:0", "b:1", "c:0"]);
      expect(rowSetups).toBe(3);
      (root.querySelector("#hide") as HTMLButtonElement).click();
      flush();
      expect(root.querySelector("#hide")).toBe(null);
    });
  });
}
