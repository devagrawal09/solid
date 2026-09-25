/**
 * @vitest-environment node
 *
 * Retained module graph of capability-selected hydration (optimization
 * slice 7). Bundles the entry composed from each positive fixture manifest —
 * and the universal hydrate() — against solid-js/@solidjs/web/@solidjs/signals
 * SOURCE with production flags, and asserts which hydration capability
 * modules (solid-js) and DOM capability functions (@solidjs/web, one module)
 * survive tree-shaking. An omitted capability must actually disappear.
 *
 * The reactive core's own async/loading/error/store implementations are out
 * of scope (optimization slice 4): they are retained by the app's primitives,
 * not by hydration, and are not asserted here.
 */
import { afterAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rollup, type Plugin } from "rollup";
import { transform } from "esbuild";
import {
  composeHydrationEntry,
  type ClientHydrationManifest
} from "../hydration-manifest/src/index.js";
import { readFixtureManifest } from "./hydration-capabilities/fixture-producer.js";

const here = dirname(fileURLToPath(import.meta.url));
const SOLID = resolve(here, "../../solid/src");
const SIGNALS = resolve(here, "../../signals/src");
const WEB = resolve(here, "../src");
const HYDRATION = join(SOLID, "client/hydration") + "/";
const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const ALIASES: Record<string, string> = {
  "solid-js": join(SOLID, "index.ts"),
  "@solidjs/signals": join(SIGNALS, "index.ts"),
  "@solidjs/web": join(WEB, "index.ts")
};

// Rollup — what the dist builds use — so cross-module build-flag constants
// fold exactly as they do in the published artifacts. Sources are
// transpiled with esbuild; the dist builds' string-literal flags
// ("_SOLID_DEV_") and the signals defines (__DEV__) are replaced the same way.
function sources(dev: boolean): Plugin {
  const flag = String(dev);
  return {
    name: "solid-sources",
    resolveId(id, importer) {
      if (ALIASES[id]) return ALIASES[id];
      if (importer && id.startsWith(".")) {
        const base = resolve(dirname(importer), id);
        for (const candidate of [
          base.replace(/\.js$/, ".ts"),
          base + ".ts",
          base,
          join(base, "index.ts")
        ])
          if (existsSync(candidate) && !candidate.endsWith("/")) return candidate;
      }
      return null;
    },
    async transform(code, id) {
      if (!id.endsWith(".ts")) return null;
      code = code.replaceAll('"_SOLID_DEV_"', flag).replaceAll('"_SOLID_OBSERVE_"', flag);
      const out = await transform(code, {
        loader: "ts",
        target: "esnext",
        define: { __DEV__: flag, __OBSERVE__: flag, __TEST__: "false" }
      });
      return { code: out.code, map: null };
    }
  };
}

async function bundle(entrySource: string, dev = false) {
  const dir = mkdtempSync(join(tmpdir(), "solid-hydration-graph-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "hydration-entry.js"), entrySource);
  const main = join(dir, "main.js");
  writeFileSync(
    main,
    // What compiled hydratable output references regardless of capabilities
    // (claim walk, inserts, delegation, the replay hook), plus the entry.
    `import { hydrate } from "./hydration-entry.js";\n` +
      `import { getNextElement, insert, delegateEvents, runHydrationEvents } from "@solidjs/web";\n` +
      `hydrate(() => { const el = getNextElement(); insert(el, () => 1); runHydrationEvents(); return el; }, document.body);\n` +
      `delegateEvents(["click"]);\n`
  );
  const build = await rollup({
    input: main,
    plugins: [sources(dev)],
    onwarn: () => {}
  });
  const { output } = await build.generate({ format: "es" });
  const chunk = output[0];
  const hydrationModules = Object.entries(chunk.modules)
    .filter(([id, mod]) => id.startsWith(HYDRATION) && mod.renderedLength > 0)
    .map(([id]) => id.slice(HYDRATION.length))
    .sort();
  return { hydrationModules, code: chunk.code };
}

const ALL_MODULES = [
  "async-results.ts",
  "boundaries.ts",
  "dispatch.ts",
  "drafts.ts",
  "lazy-assets.ts",
  "serialized.ts",
  "snapshots.ts",
  "ssr-sources.ts",
  "state.ts",
  "stores.ts",
  "stream-ledger.ts"
];
// Distinctive DOM-capability functions of @solidjs/web's client module.
const DOM_FUNCTIONS = {
  lazyAssets: "function loadModuleAssets(",
  streamLedger: "function reclaimRegion(",
  eventReplay: "function replayEvents(",
  loadingScopes: "captureBoundaryScope ="
};

const expected: Record<string, { modules: string[]; dom: (keyof typeof DOM_FUNCTIONS)[] }> = {
  sync: { modules: ["state.ts"], dom: ["eventReplay"] },
  store: {
    modules: ["drafts.ts", "serialized.ts", "snapshots.ts", "state.ts", "stores.ts"],
    dom: ["eventReplay"]
  },
  async: {
    modules: [
      "async-results.ts",
      "boundaries.ts",
      "dispatch.ts",
      "serialized.ts",
      "snapshots.ts",
      "state.ts"
    ],
    dom: ["eventReplay"]
  },
  streaming: {
    modules: [
      "async-results.ts",
      "boundaries.ts",
      "dispatch.ts",
      "serialized.ts",
      "snapshots.ts",
      "state.ts",
      "stream-ledger.ts"
    ],
    dom: ["streamLedger", "eventReplay", "loadingScopes"]
  },
  lazy: { modules: ["lazy-assets.ts", "state.ts"], dom: ["lazyAssets", "eventReplay"] },
  full: {
    modules: ALL_MODULES,
    dom: ["lazyAssets", "streamLedger", "eventReplay", "loadingScopes"]
  }
};

describe("retained hydration graph per manifest (production)", () => {
  for (const [name, want] of Object.entries(expected)) {
    test(name, async () => {
      const manifest = readFixtureManifest(name) as ClientHydrationManifest;
      const { hydrationModules, code } = await bundle(composeHydrationEntry(manifest));
      expect(hydrationModules).toEqual(want.modules);
      for (const [cap, marker] of Object.entries(DOM_FUNCTIONS))
        expect(code.includes(marker), `${cap}: ${marker}`).toBe(
          want.dom.includes(cap as keyof typeof DOM_FUNCTIONS)
        );
      // Development assertions never reach a production bundle.
      expect(code).not.toContain("HYDRATION_MANIFEST");
    });
  }

  test("the universal hydrate() retains every capability", async () => {
    const { hydrationModules, code } = await bundle(`export { hydrate } from "@solidjs/web";\n`);
    expect(hydrationModules).toEqual(ALL_MODULES);
    for (const marker of Object.values(DOM_FUNCTIONS)) expect(code).toContain(marker);
  });

  test("the store adapter rides the store capability, not the universal switch", async () => {
    // A manifest-composed entry with every capability BUT storeAdapters: the
    // derived-store adapter and its shadow drafts are gone even though the
    // rest of the async machinery (shared serialized helpers) stays.
    const full = readFixtureManifest("full") as ClientHydrationManifest;
    const { hydrationModules, code } = await bundle(
      composeHydrationEntry({
        ...full,
        capabilities: { ...full.capabilities, storeAdapters: false, ssrSources: [] }
      })
    );
    expect(hydrationModules).not.toContain("stores.ts");
    expect(hydrationModules).not.toContain("drafts.ts");
    expect(hydrationModules).toContain("serialized.ts");
    expect(code).not.toContain("hydrateStoreFromAsyncIterable");
  });

  test("no delegated events: the replay loop is gone though compiled output calls the hook", async () => {
    const { code } = await bundle(
      composeHydrationEntry(
        readFixtureManifest("violation-sync-no-delegated-events") as ClientHydrationManifest
      )
    );
    // With the slot never assigned, rollup folds the hook's body away too.
    expect(code).not.toContain(DOM_FUNCTIONS.eventReplay);
    expect(code).not.toContain("function dedupEvent(");
  });

  test("development builds carry the manifest assertions", async () => {
    const { hydrationModules, code } = await bundle(
      composeHydrationEntry(readFixtureManifest("sync") as ClientHydrationManifest),
      true
    );
    expect(hydrationModules).toContain("guards.ts");
    expect(code).toContain("HYDRATION_MANIFEST");
  });
});
