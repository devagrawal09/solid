/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
// Generator blocks v2 in the DOM renderer (uncompiled blocks: the compiler
// leaves `$component` bodies as generators until blocks v2 lowering lands).
import { afterEach, describe, expect, test } from "vitest";
import {
  $component,
  $event,
  $memo,
  $signal,
  attempt,
  Errored,
  flush,
  Loading,
  raise,
  type TypedProps
} from "solid-js";
import { render } from "@solidjs/web";

class NotFound extends Error {
  readonly kind = "not-found";
}

async function landed() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
  flush();
}

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

describe("$component in the DOM", () => {
  test("renders as a tag; the view re-renders from its reads; $event handles clicks", () => {
    const Counter = $component(function* (props: TypedProps<{ label: string }>) {
      const [count, setCount] = yield* $signal(0);
      const inc = $event(function* () {
        yield* setCount(c => c + 1);
      });
      return function* () {
        const label = yield* props.label;
        const n = yield* count;
        return (
          <button onClick={inc}>
            {label}:{n}
          </button>
        );
      };
    });
    const root = mount();
    const dispose = render(() => <Counter label="n" />, root);
    expect(root.textContent).toBe("n:0");
    root.querySelector("button")!.click();
    flush();
    expect(root.textContent).toBe("n:1");
    dispose();
  });

  test("Loading / Errored call forms handle a pending, fallible child", async () => {
    let settle!: (v: { name: string } | null) => void;
    const User = $component(function* (props: TypedProps<{ id: string }>) {
      const user = yield* $memo(function* () {
        const id = yield* props.id;
        const u = yield* attempt(
          () => new Promise<{ name: string } | null>(r => (settle = r)),
          NotFound
        );
        if (!u) return yield* raise(new NotFound(id));
        return u;
      });
      return function* () {
        const u = yield* user;
        return <h3>{u.name}</h3>;
      };
    });
    const App = $component(function* () {
      return function* () {
        return (
          <main>
            {Errored({
              fallback: err => <p>error:{err().kind}</p>,
              children: Loading({ fallback: <p>loading</p>, children: User({ id: "1" }) })
            })}
          </main>
        );
      };
    });
    const root = mount();
    const dispose = render(() => <App />, root);
    expect(root.textContent).toBe("loading");
    settle({ name: "Ada" });
    await landed();
    expect(root.textContent).toBe("Ada");
    dispose();
  });

  test("a raised failure reaches Errored; yield* Child propagates to the parent's boundary", async () => {
    let settle!: (v: string | null) => void;
    const Child = $component(function* () {
      const name = yield* $memo(function* () {
        const v = yield* attempt(() => new Promise<string | null>(r => (settle = r)), NotFound);
        if (v === null) return yield* raise(new NotFound());
        return v;
      });
      return function* () {
        const n = yield* name;
        return <b>{n}</b>;
      };
    });
    const Parent = $component(function* () {
      return function* () {
        // Hoisted: the JSX transform wraps expressions in closures, so a
        // `yield*` inside JSX needs blocks v2 compiler lowering.
        const child = yield* Child({});
        return <section>{child}</section>;
      };
    });
    const root = mount();
    const dispose = render(
      // Uncompiled, a boundary's children must be lazy (a getter) so they are
      // created inside the boundary; the compiler emits the getters.
      () =>
        Errored({
          fallback: err => <p>error:{err().kind}</p>,
          get children() {
            return Loading({
              fallback: <p>loading</p>,
              get children() {
                return Parent({});
              }
            });
          }
        }),
      root
    );
    expect(root.textContent).toBe("loading");
    settle(null);
    await landed();
    expect(root.textContent).toBe("error:not-found");
    dispose();
  });
});
