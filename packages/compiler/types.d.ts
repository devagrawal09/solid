export interface TransformOptions {
  filename?: string;
  /** Default `"@solidjs/web"`. */
  moduleName?: string;
  /**
   * Source syntax frontend, matching `@solidjs/babel-plugin`: `"auto"`
   * (default) routes `.tsrx` filenames through the TSRX frontend and
   * everything else through standard JSX; `"tsrx"` and `"jsx"` force a
   * frontend regardless of filename. TSRX support is experimental.
   */
  syntax?: "auto" | "jsx" | "tsrx";
  generate?: "dom" | "ssr" | "universal" | "dynamic";
  hydratable?: boolean;
  dev?: boolean;
  /**
   * Emit the source tag name as a third `createComponent` argument
   * (`createComponent(Home, props, "Home")`) so dev/observe runtimes can
   * label owners after minification renames the function. DOM output only;
   * the production runtime ignores the argument.
   */
  componentNames?: boolean;
  sourceMap?: boolean;
  contextToCustomElements?: boolean;
  delegateEvents?: boolean;
  delegatedEvents?: string[];
  omitQuotes?: boolean;
  omitAttributeSpacing?: boolean;
  inlineStyles?: boolean;
  effectWrapper?: "effect" | false;
  wrapConditionals?: boolean;
  memoWrapper?: "memo" | false;
  staticMarker?: string;
  validate?: boolean;
  omitNestedClosingTags?: boolean;
  omitLastClosingTag?: boolean;
  serverComponents?: boolean;
  /** Default `["For", "Show", "Switch", "Match", "Loading", "Reveal", "Portal", "Repeat", "Dynamic", "Errored"]`. */
  builtIns?: string[];
  requireImportSource?: false | string;
  renderers?: RendererOption[];
  /**
   * Lower `$(function* () { … yield* signal … })` typed blocks (`$` imported
   * from `solid-js` / `@solidjs/signals`) to call form
   * (`$(function () { … perform(signal) … })`) ahead of JSX lowering. Only
   * the sync subset is lowered (`yield*` over identifiers / member
   * expressions and direct `raise` / `attempt` / `write` / `call` / `readStore`
   * calls);
   * blocks that `wait` stay with the runtime driver. `throw`, bare `yield`,
   * `async function*`, and a `yield*` inside JSX in an unlowerable block are
   * compile errors. Default `true`.
   */
  generators?: boolean;
  /**
   * Experimental: erase `$()` block wrappers and `perform` calls when
   * consumed by a statically known host (`createMemo`, `createEffect`, …),
   * producing output identical to hand-written Solid. Requires `generators:
   * true`. Default `false`.
   *
   * Strict `$(fn)` markers (a non-generator callback) are always compiled
   * when `generators` is on: the marker is erased for its statically known
   * host and the graph lands in `TransformResult.strictBlocks`, or the
   * transform fails with a `[STRICT_…]` diagnostic.
   */
  hostFusion?: boolean;
  /**
   * Experimental (Track A, stage 1): prove lowered `$` blocks synchronous
   * and / or non-throwing and emit the proofs as block metadata
   * (`$(fn, flags)`) and `syncOnly` reactive-host options. Proofs
   * use local facts plus, in TypeScript modules, declared primitive signal
   * types; development builds verify them at runtime. Requires `generators:
   * true`. Default `false`.
   */
  blockProofs?: boolean;
  /**
   * Experimental (Track B slice 2, stage 2): hold module-local stores whose
   * uses are lowered path reads as proxy-free handles (every other use gets
   * the lazily materialized compatibility proxy), verify `Borrowed<T>` prop
   * contracts, and return the module's `storeSummary`. Requires
   * `generators: true`. Default `false`.
   */
  storeHandles?: boolean;
  /** Linker facts for `storeHandles`: imported components' verified Borrowed props. */
  storeLinkFacts?: StoreLinkFacts | null;
  /**
   * Experimental, private (resumable event blocks, see
   * documentation/plans/resumable-events.md): plan which strict `$(fn)` DOM
   * event handlers can resume from serialized captures without hydrating
   * their component, cut them into a separate event module, and on an SSR
   * generate mark the template so the server runtime emits coordinates.
   * Requires `generators: true`; SSR also requires `hydratable`. Default
   * `false`. The DOM generate is never rewritten.
   */
  resumableEvents?: boolean | ResumableEventsOptions;
}

export interface ResumableEventsOptions {
  /** Fail the build instead of leaving a marked handler hydrated. */
  require?: boolean;
  /** Project root the module id hashes the filename against. */
  root?: string;
  /** SSR helper import source. Default `"@solidjs/resumable/server"`. */
  serverModule?: string;
  /** Link facts: imports a handler may capture. */
  imports?: ResumableImportFact[];
}

export interface ResumableImportFact {
  source: string;
  imported: string;
  /** `action`: a registered server function (with its wire `id`); `trusted`: a plain value. */
  kind: "action" | "trusted";
  id?: string;
}

/** The per-module resumable-event manifest (schema 1). */
export interface ResumableManifest {
  schema: 1;
  /** xxhash32 of the root-relative filename. */
  module: string;
  file: string;
  scopes: ResumableScope[];
  handlers: ResumableHandler[];
  diagnostics: ResumableDiagnostic[];
  eventModule: { name: string; code: string; map: object | null } | null;
}

export interface ResumableScope {
  id: string;
  component: string;
  /** Keys of the per-instance values object the server serializes, in order. */
  values: string[];
  /** Signals the client reconstructs (their current value is in `values`). */
  signals: string[];
  bindings: { kind: "text"; path: number[]; hole: number | null; signal: string }[];
  elements: { path: number[]; on: Record<string, string> }[];
}

export type ResumableCapture =
  | { name: string; kind: "value"; reason: "component-const" | "props-path" }
  | { name: string; kind: "constant"; value: string | number | boolean | null }
  | { name: string; kind: "signal-setter"; signal: string }
  | { name: string; kind: "signal-accessor"; signal: string }
  | {
      name: string;
      kind: "import";
      source: string;
      imported: string;
      import: "action" | "trusted";
      id?: string;
    };

export type ResumablePreludeOp =
  | { op: "preventDefault" | "stopPropagation" | "stopImmediatePropagation" }
  | { op: "guard"; path: string[]; test: "truthy" | "falsy" }
  | { op: "guard"; path: string[]; test: "eq" | "neq"; value: string | number | boolean | null };

export interface ResumableHandler {
  id: string;
  scope: string;
  block: string;
  event: string;
  export: string;
  /** xxhash32 of the authored callback source. */
  source: string;
  async: boolean;
  captures: ResumableCapture[];
  prelude: ResumablePreludeOp[];
  snapshot: string[][];
}

export interface ResumableDiagnostic {
  block?: string;
  scope?: string;
  status: "resumable" | "hydrated";
  reason?: string;
  message: string;
  site: StrictSite;
}

export interface StoreLinkFacts {
  borrowed?: Record<string, Record<string, string[]>>;
}

/** Per-module store facts for a linker (see documentation/plans/track-b-slice-2-proxy-free-stores.md). */
export interface StoreSummary {
  version: 1;
  module: string;
  stores: {
    binding: string;
    loc: string;
    handle: boolean;
    refused: string | null;
    reads: number;
    setter: boolean;
    proxyFree: boolean;
    handoffs: { component: string; prop: string; via: string }[];
    escapes: { kind: string; loc: string; detail: string }[];
  }[];
  components: {
    name: string;
    exported: boolean;
    borrowed: {
      prop: string;
      verified: boolean;
      reads: number;
      violations: { kind: string; loc: string; detail: string }[];
    }[];
  }[];
  requires: { source: string; export: string; prop: string; status: "linked" | "unknown" }[];
}

export interface RendererOption {
  name: string;
  moduleName?: string;
  elements: string[];
}

export interface TransformResult {
  code: string;
  map?: string | null;
  /** Extracted scoped CSS for TSRX sources. */
  css?: string | null;
  /** Space-separated TSRX scope hashes. */
  cssHash?: string | null;
  /**
   * The graph summary of every strict `$(fn)` callback the module compiled
   * (see `analyzeStrictBlocks`). Absent when the module has none. A marked
   * callback that cannot be compiled fails the transform with a
   * `[STRICT_…]` error instead.
   */
  strictBlocks?: StrictAnalysis;
  /** The module's store summary, when `storeHandles` is on. */
  storeSummary?: StoreSummary;
  /** The module's resumable-event manifest, when `resumableEvents` is on and the module has strict event handlers. */
  resumable?: ResumableManifest;
}

export function transform(code: string, options?: TransformOptions | null): TransformResult;
export function transformAsync(
  code: string,
  options?: TransformOptions | null
): Promise<TransformResult>;

export interface ProjectTsrxForTypecheckOptions {
  filename?: string;
}

/** A source location: UTF-16 offsets plus 1-based line and column. */
export interface StrictSite {
  start: number;
  end: number;
  line: number;
  column: number;
}
export interface StrictDiagnostic {
  /** `STRICT_HOST_UNKNOWN`, `STRICT_CAPABILITY_ESCAPE`, `STRICT_READ_AFTER_AWAIT`, … */
  code: string;
  /** What the unsupported edge is and how to fix it. */
  message: string;
  site: StrictSite;
}
/** `exact`: every normal run performs it; `bounded`: a possible read. */
export type StrictCertainty = "exact" | "bounded";
export interface StrictRead {
  kind: "signal" | "store" | "prop";
  root: string;
  path: string[];
  /** `path`: the path's value; `structural`: a method called on the path. */
  access: "path" | "structural";
  certainty: StrictCertainty;
  /** False in event hosts, inside `untrack`, and after the first `await`. */
  tracked: boolean;
  afterAwait: boolean;
  site: StrictSite;
}
export interface StrictWrite {
  kind: "signal" | "store";
  target: string;
  certainty: StrictCertainty;
  afterAwait: boolean;
  site: StrictSite;
}
export interface StrictCreation {
  factory: string;
  /** The callback handed to the factory is itself a marked callback. */
  marked: boolean;
  certainty: StrictCertainty;
  afterAwait: boolean;
  site: StrictSite;
}
/** A call the compiler has no summary for (allowed with plain arguments). */
export interface StrictCall {
  callee: string;
  certainty: StrictCertainty;
  afterAwait: boolean;
  site: StrictSite;
}
/** A use of an unsummarized binding (an import, a context value, …). */
export interface StrictOpaque {
  name: string;
  site: StrictSite;
}
/** A capability that left the callback; always paired with a diagnostic. */
export interface StrictEscape {
  kind: string;
  name: string;
  site: StrictSite;
}
export interface StrictHost {
  /** `unknown` when host resolution failed (see `diagnostics`). */
  kind: "memo" | "signal" | "effect" | "render-effect" | "event" | "unknown";
  factory: string | null;
  events: string[];
  /** Every site that consumes the callback. */
  sites: StrictSite[];
}
export interface StrictBlockSummary {
  /** `<filename>#<index>` in source order. */
  id: string;
  host: StrictHost;
  /** The `$(…)` call. */
  marker: StrictSite;
  /** The callback expression. */
  callback: StrictSite;
  async: boolean;
  awaits: StrictSite[];
  reads: StrictRead[];
  writes: StrictWrite[];
  creations: StrictCreation[];
  calls: StrictCall[];
  opaque: StrictOpaque[];
  escapes: StrictEscape[];
  /**
   * `exact`: the listed reads are all the callback's reads and every run
   * performs them; `bounded`: the listed reads cover every read through a
   * known root, but some are conditional and/or unsummarized `calls` /
   * `opaque` accesses may read more (runtime tracking stays authoritative);
   * `unknown`: refused (see `diagnostics`).
   */
  completeness: "exact" | "bounded" | "unknown";
  diagnostics: StrictDiagnostic[];
}
export interface StrictAnalysis {
  version: 1;
  blocks: StrictBlockSummary[];
  /** Every diagnostic, in source order. */
  diagnostics: StrictDiagnostic[];
}
/**
 * Analyze the strict (non-generator) `$(fn)` callbacks of a module without
 * rewriting it: the graph summary `solid-tsc` reports alongside TypeScript
 * diagnostics and an editor language service can consume. Diagnostics are
 * returned, not thrown; `transform()` throws the first one.
 */
export function analyzeStrictBlocks(
  code: string,
  options?: { filename?: string } | null
): StrictAnalysis;

export interface TsrxTypecheckEmbeddedRegion {
  kind: "css" | "script";
  /** Authored JavaScript string offset in UTF-16 code units. */
  start: number;
  /** Authored JavaScript string offset in UTF-16 code units. */
  end: number;
  content: string;
}

export interface TsrxTypecheckMapping {
  /** Authored JavaScript string offset in UTF-16 code units. */
  sourceStart: number;
  /** Generated JavaScript string offset in UTF-16 code units. */
  generatedStart: number;
  sourceLength: number;
  generatedLength: number;
}

export interface TsrxTypecheckProjectionResult {
  /** Valid post-semantic-rewrite TypeScript/TSX. */
  code: string;
  /** JSON source map from virtual TSX back to the authored `.tsrx` source. */
  map: string;
  /** Exact equal-text ranges suitable for editor feature mappings. */
  mappings: TsrxTypecheckMapping[];
  css: string;
  cssHash: string | null;
  embeddedRegions: TsrxTypecheckEmbeddedRegion[];
}

/**
 * Experimental compiler-owned TSRX projection for typechecking and editor
 * tooling. This API is host-independent and does not run a runtime renderer.
 */
/** One splice of the block typecheck projection (offsets in UTF-16 code units). */
export interface BlockProjectionEdit {
  sourceStart: number;
  sourceEnd: number;
  generatedStart: number;
  generatedEnd: number;
}
export interface BlockTypecheckProjection {
  code: string;
  edits: BlockProjectionEdit[];
  rewrites: number;
}
/**
 * Pre-typecheck projection for `$` blocks' direct property syntax: wraps
 * each `yield* root.a[0][k]` operand as `readPath(root, ["a", 0, k], root.a[0][k])`
 * / `readProp(...)` (the ops the compiler lowers to, plus the authored
 * operand as a witness so TypeScript reports wrong keys at their column) and
 * adds their import. Every edit is an insertion, so all authored positions
 * survive; `solid-tsc` (`@solidjs/typecheck`) drives it and maps diagnostics
 * back with `edits`.
 */
export function projectBlocksForTypecheck(
  code: string,
  options?: { filename?: string } | null
): BlockTypecheckProjection;
export function projectTsrxForTypecheck(
  code: string,
  options?: ProjectTsrxForTypecheckOptions | null
): TsrxTypecheckProjectionResult;

export interface DirectiveImportDefinition {
  kind?: "named" | "default";
  name?: string;
  source: string;
}

/**
 * Options for the experimental `"use server"` directive pass. Applies to
 * plain `.js`/`.ts` modules as well as JSX/TSX.
 */
export interface TransformDirectivesOptions {
  /** Required — function IDs hash the root-relative file path. */
  filename: string;
  /** Project root for ID hashing. Defaults to the working directory. */
  root?: string;
  /**
   * `"server"` keeps the module and registers extracted functions;
   * `"client"` replaces them with reference proxies and strips server-only
   * code.
   */
  mode: "server" | "client";
  /** `"development"` appends function names to generated IDs. */
  env?: "production" | "development";
  /** @default "use server" */
  directive?: string;
  sourceMap?: boolean;
  /** Runtime import for `registerServerReference` (server output). */
  register?: DirectiveImportDefinition;
  /** Runtime import for `createServerReference` (both outputs). */
  create?: DirectiveImportDefinition;
}

/** One extracted server function, for building a bundler manifest. */
export interface ServerFunctionMeta {
  /** The wire ID (`<name>-<hash>[-<ordinal>]`). */
  id: string;
  /**
   * The dotted binding path that names the function, such as
   * `handlers.save`. `anonymous` when no enclosing binding applies.
   */
  name: string;
  /** Export names bound to this function (module-level directives only). */
  exports: string[];
}

export interface TransformDirectivesResult {
  code: string;
  map?: string | null;
  /** False when the module contained no matching directive. */
  valid: boolean;
  functions: ServerFunctionMeta[];
}

/**
 * Track A stage 2: a module's capability summary (`schema: 1`) — its import
 * and re-export edges, every reactive host compute with its local synchrony
 * proof, and the props of library components — for the capability linker.
 */
export interface CapabilitySummary {
  schema: 1;
  imports: { source: string; typeOnly: boolean; names: string[] }[];
  reexports: { source: string; names: string[] }[];
  computes: unknown[];
  componentProps: unknown[];
  dynamicImports: { source: string }[];
}

export function summarizeCapabilities(
  code: string,
  options?: { filename?: string } | null
): CapabilitySummary;

export function transformDirectives(
  code: string,
  options: TransformDirectivesOptions
): TransformDirectivesResult;
export function transformDirectivesAsync(
  code: string,
  options: TransformDirectivesOptions
): Promise<TransformDirectivesResult>;

/**
 * Options for the experimental `lazy()` module-URL pass (ported from
 * vite-plugin-solid's `lazy-module-url` Babel plugin).
 */
export interface TransformLazyOptions {
  /**
   * Mirrors the Babel plugin: without a filename the pass is a no-op (the
   * emitted placeholder is only useful to a bundler resolving relative to a
   * module id).
   */
  filename?: string;
  sourceMap?: boolean;
}

export function transformLazy(code: string, options?: TransformLazyOptions | null): TransformResult;
export function transformLazyAsync(
  code: string,
  options?: TransformLazyOptions | null
): Promise<TransformResult>;

/**
 * Options for the experimental solid-refresh HMR pass (ported from the
 * `solid-refresh` Babel plugin, `jsx: false` mode). Dev-only.
 */
export interface TransformRefreshOptions {
  /**
   * Used for `location` metadata (cwd-relative, matching the Babel plugin)
   * and to pick the parser dialect. Without it no locations are emitted.
   */
  filename?: string;
  /**
   * Selects the HMR API: `import.meta.hot` (esm/vite),
   * `import.meta.webpackHot` (webpack5/rspack-esm) or `module.hot`
   * (standard).
   * @default "standard"
   */
  bundler?: "esm" | "vite" | "webpack5" | "rspack-esm" | "standard";
  /**
   * Wrap top-level `render()`/`hydrate()` calls (imported from
   * `@solidjs/web`) with `hot.dispose` cleanup.
   * @default true
   */
  fixRender?: boolean;
  /**
   * Emit per-component `signature`/`dependencies` metadata for granular HMR.
   * @default true
   */
  granular?: boolean;
  /**
   * The Babel plugin's JSX-granularity mode is not ported; only `false` is
   * accepted (what vite-plugin-solid passes).
   */
  jsx?: false;
  /**
   * Module the runtime helpers (`$$registry`, `$$component`, `$$refresh`,
   * `$$decline`) are imported from. The dev-only `solid-js/refresh` entry
   * exposes the same frozen ABI.
   * @default "solid-refresh"
   */
  importSource?: string;
  sourceMap?: boolean;
}

export function transformRefresh(
  code: string,
  options?: TransformRefreshOptions | null
): TransformResult;
export function transformRefreshAsync(
  code: string,
  options?: TransformRefreshOptions | null
): Promise<TransformResult>;
