/**
 * The client hydration capability manifest (optimization slice 7).
 *
 * A manifest is GENERATED: a producer that sees the complete client and
 * server graphs (the Track C linker, or a deterministic fixture producer
 * today) states which hydration protocols the client graph can receive. The
 * consumer side — this module, the validator, and the entry composer — never
 * infers capabilities and has no end-user feature-selection surface. Every
 * field is required, so a producer must decide each one explicitly; a
 * producer that cannot prove a capability absent must include it.
 *
 * The manifest only selects the hydration/bootstrap layer. It does not
 * remove the reactive core's implementations of async, loading, errors, or
 * stores (that is optimization slice 4, the async-free core).
 */

/** Schema version. Bumped on any incompatible change to the shape below. */
export const HYDRATION_MANIFEST_SCHEMA = 1 as const;

/** An `ssrSource` hydration policy other than the default "server". */
export type SsrSourcePolicyName = "client" | "hybrid";

export interface HydrationCapabilities {
  /**
   * The streamed-fragment ledger: `<id>_fr` declarations, `$df` reveal
   * policy, truncation, streamed-boundary resume, region reclaim after a
   * swap. Needed when the server graph can stream a `<Loading>` fragment.
   * Requires `loadingMarkers`.
   */
  streamLedger: boolean;
  /** Loading-boundary marker adoption ("$$f", settled/pending data refs, resume). */
  loadingMarkers: boolean;
  /** Error-boundary marker adoption (a serialized server error re-thrown on the first pass). */
  errorMarkers: boolean;
  /**
   * Serialized async result adoption for the signal family (createMemo,
   * computed createSignal/createOptimistic) and effects. Needed when a
   * signal-family compute can resolve asynchronously on the server.
   */
  asyncResults: boolean;
  /**
   * Derived store / projection / optimistic-store hydration adapters. Needed
   * when a derived store can adopt a server record or declares an ssrSource
   * policy. Plain `createStore(value)` never needs it.
   */
  storeAdapters: boolean;
  /** Lazy asset maps: boundary/root module preloads and lazy()'s synchronous lookup. */
  lazyAssets: boolean;
  /**
   * Delegated event types the client graph registers, sorted and unique. The
   * server bootstrap captures exactly these before hydration and the client
   * replays them; empty means no pre-hydration capture and no replay code.
   */
  delegatedEvents: readonly string[];
  /** The ssrSource policies some primitive in the client graph declares, sorted and unique. */
  ssrSources: readonly SsrSourcePolicyName[];
  /**
   * Snapshot/deferred-source setup. Required whenever a value can change
   * during a hydration pass: with asyncResults, storeAdapters, loadingMarkers,
   * or any ssrSource policy.
   */
  snapshots: boolean;
  /**
   * Reserved for resumable event blocks (optimization slice 8). No runtime
   * consumer exists yet: `true` is rejected unless a consumer is registered
   * with the composer.
   */
  resumableEvents: boolean;
}

export interface ClientHydrationManifest {
  schema: typeof HYDRATION_MANIFEST_SCHEMA;
  /** Identifier of the client graph (entry or route) the manifest describes. */
  graph: string;
  /** Who produced it, e.g. "fixture:async-app" or "linker:track-c@0.1.0". */
  producer: string;
  capabilities: HydrationCapabilities;
}

/**
 * A manifest producer: anything that can derive a manifest from its view of
 * the application graph. The consumer side only depends on this contract;
 * producers (fixtures now, the Track C linker later) live elsewhere and are
 * never imported by the composer or the runtime.
 */
export interface HydrationManifestProducer<Input> {
  readonly name: string;
  produce(input: Input): ClientHydrationManifest;
}

/** The capability keys in canonical order. */
export const HYDRATION_CAPABILITY_KEYS = [
  "streamLedger",
  "loadingMarkers",
  "errorMarkers",
  "asyncResults",
  "storeAdapters",
  "lazyAssets",
  "delegatedEvents",
  "ssrSources",
  "snapshots",
  "resumableEvents"
] as const satisfies readonly (keyof HydrationCapabilities)[];

export type HydrationCapabilityKey = (typeof HYDRATION_CAPABILITY_KEYS)[number];
