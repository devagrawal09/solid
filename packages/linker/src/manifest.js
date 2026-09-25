// The link manifest (schema `solid-link-manifest`, version 1): one per
// environment graph. Deterministic: sorted arrays, root-relative paths, no
// timestamps (timings live in `stats.timings`, which consumers comparing
// manifests for cache stability must ignore).
export const MANIFEST_SCHEMA = "solid-link-manifest";
export const MANIFEST_VERSION = 1;

export function buildManifest(
  analysis,
  { plan = null, chunks = null, timings = {}, entries = [] } = {}
) {
  const domains = analysis.domains.map(domain => ({
    id: domain.id,
    chunk: chunks?.get(domain.id) ?? null,
    roots: domain.roots,
    blocks: domain.blocks,
    sourceBytes: domain.bytes,
    prefetch: plan?.prefetch ?? null
  }));
  const counts = { hot: 0, cold: 0, shared: 0, unknown: 0, unused: 0 };
  for (const module of analysis.modules) counts[module.class]++;
  const blockCounts = { hot: 0, cold: 0, unknown: 0 };
  for (const block of analysis.blocks) blockCounts[block.class]++;
  return {
    schema: MANIFEST_SCHEMA,
    version: MANIFEST_VERSION,
    environment: analysis.environment,
    entries,
    nonLiteralDynamicImport: analysis.nonLiteralDynamicImport,
    lazyRoots: analysis.lazyRoots,
    modules: analysis.modules.map(({ id, ...module }) => module),
    bindings: analysis.bindings,
    blocks: analysis.blocks,
    domains,
    stats: {
      modules: counts,
      blocks: blockCounts,
      domains: domains.length,
      movedStatements: [...analysis.moved.values()].reduce((sum, list) => sum + list.length, 0),
      iterations: analysis.iterations,
      timings
    }
  };
}
