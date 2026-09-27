/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
// Generator blocks v2 in the DOM renderer, compiled: bodies are lowered to
// call form, `yield*` works inside JSX, effects are split, and component /
// boundary call forms get lazy props.
import { afterEach, describe, expect, test } from "vitest";
import {
  $cleanup,
  $component,
  $effect,
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
        return <b>{yield* name}</b>;
      };
    });
    const Parent = $component(function* () {
      return function* () {
        return <section>{yield* Child({})}</section>;
      };
    });
    const root = mount();
    const dispose = render(
      // The compiler makes boundary children lazy, so they are created inside
      // the boundary.
      () =>
        Errored({
          fallback: err => <p>error:{err().kind}</p>,
          children: Loading({ fallback: <p>loading</p>, children: Parent({}) })
        }),
      root
    );
    expect(root.textContent).toBe("loading");
    settle(null);
    await landed();
    expect(root.textContent).toBe("error:not-found");
    dispose();
  });

  test("a split $effect reads, writes and cleans up", () => {
    const log: string[] = [];
    let bump!: () => void;
    const C = $component(function* () {
      const [a, setA] = yield* $signal(1);
      const [b, setB] = yield* $signal(0);
      bump = () => void setA(v => v + 1);
      yield* $effect(function* () {
        const v = yield* a;
        yield* setB(v * 10);
        log.push(`run ${v}`);
        yield* $cleanup(() => log.push(`cleanup ${v}`));
      });
      return function* () {
        return <i>{yield* b}</i>;
      };
    });
    const root = mount();
    const dispose = render(() => <C />, root);
    flush();
    expect(root.textContent).toBe("10");
    bump();
    flush();
    expect(root.textContent).toBe("20");
    expect(log).toEqual(["run 1", "cleanup 1", "run 2"]);
    dispose();
    expect(log.at(-1)).toBe("cleanup 2");
  });
});
