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
  { manifest: "read-only", app: "read-only", expect: "hydrates" },
  { manifest: "event-only", app: "event-only", expect: "hydrates" },
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
  { manifest: "full", app: "read-only", expect: "hydrates" },
  { manifest: "full", app: "event-only", expect: "hydrates" },
  // A read-only graph needs no capability, so its manifest also hydrates the
  // sync graph's markup — except that graph registers delegated events.
  { manifest: "read-only", app: "sync", expect: "violation", capability: "delegatedEvents" },

  // Intentional violations: structurally valid manifests that omit a
  // capability the page needs. Development builds must assert.
  {
    manifest: "violation-sync-no-delegated-events",
    app: "sync",
    expect: "violation",
    capability: "delegatedEvents"
  },
  {
    manifest: "violation-event-only-no-delegated-events",
    app: "event-only",
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
  { manifest: "violation-event-only-no-delegated-events", app: "event-only", expect: "diverges" },
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

/**
 * Capability summaries as a producer might hand them to the bootstrap
 * resolver (test/hydration-capabilities/summaries/*.json), and the bootstrap
 * each must resolve to. "general" summaries select `export { hydrate } from
 * "@solidjs/web"`; the hydration spec checks they hydrate exactly like the
 * universal runtime.
 */
export type SummaryCase =
  | { summary: string; app: string; mode: "selected"; installers: string[] }
  | { summary: string; app: string; mode: "general"; reason: RegExp };

export const summaryCases: SummaryCase[] = [
  {
    summary: "envelope-with-hydration",
    app: "sync",
    mode: "selected",
    installers: ["eventReplayHydration"]
  },
  {
    summary: "unknown-capability-value",
    app: "full",
    mode: "general",
    reason: /capability "asyncResults" is unknown/
  },
  { summary: "newer-schema", app: "full", mode: "general", reason: /incompatible .* schema 2/ },
  {
    summary: "core-only-envelope",
    app: "streaming",
    mode: "general",
    reason: /no hydration section/
  },
  {
    summary: "foreign-capability",
    app: "full",
    mode: "general",
    reason: /"viewTransitions" is not understood/
  },
  { summary: "missing-capability", app: "sync", mode: "general", reason: /missing "snapshots"/ }
];
