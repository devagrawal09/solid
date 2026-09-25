/**
 * The deterministic FIXTURE manifest producer (optimization slice 7).
 *
 * Manifest production is isolated from consumption: the consumer
 * (`@solidjs/web/hydration-manifest` — validator and entry composer) only
 * knows the `HydrationManifestProducer` contract and never imports this
 * module. Until the Track C linker can derive capabilities from the complete
 * client and server graphs, capabilities come from checked-in fixture
 * manifests, one per fixture graph, reviewed by hand against what the
 * graph's server render actually emits (capability-harness.spec.tsx asserts
 * the record kinds). There is deliberately no end-user API for choosing
 * capabilities: swapping this producer for the linker changes nothing on the
 * consumer side.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClientHydrationManifest,
  HydrationManifestProducer
} from "../../hydration-manifest/src/index.js";

export const MANIFEST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "manifests");
export const GENERATED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "generated");
export const SUMMARY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "summaries");

/**
 * Read a capability summary as a producer might hand it to the bootstrap
 * resolver — possibly foreign, unknown, or incompatible (summaries/*.json).
 */
export function readSummary(name: string): unknown {
  return JSON.parse(readFileSync(resolve(SUMMARY_DIR, `${name}.json`), "utf-8"));
}

export function summaryNames(): string[] {
  return readdirSync(SUMMARY_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => f.slice(0, -5))
    .sort();
}

/** Read a fixture manifest verbatim (unvalidated: invalid fixtures are fixtures too). */
export function readFixtureManifest(name: string): unknown {
  return JSON.parse(readFileSync(resolve(MANIFEST_DIR, `${name}.json`), "utf-8"));
}

export function fixtureManifestNames(): string[] {
  return readdirSync(MANIFEST_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => f.slice(0, -5))
    .sort();
}

/** Produces the positive manifest for a fixture graph by name. */
export const fixtureManifestProducer: HydrationManifestProducer<string> = {
  name: "fixture",
  produce(graph: string): ClientHydrationManifest {
    const manifest = readFixtureManifest(graph) as ClientHydrationManifest;
    if (manifest.graph !== graph)
      throw new Error(`fixture manifest "${graph}" describes graph "${manifest.graph}"`);
    return manifest;
  }
};
