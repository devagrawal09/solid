import type { HelperSummary, TransformOptions } from "./types";

/** `{ [module path]: helperSummary }`, filled by the walk. */
export type HelperSummaries = Record<string, HelperSummary>;

export interface SummarizeHelperGraphOptions {
  /** Absolute paths of the entry modules. */
  entries: string[];
  /** Resolve an import source from an importer to an absolute path (or null). */
  resolve(source: string, importer: string): Promise<string | null> | string | null;
  readFile?(file: string): string;
  /** Filled in place (default: a new object). */
  summaries?: HelperSummaries;
  /** Compiler options the application's modules compile with (e.g. `hostFusion`). */
  compile?: TransformOptions;
  /** Modules to walk into (default: everything outside node_modules). */
  isApplication?(file: string): boolean;
}

export function summarizeHelperGraph(
  options: SummarizeHelperGraphOptions
): Promise<HelperSummaries>;

export interface SolidHelperSummariesOptions {
  /** The object passed to the Solid plugin as `solid.helperSummaries`. */
  summaries?: HelperSummaries;
  /** Entries when the build input names none (vitest). */
  entries?: string[];
  /** Compiler options the application's modules compile with. */
  compile?: TransformOptions;
}

export function solidHelperSummaries(options?: SolidHelperSummariesOptions): {
  name: string;
  enforce: "pre";
  apply(config: unknown, env: { command: string }): boolean;
  configResolved(config: unknown): void;
  buildStart(this: unknown, input: unknown): Promise<void>;
};
