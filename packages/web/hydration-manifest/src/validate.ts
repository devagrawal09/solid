import {
  HYDRATION_MANIFEST_SCHEMA,
  HYDRATION_CAPABILITY_KEYS,
  type ClientHydrationManifest
} from "./schema.js";
import type { CapabilityConsumers } from "./compose.js";

export type ManifestValidation =
  | { ok: true; manifest: ClientHydrationManifest }
  | { ok: false; errors: string[] };

const TOP_LEVEL_KEYS = ["schema", "graph", "producer", "capabilities"];
const BOOLEAN_CAPABILITIES = [
  "streamLedger",
  "loadingMarkers",
  "errorMarkers",
  "asyncResults",
  "storeAdapters",
  "lazyAssets",
  "snapshots",
  "resumableEvents"
] as const;
const SSR_SOURCE_POLICIES = ["client", "hybrid"];
// Delegated event types are DOM event names the compiler delegates
// (lowercase: "click", "input", "pointerdown", …).
const EVENT_NAME = /^[a-z][a-z0-9]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function checkExactKeys(
  where: string,
  value: Record<string, unknown>,
  keys: readonly string[],
  errors: string[]
) {
  for (const key of keys) if (!(key in value)) errors.push(`${where}: missing "${key}"`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) errors.push(`${where}: unknown key "${key}"`);
}

function checkSortedUnique(where: string, list: readonly string[], errors: string[]) {
  for (let i = 1; i < list.length; i++)
    if (!(list[i - 1] < list[i])) {
      errors.push(
        `${where} must be sorted and unique (found "${list[i - 1]}" before "${list[i]}")`
      );
      return;
    }
}

/**
 * Validate a manifest against the schema and the capability dependency
 * rules. Structural: exact keys, types, sorted/unique lists (manifests are
 * compared and cached byte-for-byte, so producers must be deterministic).
 * Semantic: `streamLedger` requires `loadingMarkers`; any capability whose
 * values can change during a hydration pass requires `snapshots`; the
 * reserved `resumableEvents` requires a registered consumer.
 */
export function validateHydrationManifest(
  value: unknown,
  options: { consumers?: CapabilityConsumers } = {}
): ManifestValidation {
  const errors: string[] = [];
  if (!isPlainObject(value)) return { ok: false, errors: ["manifest: expected an object"] };
  checkExactKeys("manifest", value, TOP_LEVEL_KEYS, errors);
  if (value.schema !== HYDRATION_MANIFEST_SCHEMA)
    errors.push(
      `manifest.schema: expected ${HYDRATION_MANIFEST_SCHEMA}, got ${JSON.stringify(value.schema)}`
    );
  for (const key of ["graph", "producer"])
    if (typeof value[key] !== "string" || !(value[key] as string).length)
      errors.push(`manifest.${key}: expected a non-empty string`);

  const caps = value.capabilities;
  if (!isPlainObject(caps)) {
    errors.push("manifest.capabilities: expected an object");
    return { ok: false, errors };
  }
  checkExactKeys("manifest.capabilities", caps, HYDRATION_CAPABILITY_KEYS, errors);
  for (const key of BOOLEAN_CAPABILITIES)
    if (key in caps && typeof caps[key] !== "boolean")
      errors.push(`capabilities.${key}: expected a boolean`);

  const events = caps.delegatedEvents;
  if (!Array.isArray(events) || events.some(e => typeof e !== "string"))
    errors.push("capabilities.delegatedEvents: expected an array of event type names");
  else {
    for (const e of events)
      if (!EVENT_NAME.test(e))
        errors.push(`capabilities.delegatedEvents: "${e}" is not a delegated event type name`);
    checkSortedUnique("capabilities.delegatedEvents", events, errors);
  }

  const sources = caps.ssrSources;
  if (!Array.isArray(sources) || sources.some(s => !SSR_SOURCE_POLICIES.includes(s as string)))
    errors.push('capabilities.ssrSources: expected an array of "client" | "hybrid"');
  else checkSortedUnique("capabilities.ssrSources", sources as string[], errors);

  if (errors.length) return { ok: false, errors };

  // Semantic dependency rules.
  if (caps.streamLedger && !caps.loadingMarkers)
    errors.push(
      "capabilities.streamLedger requires loadingMarkers (a streamed fragment resumes through its loading boundary)"
    );
  const changing = (["asyncResults", "storeAdapters", "loadingMarkers"] as const).filter(
    k => caps[k]
  ) as string[];
  if ((sources as string[]).length) changing.push("ssrSources");
  if (!caps.snapshots && changing.length)
    errors.push(
      `capabilities.snapshots is required by ${changing.join(", ")} (their values can change during a hydration pass)`
    );
  if (caps.resumableEvents && !options.consumers?.resumableEvents)
    errors.push(
      "capabilities.resumableEvents is reserved for resumable event blocks (optimization slice 8) and has no registered consumer"
    );

  return errors.length
    ? { ok: false, errors }
    : { ok: true, manifest: value as unknown as ClientHydrationManifest };
}

/** validateHydrationManifest, throwing one error that lists every problem. */
export function assertHydrationManifest(
  value: unknown,
  options: { consumers?: CapabilityConsumers } = {}
): ClientHydrationManifest {
  const result = validateHydrationManifest(value, options);
  if (!result.ok)
    throw new Error(`Invalid client hydration manifest:\n  - ${result.errors.join("\n  - ")}`);
  return result.manifest;
}
