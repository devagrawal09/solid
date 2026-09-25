/**
 * The manifest-to-bootstrap contract (optimization slice 7).
 *
 * `resolveHydrationBootstrap(summary)` is what a bundler plugin calls with
 * whatever capability summary the build produced. It is CONSERVATIVE by
 * construction and never throws:
 *
 * - It selects a capability-specialized client entry only when the summary
 *   carries a hydration section in a schema this consumer understands, every
 *   capability in it is decided (no `"unknown"`), and it passes validation
 *   (exact keys, dependency rules, registered consumers for reserved
 *   capabilities).
 * - In every other case — no summary, a foreign shape, a newer or older
 *   schema, an unknown capability key, an `"unknown"` value, a structurally
 *   or semantically invalid section — it selects the GENERAL runtime:
 *   `export { hydrate } from "@solidjs/web"`, the universal hydrate() that
 *   installs every capability, plus the server bootstrap's default options.
 *   The reasons are returned and written into the entry's header.
 *
 * Slice 7 is a SIBLING consumer of the application capability manifest: when
 * the summary is an application-level envelope (`{ hydration: …, … }`), only
 * the `hydration` section is read. Other sections (for example the
 * async-free core's, optimization slice 4) are ignored — this consumer
 * neither needs nor assumes them — and a missing hydration section selects
 * the general runtime.
 *
 * The selected entry changes only which HYDRATION/BOOTSTRAP adapters are
 * installed. It never removes a reactive implementation: Loading, Errored,
 * stores, async memos, and lazy() keep working after hydration (and in any
 * client-rendered subtree) even when their adoption code is absent, because
 * those implementations are retained by the app's own imports.
 *
 * Every generated entry carries a source map whose single source is the
 * manifest it was composed from: each installer maps to the capability key
 * that selected it, and a general entry maps to the summary it rejected.
 */
import type { ClientHydrationManifest } from "./schema.js";
import { HYDRATION_MANIFEST_SCHEMA, HYDRATION_CAPABILITY_KEYS } from "./schema.js";
import { validateHydrationManifest } from "./validate.js";
import {
  composeHydrationEntry,
  resolveHydrationInstallers,
  serializeHydrationManifest,
  type ComposeOptions
} from "./compose.js";
import {
  buildSourceMap,
  inlineSourceMapComment,
  type EntrySegment,
  type EntrySourceMap
} from "./sourcemap.js";

export interface BootstrapOptions extends ComposeOptions {
  /** Source name recorded in the entry's source map. Default "hydration-manifest.json". */
  manifestSource?: string;
  /** File name recorded in the entry's source map. Default "hydration-entry.js". */
  entryFile?: string;
  /** Append the source map to the entry as an inline data URL. Default false. */
  inlineSourceMap?: boolean;
}

interface Entry {
  /** ES module source exporting `hydrate`. */
  code: string;
  /** Source map from `code` to the manifest (or rejected summary). */
  map: EntrySourceMap;
}

export type HydrationBootstrap =
  | {
      mode: "selected";
      manifest: ClientHydrationManifest;
      /** Runtime exports the entry installs, in installation order. */
      installers: string[];
      entry: Entry;
      /** Options for generateHydrationScript / <HydrationScript>. */
      server: { eventNames: string[] };
      reasons: [];
    }
  | {
      mode: "general";
      /** Why the specialized entry was not selected. Never empty. */
      reasons: string[];
      entry: Entry;
      /** Server bootstrap defaults (no eventNames: the runtime default set). */
      server: {};
    };

const INSTALLER_KEYS: Record<string, string> = {
  installSnapshotHydration: "snapshots",
  installAsyncResultHydration: "asyncResults",
  installSsrClientHydration: "ssrSources",
  installSsrHybridHydration: "ssrSources",
  installStoreHydration: "storeAdapters",
  installErrorMarkerHydration: "errorMarkers",
  loadingMarkerHydration: "loadingMarkers",
  streamLedgerHydration: "streamLedger",
  lazyAssetHydration: "lazyAssets",
  eventReplayHydration: "delegatedEvents"
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Find the hydration section: the manifest itself, or `envelope.hydration`. */
function hydrationSection(summary: unknown): { section?: unknown; reason?: string } {
  if (summary === undefined || summary === null)
    return { reason: "no capability summary was produced for this client graph" };
  if (!isObject(summary)) return { reason: "the capability summary is not an object" };
  // A hydration manifest carries `capabilities`; an application-level
  // envelope carries a `hydration` section beside sections other consumers
  // own. Anything with neither has nothing this consumer can read.
  if ("capabilities" in summary) return { section: summary };
  if ("hydration" in summary) {
    if (summary.hydration === "unknown" || summary.hydration == null)
      return { reason: "the capability summary's hydration section is unknown" };
    return { section: summary.hydration };
  }
  return { reason: "the capability summary has no hydration section" };
}

function unknownCapabilities(section: Record<string, unknown>): string[] {
  const caps = section.capabilities;
  if (caps === "unknown") return ["all capabilities are unknown"];
  if (!isObject(caps)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(caps)) {
    if (value === "unknown" || (Array.isArray(value) && value.includes("unknown")))
      out.push(`capability "${key}" is unknown`);
  }
  return out;
}

function safeJson(value: unknown): string {
  try {
    return (JSON.stringify(value, null, 2) ?? String(value)) + "\n";
  } catch {
    return String(value) + "\n";
  }
}

function generalBootstrap(
  reasons: string[],
  summary: unknown,
  options: BootstrapOptions
): HydrationBootstrap {
  const web = options.webModule ?? "@solidjs/web";
  const lines = [
    "// @generated by @solidjs/web/hydration-manifest resolveHydrationBootstrap. Do not edit.",
    "// general runtime: every hydration capability is installed, because",
    ...reasons.map(r => `// - ${r.replace(/\n/g, " ")}`),
    `export { hydrate } from ${JSON.stringify(web)};`
  ];
  const exportLine = lines.length - 1;
  const map = buildSourceMap(
    options.entryFile ?? "hydration-entry.js",
    options.manifestSource ?? "hydration-manifest.json",
    safeJson(summary),
    lines.length + 1,
    [{ line: exportLine, column: 0, sourceLine: 0, sourceColumn: 0 }]
  );
  let code = lines.join("\n") + "\n";
  if (options.inlineSourceMap) code += inlineSourceMapComment(map) + "\n";
  return { mode: "general", reasons, entry: { code, map }, server: {} };
}

/**
 * Resolve the client hydration bootstrap for a capability summary. Never
 * throws: anything this consumer cannot prove selects the general runtime.
 */
export function resolveHydrationBootstrap(
  summary: unknown,
  options: BootstrapOptions = {}
): HydrationBootstrap {
  const { section, reason } = hydrationSection(summary);
  if (reason) return generalBootstrap([reason], summary, options);
  if (!isObject(section))
    return generalBootstrap(["the hydration section is not an object"], summary, options);
  if (section.schema !== HYDRATION_MANIFEST_SCHEMA)
    return generalBootstrap(
      [
        `incompatible hydration manifest schema ${JSON.stringify(section.schema)} ` +
          `(this runtime consumes schema ${HYDRATION_MANIFEST_SCHEMA})`
      ],
      summary,
      options
    );
  const unknown = unknownCapabilities(section);
  if (unknown.length) return generalBootstrap(unknown, summary, options);
  const caps = section.capabilities;
  if (isObject(caps)) {
    const foreign = Object.keys(caps).filter(
      k => !(HYDRATION_CAPABILITY_KEYS as readonly string[]).includes(k)
    );
    if (foreign.length)
      return generalBootstrap(
        foreign.map(k => `capability "${k}" is not understood by this runtime`),
        summary,
        options
      );
  }
  const result = validateHydrationManifest(section, { consumers: options.consumers });
  if (!result.ok) return generalBootstrap(result.errors, summary, options);

  const manifest = result.manifest;
  const installers = resolveHydrationInstallers(manifest, options).map(i => i.name);
  const code = composeHydrationEntry(manifest, options);
  const source = serializeHydrationManifest(manifest);
  const sourceLines = source.split("\n");
  const keyLine = (key: string) => {
    const i = sourceLines.findIndex(l => l.trimStart().startsWith(`"${key}":`));
    return {
      sourceLine: Math.max(0, i),
      sourceColumn: Math.max(0, sourceLines[i]?.indexOf('"') ?? 0)
    };
  };
  const genLines = code.split("\n");
  const segments: EntrySegment[] = [];
  const keyFor = (name: string) =>
    INSTALLER_KEYS[name] ??
    (options.consumers?.resumableEvents?.name === name ? "resumableEvents" : "capabilities");
  genLines.forEach((text, line) => {
    if (text.startsWith("import ")) {
      const names = text.slice(text.indexOf("{") + 1, text.indexOf("}"));
      let from = text.indexOf("{") + 1;
      for (const raw of names.split(",")) {
        const name = raw.trim();
        const column = text.indexOf(name, from);
        from = column + name.length;
        segments.push({ line, column, ...keyLine(keyFor(name)) });
      }
    } else if (text.startsWith("export const hydrate")) {
      const call = text.indexOf("createHydrator(");
      segments.push({ line, column: call, ...keyLine("capabilities") });
      let from = text.indexOf("[", call) + 1;
      for (const name of installers) {
        const column = text.indexOf(name, from);
        from = column + name.length;
        segments.push({ line, column, ...keyLine(keyFor(name)) });
      }
      const events = text.lastIndexOf(", [");
      segments.push({ line, column: events + 2, ...keyLine("delegatedEvents") });
    }
  });
  const map = buildSourceMap(
    options.entryFile ?? "hydration-entry.js",
    options.manifestSource ?? "hydration-manifest.json",
    source,
    genLines.length,
    segments
  );
  const entryCode = options.inlineSourceMap ? code + inlineSourceMapComment(map) + "\n" : code;
  return {
    mode: "selected",
    manifest,
    installers,
    entry: { code: entryCode, map },
    server: { eventNames: [...manifest.capabilities.delegatedEvents] },
    reasons: []
  };
}
