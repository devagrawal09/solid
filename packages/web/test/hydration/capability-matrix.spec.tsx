/**
 * @vitest-environment jsdom
 *
 * Client half of the capability-selected hydration matrix (optimization
 * slice 7). Replays the artifacts written by
 * test/server/capability-harness.spec.tsx and hydrates each fixture graph
 * with (a) the universal hydrate() and (b) the client entry composed from a
 * fixture manifest (test/hydration-capabilities/generated/*.entry.js, kept
 * byte-identical to composeHydrationEntry's output by the manifest spec).
 *
 * Every case runs against a FRESH runtime (vi.resetModules): capability
 * installers fill module-level slots, and one page hydrates with one
 * manifest — a case must not inherit another case's installed capabilities.
 *
 * Positive cases assert, for both entries: no error or warning during
 * hydration, the settled text, claimed-node identity (every server `[_hk]`
 * element that survives is the same object), pre-hydration event replay
 * where the graph captures events, and a live delegated click afterwards.
 * Violation cases assert the development-build manifest assertion names the
 * omitted capability.
 *
 * vite.config.hydrate-prod.mjs reruns the positive cases against the
 * production runtime, where omitted capabilities leave their slots empty.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityApps, type CapabilityApp } from "../harness/capability-apps.js";
import { capabilityMatrix } from "../hydration-capabilities/matrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const artifactsDir = resolve(here, "../harness/__capability_artifacts__");
// Vite's glob import (typed locally: vite is not a dependency of this package).
declare global {
  interface ImportMeta {
    glob(pattern: string): Record<string, () => Promise<unknown>>;
  }
}
const entries = import.meta.glob("../hydration-capabilities/generated/*.entry.js");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function loadArtifact(name: string): { shell: string; rest: string; records: string[] } {
  const file = resolve(artifactsDir, `${name}.json`);
  if (!existsSync(file))
    throw new Error(
      `Missing capability artifact "${name}". Run the server harness first: ` +
        `vitest run --config vite.config.server.mjs test/server/capability-harness.spec.tsx`
    );
  return JSON.parse(readFileSync(file, "utf-8"));
}

function applyChunk(container: HTMLElement, chunk: string, first: boolean) {
  const scriptRe = /<script(?:[^>]*)>([\s\S]*?)<\/script>/g;
  const scripts = [...chunk.matchAll(scriptRe)].map(m => m[1]);
  const stripped = chunk.replace(scriptRe, "");
  if (first) container.innerHTML = stripped;
  else container.insertAdjacentHTML("beforeend", stripped);
  for (const s of scripts) (0, eval)(s);
}

type Runtime = {
  hydrate: (fn: () => any, el: Element) => () => void;
  flush: () => void;
  createComponent: (c: any, p: any) => any;
};

// A fresh solid-js/@solidjs/web instance pair, with the hydrate() either the
// universal one or the composed entry for `manifest`.
async function freshRuntime(manifest: string | null): Promise<Runtime> {
  vi.resetModules();
  delete (globalThis as any).Solid$$;
  const solid: any = await import("solid-js");
  const web: any = await import("@solidjs/web");
  // The dev artifact brands the global on import; the prod one never does.
  expect(!!(globalThis as any).Solid$$).toBe(!process.env.CAPABILITY_MATRIX_PROD);
  let hydrate = web.hydrate;
  if (manifest) {
    const load = entries[`../hydration-capabilities/generated/${manifest}.entry.js`];
    if (!load)
      throw new Error(`No composed entry for manifest "${manifest}" — run the manifest spec`);
    hydrate = ((await load()) as any).hydrate;
  }
  return { hydrate, flush: solid.flush, createComponent: solid.createComponent };
}

async function settle(rt: Runtime) {
  await sleep(40);
  rt.flush();
  await sleep(40);
  rt.flush();
}

type Outcome = {
  errors: string[];
  warnings: string[];
  text: string;
  textAfterClick: string;
  replaced: string[];
  /** Settled markup, and after the live click. */
  html: string;
  htmlAfterClick: string;
  /** Server-rendered elements gone after settling (legitimately: streamed fallbacks). */
  lost: string[];
  /** Client-created elements after settling (a claim that missed creates these). */
  created: string[];
};

async function runCase(app: CapabilityApp, manifest: string | null): Promise<Outcome> {
  const rt = await freshRuntime(manifest);
  const App = await app.load();
  const { shell, rest } = loadArtifact(app.name);
  document.body.innerHTML = "";
  const container = document.createElement("div");
  document.body.appendChild(container);
  delete (globalThis as any)._$HY;

  const errors: string[] = [];
  const warnings: string[] = [];
  const record =
    (sink: string[]) =>
    (...args: any[]) =>
      sink.push(args.map(a => (a instanceof Error ? a.message : String(a))).join(" "));
  vi.spyOn(console, "warn").mockImplementation(record(warnings));
  vi.spyOn(console, "error").mockImplementation(record(errors));
  (globalThis as any).reportError = record(errors);
  const onRejection = (r: unknown) => errors.push(r instanceof Error ? r.message : String(r));
  process.on("unhandledRejection", onRejection);

  let dispose: (() => void) | undefined;
  try {
    // The shell starts with the bootstrap script composed from the graph's
    // manifest: it creates `_$HY` and captures the listed event types.
    applyChunk(container, shell, true);
    if (app.mode === "loaded" && rest) applyChunk(container, rest, false);
    if (app.preHydrationClick) (container.querySelector("#inc") as HTMLElement).click();

    // lazy(): the client module for every module map the server filed. A
    // real client imports the mapped URL; here it is the same module source.
    const hy = (globalThis as any)._$HY;
    for (const key in hy.r) {
      if (!key.endsWith("_assets")) continue;
      const mod = await import("../harness/capability-apps/lazy-page.jsx");
      hy.modules ||= {};
      for (const k in hy.r[key]) hy.modules[k] = mod;
    }

    const serverNodes = new Map<string, Element>();
    for (const el of container.querySelectorAll("[_hk]"))
      serverNodes.set(el.getAttribute("_hk")!, el);
    const serverElements = new Set(container.querySelectorAll("*"));

    try {
      dispose = rt.hydrate(() => rt.createComponent(App, {}), container);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    rt.flush();
    await sleep(10);
    rt.flush();
    if (app.mode === "streamed" && rest) {
      await sleep(30);
      rt.flush();
      // Elements the stream delivers (swapped in by `$df`) are server nodes
      // too: add them to the claim baseline as they land.
      const beforeRest = new Set(container.querySelectorAll("*"));
      applyChunk(container, rest, false);
      for (const el of container.querySelectorAll("*"))
        if (!beforeRest.has(el)) serverElements.add(el);
    }
    await settle(rt);
    const text = container.textContent!;

    // Claimed-node identity: a server element whose key is still in the
    // document must be the very node the server rendered.
    const replaced: string[] = [];
    for (const el of container.querySelectorAll("[_hk]")) {
      const key = el.getAttribute("_hk")!;
      const original = serverNodes.get(key);
      if (original && original !== el) replaced.push(key);
    }

    const describeEl = (el: Element) => el.localName + (el.id ? "#" + el.id : "");
    const lost = [...serverElements].filter(el => !el.isConnected).map(describeEl);
    const created = [...container.querySelectorAll("*")]
      .filter(el => !serverElements.has(el))
      .map(describeEl);
    const html = container.innerHTML;

    (container.querySelector("#inc") as HTMLElement | null)?.click();
    await settle(rt);
    return {
      errors,
      warnings,
      text,
      textAfterClick: container.textContent!,
      replaced,
      html,
      htmlAfterClick: container.innerHTML,
      lost,
      created
    };
  } finally {
    process.off("unhandledRejection", onRejection);
    delete (globalThis as any).reportError;
    try {
      dispose?.();
    } catch {}
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

const appByName = new Map(capabilityApps.map(a => [a.name, a]));

// The universal runtime's outcome per graph: the reference every composed
// entry must reproduce exactly (markup, surviving server nodes, created
// nodes). Production builds emit no mismatch warnings, so this comparison is
// what catches a manifest that under-approximates there.
const references = new Map<string, Promise<Outcome>>();
function reference(app: CapabilityApp): Promise<Outcome> {
  if (!references.has(app.name)) references.set(app.name, runCase(app, null));
  return references.get(app.name)!;
}

describe("capability-selected hydration matrix", () => {
  // The universal hydrate() is the behavioral reference for every graph.
  for (const app of capabilityApps) {
    test(`universal hydrate(): ${app.name}`, async () => {
      const out = await reference(app);
      expect(out.errors).toEqual([]);
      expect(out.warnings).toEqual([]);
      expect(out.text).toBe(app.expectedTextAfterReplay ?? app.expectedText);
      expect(out.replaced).toEqual([]);
      expect(out.textAfterClick).toBe(app.expectedTextAfterClick);
    });
  }

  for (const c of capabilityMatrix) {
    if (c.expect === "invalid") continue;
    const app = appByName.get(c.app)!;
    if (c.expect === "hydrates") {
      test(`manifest "${c.manifest}" hydrates ${c.app} like the universal runtime`, async () => {
        const out = await runCase(app, c.manifest);
        expect(out.errors).toEqual([]);
        expect(out.warnings).toEqual([]);
        expect(out.text).toBe(app.expectedTextAfterReplay ?? app.expectedText);
        expect(out.replaced).toEqual([]);
        expect(out.textAfterClick).toBe(app.expectedTextAfterClick);
        const ref = await reference(app);
        expect(out.html).toBe(ref.html);
        expect(out.lost).toEqual(ref.lost);
        expect(out.created).toEqual(ref.created);
        expect(out.htmlAfterClick).toBe(ref.htmlAfterClick);
      });
    } else if (c.expect === "diverges") {
      // Production only: without assertions, an under-approximated manifest
      // must be visibly wrong, or the positive comparisons prove nothing.
      test.runIf(!!process.env.CAPABILITY_MATRIX_PROD)(
        `manifest "${c.manifest}" on ${c.app} diverges from the universal runtime (prod)`,
        async () => {
          const out = await runCase(app, c.manifest);
          const ref = await reference(app);
          const same =
            out.html === ref.html &&
            out.htmlAfterClick === ref.htmlAfterClick &&
            JSON.stringify([out.lost, out.created]) === JSON.stringify([ref.lost, ref.created]);
          expect(same).toBe(false);
        }
      );
    } else {
      // Development assertions only: the production runtime trusts the manifest.
      test.skipIf(!!process.env.CAPABILITY_MATRIX_PROD)(
        `manifest "${c.manifest}" on ${c.app} asserts "${c.capability}"`,
        async () => {
          const out = await runCase(app, c.manifest);
          const violation = out.errors.find(e => e.includes("[HYDRATION_MANIFEST]"));
          expect(violation, `errors: ${JSON.stringify(out.errors)}`).toBeDefined();
          expect(violation).toContain(`omits "${c.capability}"`);
          if (process.env.SHOW_VIOLATIONS) process.stdout.write(`\n[${c.manifest}] ${violation}\n`);
        }
      );
    }
  }
});
