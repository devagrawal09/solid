// Track A stage 2 — the capability linker (see capabilities.js).

export interface CapabilityReason {
  file: string | null;
  line: number | null;
  reason: string;
}

export interface CapabilityReport {
  /** Whether the whole graph was proven async-free. */
  asyncFree: boolean;
  /** The runtime entry `@solidjs/signals` resolves to when async-free. */
  entry: string | null;
  /** Everything that kept the full runtime (empty when async-free). */
  reasons: CapabilityReason[];
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
}): Promise<CapabilityReport>;

export interface SolidCapabilitiesOptions {
  /** Entry modules (relative to the root) when the build input does not name them. */
  entries?: string[];
  /** `solid-tsc --capabilities` output: a path relative to the root, or the parsed object. */
  typedSummary?: string | object;
  /** Write the linker report here (relative to the root). */
  report?: string;
}

/** Vite / Rollup plugin: selects the async-free runtime for proven graphs. */
export function solidCapabilities(options?: SolidCapabilitiesOptions): any;
