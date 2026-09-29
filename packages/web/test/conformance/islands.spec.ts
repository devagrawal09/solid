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
import { host } from "../../../signals/src/kernel/host.js";
import { evaluate } from "./harness/module.js";
import { mode } from "./harness/modes.js";
import { observeClient } from "./harness/runner.js";
import { controller, drain, Forbidden, NotFound, probe, Recorder } from "./harness/trace.js";
import type { DriverContext, Scenario } from "./harness/types.js";
import { scenarios as registered } from "./scenarios/index.js";
// Islands-only scenarios: their oracle is the reference source run here
// (they carry no golden and join no other mode).
import { islandsScenarios } from "./scenarios/islands.js";
// Cross-runtime flush order (islands on different tiers, one event).
import { islandsTierScenarios } from "./scenarios/islands-tiers.js";
// Compiler-derived server components: env reads, pruned serialization, frames.
import { islandsFramesScenarios } from "./scenarios/islands-frames.js";

const scenarios = [
  ...registered,
  ...islandsScenarios,
  ...islandsTierScenarios,
  ...islandsFramesScenarios
];

// Compiler-derived frames (scenarios with `islandsServer`): the real
// server-functions handler (built bundle, as the other server-function specs
// use) and the real frames applier the chunks load.
// @ts-ignore built JS without declarations
const serverFunctions = await import("../../server-functions/dist/server.js");
// @ts-ignore plain ESM without declarations
const framesClient = await import("../../../compiler/frames-client.mjs");
serverFunctions.configureServerFunctionsServer({
  provideEvent: (_event: unknown, fn: () => unknown) => fn()
});
/** Route the frames applier's requests to the server-functions handler. */
function framesFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit = {}) =>
    serverFunctions.handleServerFunctionRequest(
      new Request("http://localhost" + url, {
        ...init,
        headers: {
          ...(init.headers as any),
          origin: "http://localhost",
          "sec-fetch-site": "same-origin"
        }
      })
    )) as typeof fetch;
  return () => (globalThis.fetch = original);
}

const require = createRequire(import.meta.url);
const stream = require("../../../compiler/islands-stream.js") as {
  renderIslandsStream(
    render: ($c: unknown) => unknown,
    options: {
      onChunk(c: { id: string; html: string }): void;
      onError(e: unknown): void;
    }
  ): { shell: Promise<string> };
  swap(id: string, html: string, root: Element): void;
};
const compiler = require("../../../compiler/index.js") as {
  compileIslands(
    code: string,
    options: Record<string, unknown>
  ): {
    server: string;
    chunks: { id: string; code: string }[];
    manifest: {
      fallback: string | null;
      islands: { id: string; tier: number; anchor: string; root: string; waits: boolean }[];
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
    .replace(/ data-(i|s|f|k)="[^"]*"/g, "")
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
/** Steps start at the first step marker (after `## server` / `## mount`). */
const firstStep = (trace: string[]) =>
  trace.findIndex(l => l.startsWith("## ") && l !== "## server" && l !== "## mount");
const afterMount = (trace: string[]) => trace.slice(firstStep(trace));
/** Events of the client mount (activation), without the server render's. */
const mountOf = (trace: string[]) => trace.slice(trace.indexOf("## mount") + 1, firstStep(trace));

function expectSame(expected: string[], actual: string[], what: string) {
  if (actual.join("\n") === expected.join("\n")) return;
  if (process.env.CONFORMANCE_DUMP === "json")
    process.stderr.write(`@@ISLANDS ${JSON.stringify({ what, trace: actual })}\n`);
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
    // Only probe-host cells (`h.signal("label", …)`) are traced, as `h.signal`
    // traces them; plain `$signal` cells are not.
    get: (c: any) => {
      if (c.label) recorder.push("read", c.label, c.v);
      return c.v;
    },
    set: (c: any, v: any) =>
      t0.set(c, (prev: any) => {
        const next = typeof v === "function" ? v(prev) : v;
        if (c.label) recorder.push("write", c.label, next);
        return next;
      })
  };
}

const compileFor = (
  source: string,
  minTier = 0,
  modules: Record<string, string> = {},
  extra: Record<string, unknown> = {}
) =>
  compiler.compileIslands(source, {
    filename: "/scenario/app.jsx",
    // Cross-module: the imported modules' sources (as the bundler plugin
    // passes them from its summaries).
    imports: Object.entries(modules).map(([specifier, code]) => ({
      specifier,
      filename: `/scenario/${specifier.replace(/^\.\//, "")}.jsx`,
      code
    })),
    probeHosts: ["h.signal"],
    debug: true,
    minTier,
    t0Module: RUNTIMES.t0,
    kernelModule: RUNTIMES.kernel,
    coreModule: RUNTIMES.core,
    ...extra
  });

async function runIslands(scenario: Scenario, source: string, minTier: number) {
  const out = compileFor(source, minTier, scenario.modules, scenario.islandsOptions);
  if (out.fallback) throw new Error(`falls back: ${out.fallback}`);
  // One recorder for the whole page: the server keeps rendering while the
  // steps run (streamed boundaries settle on the server, and an `<Errored>`
  // fallback over a streamed failure renders there).
  const recorder = new Recorder();
  recorder.raw("## server");
  // --- server: the string-template module renders the page, streaming ------------------
  const serverModules: Record<string, unknown> = {
    "solid-js": solid,
    "@solidjs/web": web,
    conformance: { h: probe(recorder, solid as any), NotFound, Forbidden },
    ...scenario.islandsServer,
    ...(scenario.islandsServer ? { "server-functions": serverFunctions } : {})
  };
  const unfetch = scenario.islandsServer ? framesFetch() : null;
  // The scenario's other modules, as the server bundle has them (their own
  // islands server output; cross-module inlining copied what the page needs).
  for (const [spec, code] of Object.entries(scenario.modules ?? {}))
    serverModules[spec] = evaluate(
      compiler.compileIslands(code, { filename: `/scenario/${spec.slice(2)}.jsx` }).server,
      serverModules
    );
  const server = evaluate(out.server, serverModules);
  const early: { id: string; html: string }[] = [];
  let land: ((c: { id: string; html: string }) => void) | null = null;
  const rendered = stream.renderIslandsStream(
    ($c: unknown) => server[(scenario.entry as { component: string }).component]({}, $c),
    {
      onChunk: c => (land ? land(c) : early.push(c)),
      onError: e => recorder.raw(`server error ${e}`)
    }
  );
  const markup: string = await rendered.shell;
  // --- client: activate every island group on the markup --------------------------------
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
  const groups: { island: any; chunk: any }[] = [];
  /** A boundary is still pending around an anchor (the loader's `waits` check). */
  const pending = (el: Node) => {
    const w = document.createTreeWalker(el.parentNode ?? el, NodeFilter.SHOW_COMMENT);
    for (let n = w.nextNode(); n; n = w.nextNode())
      if (/^l\d/.test((n as Comment).data)) return true;
    return false;
  };
  // A page mixing the core with the lower tiers hands its flush to the core
  // (the entry does this in islands-build.js): one batch per page flush.
  let unhost: (() => void) | null = null;
  let landingCleanup: (() => void) | null = null;
  // Islands a `manualActivation` scenario's steps have activated so far.
  const manual = scenario.manualActivation ? new Set<string>() : null;
  /** Activate every anchor not yet active (the entry's scan, at load and on each landing). */
  const activateAll = () => {
    for (const { island, chunk } of groups) {
      if (manual && !manual.has(island.id)) continue;
      const anchors: Node[] =
        island.anchor === "comment"
          ? commentAnchors(container, island.id)
          : Array.from(container.querySelectorAll(`[data-i~="${island.id}"]`));
      for (const el of anchors) {
        const seen = ((el as any).$i ||= {});
        if (seen[island.id] || (island.waits && pending(el))) continue;
        seen[island.id] = 1;
        const d = chunk.activate(el);
        if (typeof d === "function") disposers.push(d);
      }
    }
  };
  try {
    recorder.raw("## mount");
    for (const island of out.manifest.islands) {
      const code = out.chunks.find(c => c.id === island.id)!.code;
      // The runtime the chunk imports (`tier1Core` binds tier 1 to the core).
      const on =
        (island as any).runtime ??
        RUNTIMES[island.tier === 0 ? "t0" : island.tier === 1 ? "kernel" : "core"];
      const rt: any = on === RUNTIMES.t0 ? t0i : on === RUNTIMES.kernel ? kernel : solid;
      const probeRt: any = on === RUNTIMES.core ? solid : kernel;
      const chunk = evaluate(
        // The frames applier loads lazily (a dynamic import the module
        // grammar does not rewrite): hand it the injected module.
        code.replace(/\bimport\("frames-client"\)/g, 'Promise.resolve(__import("frames-client"))'),
        {
          [RUNTIMES.t0]: t0i,
          [RUNTIMES.kernel]: kernel,
          [RUNTIMES.core]: solid,
          conformance: { h: probe(recorder, probeRt), NotFound, Forbidden },
          "frames-client": framesClient
        }
      );
      tiers.push(island.tier);
      if (rt === solid && !unhost) unhost = host(solid as any);
      if (rt.flush) flushers.add(() => rt.flush());
      groups.push({ island, chunk });
    }
    const flush = () => {
      for (const f of flushers) f();
    };
    // Chunks that landed before the entry ran, then the entry's scan; later
    // chunks swap in and activate what they carry as they land.
    land = c => {
      stream.swap(c.id, c.html, container);
      activateAll();
    };
    for (const c of early.splice(0)) land(c);
    // A frame's region landing (the frames applier's morph): keyed islands
    // are handed their state (`$SI.act`, the islands entry's activator),
    // then the landing event activates the new anchors.
    const onLanding = () => {
      activateAll();
      flush();
    };
    document.addEventListener("solid-islands", onLanding);
    (self as any).$SI = {
      act(el: any, id: string, state: unknown) {
        const g = groups.find(g => g.island.id === id);
        if (!g) return;
        (el.$i ||= {})[id] = 1;
        const d = g.chunk.activate(el, state);
        if (typeof d === "function") disposers.push(d);
      }
    };
    landingCleanup = () => {
      document.removeEventListener("solid-islands", onLanding);
      delete (self as any).$SI;
    };
    activateAll();
    flush();
    const activated = container.innerHTML;
    const ctx: DriverContext = {
      app: new Proxy(app, {
        get: (_, key: string) => {
          // Live bindings of the chunk modules (`export let setX`).
          for (const { chunk } of groups)
            if (key !== "activate" && key !== "flush" && key in chunk) return chunk[key];
          return undefined;
        }
      }),
      environment: "client",
      tasks: controller(recorder),
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
      dispose: disposeAll,
      activate(id) {
        if (!manual) throw new Error(`${scenario.name} does not set manualActivation`);
        if (!groups.some(g => g.island.id === id)) throw new Error(`no island ${id}`);
        manual.add(id);
        activateAll();
        flush();
      }
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
    return { markup, activated, trace: recorder.events, tiers, manifest: out.manifest };
  } finally {
    container.remove();
    await drain();
    unhost?.();
    landingCleanup?.();
    unfetch?.();
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
    const probe = compileFor(source, 0, scenario.modules, scenario.islandsOptions);
    if (probe.fallback) {
      test.skip(`${scenario.name} — falls back to hydration: ${probe.fallback}`, () => {});
      continue;
    }
    const tiers = probe.manifest.islands.map(i => i.tier);
    if (scenario.islandTiers || scenario.islandIds)
      test(`${scenario.name}: the compiler places the islands as intended`, () => {
        const find = (key: string) => {
          const found = probe.manifest.islands.filter(
            (i: any) => i.root === key || i.cells.includes(key)
          );
          expect(found.length, `one island for ${key}`).toBe(1);
          return found[0];
        };
        for (const [key, tier] of Object.entries(scenario.islandTiers ?? {}))
          expect(find(key).tier, `tier of ${key}`).toBe(tier);
        for (const [key, id] of Object.entries(scenario.islandIds ?? {}))
          expect(find(key).id, `id of ${key}`).toBe(id);
      });
    if (scenario.islandsManifest)
      test(`${scenario.name}: the compiler's manifest`, () => {
        scenario.islandsManifest!(probe.manifest);
      });
    const chosen = tiers.length ? `tier ${Math.max(...tiers)}` : "no islands (inert)";
    // A load-time effect writes after the server render (as it does after
    // hydration): the server markup is the pre-effect state.
    const hot = probe.manifest.islands.some(
      (i: any) => i.activation === "load" && i.why.some((w: string) => w.includes("effect"))
    );
    test(`${scenario.name}: server markup equals the oracle's initial DOM${hot ? " (after the load-time effect's activation)" : ""}`, async () => {
      const expected = await observed(scenario);
      const initial = expected[expected.indexOf("## initial") + 1];
      if (!initial?.startsWith("html = ")) return; // no initial snapshot in this scenario
      const { markup, activated } = await runIslands(scenario, source, 0);
      // A hot island's load-time effect writes after the server render (as it
      // does after hydration): the page after activation is the oracle's.
      expect(normalizeHtml(hot ? activated : markup)).toBe(
        normalizeHtml(initial.slice("html = ".length))
      );
    });
    /**
     * Every event from the first step on: the oracle's, or the scenario's
     * declared islands trace (an intentional, reviewed difference, e.g. rows
     * the islands keep where the oracle re-renders them).
     */
    const expectedSteps = async () =>
      scenario.islands?.trace ?? afterMount(normalize(await observed(scenario)));
    test(`${scenario.name}: ${chosen} (compiler's choice)${scenario.islands ? " [differs: declared]" : ""}`, async () => {
      const expected = await expectedSteps();
      const { trace, tiers } = await runIslands(scenario, source, 0);
      expectSame(expected, afterMount(normalize(trace)), `${scenario.name} / ${chosen}`);
      if (tiers.length && tiers.every(t => t === 0))
        expect(mountOf(trace), "tier-0 activation reads and computes nothing").toEqual([]);
    });
    if (tiers.some(t => t === 0))
      test(`${scenario.name}: tier 1 (kernel)`, async () => {
        const expected = await expectedSteps();
        const { trace } = await runIslands(scenario, source, 1);
        expectSame(expected, afterMount(normalize(trace)), `${scenario.name} / tier 1`);
      });
    if (tiers.length)
      test(`${scenario.name}: tier 2 control (the same chunk on the full core)`, async () => {
        const expected = await expectedSteps();
        const { trace } = await runIslands(scenario, source, 2);
        expectSame(expected, afterMount(normalize(trace)), `${scenario.name} / tier 2`);
      });
  }
});

/**
 * The dev verifier (`verify: true`, dev builds): each chunk's `verify(anchor)`
 * walks the island's static addresses on the server markup. It must be
 * silent on every scenario's own server markup, and name the node, the
 * component and the source line when the markup does not match.
 */
const pendingIn = (el: Node) => {
  const w = document.createTreeWalker(el.parentNode ?? el, NodeFilter.SHOW_COMMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) if (/^l\d/.test((n as Comment).data)) return true;
  return false;
};

describe("dev verifier", () => {
  const verifyAll = async (scenario: Scenario, source: string, edit = (h: string) => h) => {
    const out = compiler.compileIslands(source, {
      filename: "/scenario/app.jsx",
      probeHosts: ["h.signal"],
      verify: true,
      ...scenario.islandsOptions,
      imports: Object.entries(scenario.modules ?? {}).map(([specifier, code]) => ({
        specifier,
        filename: `/scenario/${specifier.slice(2)}.jsx`,
        code
      }))
    } as any);
    const mods: Record<string, unknown> = {
      "solid-js": solid,
      "@solidjs/web": web,
      conformance: { h: probe(new Recorder(), solid as any), NotFound, Forbidden },
      ...scenario.islandsServer,
      ...(scenario.islandsServer ? { "server-functions": serverFunctions } : {})
    };
    for (const [spec, code] of Object.entries(scenario.modules ?? {}))
      mods[spec] = evaluate(
        compiler.compileIslands(code, { filename: `/scenario/${spec.slice(2)}.jsx` }).server,
        mods
      );
    const server = evaluate(out.server, mods);
    const rendered = stream.renderIslandsStream(
      ($c: unknown) => server[(scenario.entry as { component: string }).component]({}, $c),
      { onChunk() {}, onError() {} }
    );
    const container = document.createElement("div");
    container.innerHTML = edit(await rendered.shell);
    const errors: string[] = [];
    for (const island of out.manifest.islands) {
      const chunk = evaluate(out.chunks.find(c => c.id === island.id)!.code, {
        [RUNTIMES.t0]: t0,
        [RUNTIMES.kernel]: kernel,
        [RUNTIMES.core]: solid,
        conformance: { h: probe(new Recorder(), solid as any), NotFound, Forbidden }
      });
      const anchors =
        island.anchor === "comment"
          ? commentAnchors(container, island.id)
          : Array.from(container.querySelectorAll(`[data-i~="${island.id}"]`));
      // An island whose paths cross a boundary still streaming is verified
      // when it lands (the entry re-checks on each landing).
      for (const a of anchors) if (!(island.waits && pendingIn(a))) errors.push(...chunk.verify(a));
    }
    return errors;
  };
  for (const scenario of candidates) {
    const source = ((scenario.sources as Record<string, string | undefined>).islands ??
      scenario.sources.blocks)!;
    if (compileFor(source, 0, scenario.modules, scenario.islandsOptions).fallback) continue;
    test(`${scenario.name}: silent on its own server markup`, async () => {
      expect(await verifyAll(scenario, source)).toEqual([]);
    });
  }
  test("reports a node the island's code does not expect, with its component and line", async () => {
    const scenario = scenarios.find(s => s.name === "tier-toggle")!;
    const errors = await verifyAll(scenario, scenario.sources.blocks!, h =>
      h.replace(/<a>/, "<span>").replace(/<\/a>/, "</span>")
    );
    expect(errors).toEqual([
      "expected <a> (App, line 13) at $a.firstElementChild.firstElementChild, found <span>"
    ]);
  });
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
