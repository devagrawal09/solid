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

/** Facts about the application modules' compiled output (build only). */
export interface CompiledFactsSummary {
  /** Application modules in the graph. */
  modules: number;
  /** Modules whose compiled output the linker read. */
  withFacts: number;
  /** Generator functions left in compiled output, with their `yield*` count. */
  residualGenerators: { file: string; line: number; delegations: number }[];
  /** `yield*` delegations left in compiled output (ITERABLE). */
  delegations: number;
  /** Compiled seams requested (`statusFree`, `isEqual`, `noThrow`, `effectEquals`). */
  seams: string[];
  /** Creation calls by kind (`signal`, `memo`, `store`, `projection`, …). */
  creates: Record<string, number>;
  /** Store / path reader calls. */
  storeReads: number;
}

export interface CapabilityReport {
  /** Whether the whole graph was proven async-free. */
  asyncFree: boolean;
  /** The runtime entry `@solidjs/signals` resolves to when async-free. */
  entry: string | null;
  /** Everything that kept the full runtime (empty when async-free). */
  reasons: CapabilityReason[];
  /** The feature switches the graph may use (core runtime slicing). */
  features: FeatureFacts;
  /** Compiled-output facts the feature proof used (null without a loader). */
  facts?: CompiledFactsSummary | null;
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
  /**
   * The bundler's transformed code of a module (Rollup's `this.load`). With
   * it, virtual modules are summarized from their code and the feature
   * proof reads every application module's compiled output.
   */
  load?: (id: string) => Promise<string | null>;
}): Promise<CapabilityReport>;

export const FEATURE_SWITCHES: readonly FeatureSwitch[];

/**
 * A module of a published @solidjs/signals tree with the marked switch
 * literals (`/* @solid-feature NAME *\/ true`, left by the package's
 * scripts/inline-features.mjs) of every switch that is off rewritten to
 * `false`; null when nothing changes.
 */
export function sliceFeatureLiterals(
  code: string,
  features: Record<string, { on: boolean }>
): string | null;

export function proveFeatures(options: {
  libraries: Map<string, { manifest: any; names: Set<string> }>;
  complete: boolean;
  compiledSeams: boolean;
  /** App modules whose source contains `yield*` (ITERABLE stays on). */
  yieldStar?: string[];
  /** Per application module: authored imports, and compiled facts when known. */
  modules?: {
    rel: string;
    libraries: Map<string, { manifest: any; names: Set<string> }>;
    yieldStar: boolean;
    facts?: {
      libraries: Map<string, { manifest: any; names: Set<string> }>;
      delegations: number;
      residualGenerators: { line: number; delegations: number }[];
      seams: string[];
    };
  }[];
}): FeatureFacts;

/** The link-time switches of @solidjs/web/frames' client (frames/src/features.ts). */
export type FramesSwitch =
  | "FRAGMENTS"
  | "ASSETS"
  | "SLOT_DATA"
  | "ASYNC_ARGS"
  | "CONTAINERS"
  | "LIVE_PROPS"
  | "SINGLE_FLIGHT"
  | "FULL_CODEC"
  | "HYDRATION_CLAIMS";

export const FRAMES_SWITCHES: readonly FramesSwitch[];

/**
 * The frames client switches an application needs, proven from its server
 * graph's compiled output (conservative: a name or shape that may produce a
 * feature keeps it on; an unknown module keeps every switch on).
 */
export function proveFramesFeatures(options: {
  modules: { rel: string; code: string | null }[];
  complete?: boolean;
}): Record<FramesSwitch, { on: boolean; because: string[] }>;

/** The frames client's features module with the proven switches. */
export function framesFeaturesModuleSource(features: Record<FramesSwitch, { on: boolean }>): string;

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
  /** Prove the feature switches from compiled output (build only; default true). */
  compiledFacts?: boolean;
  /**
   * Slice the frames client's switches (default true): the server build
   * writes the proof from its compiled output, the client build (run after
   * it) substitutes @solidjs/web/frames' features module from it.
   */
  frames?: boolean;
  /** Where the server build writes the frames proof (relative to the root;
   * default `node_modules/.cache/solid/frames-features.json`). */
  framesProof?: string;
}

/** Vite / Rollup plugin: selects the async-free runtime for proven graphs,
 * and switches off the runtime features the graph is proven not to use. */
export function solidCapabilities(options?: SolidCapabilitiesOptions): any;

/**
 * A module's final output that hands a generator body to `createMemo` /
 * `createEffect` / `onSettled` (a module the Solid compiler did not
 * transform): the output importing and calling `installBlockDriver` first,
 * and the bodies found; `null` when it has none. `solidCapabilities` applies
 * it to every application module (a post transform) and warns.
 */
export function installDriverFor(
  code: string,
  id: string
): { code: string; bodies: { line: number; host: string; source: string }[] } | null;
