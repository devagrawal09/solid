/**
 * Types of the resumable-events prototype (experimental, private).
 */
import type { ResumableHandler, ResumableManifest, ResumableScope } from "@solidjs/compiler";

/** Manifest / record / module schema shared by every part. */
export const SCHEMA: 1;

// ---- server ---------------------------------------------------------------

/** `sr:<hydration key>`: the serializer key of an instance record. */
export const RECORD_PREFIX: "sr:";

export interface Refusal {
  kind: "refused";
  scope: string;
  key?: string;
  reason: string;
  error?: unknown;
}

export function configureResumable(options: {
  onRefuse?: ((refusal: Refusal) => void) | null;
  log?: boolean;
}): void;

export interface ScopeInstance {
  id: string;
  values: () => Record<string, unknown>;
  key: string | undefined;
  refused: string | null;
}

/** Compiler-emitted: one component instance's scope. */
export function srScope(id: string, values: () => Record<string, unknown>): ScopeInstance;
/** Compiler-emitted: the template root's hydration-key hole. */
export function srRoot(instance: ScopeInstance): string;
/** Compiler-emitted: the element marker hole. */
export function srEl(instance: ScopeInstance, index: number): string;
/** The nearest server error boundary's hydration id, or null. */
export function nearestBoundary(): string | null;
/** Why `value` is not data the client can receive, or null. */
export function checkData(value: unknown, path: string): string | null;
/** JSON safe inside an inline script. */
export function jsonForScript(value: unknown): string;

export interface RouteManifest {
  schema: 1;
  /** Hash of every module id and handler source hash. */
  build: string;
  /** URL of the event-domain runtime chunk. */
  runtime: string;
  modules: Record<string, { url: string; file: string }>;
  scopes: ResumableScope[];
  handlers: ResumableHandler[];
}

export function generateResumeBootstrap(options: {
  manifest: RouteManifest;
  nonce?: string;
  /** Bootstrap code to inline (defaults to the built `dist/bootstrap.iife.js`). */
  code?: string;
  options?: object;
}): string;

// ---- bootstrap ------------------------------------------------------------

export interface ResumeFailure {
  kind:
    | "stale-manifest"
    | "missing-record"
    | "stale-record"
    | "stale-module"
    | "chunk-failed"
    | "root-mismatch"
    | "reconstruct-failed"
    | "handler-error"
    | "invariant";
  message: string;
  node: Element | null;
  key?: string;
  handler?: string;
  boundary?: string | null;
  error?: unknown;
}

export interface BootstrapOptions {
  document?: Document;
  window?: Window & typeof globalThis;
  /** Module loader (default: dynamic `import(url)`). */
  load?: (url: string) => Promise<any>;
  report?: (failure: ResumeFailure) => void;
  dev?: boolean;
}

export interface BootstrapController {
  stats: {
    cold: number;
    warm: number;
    dropped: number;
    guarded: number;
    failed: number;
    loads: number;
  };
  dispose(key: string): void;
  prefetch(handlerId: string): Promise<void>;
  settled(): Promise<void>;
  uninstall(): void;
}

export function install(
  manifest: RouteManifest,
  options?: BootstrapOptions
): BootstrapController | null;

// ---- runtime --------------------------------------------------------------

export function registerBoundary(
  id: string,
  receiver: (error: unknown, info: ResumeFailure) => void
): () => void;
export function reconstruct(input: {
  key: string;
  scope: ResumableScope;
  record: { s: string; v: Record<string, unknown>; b: string | null };
  root: Element;
  dev: boolean;
  report: (failure: ResumeFailure) => void;
}): unknown;
export function invoke(
  instance: unknown,
  handler: ResumableHandler,
  factory: (scope: object) => Function,
  event: unknown,
  live: boolean
): void;
export function flush(): void;

// ---- build ----------------------------------------------------------------

export interface BuildOptions {
  root: string;
  entries: string[];
  outDir: string;
  serverModule?: string;
  dev?: boolean;
  minify?: boolean;
  require?: boolean;
  trusted?: { source: string; imported: string }[];
  compile?: Record<string, unknown>;
  esbuild?: Record<string, unknown>;
}

export interface BuildResult {
  manifest: RouteManifest;
  diagnostics: (ResumableManifest["diagnostics"][number] & { file: string })[];
  outDir: string;
  serverFiles: Record<string, string>;
  metafile: unknown;
  written: string[];
}

export function buildResumable(options: BuildOptions): Promise<BuildResult>;
export function buildBootstrap(options: { outFile?: string; minify?: boolean }): Promise<string>;
export function linkFacts(
  file: string,
  source: string,
  options: { root: string; trusted?: { source: string; imported: string }[] }
): Promise<{ facts: object[]; actionModules: Map<string, object>; imports: object[] }>;

// ---- rollup ---------------------------------------------------------------

export function solidResumable(options: {
  root: string;
  entries: string[];
  serverModule?: string;
  require?: boolean;
  manifestFileName?: string;
}): import("rollup").Plugin;
