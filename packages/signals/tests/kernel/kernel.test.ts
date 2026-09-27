/**
 * The tier-1 island kernel's contract, spelled out case by case. Every case
 * runs against the kernel and against the core, so each expectation is also
 * a statement about the core that the kernel reproduces.
 */
import * as core from "../../src/index.js";
import * as kernel from "../../src/kernel/index.js";

type Api = typeof kernel;
const apis: [string, Api][] = [
  ["kernel", kernel],
  ["core", core as unknown as Api]
];

describe.each(apis)("%s", (_name, k) => {
  const {
    createSignal,
    createMemo,
    createEffect,
    createRenderEffect,
    createRoot,
    onCleanup,
    untrack,
    flush
  } = k;
  afterEach(() => flush());

  it("stages writes: untracked reads see the committed value until the flush", () => {
    const [a, setA] = createSignal(1);
    setA(2);
    expect(a()).toBe(1);
    setA(v => v + 1); // the updater sees the staged value
    flush();
    expect(a()).toBe(3);
  });

  it("flushes on a microtask", async () => {
    const log: number[] = [];
    let set!: (v: number) => void;
    const dispose = createRoot(d => {
      const [a, setA] = createSignal(0);
      set = setA;
      createRenderEffect(a, v => void log.push(v));
      return d;
    });
    set(1);
    set(2);
    expect(log).toEqual([0]);
    await Promise.resolve();
    expect(log).toEqual([0, 2]);
    dispose();
  });

  it("is glitch-free on a diamond and runs each node once per flush", () => {
    const log: string[] = [];
    let set!: (v: number) => void;
    createRoot(() => {
      const [a, setA] = createSignal(1);
      set = setA;
      const b = createMemo(() => (log.push("b"), a() + 1));
      const c = createMemo(() => (log.push("c"), a() * 10));
      createRenderEffect(
        () => `${b()}/${c()}`,
        v => void log.push(`effect ${v}`)
      );
    });
    log.length = 0;
    set(2);
    flush();
    expect(log).toEqual(["b", "c", "effect 3/20"]);
  });

  it("cuts off unchanged memos; effects always run when recomputed", () => {
    const log: string[] = [];
    let set!: (v: number) => void;
    createRoot(() => {
      const [a, setA] = createSignal(1);
      set = setA;
      const parity = createMemo(() => a() % 2);
      createRenderEffect(parity, v => void log.push(`parity ${v}`));
      createRenderEffect(
        () => (a(), 0),
        v => void log.push(`constant ${v}`)
      );
    });
    set(3);
    flush();
    expect(log).toEqual(["parity 1", "constant 0", "constant 0"]);
  });

  it("orders a flush: heap by height, commit and deferred cleanups, render effects, user effects", () => {
    const log: string[] = [];
    let set!: (v: number) => void;
    createRoot(() => {
      const [a, setA] = createSignal(0);
      set = setA;
      createEffect(
        () => a(),
        v => {
          log.push(`user ${v}`);
          return () => log.push(`user cleanup ${v}`);
        }
      );
      createRenderEffect(
        () => {
          onCleanup(() => log.push("render compute cleanup"));
          return a();
        },
        v => void log.push(`render ${v}`)
      );
    });
    flush();
    log.length = 0;
    set(1);
    flush();
    expect(log).toEqual(["render compute cleanup", "render 1", "user cleanup 0", "user 1"]);
  });

  it("re-tracks dynamic reads: a branch not taken no longer notifies", () => {
    const log: string[] = [];
    let setCond!: (v: boolean) => void, setX!: (v: string) => void, setY!: (v: string) => void;
    createRoot(() => {
      const [cond, sc] = createSignal(true);
      const [x, sx] = createSignal("x");
      const [y, sy] = createSignal("y");
      setCond = sc;
      setX = sx;
      setY = sy;
      createRenderEffect(
        () => (cond() ? x() : y()),
        v => void log.push(v)
      );
    });
    setY("y2");
    flush();
    setCond(false);
    flush();
    setX("x2");
    flush();
    setY("y3");
    flush();
    expect(log).toEqual(["x", "y2", "y3"]);
  });

  it("disposes children newest first, then cleanups in order, then the effect cleanup", () => {
    const log: string[] = [];
    const dispose = createRoot(d => {
      createRenderEffect(
        () => {
          onCleanup(() => log.push("first compute cleanup"));
          return 1;
        },
        () => () => log.push("first effect cleanup")
      );
      createMemo(() => onCleanup(() => log.push("memo cleanup")));
      onCleanup(() => log.push("root cleanup 1"));
      onCleanup(() => log.push("root cleanup 2"));
      return d;
    });
    dispose();
    expect(log).toEqual([
      "memo cleanup",
      "first compute cleanup",
      "first effect cleanup",
      "root cleanup 1",
      "root cleanup 2"
    ]);
  });

  it("untrack reads without subscribing", () => {
    const log: number[] = [];
    let setA!: (v: number) => void, setB!: (v: number) => void;
    createRoot(() => {
      const [a, sa] = createSignal(1);
      const [b, sb] = createSignal(10);
      setA = sa;
      setB = sb;
      createRenderEffect(
        () => a() + untrack(b),
        v => void log.push(v)
      );
    });
    setB(20);
    flush();
    setA(2);
    flush();
    expect(log).toEqual([11, 22]);
  });

  it("honours equals: false and custom equality", () => {
    const log: string[] = [];
    let setA!: (v: number) => void, setB!: (v: number) => void;
    createRoot(() => {
      const [a, sa] = createSignal<number>(1, { equals: false });
      const [b, sb] = createSignal<number>(1, {
        equals: (x: number, y: number) => x % 2 === y % 2
      });
      setA = sa;
      setB = sb;
      createRenderEffect(a, v => void log.push(`a ${v}`));
      createRenderEffect(b, v => void log.push(`b ${v}`));
    });
    setA(1);
    setB(3);
    flush();
    setB(4);
    flush();
    expect(log).toEqual(["a 1", "b 1", "a 1", "b 4"]);
  });

  it("runs an effect's writes in the same flush call (loops until quiet)", () => {
    const log: string[] = [];
    let set!: (v: number) => void;
    createRoot(() => {
      const [a, setA] = createSignal(0);
      const [b, setB] = createSignal(0);
      set = setA;
      createEffect(a, v => void setB(v * 2));
      createRenderEffect(b, v => void log.push(`b ${v}`));
    });
    flush();
    set(2);
    flush();
    expect(log).toEqual(["b 0", "b 4"]);
  });
});
