// Stage 3 (F, compiler-scoped lazy hydration) — the island linker (see islands.js).

/** One module's summary, from `summarizeIslands(code, { filename })`. */
export type IslandSummary = Record<string, unknown>;

export interface IslandMap {
  /** Every cell in the graph, `"<module>#<name>"`. */
  cells: string[];
  /** Island → the cells it may read (event handlers excluded). */
  islands: Record<string, string[]>;
  /** `"<module>#<export>"` → what an exported function may write, and the islands reading it. */
  exports: Record<string, { writes: string[]; islands: string[] }>;
  /** JSX `on*` handlers. */
  handlers: { module: string; start: number; event: string; writes: string[]; islands: string[] }[];
  /** Island → the islands to hydrate before its first event is handled (itself included). */
  onEvent: Record<string, string[]>;
  /** Cells whose setter escaped: written by any code that calls unknown functions. */
  escaped: string[];
  /** Cells whose accessor escaped: read by any code that calls unknown functions. */
  escapedRead: string[];
}

export function linkIslands(options: {
  modules: Record<string, IslandSummary>;
  /** The module id an import specifier names, or null outside the analyzed graph. */
  resolve: (from: string, source: string) => string | null;
  /** Island name → its root component. */
  islands: Record<string, { module: string; export: string }>;
}): IslandMap;
