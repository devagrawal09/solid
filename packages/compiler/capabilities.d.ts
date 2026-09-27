// Track A stage 2 — the capability linker (see capabilities.js).

export interface CapabilityReason {
  file: string | null;
  line: number | null;
  reason: string;
  /** "async": an async fact; "graph": the module graph is not fully known. */
  kind: "async" | "graph";
}

/** The link-time feature switches of @solidjs/signals (src/core/features.ts). */
export type FeatureSwitch =
  | "OPTIMISTIC"
  | "VERDICTS"
  | "STORES"
  | "SNAPSHOTS"
  | "ITERABLE"
  | "COMPILED_SEAMS";

/** Per switch: whether the graph may use the feature, and why (first few). */
export type FeatureFacts = Record<FeatureSwitch, { on: boolean; because: string[] }>;

export interface CapabilityReport {
  /** Whether the whole graph was proven async-free. */
  asyncFree: boolean;
  /** The runtime entry `@solidjs/signals` resolves to when async-free. */
  entry: string | null;
  /** Everything that kept the full runtime (empty when async-free). */
  reasons: CapabilityReason[];
  /** The feature switches the graph may use (core runtime slicing). */
  features: FeatureFacts;
  /** Application modules in the graph (relative to the root). */
  modules: string[];
  /** Library packages reached, with the names imported from each. */
  libraries: Record<string, string[]>;
  counts: {
    computes: number;
    computesLocal: number;
    computesTyped: number;
    props: number;
    propsChecked: number;
    assets: number;
    dynamicImports: number;
  };
  graph?: "client" | "server";
}

export function proveGraph(options: {
  entries: string[];
  resolve: (source: string, importer: string) => Promise<string | null>;
  readFile?: (file: string) => string;
  typedSummary?: unknown;
  root: string;
  /** Whether the build's compiler passes may emit compiled seams (default true). */
  compiledSeams?: boolean;
}): Promise<CapabilityReport>;

export const FEATURE_SWITCHES: readonly FeatureSwitch[];

export function proveFeatures(options: {
  libraries: Map<string, { manifest: any; names: Set<string> }>;
  complete: boolean;
  compiledSeams: boolean;
  /** App modules whose source contains `yield*` (ITERABLE stays on). */
  yieldStar?: string[];
}): FeatureFacts;

export interface SolidCapabilitiesOptions {
  /** Entry modules (relative to the root) when the build input does not name them. */
  entries?: string[];
  /** `solid-tsc --capabilities` output: a path relative to the root, or the parsed object. */
  typedSummary?: string | object;
  /** Write the linker report here (relative to the root). */
  report?: string;
  /** Slice the runtime's link-time feature switches (default true). */
  features?: boolean;
  /** Whether this build's compiler passes may emit compiled seams (default true). */
  compiledSeams?: boolean;
}

/** Vite / Rollup plugin: selects the async-free runtime for proven graphs,
 * and switches off the runtime features the graph is proven not to use. */
export function solidCapabilities(options?: SolidCapabilitiesOptions): any;
