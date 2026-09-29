/**
 * The page flush (src/kernel/page.ts, host.ts): runtimes on one page flush as
 * one batch, phase by phase — every runtime's computes, then every render
 * effect (DOM write), then every user effect — in the order they first
 * scheduled, as one runtime would. The oracle is one core running both
 * "islands" (two unrelated graphs on the same runtime).
 */
import * as core from "../../src/index.js";
import * as kernel from "../../src/kernel/index.js";
import * as t0 from "../../src/kernel/t0.js";
import { host } from "../../src/kernel/host.js";
import { page } from "../../src/kernel/page.js";

type Log = string[];

/** A tier-0 "island": one cell, one hole whose apply writes `dom.a`. */
function t0Island(log: Log, dom: Record<string, number>) {
  const a = t0.cell(1);
  t0.hole(
    [a],
    () => (log.push("compute a"), t0.get(a)),
    v => {
      log.push("apply a");
      dom.a = v;
    },
    1
  );
  return (v: number) => t0.set(a, v);
}

/** A kernel / core "island": a cell, a render effect writing `dom.b`, a user effect reading `dom.a`. */
function effectIsland(api: typeof kernel, log: Log, dom: Record<string, number>) {
  return api.createRoot(dispose => {
    const [b, setB] = api.createSignal(10);
    api.createRenderEffect(
      () => (log.push("compute b"), b()),
      v => {
        log.push("render b");
        dom.b = v;
      }
    );
    api.createEffect(b, v => {
      log.push(`user b=${v} sees a=${dom.a}`);
      return () => log.push(`cleanup b=${v}`);
    });
    return { setB, dispose };
  });
}

/** The same two islands on one core (the oracle). */
function oracle(log: Log, dom: Record<string, number>) {
  return core.createRoot(dispose => {
    const [a, setA] = core.createSignal(1);
    core.createRenderEffect(
      () => (log.push("compute a"), a()),
      v => {
        if (v === 1) return;
        log.push("apply a");
        dom.a = v;
      }
    );
    const { setB } = effectIsland(core as unknown as typeof kernel, log, dom);
    return { setA, setB, dispose };
  });
}

async function scenario(order: "ab" | "ba", runtime: "kernel" | "core") {
  // oracle
  const want: Log = [];
  const odom = { a: 1, b: 10 };
  const o = oracle(want, odom);
  core.flush();
  want.length = 0;
  for (const k of order) k === "a" ? o.setA(2) : o.setB(20);
  await Promise.resolve();
  await Promise.resolve();
  o.dispose();
  // split runtimes
  const got: Log = [];
  const dom = { a: 1, b: 10 };
  const api = (runtime === "kernel" ? kernel : core) as typeof kernel;
  const unhost = runtime === "core" ? host(core as any) : null;
  try {
    const setA = t0Island(got, dom);
    const k = effectIsland(api, got, dom);
    api.flush();
    got.length = 0;
    for (const x of order) x === "a" ? setA(2) : k.setB(20);
    await Promise.resolve();
    await Promise.resolve();
    k.dispose();
  } finally {
    unhost?.();
  }
  return { want, got };
}

describe("page flush", () => {
  for (const runtime of ["kernel", "core"] as const)
    for (const order of ["ab", "ba"] as const)
      it(`t0 + ${runtime}, writes ${order === "ab" ? "t0 first" : `${runtime} first`}: one batch in the core's order`, async () => {
        const { want, got } = await scenario(order, runtime);
        expect(got).toEqual(want);
        expect(got).toContain("user b=20 sees a=2");
      });

  it("t0.flush() and the kernel's flush() drain the whole page", () => {
    const log: Log = [];
    const dom = { a: 1, b: 10 };
    const setA = t0Island(log, dom);
    const k = effectIsland(kernel, log, dom);
    kernel.flush();
    log.length = 0;
    k.setB(20);
    setA(2);
    t0.flush();
    expect(log).toEqual([
      "compute b",
      "compute a",
      "render b",
      "apply a",
      "cleanup b=10",
      "user b=20 sees a=2"
    ]);
    expect(dom).toEqual({ a: 2, b: 20 });
    setA(3);
    kernel.flush();
    expect(dom.a).toBe(3);
    k.dispose();
  });

  it("the host runs the page's parts inside the core's flush, and uninstalls", () => {
    const log: Log = [];
    const dom = { a: 1, b: 10 };
    const unhost = host(core as any);
    try {
      expect(page.x).toBe(core.flush);
      const setA = t0Island(log, dom);
      const k = effectIsland(core as unknown as typeof kernel, log, dom);
      core.flush();
      setA(2);
      core.flush(); // the core's flush reaches the t0 island
      expect(dom.a).toBe(2);
      setA(3);
      t0.flush(); // and t0's flush is the core's
      expect(dom.a).toBe(3);
      k.dispose();
    } finally {
      unhost();
    }
    expect(page.x ?? null).toBe(null);
  });
});
