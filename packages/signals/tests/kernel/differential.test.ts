/**
 * Differential suite for the tier-1 island kernel (src/kernel): random
 * synchronous graphs run through the core and through the kernel, and the
 * two event logs must be identical — every compute run, the value each read
 * saw, every effect run with (value, prev), every cleanup, in order.
 *
 * Generated shapes cover the kernel's whole subset: signal / memo / render
 * effect / user effect; static and branching (dynamic) reads; memo chains
 * and diamonds (glitch-freedom: a reader never sees a torn pair); equality
 * cut-off (equal writes, memos that settle to the same value, custom
 * `equals`, `equals: false`); nested owners (render effects that create
 * children, child roots); onCleanup in computes and effect cleanups;
 * batches of writes with explicit `flush()` or a microtask flush; untracked
 * reads between a write and its flush (stale reads); `untrack` inside
 * computes; disposal of child roots mid-run and of the whole graph.
 */
import * as core from "../../src/index.js";
import * as kernel from "../../src/kernel/index.js";

type Api = Pick<
  typeof kernel,
  | "createSignal"
  | "createMemo"
  | "createEffect"
  | "createRenderEffect"
  | "createRoot"
  | "onCleanup"
  | "untrack"
  | "flush"
>;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// A program is data, interpreted identically against each API.
type Read = { src: number; untracked?: boolean };
type Body = {
  reads: Read[];
  branch?: { cond: number; then: Read[]; else: Read[] };
  cleanup: boolean;
};
type NodeSpec =
  | { kind: "memo"; body: Body; equals?: "never" | "parity" }
  | { kind: "render" | "user"; body: Body; effectCleanup: boolean; children: NodeSpec[] }
  | { kind: "root"; children: NodeSpec[]; cleanup: boolean };
type Step =
  | { op: "write"; sig: number; value: number; fn?: boolean }
  | { op: "peek"; src: number }
  | { op: "flush" }
  | { op: "microtask" }
  | { op: "disposeRoot"; root: number };
interface Program {
  signals: { init: number; equals?: "never" }[];
  nodes: NodeSpec[];
  steps: Step[];
}

function generate(seed: number): Program {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const nSignals = 2 + Math.floor(r() * 4);
  const signals = Array.from({ length: nSignals }, () => ({
    init: Math.floor(r() * 3),
    ...(r() < 0.1 ? { equals: "never" as const } : {})
  }));
  // Sources are numbered: signals first, then memos in creation order.
  let sources = nSignals;
  let roots = 0;
  const readsOf = (n: number): Read[] =>
    Array.from({ length: n }, () => ({
      src: Math.floor(r() * sources),
      ...(r() < 0.1 ? { untracked: true } : {})
    }));
  const body = (): Body => ({
    reads: readsOf(1 + Math.floor(r() * 3)),
    ...(r() < 0.4
      ? {
          branch: {
            cond: Math.floor(r() * sources),
            then: readsOf(1 + Math.floor(r() * 2)),
            else: readsOf(Math.floor(r() * 2))
          }
        }
      : {}),
    cleanup: r() < 0.3
  });
  const nodes = (depth: number, count: number): NodeSpec[] => {
    const out: NodeSpec[] = [];
    for (let i = 0; i < count; i++) {
      const k = r();
      if (k < 0.4) {
        out.push({
          kind: "memo",
          body: body(),
          ...(r() < 0.15 ? { equals: pick(["never", "parity"] as const) } : {})
        });
        sources++;
      } else if (k < 0.85 || depth > 1) {
        out.push({
          kind: r() < 0.6 ? "render" : "user",
          body: body(),
          effectCleanup: r() < 0.4,
          children: depth < 2 && r() < 0.25 ? nodes(depth + 1, 1 + Math.floor(r() * 2)) : []
        });
      } else {
        roots++;
        out.push({
          kind: "root",
          children: nodes(depth + 1, 1 + Math.floor(r() * 3)),
          cleanup: r() < 0.5
        });
      }
    }
    return out;
  };
  const top = nodes(0, 3 + Math.floor(r() * 6));
  const steps: Step[] = [];
  const nSteps = 4 + Math.floor(r() * 10);
  for (let i = 0; i < nSteps; i++) {
    const writes = 1 + Math.floor(r() * 3);
    for (let w = 0; w < writes; w++)
      steps.push({
        op: "write",
        sig: Math.floor(r() * nSignals),
        value: Math.floor(r() * 3),
        ...(r() < 0.3 ? { fn: true } : {})
      });
    if (r() < 0.3) steps.push({ op: "peek", src: Math.floor(r() * sources) });
    steps.push({ op: r() < 0.7 ? "flush" : "microtask" });
    if (roots && r() < 0.1) steps.push({ op: "disposeRoot", root: Math.floor(r() * roots) });
  }
  return { signals, nodes: top, steps };
}

async function run(api: Api, p: Program): Promise<string[]> {
  const log: string[] = [];
  const L = (s: string) => void log.push(s);
  const reads: (() => number)[] = [];
  const setters: ((v: any) => any)[] = [];
  const rootDisposers: (() => void)[] = [];
  p.signals.forEach((s, i) => {
    const [get, set] = api.createSignal(
      s.init,
      s.equals === "never" ? { equals: false } : undefined
    );
    reads[i] = get;
    setters[i] = set;
  });
  let id = 0;
  const evalBody = (label: string, b: Body) => {
    let acc = 0;
    const rd = (x: Read) => {
      const v = x.untracked ? api.untrack(reads[x.src]) : reads[x.src]();
      L(`${label} read s${x.src}=${v}`);
      acc = (acc * 7 + v) % 101;
    };
    b.reads.forEach(rd);
    if (b.branch) (reads[b.branch.cond]() % 2 ? b.branch.then : b.branch.else).forEach(rd);
    if (b.cleanup) api.onCleanup(() => L(`${label} compute-cleanup`));
    return acc;
  };
  const build = (specs: NodeSpec[]) => {
    for (const spec of specs) {
      const label = `${spec.kind}${id++}`;
      if (spec.kind === "memo") {
        const opts =
          spec.equals === "never"
            ? { equals: false as const }
            : spec.equals === "parity"
              ? { equals: (a: number, b: number) => a % 2 === b % 2 }
              : undefined;
        reads.push(
          api.createMemo(() => {
            L(`${label} run`);
            return evalBody(label, spec.body);
          }, opts as any)
        );
      } else if (spec.kind === "root") {
        api.createRoot(dispose => {
          rootDisposers.push(dispose);
          if (spec.cleanup) api.onCleanup(() => L(`${label} cleanup`));
          build(spec.children);
        });
      } else {
        const create = spec.kind === "render" ? api.createRenderEffect : api.createEffect;
        create(
          () => {
            L(`${label} compute`);
            const v = evalBody(label, spec.body);
            if (spec.children.length) build(spec.children);
            return v;
          },
          (v: number, prev?: number) => {
            L(`${label} effect ${v} prev ${prev}`);
            if (spec.effectCleanup) return () => L(`${label} effect-cleanup ${v}`);
          }
        );
      }
    }
  };
  let disposeAll!: () => void;
  api.createRoot(dispose => {
    disposeAll = dispose;
    api.onCleanup(() => L("top cleanup"));
    build(p.nodes);
  });
  L("## mounted");
  api.flush();
  for (const s of p.steps) {
    switch (s.op) {
      case "write":
        L(`## write s${s.sig} ${s.fn ? "+" : "="}${s.value}`);
        setters[s.sig](s.fn ? (prev: number) => (prev + s.value) % 4 : s.value);
        break;
      case "peek":
        L(`## peek s${s.src} = ${reads[s.src]()}`);
        break;
      case "flush":
        L("## flush");
        api.flush();
        break;
      case "microtask":
        L("## microtask");
        await Promise.resolve();
        await Promise.resolve();
        break;
      case "disposeRoot":
        L(`## dispose root ${s.root}`);
        rootDisposers[s.root]?.();
        break;
    }
  }
  L("## dispose");
  disposeAll();
  api.flush();
  return log;
}

const SEEDS = Number(process.env.KERNEL_DIFF_SEEDS ?? 400);
const FROM = Number(process.env.KERNEL_DIFF_FROM ?? 1);

// Both runtimes are module singletons. Every BATCH programs they are
// re-imported, so a program starts from a fresh runtime at least that often
// (see the note on long-lived zombie heaps in island-runtime-tiers.md).
const BATCH = Number(process.env.KERNEL_DIFF_BATCH ?? 250);

describe("tier-1 kernel is trace-equivalent to the core on random sync graphs", () => {
  it(`${SEEDS} random programs`, async () => {
    let checked = 0;
    let c = core as unknown as Api,
      k: Api = kernel;
    for (let seed = FROM; seed <= SEEDS; seed++) {
      if ((seed - FROM) % BATCH === 0 && seed !== FROM) {
        vi.resetModules();
        c = (await import("../../src/index.js")) as unknown as Api;
        k = await import("../../src/kernel/index.js");
      }
      const p = generate(seed);
      if (process.env.KERNEL_DIFF_ONLY === "kernel") {
        try {
          checked += (await run(k, p)).length;
        } catch (e) {
          throw new Error(`seed ${seed}: the kernel threw: ${(e as Error).stack}`);
        }
        continue;
      }
      let expected: string[];
      try {
        expected = await run(c, p);
      } catch (e) {
        throw new Error(`seed ${seed}: the core threw: ${(e as Error).stack}`);
      }
      const actual = await run(k, p);
      if (actual.join("\n") !== expected.join("\n")) {
        if (process.env.KERNEL_DIFF_DUMP)
          console.log(
            JSON.stringify(p),
            "\n=== core\n" + expected.join("\n") + "\n=== kernel\n" + actual.join("\n")
          );
        let i = 0;
        while (actual[i] === expected[i]) i++;
        throw new Error(
          `seed ${seed}: first divergence at event ${i}\n  core:   ${expected.slice(Math.max(0, i - 6), i + 4).join("\n          ")}\n  kernel: ${actual
            .slice(Math.max(0, i - 6), i + 4)
            .join("\n          ")}`
        );
      }
      checked += expected.length;
    }
    expect(checked).toBeGreaterThan((SEEDS - FROM + 1) * 20);
  }, 900_000);
});
