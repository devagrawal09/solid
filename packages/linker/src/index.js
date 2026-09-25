// @solidjs/linker — strict-mode bundler/linker analysis (Track C).
//
//   loadGraph      crawl one environment's graph; summarize modules; attach
//                  typed summaries and library summaries
//   analyze        event-only proofs, fixed-point hot|cold|shared|unknown
//                  classification, interaction-domain clustering
//   buildManifest  the `solid-link-manifest` document
export { analyze, classOf, LABELS } from "./analyze.js";
export {
  loadGraph,
  loadTypedSummaries,
  loadLibrarySummary,
  summarizePackage,
  createNodeResolver,
  sourceHash,
  RUNTIME_PACKAGES,
  LIBRARY_SCHEMA
} from "./load.js";
export { buildManifest, MANIFEST_SCHEMA, MANIFEST_VERSION } from "./manifest.js";

import fs from "node:fs";
import { analyze } from "./analyze.js";
import { createNodeResolver, loadGraph, loadTypedSummaries } from "./load.js";

/**
 * Analyze one environment graph outside a bundler (tests, CLIs, the server
 * graph): `link({ root, entries, environment, typedSummaries, resolve })`.
 */
export async function link({
  root,
  entries,
  environment = "client",
  typedSummaries = null,
  typedRoot = root,
  strict = true,
  maxDomainBytes,
  resolve = createNodeResolver({
    conditions:
      environment === "server" ? ["import", "node", "default"] : ["import", "browser", "default"]
  })
}) {
  const typed = typedSummaries ? loadTypedSummaries(typedSummaries) : null;
  const graph = await loadGraph({
    entries,
    root,
    typed,
    typedRoot,
    resolve: async (source, importer) => resolve(source, importer),
    load: async id => {
      try {
        return fs.readFileSync(id, "utf8");
      } catch {
        return null;
      }
    }
  });
  return analyze(graph, { environment, strict, maxDomainBytes, root });
}
