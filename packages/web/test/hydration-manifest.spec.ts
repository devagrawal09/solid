/**
 * @vitest-environment node
 *
 * The client hydration capability manifest's consumer side (optimization
 * slice 7): validation of every fixture manifest, deterministic entry
 * composition (golden files under test/hydration-capabilities/generated —
 * regenerate with UPDATE_CAPABILITY_ENTRIES=1), the server half, and the
 * isolation of manifest production from consumption.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateHydrationManifest,
  composeHydrationEntry,
  composeServerHydrationOptions,
  resolveHydrationInstallers,
  serializeHydrationManifest,
  type ClientHydrationManifest
} from "../hydration-manifest/src/index.js";
import {
  MANIFEST_DIR,
  GENERATED_DIR,
  fixtureManifestNames,
  fixtureManifestProducer,
  readFixtureManifest
} from "./hydration-capabilities/fixture-producer.js";
import { capabilityMatrix } from "./hydration-capabilities/matrix.js";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const solidRoot = resolve(here, "../../solid");
const update = process.env.UPDATE_CAPABILITY_ENTRIES === "1";

describe("fixture manifests", () => {
  test("every fixture manifest is covered by the matrix", () => {
    const inMatrix = new Set(capabilityMatrix.map(c => c.manifest));
    expect(fixtureManifestNames().filter(n => !inMatrix.has(n))).toEqual([]);
  });

  test("fixture manifests are stored in canonical form", () => {
    for (const name of fixtureManifestNames()) {
      if (name.startsWith("invalid-")) continue;
      const raw = readFileSync(resolve(MANIFEST_DIR, `${name}.json`), "utf-8");
      expect(serializeHydrationManifest(JSON.parse(raw)), name).toBe(raw);
    }
  });

  for (const c of capabilityMatrix) {
    if (c.expect === "invalid") {
      test(`${c.manifest} is rejected`, () => {
        const result = validateHydrationManifest(readFixtureManifest(c.manifest));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.join("\n")).toMatch(c.error);
        expect(() => composeHydrationEntry(readFixtureManifest(c.manifest) as any)).toThrow(
          /Invalid client hydration manifest/
        );
      });
    } else {
      test(`${c.manifest} is valid`, () => {
        const result = validateHydrationManifest(readFixtureManifest(c.manifest));
        expect(result.ok ? [] : result.errors).toEqual([]);
      });
    }
  }

  test("the fixture producer returns the positive manifest for a graph", () => {
    const m = fixtureManifestProducer.produce("streaming");
    expect(m.graph).toBe("streaming");
    expect(m.producer).toBe("fixture:streaming");
    expect(validateHydrationManifest(m).ok).toBe(true);
  });
});

describe("composeHydrationEntry", () => {
  const valid = fixtureManifestNames().filter(n => !n.startsWith("invalid-"));

  for (const name of valid) {
    test(`golden entry: ${name}`, () => {
      const manifest = readFixtureManifest(name) as ClientHydrationManifest;
      const source = composeHydrationEntry(manifest);
      expect(composeHydrationEntry(manifest)).toBe(source); // deterministic
      const file = resolve(GENERATED_DIR, `${name}.entry.js`);
      if (update || !existsSync(file)) writeFileSync(file, source);
      expect(source).toBe(readFileSync(file, "utf-8"));
    });
  }

  test("no stale golden entries", () => {
    const expected = new Set(valid.map(n => `${n}.entry.js`));
    expect(readdirSync(GENERATED_DIR).filter(f => !expected.has(f))).toEqual([]);
  });

  test("the sync entry installs nothing but the delegated-event replay", () => {
    const src = composeHydrationEntry(readFixtureManifest("sync") as ClientHydrationManifest);
    expect(src).toContain('import { createHydrator, eventReplayHydration } from "@solidjs/web";');
    expect(src).not.toContain("solid-js");
    expect(src).toContain('createHydrator([eventReplayHydration], ["click"])');
  });

  test("the full entry installs every capability in the universal hydrate() order", () => {
    const names = resolveHydrationInstallers(
      readFixtureManifest("full") as ClientHydrationManifest
    ).map(i => i.name);
    expect(names).toEqual([
      "installSnapshotHydration",
      "installAsyncResultHydration",
      "installSsrClientHydration",
      "installSsrHybridHydration",
      "installStoreHydration",
      "installErrorMarkerHydration",
      "loadingMarkerHydration",
      "streamLedgerHydration",
      "lazyAssetHydration",
      "eventReplayHydration"
    ]);
    // …which is exactly the list the universal hydrate() installs.
    const client = readFileSync(resolve(webRoot, "src/client.ts"), "utf-8");
    const all = client.match(/const ALL_HYDRATION_CAPABILITIES = \[([\s\S]*?)\];/)![1];
    expect(all.split(",").map(s => s.trim())).toEqual(names);
  });

  test("capabilities compose independently", () => {
    const base = readFixtureManifest("sync") as ClientHydrationManifest;
    const only = (caps: Partial<ClientHydrationManifest["capabilities"]>) =>
      resolveHydrationInstallers({ ...base, capabilities: { ...base.capabilities, ...caps } }).map(
        i => i.name
      );
    expect(only({ delegatedEvents: [] })).toEqual([]);
    expect(only({ lazyAssets: true, delegatedEvents: [] })).toEqual(["lazyAssetHydration"]);
    expect(only({ errorMarkers: true, delegatedEvents: [] })).toEqual([
      "installErrorMarkerHydration"
    ]);
    expect(only({ ssrSources: ["hybrid"], snapshots: true, delegatedEvents: [] })).toEqual([
      "installSnapshotHydration",
      "installSsrHybridHydration"
    ]);
  });

  test("the reserved resumableEvents capability needs a registered consumer", () => {
    const manifest = readFixtureManifest(
      "invalid-reserved-resumable-events"
    ) as ClientHydrationManifest;
    expect(() => composeHydrationEntry(manifest)).toThrow(/resumableEvents is reserved/);
    const src = composeHydrationEntry(manifest, {
      consumers: { resumableEvents: { module: "virtual:resumable", name: "resumableBootstrap" } }
    });
    expect(src).toContain('import { resumableBootstrap } from "virtual:resumable";');
    expect(src).toContain("createHydrator([eventReplayHydration, resumableBootstrap]");
  });

  test("module specifiers are configurable", () => {
    const src = composeHydrationEntry(readFixtureManifest("full") as ClientHydrationManifest, {
      solidModule: "/src/solid.js",
      webModule: "/src/web.js"
    });
    expect(src).toContain('from "/src/solid.js"');
    expect(src).toContain('from "/src/web.js"');
    expect(src).not.toContain('"solid-js"');
  });
});

describe("composeServerHydrationOptions", () => {
  test("the bootstrap captures exactly the manifest's delegated events", () => {
    expect(
      composeServerHydrationOptions(readFixtureManifest("full") as ClientHydrationManifest)
    ).toEqual({ eventNames: ["click", "input"] });
    expect(
      composeServerHydrationOptions(
        readFixtureManifest("violation-sync-no-delegated-events") as ClientHydrationManifest
      )
    ).toEqual({ eventNames: [] });
  });
});

describe("production is isolated from consumption", () => {
  const sources = (dir: string) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && /\.(ts|tsx|js)$/.test(e.name))
      .map(e => resolve(e.parentPath, e.name));

  test("the consumer never imports a producer or a fixture", () => {
    for (const file of sources(resolve(webRoot, "hydration-manifest/src"))) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toMatch(/from\s+["'][^"']*(test|fixture|producer)/);
    }
  });

  test("the runtime never imports the manifest module", () => {
    for (const file of [
      ...sources(resolve(webRoot, "src")),
      ...sources(resolve(solidRoot, "src/client"))
    ]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toMatch(/(from|import\()\s*["'][^"']*hydration-manifest/);
    }
  });

  test("every composed import exists on the client entries and has a server stub", () => {
    const full = readFixtureManifest("full") as ClientHydrationManifest;
    const solidClient = readFileSync(resolve(solidRoot, "src/index.ts"), "utf-8");
    const solidServer = readFileSync(resolve(solidRoot, "src/server/component.ts"), "utf-8");
    const webClient = readFileSync(resolve(webRoot, "src/client.ts"), "utf-8");
    const webServer = readFileSync(resolve(webRoot, "src/server.ts"), "utf-8");
    for (const { module, name } of [
      ...resolveHydrationInstallers(full),
      { module: "@solidjs/web", name: "createHydrator" }
    ]) {
      if (module === "solid-js") {
        expect(solidClient, name).toMatch(new RegExp(`\\b${name},`));
        expect(solidServer, name).toMatch(new RegExp(`export function ${name}\\(`));
      } else {
        expect(webClient, name).toMatch(new RegExp(`export function ${name}\\(`));
        expect(webServer, name).toMatch(
          new RegExp(`(notSup as ${name}\\b|export function ${name}\\()`)
        );
      }
    }
  });
});
