/**
 * @vitest-environment jsdom
 *
 * Island runtime tiers (documentation/plans/island-runtime-tiers.md): every
 * tier must be trace-equivalent to the full core. Two checks, both judged
 * against the client oracle (`client/reference`, itself pinned to golden):
 *
 * 1. Kernel binding of real compiler output. A DOM-free scenario whose
 *    reference source uses only the kernel's API is compiled as usual and
 *    evaluated with `solid-js` bound to the tier-1 kernel (the probe's
 *    `h.signal` too). The whole trace, mount included, must equal the
 *    oracle's. Scenarios importing anything else are listed as skipped.
 *
 * 2. Activation stand-ins (tiers/activations.ts). For the component
 *    scenarios the oracle's rendered DOM (its `initial` html) becomes the
 *    server markup; the scenario's tier-0 and tier-1 activation code is run
 *    on it — tier 1 on the kernel and, as the tier-2 control, the same code
 *    on the full core — and the scenario's steps are driven. Everything from
 *    the first step on must equal the oracle's trace. The mount section is
 *    what activation itself does: nothing at tier 0 (asserted), the
 *    activation's own reads at tiers 1/2 (reported).
 */
import * as solid from "solid-js";
import * as web from "@solidjs/web";
import { describe, expect, test } from "vitest";
import * as kernel from "../../../signals/src/kernel/index.js";
import * as t0 from "../../../signals/src/kernel/t0.js";
import { compile } from "./harness/module.js";
import { mode } from "./harness/modes.js";
import { observeClient } from "./harness/runner.js";
import { drain, probe, Recorder } from "./harness/trace.js";
import type { DriverContext, Scenario } from "./harness/types.js";
import { scenarios } from "./scenarios/index.js";
import { activations, type Kernelish } from "./tiers/activations.js";

const reference = mode("client/reference");
const oracle = new Map<string, Promise<string[]>>();
const observed = (scenario: Scenario) => {
  let p = oracle.get(scenario.name);
  if (!p)
    oracle.set(
      scenario.name,
      (p = observeClient(scenario, reference, { solid, web }).then(o => o.trace))
    );
  return p;
};
/** The trace from the first step on (the mount section dropped). */
const afterMount = (trace: string[]) =>
  trace.slice(trace.findIndex((l, i) => i > 0 && l.startsWith("## ")));
const mountOf = (trace: string[]) =>
  trace.slice(
    1,
    trace.findIndex((l, i) => i > 0 && l.startsWith("## "))
  );

function expectSame(expected: string[], actual: string[], what: string) {
  if (actual.join("\n") === expected.join("\n")) return;
  const rows = Math.max(expected.length, actual.length);
  const lines = [`${what}: oracle | tier`];
  for (let i = 0; i < rows; i++) {
    const a = expected[i] ?? "",
      b = actual[i] ?? "";
    lines.push(`${a === b ? " " : "≠"} ${a.padEnd(60)} | ${b}`);
  }
  expect.fail(lines.join("\n"));
}

// --- 1. real compiler output bound to the kernel ----------------------------------------
const KERNEL_API = new Set(Object.keys(kernel));
function kernelOnly(scenario: Scenario): string | undefined {
  if (!("root" in scenario.entry)) return "component entry (the DOM renderer is bound to the core)";
  const source = scenario.sources.reference!;
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"solid-js"/g))
    for (const name of m[1]
      .split(",")
      .map(s => s.trim())
      .filter(Boolean))
      if (!KERNEL_API.has(name)) return `imports \`${name}\` (not in the kernel)`;
  return undefined;
}

describe("tier 1: real compiler output bound to the kernel", () => {
  for (const scenario of scenarios) {
    if (!scenario.sources.reference) continue;
    const skip = kernelOnly(scenario);
    (skip ? test.skip : test)(`${scenario.name}${skip ? ` — ${skip}` : ""}`, async () => {
      // Compiled exactly as client/reference compiles it; only the module
      // table binds `solid-js` to the kernel.
      expect(compile(scenario.sources.reference!, reference.compile).code).toContain("solid-js");
      const expected = await observed(scenario);
      const actual = (
        await observeClient(
          scenario,
          { ...reference, id: "client/kernel" },
          { solid: kernel as any, web }
        )
      ).trace;
      expectSame(expected, actual, `${scenario.name} (kernel)`);
    });
  }
});

// --- 2. activation stand-ins ------------------------------------------------------------------
type Runner = { tier: string; runtime: "t0" | "kernel" | "core" };
const RUNS: Runner[] = [
  { tier: "tier0", runtime: "t0" },
  { tier: "tier1", runtime: "kernel" },
  { tier: "tier1", runtime: "core" } // the tier-2 control: the same activation code on the full core
];

async function activate(scenario: Scenario, markup: string, run: Runner): Promise<string[]> {
  const recorder = new Recorder();
  const rt: Kernelish = run.runtime === "core" ? (solid as any) : (kernel as any);
  const h = probe(recorder, rt as any);
  const flush = () => (run.runtime === "t0" ? t0.flush() : rt.flush());
  const container = document.createElement("div");
  container.innerHTML = markup;
  document.body.appendChild(container);
  try {
    recorder.raw("## mount");
    const stand = activations[scenario.name] as any;
    const activated =
      run.tier === "tier0" ? stand.tier0(container, h, t0) : stand.tier1(container, h, rt);
    flush();
    const ctx: DriverContext = {
      app: {},
      environment: "client",
      tasks: undefined as any,
      flush,
      async settle() {
        await drain();
        flush();
      },
      html: () => recorder.raw(`html = ${container.innerHTML}`),
      click(selector) {
        const el = container.querySelector<HTMLElement>(selector);
        if (!el) throw new Error(`no element matches ${selector}`);
        el.click();
      },
      observe: (label, value) => recorder.push("value", label, value),
      dispose: () => activated.dispose()
    };
    for (const step of scenario.steps) {
      if (step.environments && !step.environments.includes("client")) continue;
      recorder.raw(`## ${step.name}`);
      await step.run(ctx);
    }
    recorder.raw("## teardown");
    activated.dispose();
    flush();
    return recorder.events;
  } finally {
    container.remove();
    await drain();
  }
}

/**
 * Self-tests: two plausible but wrong tier-0 schedulers must be caught.
 * - `creation-order`: a dirty set, holes run in creation order (not in the
 *   order the core's heap would visit them after a batch);
 * - `eager`: no batching, a write applies its holes at once.
 */
function wrongT0(kind: "creation-order" | "eager") {
  type Hole = { c: () => any; a: (v: any, p: any) => void; v: any };
  const all: Hole[] = [];
  const dirty = new Set<Hole>();
  let staged: { v: any; p: any; h: Hole[] }[] = [];
  const NOT = {};
  const api = {
    cell: (v: any) => ({ v, p: NOT, h: [] as Hole[] }),
    get: (c: any) => c.v,
    hole(cells: any[], c: () => any, a: (v: any, p: any) => void, v: any) {
      const hole = { c, a, v };
      all.push(hole);
      for (const cell of cells) cell.h.push(hole);
    },
    set(cell: any, v: any) {
      const cur = cell.p === NOT ? cell.v : cell.p;
      if (typeof v === "function") v = v(cur);
      if (v === cur) return v;
      cell.p = v;
      staged.push(cell);
      for (const hole of cell.h) dirty.add(hole);
      if (kind === "eager") api.flush();
      return v;
    },
    flush() {
      for (const cell of staged) ((cell.v = cell.p), (cell.p = NOT));
      staged = [];
      for (const hole of all.filter(x => dirty.has(x))) {
        const p = hole.v;
        hole.a((hole.v = hole.c()), p);
      }
      dirty.clear();
    }
  };
  return api;
}

describe("self-test: wrong tier-0 schedulers diverge", () => {
  for (const [kind, scenarioName] of [
    ["creation-order", "tier-two-cells"],
    ["eager", "tier-toggle"]
  ] as const) {
    test(`${kind} (${scenarioName})`, async () => {
      const scenario = scenarios.find(s => s.name === scenarioName)!;
      const expected = afterMount(await observed(scenario));
      const markup = (await observed(scenario))
        .find(l => l.startsWith("html = "))!
        .slice("html = ".length);
      const drive = async (impl: { flush(): void }) => {
        const recorder = new Recorder();
        const container = document.createElement("div");
        container.innerHTML = markup;
        document.body.appendChild(container);
        activations[scenarioName].tier0!(container, probe(recorder, kernel as any), impl as any);
        for (const step of scenario.steps) {
          recorder.raw(`## ${step.name}`);
          await step.run({
            flush: () => impl.flush(),
            html: () => recorder.raw(`html = ${container.innerHTML}`),
            click: (s: string) => container.querySelector<HTMLElement>(s)!.click()
          } as any);
        }
        recorder.raw("## teardown");
        container.remove();
        return recorder.events;
      };
      // The same driver with the real helper reproduces the oracle ...
      expect(await drive(t0)).toEqual(expected);
      // ... and with the wrong one it does not.
      expect(await drive(wrongT0(kind))).not.toEqual(expected);
    });
  }
});

describe("activation stand-ins reproduce the oracle", () => {
  for (const scenario of scenarios) {
    const stand = activations[scenario.name];
    if (!stand) continue;
    for (const run of RUNS) {
      if (!(stand as any)[run.tier]) continue;
      const label =
        run.runtime === "core"
          ? "tier 1 code on the full core (tier-2 control)"
          : run.tier === "tier0"
            ? "tier 0 (no runtime)"
            : "tier 1 (kernel)";
      test(`${scenario.name}: ${label}`, async () => {
        const expected = await observed(scenario);
        const initial = expected[expected.indexOf("## initial") + 1];
        expect(initial?.startsWith("html = ")).toBe(true);
        const actual = await activate(scenario, initial.slice("html = ".length), run);
        expectSame(afterMount(expected), afterMount(actual), `${scenario.name} / ${label}`);
        if (run.tier === "tier0")
          expect(mountOf(actual), "tier-0 activation reads and computes nothing").toEqual([]);
      });
    }
  }
});
