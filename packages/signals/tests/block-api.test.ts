/**
 * Generator blocks v2 (documentation/plans/generator-blocks-v2.md): the
 * `$component` / `$memo` / `$effect` / `$event` API and its operations, run
 * uncompiled on the generator driver. Views are rendered the way `insert`
 * renders a block: `renderBlock` inside a render effect.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  $cleanup,
  $component,
  $effect,
  $event,
  $flush,
  $memo,
  $signal,
  $store,
  attempt,
  createContext,
  createEffect,
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  raise,
  renderBlock,
  resetErrorHalt,
  setContext,
  type TypedProps
} from "../src/index.js";

// An uncaught effect error halts reactivity globally; isolate the tests.
afterEach(() => resetErrorHalt());

/** Mount a component and record what its view renders. */
function mount<P>(component: (props: P) => unknown, props: P) {
  const out: unknown[] = [];
  let dispose!: () => void;
  createRoot(d => {
    dispose = d;
    const view = component(props) as any;
    createRenderEffect(
      () => renderBlock(view),
      v => void out.push(v)
    );
  });
  flush();
  return { out, dispose };
}
const tick = () => new Promise(r => setTimeout(r, 0));

describe("$component", () => {
  it("setup creates state once; the view reads it and re-renders on change", () => {
    let set!: (v: number) => any;
    let setups = 0;
    const Counter = $component(function* () {
      setups++;
      const [count, setCount] = yield* $signal(1);
      set = setCount;
      const doubled = yield* $memo(function* () {
        return (yield* count) * 2;
      });
      return function* () {
        return `${yield* count}/${yield* doubled}`;
      };
    });
    const { out } = mount(Counter, {});
    set(5);
    flush();
    expect(out).toEqual(["1/2", "5/10"]);
    expect(setups).toBe(1);
  });

  it("props are reads: the view tracks them; forwarding passes the read", () => {
    const [id, setId] = createSignal("a");
    const Child = $component(function* (props: TypedProps<{ tag: string }>) {
      return function* () {
        return `child:${yield* props.tag}`;
      };
    });
    const Parent = $component(function* (props: TypedProps<{ id: string }>) {
      return function* () {
        const child = Child({ tag: props.id }) as any;
        return `${yield* props.id}|${renderBlock(child)}`;
      };
    });
    const { out } = mount(Parent, {
      get id() {
        return id();
      }
    });
    setId("b");
    flush();
    expect(out).toEqual(["a|child:a", "b|child:b"]);
  });

  it("setup may not read, and creation is refused outside setup", () => {
    const [n] = createSignal(0);
    const ReadsInSetup = $component(function* () {
      yield* n as any;
      return function* () {
        return 1;
      };
    });
    expect(() => createRoot(() => ReadsInSetup({}))).toThrow(/OP_NOT_ALLOWED.*read.*component/s);

    const CreatesInView = $component(function* () {
      return function* () {
        yield* $signal(0) as any;
        return 1;
      };
    });
    expect(() => mount(CreatesInView, {})).toThrow(/OP_NOT_ALLOWED_IN_JSX/);
  });

  it("yield* Ctx reads context in setup", () => {
    const Theme = createContext("light");
    const Themed = $component(function* () {
      const theme = yield* Theme;
      return function* () {
        return theme;
      };
    });
    let out: unknown[] = [];
    createRoot(() => {
      setContext(Theme, "dark");
      out = mount(Themed, {}).out;
    });
    expect(out).toEqual(["dark"]);
  });

  it("$cleanup runs when the component is disposed", () => {
    const log: string[] = [];
    const C = $component(function* () {
      yield* $cleanup(() => log.push("cleanup"));
      return function* () {
        return "x";
      };
    });
    const { dispose } = mount(C, {});
    expect(log).toEqual([]);
    dispose();
    expect(log).toEqual(["cleanup"]);
  });

  it("yield* Child(props) evaluates to the child's view", () => {
    const Child = $component(function* () {
      return function* () {
        return "child";
      };
    });
    const Parent = $component(function* () {
      return function* () {
        const v = yield* Child({}) as any;
        return renderBlock(v as any);
      };
    });
    expect(mount(Parent, {}).out).toEqual(["child"]);
  });
});

describe("$signal / $store setters", () => {
  it("yield* set(v) writes and evaluates to the new value", async () => {
    let handler!: (e: unknown) => void;
    const seen: unknown[] = [];
    const C = $component(function* () {
      const [count, setCount] = yield* $signal(1);
      const [state, setState] = yield* $store({ n: 0 });
      handler = $event(function* () {
        seen.push(yield* setCount(c => c + 1));
        yield* setState(d => {
          d.n = 7;
        });
      });
      return function* () {
        return `${yield* count}:${yield* state.n}`;
      };
    });
    const { out } = mount(C, {});
    handler(undefined);
    flush();
    expect(seen).toEqual([2]);
    expect(out.at(-1)).toMatch(/^2:/);
  });
});

describe("$memo", () => {
  it("attempt(() => promise) suspends; the memo is pending, then resolves", async () => {
    let resolve!: (v: string) => void;
    const C = $component(function* () {
      const [id] = yield* $signal("u1");
      const user = yield* $memo(function* () {
        const key = yield* id;
        const name = yield* attempt(() => new Promise<string>(r => (resolve = r)));
        return `${key}:${name}`;
      });
      return function* () {
        return yield* user;
      };
    });
    const out: unknown[] = [];
    createRoot(() => {
      const view = C({}) as any;
      createRenderEffect(
        () => renderBlock(view),
        v => void out.push(v)
      );
    });
    flush();
    expect(out).toEqual([]);
    resolve("ada");
    await tick();
    flush();
    expect(out).toEqual(["u1:ada"]);
  });

  it("a read after the suspension is an error in a memo", async () => {
    const [a] = createSignal(1);
    let m!: () => unknown;
    const C = $component(function* () {
      m = yield* $memo(function* () {
        yield* attempt(() => Promise.resolve(1));
        return yield* a;
      });
      return function* () {
        return 1;
      };
    });
    createRoot(() => C({}));
    flush();
    await tick();
    flush();
    expect(() => m()).toThrow(/READ_AFTER_WAIT/);
  });

  it("writes are refused in a memo", () => {
    const C = $component(function* () {
      const [, set] = yield* $signal(0);
      const m: any = yield* $memo(function* () {
        yield* set(1);
        return 1;
      } as any) as any;
      return function* () {
        return yield* m;
      };
    });
    expect(() => mount(C, {})).toThrow();
  });
});

describe("attempt / raise", () => {
  it("try/catch around attempt, and raise for a typed failure", () => {
    class Bad extends Error {}
    let handler!: (e: unknown) => void;
    const log: string[] = [];
    const C = $component(function* () {
      handler = $event(function* () {
        try {
          yield* attempt(() => JSON.parse("{"));
        } catch {
          log.push("caught");
        }
        yield* raise(new Bad("typed"));
      });
      return function* () {
        return 1;
      };
    });
    mount(C, {});
    expect(() => handler(undefined)).toThrow(Bad);
    expect(log).toEqual(["caught"]);
  });
});

describe("$event", () => {
  it("reads current values, writes, flushes, and awaits async attempts", async () => {
    let handler!: (e: unknown) => void;
    const log: unknown[] = [];
    const C = $component(function* () {
      const [n, setN] = yield* $signal(0);
      handler = $event(function* () {
        yield* setN(1);
        yield* $flush();
        log.push(yield* n);
        const v = yield* attempt(() => Promise.resolve(41));
        yield* setN(v + 1);
        log.push("done");
      });
      return function* () {
        return yield* n;
      };
    });
    const { out } = mount(C, {});
    handler(undefined);
    await tick();
    flush();
    expect(log).toEqual([1, "done"]);
    expect(out.at(-1)).toBe(42);
  });

  it("creation and $cleanup are refused in an event", () => {
    const h1 = $event(function* () {
      yield* $signal(0) as any;
    });
    expect(() => h1(undefined)).toThrow(/OP_NOT_ALLOWED.*create.*event/s);
    const h2 = $event(function* () {
      yield* $cleanup(() => {}) as any;
    });
    expect(() => h2(undefined)).toThrow(/OP_NOT_ALLOWED.*cleanup.*event/s);
  });
});

describe("$effect", () => {
  it("reads, writes and cleans up; re-runs when a read changes", () => {
    const log: string[] = [];
    let setA!: (v: number) => any;
    let mirror!: () => number;
    const C = $component(function* () {
      const [a, _setA] = yield* $signal(1);
      const [b, setB] = yield* $signal(0);
      setA = _setA;
      mirror = b;
      yield* $effect(function* () {
        const v = yield* a;
        yield* setB(v * 10);
        log.push(`run ${v}`);
        yield* $cleanup(() => log.push(`cleanup ${v}`));
      });
      return function* () {
        return yield* b;
      };
    });
    const { out } = mount(C, {});
    flush();
    setA(2);
    flush();
    expect(log).toEqual(["run 1", "cleanup 1", "run 2"]);
    expect(mirror()).toBe(20);
    expect(out.at(-1)).toBe(20);
  });

  it("$flush is refused in an effect", () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const C = $component(function* () {
      yield* $effect(function* () {
        yield* $flush() as any;
      });
      return function* () {
        return 1;
      };
    });
    try {
      mount(C, {});
    } catch (e) {
      errors.push(e);
    }
    spy.mockRestore();
    expect(String(errors[0] ?? "")).toMatch(/OP_NOT_ALLOWED.*flush.*effect/s);
  });
});

describe("interop: plain APIs accept generator bodies", () => {
  it("createMemo(function* …) is a memo block", () => {
    const [a, setA] = createSignal(2);
    let m!: () => number;
    createRoot(() => {
      m = createMemo(function* () {
        return (yield* a) * 3;
      });
    });
    expect(m()).toBe(6);
    setA(3);
    flush();
    expect(m()).toBe(9);
  });

  it("createEffect(function* …) is an effect block", () => {
    const [a, setA] = createSignal(1);
    const [b, setB] = createSignal(0);
    const log: string[] = [];
    createRoot(() => {
      createEffect(function* () {
        const v = yield* a;
        setB(v * 10);
        log.push(`run ${v}`);
        yield* $cleanup(() => log.push(`cleanup ${v}`));
      });
    });
    flush();
    setA(2);
    flush();
    expect(log).toEqual(["run 1", "cleanup 1", "run 2"]);
    expect(b()).toBe(20);
    void setB;
  });
});

describe("call form (compiled bodies)", () => {
  it("perform steps receipts and context, and returns child views unrendered", async () => {
    const { perform } = await import("../src/index.js");
    const Theme = createContext("light");
    let handler!: (e: unknown) => void;
    const seen: unknown[] = [];
    const Child = $component(function () {
      return function () {
        return "child";
      };
    } as any);
    // Hand-lowered bodies, as the compiler emits them.
    const C = $component(function () {
      const theme = perform(Theme as any);
      const [count, setCount] = perform($signal(1) as any) as any;
      handler = $event(function () {
        seen.push(perform(setCount((c: number) => c + 1)));
      } as any);
      return function () {
        const child = perform(Child({}) as any) as any;
        return `${theme}:${perform(count)}:${renderBlock(child)}`;
      };
    } as any);
    let out: unknown[] = [];
    createRoot(() => {
      setContext(Theme, "dark");
      out = mount(C as any, {}).out;
    });
    handler(undefined);
    flush();
    expect(seen).toEqual([2]);
    expect(out).toEqual(["dark:1:child", "dark:2:child"]);
  });
});
