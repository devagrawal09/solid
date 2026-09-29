/**
 * Runtime tests. Views here are written in the form the JSX transform's block
 * rule produces (`{perform(x)}` for `{yield* x}`), so they run with or
 * without the rule; `transform.spec.tsx` covers the `yield*` spelling.
 */
import { flush, createRoot, isPending } from "solid-js";
import {
  $,
  $cleanup,
  $component,
  $effect,
  $event,
  $flush,
  $memo,
  $scope,
  $settled,
  $signal,
  $snapshot,
  $store,
  attempt,
  createContext,
  Errored,
  For,
  Loading,
  Match,
  paths,
  perform,
  raise,
  read,
  readStore,
  render,
  Repeat,
  Show,
  Switch,
  type TypedProps
} from "@solidjs/blocks";
import { createSignal as plainSignal, createStore as plainStore } from "solid-js";

declare const __DEV__: boolean;
/** Dev-only checks (warnings, dev errors) are skipped against production builds. */
const devIt = __DEV__ ? it : it.skip;

const tick = () => new Promise<void>(r => setTimeout(r, 0));
async function settle(times = 3) {
  for (let i = 0; i < times; i++) {
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
  dispose = undefined;
  root.remove();
});

function mount(App: () => any) {
  dispose = render(App as any, root);
  flush();
}

describe("views are fine-grained", () => {
  it("runs the view once; holes update independently; the input keeps its text", () => {
    let viewRuns = 0;
    let bump!: () => void;
    const Counter = $component(function* () {
      const [n, setN] = yield* $signal(0);
      bump = () => void setN(v => v + 1);
      return function* () {
        viewRuns++;
        return (
          <div>
            <p class={{ big: perform(n) > 3 }}>Count {perform(n)}</p>
            <input />
          </div>
        );
      };
    });
    mount(Counter);
    const input = root.querySelector("input")!;
    input.value = "typed";
    for (let i = 0; i < 5; i++) {
      bump();
      flush();
    }
    expect(root.querySelector("p")!.textContent).toBe("Count 5");
    expect(root.querySelector("p")!.className).toBe("big");
    expect(root.querySelector("input")).toBe(input);
    expect(input.value).toBe("typed");
    expect(viewRuns).toBe(1);
  });

  it("an async memo suspends to Loading and resolves; the view still runs once", async () => {
    let viewRuns = 0;
    let resolve!: (v: { name: string }) => void;
    const User = $component(function* () {
      const user = yield* $memo(function* () {
        return yield* attempt(() => new Promise<{ name: string }>(r => (resolve = r)));
      });
      return function* () {
        viewRuns++;
        return <h3>Hello {perform(user).name}</h3>;
      };
    });
    mount(() => <Loading fallback={<i>loading</i>}>{User()}</Loading>);
    expect(root.innerHTML).toContain("<i>loading</i>");
    resolve({ name: "Ada" });
    await settle();
    expect(root.querySelector("h3")!.textContent).toBe("Hello Ada");
    expect(viewRuns).toBe(1);
  });

  devIt("a view that reads at its top level re-renders as a whole, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let set!: (v: number) => void;
    let runs = 0;
    const Whole = $component(function* () {
      const [n, setN] = yield* $signal(1);
      set = v => void setN(v);
      return function* () {
        runs++;
        const v = yield* n;
        return <b>{v}</b>;
      };
    });
    mount(Whole);
    expect(root.textContent).toBe("1");
    set(2);
    flush();
    expect(root.textContent).toBe("2");
    // the first run stops at its first top-level read; the view then runs
    // whole, once per change
    expect(runs).toBe(3);
    expect(warn.mock.calls.some(c => String(c[0]).includes("VIEW_READS_OUTSIDE_JSX"))).toBe(true);
    warn.mockRestore();
  });
});

describe("setup operations", () => {
  it("$memo derives; $effect runs after changes and cleans up; $settled runs once", () => {
    const log: string[] = [];
    let set!: (v: number) => void;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(1);
      set = v => void setN(v);
      const doubled = yield* $memo(function* () {
        return (yield* n) * 2;
      });
      yield* $effect(function* () {
        const d = yield* doubled;
        log.push(`effect ${d}`);
        yield* $cleanup(() => log.push(`cleanup ${d}`));
      });
      yield* $settled(function* () {
        log.push(`settled ${yield* doubled}`);
      });
      return function* () {
        return <span>{perform(doubled)}</span>;
      };
    });
    mount(App);
    expect(root.textContent).toBe("2");
    set(2);
    flush();
    expect(root.textContent).toBe("4");
    expect(log).toEqual(["effect 2", "settled 2", "cleanup 2", "effect 4"]);
  });

  it("an $effect's writes apply", () => {
    let set!: (v: number) => void;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(1);
      const [copy, setCopy] = yield* $signal(0);
      set = v => void setN(v);
      yield* $effect(function* () {
        const v = yield* n;
        const written = yield* setCopy(v * 10);
        expect(written).toBe(v * 10);
      });
      return function* () {
        return <span>{perform(copy)}</span>;
      };
    });
    mount(App);
    flush();
    expect(root.textContent).toBe("10");
    set(3);
    flush();
    flush();
    expect(root.textContent).toBe("30");
  });

  it("$store paths and readStore selections are tracked reads", () => {
    let toggle!: () => void;
    const App = $component(function* () {
      const [todos, setTodos] = yield* $store({ list: [{ title: "a", done: false }] });
      toggle = () =>
        void setTodos(s => {
          s.list[0].done = !s.list[0].done;
        });
      const remaining = readStore(todos, t => t.list.filter(x => !x.done).length);
      return function* () {
        return (
          <p>
            {perform(todos.list[0].title)} {String(perform(todos.list[0].done))}{" "}
            {perform(remaining)}
          </p>
        );
      };
    });
    mount(App);
    expect(root.textContent).toBe("a false 1");
    toggle();
    flush();
    expect(root.textContent).toBe("a true 0");
  });

  devIt("$snapshot takes a value in a setup; setup reads are dev errors", () => {
    const Child = $component(function* (props: TypedProps<{ start: number }>) {
      const start = yield* $snapshot(props.start);
      const [n] = yield* $signal(start * 2);
      return function* () {
        return <i>{perform(n)}</i>;
      };
    });
    mount(() => <Child start={21} />);
    expect(root.textContent).toBe("42");
    // @ts-expect-error a setup does not read (Read is not a SetupOp)
    const Bad = $component(function* (props: TypedProps<{ start: number }>) {
      const v = yield* props.start;
      return function* () {
        return <i>{v}</i>;
      };
    });
    expect(() => createRoot(() => Bad({ start: 1 }))).toThrow(/READ_IN_SETUP/);
  });

  devIt("creating outside a setup and writing in a memo are dev errors", () => {
    // @ts-expect-error a view only reads (Create is not a ViewOp)
    const CreatesInView = $component(function* () {
      return function* () {
        const [x] = yield* $signal(1);
        return <i>{perform(x)}</i>;
      };
    });
    expect(() => createRoot(() => CreatesInView())).toThrow(/CREATE_OUTSIDE_SETUP/);
    let error: unknown;
    const WritesInMemo = $component(function* () {
      const [n, setN] = yield* $signal(1);
      const m = yield* $memo(function* () {
        try {
          setN(2);
        } catch (e) {
          error = e;
        }
        return yield* n;
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(WritesInMemo);
    expect(String(error)).toMatch(/WRITE_IN_REACTIVE/);
  });
});

describe("setups inside a parent's first view run", () => {
  it("a child's $snapshot is not a read at the parent view's top level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let parentRuns = 0;
    const Leaf = $component(function* (props: TypedProps<{ n: number }>) {
      const n = yield* $snapshot(props.n);
      return function* () {
        return <i>{n}</i>;
      };
    });
    const Parent = $component(function* () {
      return function* () {
        parentRuns++;
        return <p>{perform(Leaf({ n: 1 }))}</p>;
      };
    });
    mount(Parent);
    expect(root.textContent).toBe("1");
    expect(parentRuns).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("props", () => {
  it("props are reads; forwarding a source forwards the read; paths walk deep", () => {
    let setName!: (v: string) => void;
    let childRuns = 0;
    const Card = $component(function* (props: TypedProps<{ user: { name: string }; tag: string }>) {
      return function* () {
        childRuns++;
        return (
          <p>
            {perform(props.tag)}:{perform(props.user.name)}
          </p>
        );
      };
    });
    const Parent = $component(function* () {
      const [user, setUser] = yield* $signal({ name: "a" });
      setName = name => void setUser({ name });
      return function* () {
        return <Card user={user} tag="t" />;
      };
    });
    mount(Parent);
    expect(root.textContent).toBe("t:a");
    setName("b");
    flush();
    expect(root.textContent).toBe("t:b");
    expect(childRuns).toBe(1);
  });

  it("foreign accessors and stores: read(), paths()", () => {
    const [count, setCount] = plainSignal(1);
    const [store, setStore] = plainStore({ a: { b: 2 } });
    const App = $component(function* () {
      const c = read(count);
      const s = paths(store);
      const sum = yield* $memo(function* () {
        return (yield* c) + (yield* s.a.b);
      });
      return function* () {
        return <i>{perform(sum)}</i>;
      };
    });
    mount(App);
    expect(root.textContent).toBe("3");
    setCount(10);
    setStore(s => {
      s.a.b = 5;
    });
    flush();
    expect(root.textContent).toBe("15");
  });
});

describe("context", () => {
  it("yield* Ctx reads a context in a setup", () => {
    const Theme = createContext<string>("light");
    const Child = $component(function* () {
      const theme = yield* Theme;
      return function* () {
        return <i>{theme}</i>;
      };
    });
    mount(() => <Theme value="dark">{Child()}</Theme>);
    expect(root.textContent).toBe("dark");
  });
});

describe("events", () => {
  it("$event reads current values, writes, flushes, and waits on an async attempt", async () => {
    let resolve!: () => void;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(0);
      const [status, setStatus] = yield* $signal("idle");
      const click = $event(function* () {
        const v = yield* n;
        setN(v + 1);
        yield* $flush();
        setStatus("saving");
        yield* attempt(() => new Promise<void>(r => (resolve = r)));
        setStatus("saved");
      });
      return function* () {
        return (
          <button onClick={click}>
            {perform(n)} {perform(status)}
          </button>
        );
      };
    });
    mount(App);
    root.querySelector("button")!.click();
    flush();
    expect(root.textContent).toBe("1 saving");
    resolve();
    await settle();
    expect(root.textContent).toBe("1 saved");
  });

  it("a failing $event goes to the nearest Errored", async () => {
    class SaveError extends Error {}
    const App = $component(function* () {
      const click = $event(function* () {
        yield* raise(new SaveError("nope"));
      });
      return function* () {
        return <button onClick={click}>go</button>;
      };
    });
    mount(() => <Errored fallback={(e: any) => <p>failed: {e().message}</p>}>{App()}</Errored>);
    root.querySelector("button")!.click();
    await settle();
    expect(root.textContent).toBe("failed: nope");
  });

  it("a memo's raise reaches Errored", () => {
    class Missing extends Error {}
    const App = $component(function* () {
      const m = yield* $memo(function* () {
        yield* raise(new Missing("missing"));
        return 1;
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(() => <Errored fallback={(e: any) => <p>{e().message}</p>}>{App()}</Errored>);
    expect(root.textContent).toBe("missing");
  });
});

describe("row blocks", () => {
  it("per-row state in a For; updating the list keeps rows (issue: views re-rendered on re-walk)", () => {
    let setItems!: (v: { id: number; text: string }[]) => void;
    let setups = 0;
    let views = 0;
    const List = $component(function* () {
      const [items, set] = yield* $signal([
        { id: 1, text: "a" },
        { id: 2, text: "b" }
      ]);
      setItems = v => void set(v);
      return function* () {
        return (
          <ul>
            <For each={perform(items)}>
              {function* (item) {
                setups++;
                const [open, setOpen] = yield* $signal(false);
                const toggle = $event(function* () {
                  setOpen(o => !o);
                });
                return function* () {
                  views++;
                  return (
                    <li onClick={toggle}>
                      {perform(item.text)} {perform(open) ? "[-]" : "[+]"}
                    </li>
                  );
                };
              }}
            </For>
          </ul>
        );
      };
    });
    mount(List);
    const first = root.querySelector("li")!;
    first.click();
    flush();
    expect(root.textContent).toBe("a [-]b [+]");
    setItems([
      { id: 0, text: "z" },
      ...[...root.querySelectorAll("li")].map((_, i) => ({ id: i + 1, text: "ab"[i] }))
    ]);
    flush();
    // Keyed by reference: new objects are new rows; the state belongs to the row.
    expect(root.querySelectorAll("li").length).toBe(3);
    expect(setups).toBe(5);
    expect(views).toBe(5);
  });

  it("rows survive re-reads of the For output (same objects)", () => {
    const rows = [{ t: "a" }, { t: "b" }];
    let set!: (v: typeof rows) => void;
    let views = 0;
    const Row = $component(function* (props: TypedProps<{ row: { t: string } }>) {
      const [n] = yield* $signal(0);
      return function* () {
        views++;
        return (
          <li>
            {perform(props.row.t)}
            {perform(n)}
          </li>
        );
      };
    });
    const App = $component(function* () {
      const [items, setItems] = yield* $signal(rows);
      set = v => void setItems(v);
      return function* () {
        return (
          <ul>
            <For each={perform(items)}>{row => <Row row={row} />}</For>
          </ul>
        );
      };
    });
    mount(App);
    const lis = [...root.querySelectorAll("li")];
    set([...rows, { t: "c" }]);
    flush();
    set([...rows].reverse());
    flush();
    const after = [...root.querySelectorAll("li")];
    expect(after[1]).toBe(lis[0]);
    expect(after[0]).toBe(lis[1]);
    expect(views).toBe(3);
  });

  it("named recursive row blocks, $() and $scope rows, Show / Match / Repeat branches", () => {
    type C = { id: number; kids: C[] };
    const tree: C[] = [{ id: 1, kids: [{ id: 2, kids: [] }] }];
    const Thread = $component(function* () {
      function* comment(c: any) {
        const [open] = yield* $signal(true);
        return function* () {
          return (
            <li>
              {perform(c.id)}
              <Show when={perform(open)}>
                <ul>
                  <For each={perform(c.kids)}>{comment}</For>
                </ul>
              </Show>
            </li>
          );
        };
      }
      return function* () {
        return <For each={tree}>{comment}</For>;
      };
    });
    mount(Thread);
    expect(root.querySelectorAll("li").length).toBe(2);
    dispose!();
    root.textContent = "";

    const [when, setWhen] = plainSignal<{ name: string } | undefined>({ name: "x" });
    const App = $component(function* () {
      return function* () {
        return (
          <div>
            <Show when={when()} keyed>
              {$(function* (v: any) {
                const [k] = yield* $signal("!");
                return function* () {
                  return (
                    <b>
                      {perform(v.name)}
                      {perform(k)}
                    </b>
                  );
                };
              })}
            </Show>
            <Switch>
              <Match when={when()}>
                {$scope(function* (v: any) {
                  return function* () {
                    return <s>{perform(v.name)}</s>;
                  };
                })}
              </Match>
            </Switch>
            <Repeat count={2}>
              {function* (i) {
                const [x] = yield* $signal(10);
                return function* () {
                  return <u>{perform(i) + perform(x)}</u>;
                };
              }}
            </Repeat>
          </div>
        );
      };
    });
    mount(App);
    expect(root.querySelector("b")!.textContent).toBe("x!");
    expect(root.querySelector("s")!.textContent).toBe("x");
    expect([...root.querySelectorAll("u")].map(u => u.textContent)).toEqual(["10", "11"]);
    setWhen({ name: "y" });
    flush();
    expect(root.querySelector("b")!.textContent).toBe("y!");
    expect(root.querySelector("s")!.textContent).toBe("y");
  });

  it("a Show's direct child view is not rebuilt when the Show re-reads", () => {
    let views = 0;
    const [flag, setFlag] = plainSignal(1);
    const Child = $component(function* () {
      return function* () {
        views++;
        return <i>child</i>;
      };
    });
    mount(() => <Show when={flag()}>{Child()}</Show>);
    const i = root.querySelector("i");
    setFlag(2);
    flush();
    setFlag(3);
    flush();
    expect(root.querySelector("i")).toBe(i);
    expect(views).toBe(1);
  });
});

describe("hole blocks", () => {
  it("$() is a fine-grained child and readable with yield*", () => {
    let set!: (v: number) => void;
    let runs = 0;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(2);
      set = v => void setN(v);
      const doubled = $(function* () {
        runs++;
        return (yield* n) * 2;
      });
      const plusOne = yield* $memo(function* () {
        return (yield* doubled) + 1;
      });
      return function* () {
        return (
          <p>
            {doubled} {perform(plusOne)}
          </p>
        );
      };
    });
    mount(App);
    expect(root.textContent).toBe("4 5");
    set(5);
    flush();
    expect(root.textContent).toBe("10 11");
    expect(runs).toBe(4);
  });
});

describe("attempt / isPending interplay", () => {
  it("a memo that waits is pending, and a superseded run is closed", async () => {
    const resolvers: ((v: number) => void)[] = [];
    let after = 0;
    let set!: (v: number) => void;
    const App = $component(function* () {
      const [id, setId] = yield* $signal(1);
      set = v => void setId(v);
      const m = yield* $memo(function* () {
        const i = yield* id;
        const v = yield* attempt(() => new Promise<number>(r => resolvers.push(r)));
        after++;
        return v + i;
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(() => <Loading fallback="…">{App()}</Loading>);
    set(2);
    flush();
    resolvers[0](100);
    resolvers[1](200);
    await settle();
    expect(root.textContent).toBe("202");
    expect(after).toBe(1);
    void isPending;
  });
});
