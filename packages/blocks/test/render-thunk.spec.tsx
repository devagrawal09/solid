/**
 * `render(App, root)`, `render(() => <App />, root)` and
 * `render(() => jsx(App, {}), root)` behave the same: the component is created
 * once and keeps its state whatever its view reads (in holes or, re-rendering
 * whole, at its top level), including across a Loading / async round trip.
 */
import { flush } from "solid-js";
import { jsx } from "@solidjs/blocks/jsx-runtime";
import { jsx as coreJsx } from "@solidjs/h/jsx-runtime";
import { $component, $event, $memo, $signal, attempt, Loading, render } from "@solidjs/blocks";

const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 4; i++) {
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
  vi.restoreAllMocks();
});

type Form = "component" | "jsx-thunk" | "jsx-runtime-thunk" | "core-h-jsx-runtime-thunk";
const forms: Form[] = ["component", "jsx-thunk", "jsx-runtime-thunk", "core-h-jsx-runtime-thunk"];
function mount(form: Form, App: any) {
  dispose =
    form === "component"
      ? render(App, root)
      : form === "jsx-thunk"
        ? render(() => <App />, root)
        : form === "jsx-runtime-thunk"
          ? render(() => jsx(App, {}) as any, root)
          : render(() => coreJsx(App, {}) as any, root);
  flush();
}

for (const form of forms) {
  describe(form, () => {
    it("keeps state when the view reads in holes", () => {
      let setups = 0;
      const App = $component(function* () {
        setups++;
        const [n, setN] = yield* $signal(0);
        const inc = $event(function* () {
          setN(v => v + 1);
        });
        return function* () {
          return <button onClick={inc}>{yield* n}</button>;
        };
      });
      mount(form, App);
      root.querySelector("button")!.click();
      flush();
      root.querySelector("button")!.click();
      flush();
      expect(root.textContent).toBe("2");
      expect(setups).toBe(1);
    });

    it("keeps state when the view reads at its top level (re-renders whole)", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      let setups = 0;
      const App = $component(function* () {
        setups++;
        const [n, setN] = yield* $signal(0);
        const inc = $event(function* () {
          setN(v => v + 1);
        });
        return function* () {
          const v = yield* n;
          return <button onClick={inc}>{v}</button>;
        };
      });
      mount(form, App);
      root.querySelector("button")!.click();
      flush();
      root.querySelector("button")!.click();
      flush();
      expect(root.textContent).toBe("2");
      expect(setups).toBe(1);
      expect(error).not.toHaveBeenCalled();
    });

    it("an async view under Loading resolves without recreating the component", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      let setups = 0;
      let resolve!: (v: string) => void;
      const Inner = $component(function* () {
        setups++;
        const [n, setN] = yield* $signal(0);
        const data = yield* $memo(function* () {
          return yield* attempt(() => new Promise<string>(r => (resolve = r)));
        });
        const inc = $event(function* () {
          setN(v => v + 1);
        });
        return function* () {
          const d = yield* data;
          return (
            <button onClick={inc}>
              {d}:{yield* n}
            </button>
          );
        };
      });
      const App = $component(function* () {
        return function* () {
          return <Loading fallback={<i>…</i>}>{Inner()}</Loading>;
        };
      });
      mount(form, App);
      expect(root.textContent).toBe("…");
      resolve("ok");
      await settle();
      expect(root.textContent).toBe("ok:0");
      root.querySelector("button")!.click();
      flush();
      expect(root.textContent).toBe("ok:1");
      expect(setups).toBe(1);
    });
  });
}
