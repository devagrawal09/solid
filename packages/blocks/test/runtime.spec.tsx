/**
 * Runtime tests. Views here are written in the form the JSX transform's block
 * rule produces (`{perform(x)}` for `{yield* x}`), so they run with or
 * without the rule; `transform.spec.tsx` covers the `yield*` spelling.
 */
import { flush, createRoot, isPending, lazy as plainLazy, Reveal, untrack } from "solid-js";
import {
  $,
  $cleanup,
  $component,
  $dynamic,
  $effect,
  $event,
  $memo,
  $optimistic,
  $optimisticStore,
  $projection,
  isPendingOf,
  $scope,
  $settled,
  $signal,
  $snapshot,
  $store,
  adopt,
  attempt,
  createContext,
  Errored,
  For,
  Loading,
  Match,
  perform,
  raise,
  readStore,
  refresh,
  render,
  Repeat,
  rowArg,
  Show,
  start,
  Switch,
  until,
  type TypedProps
} from "@solidjs/blocks";
import { createSignal as plainSignal } from "solid-js";
import { INSTANCE, registerInstance } from "../src/runtime.js";

declare const __DEV__: boolean;
/** Dev-only checks (warnings, dev errors) are skipped against production builds. */
const devIt = __DEV__ ? it : it.skip;

const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** An attempt's handler in these tests: what failed, as an Error. */
const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** A write driven from plain test code (no block host): what `yield*` does in an $event. */
const write = (receipt: Iterable<unknown>): void => void [...receipt];
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
      bump = () => write(setN(v => v + 1));
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
        return yield* attempt(() => new Promise<{ name: string }>(r => (resolve = r)), toError);
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

  it("a memo with a loadingValue renders it without a boundary, then its answer", async () => {
    let resolve!: (v: { name: string }) => void;
    const User = $component(function* () {
      const user = yield* $memo(
        function* () {
          return yield* attempt(() => new Promise<{ name: string }>(r => (resolve = r)), toError);
        },
        { loadingValue: { name: "…" } }
      );
      const pending = isPendingOf(user);
      return function* () {
        return <h3 class={{ pending: perform(pending) }}>Hello {perform(user).name}</h3>;
      };
    });
    mount(User);
    expect(root.querySelector("h3")!.textContent).toBe("Hello …");
    resolve({ name: "Ada" });
    await settle();
    expect(root.querySelector("h3")!.textContent).toBe("Hello Ada");
    expect(root.querySelector("h3")!.className).toBe("");
  });

  devIt("a view that reads at its top level re-renders as a whole, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let set!: (v: number) => void;
    let runs = 0;
    const Whole = $component(function* () {
      const [n, setN] = yield* $signal(1);
      set = v => write(setN(v));
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

describe("components", () => {
  it("a named setup names the component (dev owner labels)", () => {
    const Greeting = $component(function* Greeting() {
      return function* () {
        return <b>hi</b>;
      };
    });
    const Anonymous = $component(function* () {
      return function* () {
        return <b>hi</b>;
      };
    });
    expect(Greeting.name).toBe("Greeting");
    expect(Anonymous.name).toBe("component");
  });
});

describe("setup operations", () => {
  it("$memo derives; $effect runs after changes and cleans up; $settled runs once", () => {
    const log: string[] = [];
    let set!: (v: number) => void;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(1);
      set = v => write(setN(v));
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
      set = v => write(setN(v));
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
        write(
          setTodos(s => {
            s.list[0].done = !s.list[0].done;
          })
        );
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
          write(setN(2));
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

describe("the runtime's other dev errors", () => {
  // Each is also a type error or a lint error where the syntax allows it;
  // these reach the runtime through casts / plain JS.
  const hole = (body: () => Generator<unknown, unknown, unknown>) =>
    $(body as () => Generator<never, unknown, unknown>);

  devIt("operations in the wrong host", () => {
    const Ctx = createContext("x");
    // an async attempt suspends: only a $memo or an $event may wait
    expect(() =>
      perform(
        hole(function* () {
          return yield* attempt(() => Promise.resolve(1), toError);
        })
      )
    ).toThrow(/ASYNC_NOT_ALLOWED/);
    // a plain yield is not an operation
    expect(() =>
      perform(
        hole(function* () {
          yield 1;
        })
      )
    ).toThrow(/NOT_AN_OPERATION/);
    // $cleanup belongs to a setup or an effect
    expect(() =>
      perform(
        hole(function* () {
          yield* $cleanup(() => {});
        })
      )
    ).toThrow(/CLEANUP_OUTSIDE_OWNER/);
    // yield* Ctx belongs to a setup
    expect(() =>
      perform(
        hole(function* () {
          return yield* Ctx;
        })
      )
    ).toThrow(/CONTEXT_OUTSIDE_SETUP/);
  });

  devIt("a setup returns its view; a path is not writable", () => {
    const NoView = $component(function* () {
      return 1;
    } as unknown as () => Generator<never, () => Generator<never, null>>);
    expect(() => createRoot(() => NoView())).toThrow(/COMPONENT_VIEW/);
    const p = rowArg({ a: 1 }, false) as unknown as { a: number };
    expect(() => {
      p.a = 2;
    }).toThrow(/PATH_WRITE/);
  });

  devIt("a second copy of the runtime is an error naming both module URLs", async () => {
    const g = globalThis as any;
    // this copy registered itself when it loaded
    const registered = g[INSTANCE] as { url: string };
    expect(registered.url).toMatch(/\/src\/runtime\.ts$/);
    try {
      // the same module evaluated again at its URL (a re-import) is not a copy
      await import("../src/runtime.ts?again" as string);
      // another copy (a duplicated dependency) loaded first: loading this one fails
      const other = "file:///app/node_modules/.pnpm/@solidjs+blocks@0.0.0/dist/blocks.dev.js";
      g[INSTANCE] = { url: other };
      let error: unknown;
      try {
        await import("../src/runtime.ts?copy" as string);
      } catch (e) {
        error = e;
      }
      expect(String(error)).toMatch(/DUPLICATE_RUNTIME/);
      expect(String(error)).toContain(other);
      expect(String(error)).toContain(registered.url);
      // a copy whose URL is unknown cannot be told apart from another one
      expect(() => registerInstance(undefined)).toThrow(/DUPLICATE_RUNTIME.*\(unknown URL\)/);
    } finally {
      g[INSTANCE] = registered;
    }
  });

  devIt("a memo's reads after its first async attempt are errors", async () => {
    const Late = $component(function* () {
      const [n] = yield* $signal(1);
      const m = yield* $memo(function* () {
        yield* attempt(() => Promise.resolve(0), toError);
        return yield* n;
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(() => (
      <Loading fallback="…">
        <Errored fallback={e => <b>{String(e())}</b>}>{Late()}</Errored>
      </Loading>
    ));
    await settle();
    expect(root.textContent).toMatch(/READ_AFTER_ATTEMPT/);
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
      setName = name => write(setUser({ name }));
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

  it("a setter call does nothing until it is delegated to", () => {
    let poke!: () => void;
    let bump!: () => void;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(0);
      poke = () => void setN(1);
      bump = () => write(setN(2));
      return function* () {
        return <i>{perform(n)}</i>;
      };
    });
    mount(App);
    poke();
    flush();
    expect(root.textContent).toBe("0");
    bump();
    flush();
    expect(root.textContent).toBe("2");
  });

  it("$optimistic / $optimisticStore: an $event's writes show at once and revert when it settles", async () => {
    let resolve!: () => void;
    const App = $component(function* () {
      const [saving, setSaving] = yield* $optimistic(false);
      const [list, setList] = yield* $optimisticStore({ items: ["a"] });
      const add = $event(function* () {
        yield* setSaving(true);
        yield* setList(s => {
          s.items.push("b");
        });
        yield* attempt(() => new Promise<void>(r => (resolve = r)), toError);
      });
      return function* () {
        return (
          <button onClick={add}>
            {String(perform(saving))} {perform(readStore(list, s => s.items.join(",")))}
          </button>
        );
      };
    });
    mount(App);
    root.querySelector("button")!.click();
    flush();
    expect(root.textContent).toBe("true a,b");
    resolve();
    await settle();
    expect(root.textContent).toBe("false a");
  });

  it("a derived $optimisticStore waits on its body; refresh recomputes it", async () => {
    let calls = 0;
    let reload!: () => void;
    const App = $component(function* () {
      const [todos] = yield* $optimisticStore(function* () {
        const n = ++calls;
        return yield* attempt(() => Promise.resolve([`t${n}`]), toError);
      }, [] as string[]);
      const again = $event(function* () {
        yield* refresh(todos);
      });
      reload = () => void again();
      return function* () {
        return <i>{perform(readStore(todos, t => t.join(",")))}</i>;
      };
    });
    mount(() => <Loading fallback={<b>wait</b>}>{App()}</Loading>);
    expect(root.textContent).toBe("wait");
    await settle();
    expect(root.textContent).toBe("t1");
    reload();
    await settle();
    expect(root.textContent).toBe("t2");
  });

  it("$projection derives a store from block reads", () => {
    let setN!: (v: number) => void;
    const App = $component(function* () {
      const [n, set] = yield* $signal(1);
      setN = v => write(set(v));
      const view = yield* $projection(
        function* (draft: { doubled: number }) {
          draft.doubled = (yield* n) * 2;
        },
        { doubled: 0 }
      );
      return function* () {
        return <i>{perform(view.doubled)}</i>;
      };
    });
    mount(App);
    expect(root.textContent).toBe("2");
    setN(4);
    flush();
    expect(root.textContent).toBe("8");
  });

  it("until waits in an $event until a source reads truthy", async () => {
    let ready!: () => void;
    let done = false;
    const App = $component(function* () {
      const [ok, setOk] = yield* $signal(false);
      ready = () => write(setOk(true));
      const go = $event(function* () {
        yield* until(ok, toError);
        done = true;
      });
      return function* () {
        return <button onClick={go}>go</button>;
      };
    });
    mount(App);
    root.querySelector("button")!.click();
    await settle();
    expect(done).toBe(false);
    ready();
    await settle();
    expect(done).toBe(true);
  });

  it("$dynamic renders what its body returns and re-runs on its reads", () => {
    let setWhich!: (v: "a" | "b") => void;
    const A = () => <i>A</i>;
    const B = () => <b>B</b>;
    const App = $component(function* () {
      const [which, set] = yield* $signal<"a" | "b">("a");
      setWhich = v => write(set(v));
      const View = yield* $dynamic(function* () {
        return (yield* which) === "a" ? A : B;
      });
      return function* () {
        return (
          <div>
            <View />
          </div>
        );
      };
    });
    mount(App);
    expect(root.textContent).toBe("A");
    setWhich("b");
    flush();
    expect(root.textContent).toBe("B");
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
  it("$event is an action: its writes are one transaction across an async attempt", async () => {
    let resolve!: () => void;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(0);
      const [status, setStatus] = yield* $signal("idle");
      const click = $event(function* () {
        const v = yield* n;
        yield* setN(v + 1);
        yield* setStatus("saving");
        yield* attempt(() => new Promise<void>(r => (resolve = r)), toError);
        yield* setStatus("saved");
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
    // held by the transaction: nothing the handler wrote shows while it waits
    expect(root.textContent).toBe("0 idle");
    resolve();
    await settle();
    expect(root.textContent).toBe("1 saved");
  });

  it("$event takes arguments, returns its result, and throws a rejection at the yield*", async () => {
    class SaveError extends Error {}
    const caught: string[] = [];
    const save = $event(function* (id: string, times: number) {
      try {
        yield* attempt(
          () => Promise.reject(new SaveError(id)),
          e => e as SaveError
        );
      } catch (e) {
        caught.push((e as Error).message);
      }
      return id.repeat(times);
    });
    expect(await save("a", 3)).toBe("aaa");
    expect(caught).toEqual(["a"]);
  });

  it("a failure the caller handles goes to the caller, not to the Errored", async () => {
    let caught: unknown;
    let save!: () => Promise<unknown>;
    const App = $component(function* () {
      const failing = $event(function* () {
        yield* raise(new Error("declined"));
      });
      save = () => failing().catch(e => (caught = e));
      return function* () {
        return <p>ok</p>;
      };
    });
    mount(() => <Errored fallback={(e: any) => <p>failed: {e().message}</p>}>{App()}</Errored>);
    await save();
    await settle();
    expect((caught as Error).message).toBe("declined");
    expect(root.textContent).toBe("ok");
  });

  it("an event that reads a pending source waits for its data", async () => {
    let resolve!: (v: number) => void;
    let seen: number | undefined;
    let go!: () => unknown;
    const App = $component(function* () {
      const data = yield* $memo(function* () {
        return yield* attempt(() => new Promise<number>(r => (resolve = r)), toError);
      });
      const take = $event(function* () {
        seen = yield* data;
      });
      go = () => take();
      return function* () {
        return <p>ok</p>;
      };
    });
    mount(App);
    go();
    await settle();
    expect(seen).toBe(undefined);
    resolve(7);
    await settle();
    expect(seen).toBe(7);
  });

  it("yield* a call of another event waits for it, returns its result, and throws its failure", async () => {
    let resolve!: (v: number) => void;
    const log: string[] = [];
    const fetchN = $event(function* () {
      return yield* attempt(() => new Promise<number>(r => (resolve = r)), toError);
    });
    const fail = $event(function* () {
      yield* raise(new Error("no"));
    });
    const outer = $event(function* () {
      const n = yield* fetchN();
      log.push(`got ${n}`);
      try {
        yield* fail();
      } catch (e) {
        log.push((e as Error).message);
      }
    });
    const done = outer();
    await settle();
    expect(log).toEqual([]);
    resolve(3);
    await done;
    expect(log).toEqual(["got 3", "no"]);
  });

  it("start runs an event call without waiting for it", async () => {
    let resolve!: () => void;
    const order: string[] = [];
    const slow = $event(function* () {
      yield* attempt(() => new Promise<void>(r => (resolve = r)), toError);
      order.push("slow done");
    });
    const outer = $event(function* () {
      yield* start(slow());
      order.push("outer done");
    });
    await outer();
    expect(order).toEqual(["outer done"]);
    resolve();
    await settle();
    expect(order).toEqual(["outer done", "slow done"]);
  });

  it("an $effect delegates to a synchronous event call", () => {
    const seen: number[] = [];
    let setN!: (v: number) => void;
    const record = $event(function* (v: number) {
      seen.push(v);
    });
    const App = $component(function* () {
      const [n, set] = yield* $signal(1);
      setN = v => write(set(v));
      yield* $effect(function* () {
        yield* record(yield* n);
      });
      return function* () {
        return <p />;
      };
    });
    mount(App);
    flush();
    setN(2);
    flush();
    expect(seen).toEqual([1, 2]);
  });

  it("a failing $event with no Errored rejects its promise", async () => {
    const fail = $event(function* () {
      yield* raise(new Error("nope"));
    });
    await expect(fail()).rejects.toThrow("nope");
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

  it("an Errored with catch handles the error types it lists", () => {
    class NotFound extends Error {
      readonly kind = "not-found";
    }
    const Fails = $component(function* () {
      const m = yield* $memo(function* () {
        yield* raise(new NotFound("nf"));
        return 1;
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(() => (
      <Errored fallback={(e: any) => <p>outer: {e().message}</p>}>
        {Errored({
          catch: [NotFound],
          fallback: (e: any) => <p>inner: {e().message}</p>,
          children: () => Fails()
        })}
      </Errored>
    ));
    expect(root.textContent).toBe("inner: nf");
  });

  it("an Errored with catch rethrows any other error to the boundary above", () => {
    class NotFound extends Error {
      readonly kind = "not-found";
    }
    class Forbidden extends Error {
      readonly kind = "forbidden";
    }
    const Fails = $component(function* () {
      const m = yield* $memo(function* () {
        yield* raise(new Forbidden("no"));
        return 1;
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(() => (
      <Errored fallback={(e: any) => <p>outer: {e().message}</p>}>
        {Errored({
          catch: [NotFound],
          fallback: (e: any) => <p>inner: {e().message}</p>,
          children: () => Fails()
        })}
      </Errored>
    ));
    expect(root.textContent).toBe("outer: no");
  });

  it("a body's attempt types a returned promise's failure", async () => {
    class LoadError extends Error {
      readonly kind = "load";
    }
    const Loads = $component(function* () {
      const m = yield* $memo(function* () {
        return yield* attempt(
          () => Promise.reject(new Error("boom")),
          e => new LoadError((e as Error).message)
        );
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(() => (
      <Errored
        fallback={(e: any) => (
          <p>
            {e() instanceof LoadError ? "load" : "other"}: {e().message}
          </p>
        )}
      >
        {Loading({ children: () => Loads() })}
      </Errored>
    ));
    await settle();
    expect(root.textContent).toBe("load: boom");
  });

  it("a body's attempt gives back a stream whose failures it types", async () => {
    class StreamError extends Error {
      readonly kind = "stream";
    }
    const Streams = $component(function* () {
      const m = yield* $memo(function* () {
        return yield* attempt(
          () =>
            (async function* () {
              yield 1;
              throw new Error("cut");
            })(),
          e => new StreamError((e as Error).message)
        );
      });
      return function* () {
        return <i>{perform(m)}</i>;
      };
    });
    mount(() => (
      <Errored
        fallback={(e: any) => (
          <p>
            {e() instanceof StreamError ? "stream" : "other"}: {e().message}
          </p>
        )}
      >
        {Loading({ children: () => Streams() })}
      </Errored>
    ));
    await settle(6);
    expect(root.textContent).toBe("stream: cut");
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
      setItems = v => write(set(v));
      return function* () {
        return (
          <ul>
            <For each={perform(items)}>
              {function* (item) {
                setups++;
                const [open, setOpen] = yield* $signal(false);
                const toggle = $event(function* () {
                  yield* setOpen(o => !o);
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
      set = v => write(setItems(v));
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

describe("reads from JSX positions are never a view's or a setup's own", () => {
  it("plain Solid code reading a prop getter untracked while a child view is built (Reveal registering a Loading)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let resolve!: (v: string) => void;
    let cardViews = 0;
    const Card = $component(function* () {
      const v = yield* $memo(function* () {
        return yield* attempt(() => new Promise<string>(r => (resolve = r)), toError);
      });
      return function* () {
        cardViews++;
        return (
          <Loading fallback={<i>loading</i>}>
            <b>{perform(v)}</b>
          </Loading>
        );
      };
    });
    // a plain component that reads its prop untracked when it is created
    let seen: unknown;
    const Probe = (props: { value: unknown; children: unknown }) => {
      seen = untrack(() => props.value);
      return props.children as never;
    };
    const Page = $component(function* () {
      const [order] = yield* $signal<"sequential" | "together">("sequential");
      const [label] = yield* $signal("x");
      return function* () {
        return (
          <div>
            <Probe value={perform(label)}>{Card()}</Probe>
            <Reveal order={perform(order)}>
              {Card()}
              {Card()}
            </Reveal>
          </div>
        );
      };
    });
    mount(Page);
    expect(seen).toBe("x");
    expect(root.textContent).toBe("loadingloadingloading");
    resolve("done");
    await settle();
    expect(warn.mock.calls.some(c => String(c[0]).includes("VIEW_READS_OUTSIDE_JSX"))).toBe(false);
    expect(cardViews).toBe(3);
    warn.mockRestore();
  });
});

describe("a view that is a function is a branch's content", () => {
  it("Show / Match render it (a whole-view component, an adopted lazy page) instead of calling it as a render callback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [n, setN] = plainSignal(1);
    // reads at its top level: its output is a memo (a function marked as a view)
    const Whole = $component(function* (props: TypedProps<{ n: number }>) {
      return function* () {
        const v = yield* props.n;
        return <b>{v}</b>;
      };
    });
    const Page = adopt(plainLazy(() => Promise.resolve({ default: Whole })));
    const [on, setOn] = plainSignal<string | false>("a");
    const nProps = {
      get n() {
        return n();
      }
    };
    mount(() => (
      <div>
        <Show when={on()}>{Whole(nProps)}</Show>
        <Switch>
          <Match when={on()}>{perform(Page(nProps))}</Match>
        </Switch>
      </div>
    ));
    await settle();
    expect(root.textContent).toBe("11");
    setN(2);
    flush();
    expect(root.textContent).toBe("22");
    // a new truthy value re-reads the branch: still content, still one view
    setOn("b");
    flush();
    expect(root.textContent).toBe("22");
    warn.mockRestore();
  });
});

describe("adopt", () => {
  it("a lazy block component in call form is built once; its chunk and its state land in place", async () => {
    let setups = 0;
    let bump!: () => void;
    const Inner = $component(function* (props: TypedProps<{ label: string }>) {
      setups++;
      const [n, setN] = yield* $signal(1);
      bump = () => write(setN(v => v + 1));
      return function* () {
        return (
          <b>
            {perform(props.label)}
            {perform(n)}
          </b>
        );
      };
    });
    let land!: (m: { default: typeof Inner }) => void;
    const Page = adopt(plainLazy(() => new Promise<{ default: typeof Inner }>(r => (land = r))));
    let setLabel!: (v: string) => void;
    const App = $component(function* () {
      const [label, set] = yield* $signal("n=");
      setLabel = v => write(set(v));
      return function* () {
        return <div>{perform(Page({ label }))}</div>;
      };
    });
    mount(() => <Loading fallback={<i>wait</i>}>{App()}</Loading>);
    expect(root.textContent).toBe("wait");
    land({ default: Inner });
    await settle();
    expect(root.textContent).toBe("n=1");
    bump();
    flush();
    setLabel("count ");
    flush();
    expect(root.textContent).toBe("count 2");
    expect(setups).toBe(1);
    // lazy's own properties are kept
    expect(typeof (Page as unknown as { preload: unknown }).preload).toBe("function");
  });
});

describe("flow controls keep children lazy", () => {
  it("element children are built when (and each time) the branch shows", () => {
    let built = 0;
    const node = document.createElement("b");
    const [which, setWhich] = plainSignal("a");
    const App = $component(function* () {
      const make = (label: string) => {
        built++;
        return <i>{label}</i>;
      };
      return function* () {
        return (
          <div>
            <Show when={which() === "a"}>
              <p>{node}</p>
            </Show>
            <Show when={which() === "b"}>
              <s>{node}</s>
            </Show>
            <Show when={which() === "c"}>{make("c")}</Show>
          </div>
        );
      };
    });
    mount(App);
    // the shared node sits in the branch that shows (built lazily, not by
    // every Show at creation)
    expect(root.querySelector("p")!.firstChild).toBe(node);
    expect(built).toBe(0);
    setWhich("b");
    flush();
    expect(root.querySelector("s")!.firstChild).toBe(node);
    setWhich("c");
    flush();
    expect(built).toBe(1);
    expect(root.textContent).toBe("c");
  });
});

describe("computations created in a setup", () => {
  it("read sources in their own pass (their reads are theirs, not the setup's)", () => {
    const Child = $component(function* (props: TypedProps<{ n: number }>) {
      const m = yield* $memo(function* () {
        return (yield* props.n) * 2;
      });
      return function* () {
        return <b>{yield* m}</b>;
      };
    });
    const [n, setN] = plainSignal(2);
    mount(() => <Child n={n()} />);
    expect(root.textContent).toBe("4");
    setN(3);
    flush();
    expect(root.textContent).toBe("6");
  });

  devIt("the setup's own read is still an error", () => {
    const Child = $component(function* (props: TypedProps<{ n: number }>) {
      yield* props.n as unknown as Iterable<never>;
      return function* () {
        return <b />;
      };
    });
    expect(() => createRoot(() => Child({ n: 1 }))).toThrow("[READ_IN_SETUP]");
  });
});

describe("Loading on a source", () => {
  it("the call form's `on` may be a source: a new key shows the fallback", async () => {
    let setKey!: (v: string) => void;
    const resolvers: Record<string, (v: string) => void> = {};
    const Page = $component(function* () {
      const [k, set] = yield* $signal("a");
      setKey = v => write(set(v));
      const v = yield* $memo(function* () {
        const at = yield* k;
        return yield* attempt(() => new Promise<string>(r => (resolvers[at] = r)), toError);
      });
      const Content = $component(function* () {
        return function* () {
          return <b>{perform(v)}</b>;
        };
      });
      return function* () {
        return (
          <div>{perform(Loading({ on: k, fallback: <i>wait</i>, children: () => Content() }))}</div>
        );
      };
    });
    mount(Page);
    expect(root.textContent).toBe("wait");
    resolvers.a("A");
    await settle();
    expect(root.textContent).toBe("A");
    setKey("b");
    flush();
    // a different key is different content: the fallback, not the stale "A"
    expect(root.textContent).toBe("wait");
    resolvers.b("B");
    await settle();
    expect(root.textContent).toBe("B");
  });
});

describe("boundaries in call form", () => {
  // `<Loading>{X()}</Loading>` gets its children as a getter; the call form
  // gets what the caller built. A component called in the argument list is
  // built before the boundary exists — its pending reads would reach the
  // boundary above — so the call form takes its content as a function.
  function pendingView() {
    let resolve!: (v: string) => void;
    const Pending = $component(function* () {
      const v = yield* $memo(function* () {
        return yield* attempt(() => new Promise<string>(r => (resolve = r)), toError);
      });
      return function* () {
        return <b>{perform(v)}</b>;
      };
    });
    return { Pending, resolve: (v: string) => resolve(v) };
  }

  it("Loading({ children: () => View }) builds the content inside the boundary", async () => {
    const { Pending, resolve } = pendingView();
    const Page = $component(function* () {
      return function* () {
        return (
          <div>
            <p>shell</p>
            {perform(Loading({ fallback: <i>inner</i>, children: () => Pending() }))}
          </div>
        );
      };
    });
    mount(() => <Loading fallback={<i>outer</i>}>{Page()}</Loading>);
    expect(root.textContent).toBe("shellinner");
    resolve("done");
    await settle();
    expect(root.textContent).toBe("shelldone");
  });

  it("Errored({ children: () => View }) too", async () => {
    const Failing = $component(function* () {
      const v = yield* $memo(function* () {
        return yield* raise(new Error("nope"));
      });
      return function* () {
        return <b>{perform(v)}</b>;
      };
    });
    const Page = $component(function* () {
      return function* () {
        return (
          <div>
            {perform(
              Errored({
                fallback: (e: () => unknown) => <i>{String((e() as Error).message)}</i>,
                children: () => Failing()
              })
            )}
          </div>
        );
      };
    });
    mount(() => <Errored fallback={<i>outer</i>}>{Page()}</Errored>);
    expect(root.textContent).toBe("nope");
  });

  devIt("content built before the boundary is a dev error", () => {
    const { Pending } = pendingView();
    expect(() =>
      createRoot(dispose => {
        try {
          Loading({ fallback: "…", children: Pending() });
        } finally {
          dispose();
        }
      })
    ).toThrow("[BOUNDARY_CONTENT_BUILT]");
  });
});

describe("hole blocks", () => {
  it("$() is a fine-grained child and readable with yield*", () => {
    let set!: (v: number) => void;
    let runs = 0;
    const App = $component(function* () {
      const [n, setN] = yield* $signal(2);
      set = v => write(setN(v));
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
      set = v => write(setId(v));
      const m = yield* $memo(function* () {
        const i = yield* id;
        const v = yield* attempt(() => new Promise<number>(r => resolvers.push(r)), toError);
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
