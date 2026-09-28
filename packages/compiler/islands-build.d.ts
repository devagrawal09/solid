// Compiled islands: build glue around `compileIslands` (see islands-build.js).

export type PrefetchPolicy = "load" | "idle" | "visible" | "intent" | "interaction";

export interface IslandInfo {
  id: string;
  /** Root component of the island group. */
  root: string;
  members: string[];
  /** Runtime tier the chunk is bound to (0: t0 helper, 1: kernel, 2: core). */
  tier: 0 | 1 | 2;
  events: string[];
  windowEvents: string[];
  activation: "lazy" | "load";
  anchor: "element" | "comment";
  preventDefault: boolean;
  nests?: boolean;
  /** Its static paths cross a streamed boundary: activate once none around it is pending. */
  waits?: boolean;
  /** Per-island prefetch override. */
  prefetch?: PrefetchPolicy;
  /** Chunk size in bytes (for the prefetch budget). */
  size?: number;
  file?: string;
}

export interface IslandsEntryOptions {
  islands: IslandInfo[];
  /** "auto": hot islands at load, the rest on interaction; "eager": all at load; "lazy": as auto. */
  mode?: "auto" | "eager" | "lazy";
  /** App default prefetch policy (default "interaction"). */
  prefetch?: PrefetchPolicy;
  /** Per-island overrides, by root component name or island id. */
  overrides?: Record<string, PrefetchPolicy>;
  /** Bytes of lazy chunks prefetch may load. */
  budget?: number;
  /** Downgrade prefetch to "interaction" under saveData / 2G (default true). */
  network?: boolean;
  chunk?: (id: string) => string;
  hooks?: { before?: string; after?: string };
  /** Root components of modules that fell back to hydration. */
  hydrate?: { module: string; export: string; selector?: string }[];
  web?: string;
  /** Some module streams boundary chunks (islands-stream.js): activate islands as they land. */
  streams?: boolean;
  /** A lazy island's chunk size as a JS expression (default: its source bytes). */
  sizeOf?: (island: IslandInfo) => string;
  /** The dev verifier: check every anchor's server markup against its island's addresses. */
  verify?: boolean;
}

/** The page's client entry module source (exports `start()`). */
export function islandsEntry(options: IslandsEntryOptions): string;

export interface IslandsCompilerOptions {
  runtimes?: { t0?: string; kernel?: string; core?: string };
  tier1Core?: boolean;
  minTier?: 0 | 1 | 2;
  debug?: boolean;
  idPrefix?: string;
  /** Cross-module inlining from per-module summaries (default true). */
  crossModule?: boolean;
  /** Chunks export `verify(anchor)` (the dev verifier). */
  verify?: boolean;
}

export class IslandsCompiler {
  constructor(options?: IslandsCompilerOptions);
  compileFile(
    file: string,
    code?: string
  ): {
    server: string;
    client: string | null;
    chunks: { id: string; code: string; size: number }[];
    manifest: any;
    fallback: string | null;
  };
  /** A module's `islandExports` summary (pass one, cached by content). */
  summary(file: string, code?: string): import("./types").IslandExports;
  /** The imported modules whose sources this module's compile inlines. */
  importsFor(file: string, code: string): { specifier: string; filename: string; code: string }[];
  collect(
    root: string,
    filter?: (file: string) => boolean
  ): {
    islands: IslandInfo[];
    chunks: Map<string, string>;
    fallbacks: { file: string; reason: string }[];
    files: string[];
    /** Some collected module streams a boundary. */
    streams: boolean;
  };
}

export interface SolidIslandsOptions {
  /** The page's root module (islands are collected from it and its relative imports). */
  root: string;
  include?: RegExp;
  exclude?: RegExp;
  mode?: "auto" | "eager" | "lazy";
  prefetch?: PrefetchPolicy;
  overrides?: Record<string, PrefetchPolicy>;
  budget?: number;
  network?: boolean;
  runtimes?: { t0?: string; kernel?: string; core?: string };
  /** Bind tier-1 islands to the core when the page loads it anyway ("auto"). */
  tier1Core?: boolean | "auto";
  /** Export of the root module hydrated when it falls back (default "App"). */
  rootExport?: string;
  /** Mount selector for a fallback root (default "#root"). */
  mount?: string;
  /** The dev verifier (default: on in the dev server). */
  verify?: boolean;
}

/** Vite plugin: client (virtual:solid-islands entry + chunks) and SSR builds. */
export function solidIslands(options: SolidIslandsOptions): any;

/** esbuild plugin (the measurement harness). */
export function esbuildIslands(options: {
  root: string;
  mode?: "auto" | "eager" | "lazy";
  prefetch?: PrefetchPolicy;
  overrides?: Record<string, PrefetchPolicy>;
  budget?: number;
  network?: boolean;
  hooks?: { before?: string; after?: string };
  compiler?: IslandsCompiler;
  filter?: RegExp;
  rootExport?: string;
  mount?: string;
}): any;

export const PREFETCH: PrefetchPolicy[];
export const ENTRY: string;
export const CHUNK: string;
