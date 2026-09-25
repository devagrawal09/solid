/**
 * @vitest-environment node
 *
 * The manifest-to-bootstrap contract (optimization slice 7):
 * `resolveHydrationBootstrap(summary)` selects a capability-specialized
 * client entry only for a known, valid, fully decided hydration section, and
 * the GENERAL runtime (`export { hydrate } from "@solidjs/web"`) for anything
 * unknown or incompatible. Covers fallback, every capability combination,
 * golden bootstrap entries (UPDATE_CAPABILITY_ENTRIES=1 regenerates), and the
 * entries' source maps (direct and through a bundler).
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
  resolveHydrationBootstrap,
  resolveHydrationInstallers,
  validateHydrationManifest,
  serializeHydrationManifest,
  type ClientHydrationManifest,
  type EntrySourceMap
} from "../hydration-manifest/src/index.js";
import {
  GENERATED_DIR,
  readFixtureManifest,
  readSummary,
  summaryNames
} from "./hydration-capabilities/fixture-producer.js";
import { summaryCases } from "./hydration-capabilities/matrix.js";

const update = process.env.UPDATE_CAPABILITY_ENTRIES === "1";
const GENERAL_EXPORT = 'export { hydrate } from "@solidjs/web";';

// --- a tiny source map v3 decoder (single-source maps) ---------------------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decode(mappings: string) {
  const out: { line: number; column: number; sourceLine: number; sourceColumn: number }[] = [];
  let sourceLine = 0,
    sourceColumn = 0;
  mappings.split(";").forEach((lineText, line) => {
    let column = 0;
    if (!lineText) return;
    for (const seg of lineText.split(",")) {
      const values: number[] = [];
      let shift = 0,
        value = 0;
      for (const ch of seg) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) shift += 5;
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          shift = value = 0;
        }
      }
      column += values[0];
      sourceLine += values[2];
      sourceColumn += values[3];
      out.push({ line, column, sourceLine, sourceColumn });
    }
  });
  return out;
}

function lookup(map: EntrySourceMap, code: string, needle: string, fromLine = 0) {
  const lines = code.split("\n");
  for (let line = fromLine; line < lines.length; line++) {
    const column = lines[line].indexOf(needle);
    if (column < 0) continue;
    const seg = decode(map.mappings).find(s => s.line === line && s.column === column);
    if (!seg) return undefined;
    return map.sourcesContent[0].split("\n")[seg.sourceLine].slice(seg.sourceColumn);
  }
  return undefined;
}

describe("fallback: unknown or incompatible summaries select the general runtime", () => {
  const cases: [string, unknown, RegExp][] = [
    ["undefined", undefined, /no capability summary/],
    ["null", null, /no capability summary/],
    ["a string", "hydrate everything", /not an object/],
    ["an array", [], /not an object/],
    ["an empty object", {}, /no hydration section/],
    ["an unknown hydration section", { hydration: "unknown" }, /hydration section is unknown/],
    ["a non-object hydration section", { hydration: 7 }, /hydration section is not an object/],
    [
      "all capabilities unknown",
      { ...(readFixtureManifest("sync") as object), capabilities: "unknown" },
      /all capabilities are unknown/
    ],
    [
      "an unknown event list",
      {
        ...(readFixtureManifest("sync") as any),
        capabilities: {
          ...(readFixtureManifest("sync") as any).capabilities,
          delegatedEvents: "unknown"
        }
      },
      /"delegatedEvents" is unknown/
    ],
    [
      "an older schema",
      { ...(readFixtureManifest("sync") as object), schema: 0 },
      /incompatible hydration manifest schema 0/
    ],
    [
      "a dependency violation",
      readFixtureManifest("invalid-missing-snapshots"),
      /snapshots is required/
    ],
    [
      "a reserved capability without a consumer",
      readFixtureManifest("invalid-reserved-resumable-events"),
      /resumableEvents is reserved/
    ]
  ];
  for (const [what, summary, reason] of cases) {
    test(what, () => {
      const b = resolveHydrationBootstrap(summary);
      expect(b.mode).toBe("general");
      expect(b.reasons.join("\n")).toMatch(reason);
      expect(b.entry.code).toContain(GENERAL_EXPORT);
      expect(b.server).toEqual({});
    });
  }

  test("a cyclic summary still resolves (never throws)", () => {
    const cyclic: any = { hydration: {} };
    cyclic.hydration.self = cyclic;
    const b = resolveHydrationBootstrap(cyclic);
    expect(b.mode).toBe("general");
  });

  for (const c of summaryCases) {
    test(`summary "${c.summary}" resolves ${c.mode}`, () => {
      const b = resolveHydrationBootstrap(readSummary(c.summary));
      expect(b.mode).toBe(c.mode);
      if (c.mode === "general") {
        expect(b.reasons.join("\n")).toMatch(c.reason);
        expect(b.entry.code).toContain(GENERAL_EXPORT);
      } else if (b.mode === "selected") {
        expect(b.installers).toEqual(c.installers);
      }
    });
  }

  test("every summary fixture is covered", () => {
    expect(summaryNames()).toEqual(summaryCases.map(c => c.summary).sort());
  });

  for (const name of summaryNames()) {
    test(`golden bootstrap entry: summary-${name}`, () => {
      const { code } = resolveHydrationBootstrap(readSummary(name)).entry;
      const file = resolve(GENERATED_DIR, `summary-${name}.entry.js`);
      if (update || !existsSync(file)) writeFileSync(file, code);
      expect(code).toBe(readFileSync(file, "utf-8"));
    });
  }

  test("a sibling section it does not consume never changes the selection", () => {
    const sync = readFixtureManifest("sync");
    const bare = resolveHydrationBootstrap(sync);
    for (const core of [undefined, { async: false }, { async: "unknown" }, "unknown", 42]) {
      const b = resolveHydrationBootstrap({ schema: 1, core, hydration: sync });
      expect(b.mode).toBe("selected");
      expect(b.entry.code).toBe(bare.entry.code);
    }
  });
});

describe("selection: every capability combination", () => {
  const BOOLS = [
    "streamLedger",
    "loadingMarkers",
    "errorMarkers",
    "asyncResults",
    "storeAdapters",
    "lazyAssets",
    "snapshots"
  ] as const;
  const EVENTS = [[], ["click"], ["click", "input"]];
  const SOURCES = [[], ["client"], ["hybrid"], ["client", "hybrid"]];
  const base = readFixtureManifest("sync") as ClientHydrationManifest;

  test("each of 1536 combinations selects exactly its installers, or falls back with the validator's reasons", () => {
    let selected = 0,
      general = 0;
    for (let mask = 0; mask < 1 << BOOLS.length; mask++)
      for (const delegatedEvents of EVENTS)
        for (const ssrSources of SOURCES) {
          const capabilities: any = { ...base.capabilities, delegatedEvents, ssrSources };
          BOOLS.forEach((k, i) => (capabilities[k] = !!(mask & (1 << i))));
          const manifest = { ...base, capabilities } as ClientHydrationManifest;
          const validation = validateHydrationManifest(manifest);
          const b = resolveHydrationBootstrap(manifest);
          if (!validation.ok) {
            general++;
            expect(b.mode).toBe("general");
            expect(b.reasons).toEqual(validation.errors);
            continue;
          }
          selected++;
          expect(b.mode).toBe("selected");
          if (b.mode !== "selected") continue;
          const expected = resolveHydrationInstallers(manifest).map(i => i.name);
          expect(b.installers).toEqual(expected);
          // Each capability contributes its installer independently.
          expect(b.installers.includes("installStoreHydration")).toBe(capabilities.storeAdapters);
          expect(b.installers.includes("streamLedgerHydration")).toBe(capabilities.streamLedger);
          expect(b.installers.includes("lazyAssetHydration")).toBe(capabilities.lazyAssets);
          expect(b.installers.includes("eventReplayHydration")).toBe(delegatedEvents.length > 0);
          expect(b.installers.includes("installSsrClientHydration")).toBe(
            ssrSources.includes("client")
          );
          // The entry imports exactly what it installs (plus createHydrator).
          const imported = [...b.entry.code.matchAll(/import \{ ([^}]*) \}/g)]
            .flatMap(m => m[1].split(",").map(s => s.trim()))
            .filter(n => n !== "createHydrator")
            .sort();
          expect(imported).toEqual([...expected].sort());
          expect(b.server.eventNames).toEqual(delegatedEvents);
          // Deterministic.
          expect(resolveHydrationBootstrap(manifest).entry.code).toBe(b.entry.code);
        }
    expect(selected + general).toBe(1536);
    // Dependency rules really prune: streamLedger without loadingMarkers,
    // and changing capabilities without snapshots.
    expect(general).toBeGreaterThan(0);
    expect(selected).toBeGreaterThan(0);
  });
});

describe("source maps", () => {
  test("each installer maps to the capability key that selected it", () => {
    const manifest = readFixtureManifest("full");
    const { entry } = resolveHydrationBootstrap(manifest);
    expect(entry.map.version).toBe(3);
    expect(entry.map.sources).toEqual(["hydration-manifest.json"]);
    expect(entry.map.sourcesContent[0]).toBe(
      serializeHydrationManifest(manifest as ClientHydrationManifest)
    );
    const hydrateLine = entry.code.split("\n").findIndex(l => l.startsWith("export const"));
    const pairs: [string, string][] = [
      ["installSnapshotHydration", "snapshots"],
      ["installAsyncResultHydration", "asyncResults"],
      ["installSsrClientHydration", "ssrSources"],
      ["installSsrHybridHydration", "ssrSources"],
      ["installStoreHydration", "storeAdapters"],
      ["installErrorMarkerHydration", "errorMarkers"],
      ["loadingMarkerHydration", "loadingMarkers"],
      ["streamLedgerHydration", "streamLedger"],
      ["lazyAssetHydration", "lazyAssets"],
      ["eventReplayHydration", "delegatedEvents"]
    ];
    for (const [installer, key] of pairs) {
      // the import specifier …
      expect(lookup(entry.map, entry.code, installer), installer).toMatch(new RegExp(`^"${key}":`));
      // … and the installation site.
      expect(lookup(entry.map, entry.code, installer, hydrateLine), installer).toMatch(
        new RegExp(`^"${key}":`)
      );
    }
    expect(lookup(entry.map, entry.code, "createHydrator(")).toMatch(/^"capabilities":/);
    expect(lookup(entry.map, entry.code, '["click","input"]')).toMatch(/^"delegatedEvents":/);
  });

  test("a general entry maps to the summary it rejected", () => {
    const summary = readSummary("unknown-capability-value");
    const { entry } = resolveHydrationBootstrap(summary, { manifestSource: "summary.json" });
    expect(entry.map.sources).toEqual(["summary.json"]);
    expect(entry.map.sourcesContent[0]).toBe(JSON.stringify(summary, null, 2) + "\n");
    expect(lookup(entry.map, entry.code, GENERAL_EXPORT)).toMatch(/^\{/);
  });

  test("the inline map survives a bundler and still points at the manifest", async () => {
    const { entry } = resolveHydrationBootstrap(readFixtureManifest("streaming"), {
      inlineSourceMap: true,
      webModule: "web-stub",
      solidModule: "solid-stub"
    });
    expect(entry.code).toMatch(/\/\/# sourceMappingURL=data:application\/json;/);
    const inline = entry.code.match(/base64,(.*)$/m)![1];
    expect(JSON.parse(Buffer.from(inline, "base64").toString("utf-8"))).toEqual(entry.map);
    const stub = (names: string[]) =>
      names.map(n => `export function ${n}(){}`).join("\n") +
      "\nexport const createHydrator = (c, e) => () => [c, e];";
    const result = await build({
      stdin: { contents: entry.code, sourcefile: "hydration-entry.js", loader: "js" },
      bundle: true,
      write: false,
      format: "esm",
      sourcemap: "external",
      outfile: "out.js",
      logLevel: "silent",
      plugins: [
        {
          name: "stubs",
          setup(b) {
            b.onResolve({ filter: /-stub$/ }, a => ({ path: a.path, namespace: "stub" }));
            b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
              contents: stub([
                "installSnapshotHydration",
                "installAsyncResultHydration",
                "loadingMarkerHydration",
                "streamLedgerHydration",
                "eventReplayHydration"
              ]),
              loader: "js"
            }));
          }
        }
      ]
    });
    const mapFile = result.outputFiles.find(f => f.path.endsWith(".map"))!;
    const map = JSON.parse(mapFile.text);
    const i = map.sources.findIndex((s: string) => s.endsWith("hydration-manifest.json"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(map.sourcesContent[i]).toContain('"streamLedger": true');
  });
});
