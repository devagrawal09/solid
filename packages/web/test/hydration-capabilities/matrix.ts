/**
 * The capability matrix: every fixture manifest, the app it is hydrated
 * against, and the expected outcome. Shared by the manifest spec (validator
 * and composer) and the hydration spec (runtime behavior).
 */
export type MatrixCase =
  | { manifest: string; app: string; expect: "hydrates" }
  | { manifest: string; app: string; expect: "violation"; capability: string }
  | { manifest: string; app: string; expect: "diverges" }
  | { manifest: string; expect: "invalid"; error: RegExp };

export const capabilityMatrix: MatrixCase[] = [
  // Positive: the minimal manifest for each fixture graph.
  { manifest: "sync", app: "sync", expect: "hydrates" },
  { manifest: "store", app: "store", expect: "hydrates" },
  { manifest: "async", app: "async", expect: "hydrates" },
  { manifest: "streaming", app: "streaming", expect: "hydrates" },
  { manifest: "lazy", app: "lazy", expect: "hydrates" },
  { manifest: "full", app: "full", expect: "hydrates" },
  // Over-approximation is always sound: the full runtime hydrates every app.
  { manifest: "full", app: "sync", expect: "hydrates" },
  { manifest: "full", app: "store", expect: "hydrates" },
  { manifest: "full", app: "async", expect: "hydrates" },
  { manifest: "full", app: "lazy", expect: "hydrates" },

  // Intentional violations: structurally valid manifests that omit a
  // capability the page needs. Development builds must assert.
  {
    manifest: "violation-sync-no-delegated-events",
    app: "sync",
    expect: "violation",
    capability: "delegatedEvents"
  },
  {
    manifest: "violation-store-no-store-adapters",
    app: "store",
    expect: "violation",
    capability: "storeAdapters"
  },
  {
    manifest: "violation-async-no-async-results",
    app: "async",
    expect: "violation",
    capability: "asyncResults"
  },
  {
    manifest: "violation-async-no-error-markers",
    app: "async",
    expect: "violation",
    capability: "errorMarkers"
  },
  {
    manifest: "violation-streaming-no-stream-ledger",
    app: "streaming",
    expect: "violation",
    capability: "streamLedger"
  },
  {
    manifest: "violation-streaming-no-loading-markers",
    app: "streaming",
    expect: "violation",
    capability: "streamLedger"
  },
  {
    manifest: "violation-lazy-no-lazy-assets",
    app: "lazy",
    expect: "violation",
    capability: "lazyAssets"
  },
  {
    manifest: "violation-full-no-ssr-sources",
    app: "full",
    expect: "violation",
    capability: "ssrSources"
  },
  // Under-approximating a sparser graph: the sync manifest cannot hydrate
  // an async graph.
  { manifest: "sync", app: "async", expect: "violation", capability: "asyncResults" },

  // Production has no assertions: there the matrix proves its positive checks
  // are sensitive — an under-approximated manifest must observably diverge
  // from the universal runtime (markup, claimed nodes, or live updates).
  { manifest: "sync", app: "async", expect: "diverges" },
  { manifest: "sync", app: "store", expect: "diverges" },
  { manifest: "sync", app: "streaming", expect: "diverges" },
  { manifest: "sync", app: "lazy", expect: "diverges" },
  { manifest: "async", app: "streaming", expect: "diverges" },
  { manifest: "streaming", app: "full", expect: "diverges" },

  // Invalid manifests: rejected before any entry is composed.
  { manifest: "invalid-missing-snapshots", expect: "invalid", error: /snapshots is required/ },
  {
    manifest: "invalid-stream-without-loading",
    expect: "invalid",
    error: /streamLedger requires loadingMarkers/
  },
  {
    manifest: "invalid-reserved-resumable-events",
    expect: "invalid",
    error: /resumableEvents is reserved/
  },
  { manifest: "invalid-unsorted-events", expect: "invalid", error: /sorted and unique/ },
  {
    manifest: "invalid-unknown-capability",
    expect: "invalid",
    error: /unknown key "hydrateEverything"/
  },
  { manifest: "invalid-schema-version", expect: "invalid", error: /schema: expected 1/ }
];
