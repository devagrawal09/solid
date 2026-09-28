/**
 * @vitest-environment jsdom
 *
 * Compiled islands (documentation/plans/ssr-hydration-redesign.md,
 * "Compiler emission"): the islands mode. Every component scenario with a
 * blocks-v2 source (`islands`, else `blocks`) is compiled by
 * `compileIslands` — real compiler output only, both halves:
 *
 * 1. the **server** module (string templates) renders the page; its markup
 *    must equal the oracle's initial DOM (`client/reference`), modulo island
 *    anchors and region markers;
 * 2. each island group's **activation chunk** runs on that markup at the tier
 *    the compiler chose — tier 0 on the t0 helper (instrumented: labelled
 *    cells trace their reads and writes like `h.signal`), tier 1 on the
 *    kernel — and, as the tier-2 control, the same group raised to tier 2 on
 *    the full core. The scenario's steps are driven; everything from the
 *    first step on must equal the oracle's trace. Tier-0 activation must
 *    record nothing at mount.
 *
 * A scenario the compiler does not compile to islands (it falls back to
 * whole-module hydration) is listed as skipped with the compiler's reason:
 * the fallback list is part of the evidence.
 */
import { createRequire } from "node:module";
import * as solid from "solid-js";
import * as web from "@solidjs/web";
import { describe, expect, test } from "vitest";
import * as kernel from "../../../signals/src/kernel/index.js";
import * as t0 from "../../../signals/src/kernel/t0.js";
import { evaluate } from "./harness/module.js";
import { mode } from "./harness/modes.js";
import { observeClient } from "./harness/runner.js";
import { drain, Forbidden, NotFound, probe, Recorder } from "./harness/trace.js";
import type { DriverContext, Scenario } from "./harness/types.js";
import { scenarios as registered } from "./scenarios/index.js";
// Islands-only scenarios: their oracle is the reference source run here
// (they carry no golden and join no other mode).
import { islandsScenarios } from "./scenarios/islands.js";

const scenarios = [...registered, ...islandsScenarios];

const require = createRequire(import.meta.url);
const compiler = require("../../../compiler/index.js") as {
  compileIslands(
    code: string,
    options: Record<string, unknown>
  ): {
    server: string;
    chunks: { id: string; code: string }[];
    manifest: {
      fallback: string | null;
      islands: { id: string; tier: number; anchor: string; root: string }[];
    };
    fallback: string | null;
  };
};

const RUNTIMES = {
  t0: "@solidjs/signals/t0",
  kernel: "@solidjs/signals/kernel",
  core: "@solidjs/signals"
};

const reference = mode("client/reference");
const blocksCompiled = mode("client/blocks-compiled");
const oracle = new Map<string, Promise<string[]>>();
/**
 * The expectation: the reference oracle, or — where the scenario pins a
 * documented difference of compiled blocks from it (the v1 effect split) —
 * the observed `client/blocks-compiled` run of the same blocks source, since
 * the islands compiler implements the same block semantics.
 */
const observed = (scenario: Scenario) => {
  let p = oracle.get(scenario.name);
  if (!p) {
    const m =
      scenario.modes?.["client/blocks-compiled"]?.status === "differs" ? blocksCompiled : reference;
    oracle.set(scenario.name, (p = observeClient(scenario, m, { solid, web }).then(o => o.trace)));
  }
  return p;
};

/** Markup without comments (hole / region markers, island comment anchors) and island attributes. */
const normalizeHtml = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/ data-(i|s)="[^"]*"/g, "")
    .replace(/ data-pd(="")?/g, "")
    // A dynamic class the server rendered empty (`class=""`, as the SSR
    // runtime does) vs. a client render that never set it.
    .replace(/ class=""/g, "")
    // Parsed style attributes keep the server's text; CSSOM-written ones
    // serialize as `a: b;` (same declarations).
    .replace(
      / style="([^"]*)"/g,
      (_, s: string) => ` style="${s.replace(/\s*([:;])\s*/g, "$1").replace(/;$/, "")}"`
    );
const normalize = (trace: string[]) =>
  trace.map(line => (line.startsWith("html = ") ? normalizeHtml(line) : line));
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
  const lines = [`${what}: oracle | islands`];
  for (let i = 0; i < rows; i++) {
    const a = expected[i] ?? "",
      b = actual[i] ?? "";
    lines.push(`${a === b ? " " : "≠"} ${a.padEnd(60)} | ${b}`);
  }
  expect.fail(lines.join("\n"));
}

/** The t0 helper with `h.signal`'s trace grammar for labelled cells. */
function tracedT0(recorder: Recorder) {
  return {
    ...t0,
    cell: (v: unknown, label?: string) => Object.assign(t0.cell(v), { label }),
    get: (c: any) => {
      recorder.push("read", c.label, c.v);
      return c.v;
    },
    set: (c: any, v: any) =>
      t0.set(c, (prev: any) => {
        const next = typeof v === "function" ? v(prev) : v;
        recorder.push("write", c.label, next);
        return next;
      })
  };
}

const compileFor = (source: string, minTier = 0) =>
  compiler.compileIslands(source, {
    filename: "scenario.jsx",
    probeHosts: ["h.signal"],
    debug: true,
    minTier,
    t0Module: RUNTIMES.t0,
    kernelModule: RUNTIMES.kernel,
    coreModule: RUNTIMES.core
  });

async function runIslands(scenario: Scenario, source: string, minTier: number) {
  const out = compileFor(source, minTier);
  if (out.fallback) throw new Error(`falls back: ${out.fallback}`);
  // --- server: the string-template module renders the page -----------------------------
  const serverRecorder = new Recorder();
  const server = evaluate(out.server, {
    "solid-js": solid,
    "@solidjs/web": web,
    conformance: { h: probe(serverRecorder, solid as any), NotFound, Forbidden }
  });
  const markup: string = await server[(scenario.entry as { component: string }).component]({});
  // --- client: activate every island group on the markup --------------------------------
  const recorder = new Recorder();
  const container = document.createElement("div");
  container.innerHTML = markup;
  document.body.appendChild(container);
  const t0i = tracedT0(recorder);
  const app: Record<string, any> = {};
  const disposers: (() => void)[] = [];
  let disposed = false;
  const disposeAll = () => {
    if (disposed) return;
    disposed = true;
    disposers.forEach(d => d());
    for (const f of flushers) f();
  };
  const flushers = new Set<() => void>([() => t0.flush()]);
  const tiers: number[] = [];
  try {
    recorder.raw("## mount");
    for (const island of out.manifest.islands) {
      const code = out.chunks.find(c => c.id === island.id)!.code;
      const rt: any = island.tier === 0 ? t0i : island.tier === 1 ? kernel : solid;
      const probeRt: any = island.tier === 2 ? solid : kernel;
      const chunk = evaluate(code, {
        [RUNTIMES.t0]: t0i,
        [RUNTIMES.kernel]: kernel,
        [RUNTIMES.core]: solid,
        conformance: { h: probe(recorder, probeRt), NotFound, Forbidden }
      });
      tiers.push(island.tier);
      if (rt.flush) flushers.add(() => rt.flush());
      const anchors: Node[] =
        island.anchor === "comment"
          ? commentAnchors(container, island.id)
          : Array.from(container.querySelectorAll(`[data-i~="${island.id}"]`));
      for (const el of anchors) {
        const d = chunk.activate(el);
        if (typeof d === "function") disposers.push(d);
      }
      for (const k of Object.keys(chunk)) if (k !== "activate" && k !== "flush") app[k] = chunk[k];
    }
    const flush = () => {
      for (const f of flushers) f();
    };
    flush();
    const ctx: DriverContext = {
      app: new Proxy(app, {
        get: (target, key: string) => {
          // Live bindings of the chunk modules (`export let setX`).
          for (const k of Object.keys(target)) if (k === key) return target[k];
          return undefined;
        }
      }),
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
      dispose: disposeAll
    };
    for (const step of scenario.steps) {
      if (step.environments && !step.environments.includes("client")) continue;
      recorder.raw(`## ${step.name}`);
      await step.run(ctx);
    }
    if (!disposed) {
      recorder.raw("## teardown");
      disposeAll();
    }
    return { markup, trace: recorder.events, tiers, manifest: out.manifest };
  } finally {
    container.remove();
    await drain();
  }
}

function commentAnchors(root: Node, id: string): Node[] {
  const out: Node[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  for (let n = w.nextNode(); n; n = w.nextNode())
    if (
      (n as Comment).data.startsWith("i:") &&
      (n as Comment).data.slice(2).split(" ").includes(id)
    )
      out.push(n);
  return out;
}

const candidates = scenarios.filter(
  s =>
    "component" in s.entry &&
    ((s.sources as Record<string, string | undefined>).islands ?? s.sources.blocks)
);

describe("compiled islands reproduce the oracle", () => {
  for (const scenario of candidates) {
    const source = ((scenario.sources as Record<string, string | undefined>).islands ??
      scenario.sources.blocks)!;
    const probe = compileFor(source);
    if (probe.fallback) {
      test.skip(`${scenario.name} — falls back to hydration: ${probe.fallback}`, () => {});
      continue;
    }
    const tiers = probe.manifest.islands.map(i => i.tier);
    const chosen = tiers.length ? `tier ${Math.max(...tiers)}` : "no islands (inert)";
    // A load-time effect writes after the server render (as it does after
    // hydration): the server markup is the pre-effect state.
    const hot = probe.manifest.islands.some(
      (i: any) => i.activation === "load" && i.why.some((w: string) => w.includes("effect"))
    );
    (hot ? test.skip : test)(
      `${scenario.name}: server markup equals the oracle's initial DOM${hot ? " — n/a: a load-time effect writes after the server render" : ""}`,
      async () => {
        const expected = await observed(scenario);
        const initial = expected[expected.indexOf("## initial") + 1];
        if (!initial?.startsWith("html = ")) return; // no initial snapshot in this scenario
        const { markup } = await runIslands(scenario, source, 0);
        expect(normalizeHtml(markup)).toBe(normalizeHtml(initial.slice("html = ".length)));
      }
    );
    test(`${scenario.name}: ${chosen} (compiler's choice)`, async () => {
      const expected = normalize(await observed(scenario));
      const { trace, tiers } = await runIslands(scenario, source, 0);
      expectSame(
        afterMount(expected),
        afterMount(normalize(trace)),
        `${scenario.name} / ${chosen}`
      );
      if (tiers.length && tiers.every(t => t === 0))
        expect(mountOf(trace), "tier-0 activation reads and computes nothing").toEqual([]);
    });
    if (tiers.some(t => t === 0))
      test(`${scenario.name}: tier 1 (kernel)`, async () => {
        const expected = normalize(await observed(scenario));
        const { trace } = await runIslands(scenario, source, 1);
        expectSame(afterMount(expected), afterMount(normalize(trace)), `${scenario.name} / tier 1`);
      });
    if (tiers.length)
      test(`${scenario.name}: tier 2 control (the same chunk on the full core)`, async () => {
        const expected = normalize(await observed(scenario));
        const { trace } = await runIslands(scenario, source, 2);
        expectSame(afterMount(expected), afterMount(normalize(trace)), `${scenario.name} / tier 2`);
      });
  }
});

describe("islands mode self-test", () => {
  test("a tier-0 island without batching diverges from the oracle", async () => {
    const scenario = scenarios.find(s => s.name === "tier-toggle")!;
    const out = compileFor(scenario.sources.blocks!);
    // Break the chunk: every write applies at once (no batching).
    const chunkCode = out.chunks[0].code;
    const expected = normalize(await observed(scenario));
    const recorder = new Recorder();
    const eager = {
      ...tracedT0(recorder),
      set: (c: any, v: any) => {
        const r = tracedT0(recorder).set(c, v);
        t0.flush();
        return r;
      }
    };
    const container = document.createElement("div");
    const server = evaluate(out.server, {
      "solid-js": solid,
      "@solidjs/web": web,
      conformance: { h: probe(new Recorder(), solid as any), NotFound, Forbidden }
    });
    container.innerHTML = await server.App({});
    const chunk = evaluate(chunkCode, { [RUNTIMES.t0]: eager, conformance: {} });
    chunk.activate(container.querySelector("[data-i]"));
    recorder.raw("## mount");
    for (const step of scenario.steps) {
      recorder.raw(`## ${step.name}`);
      await step.run({
        flush: () => t0.flush(),
        html: () => recorder.raw(`html = ${container.innerHTML}`),
        click: (s: string) => container.querySelector<HTMLElement>(s)!.click()
      } as any);
    }
    recorder.raw("## teardown");
    expect(afterMount(normalize(recorder.events)).join("\n")).not.toBe(
      afterMount(expected).join("\n")
    );
  });
});
