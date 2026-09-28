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
   * Erase `$()` block wrappers and `perform` calls when consumed by a
   * statically known host (`createMemo`, `createEffect`, …), producing output
   * identical to hand-written Solid. Requires `generators: true`.
   *
   * Unset (the default): generator blocks v2 bodies are fused (`$memo`
   * creations, split-effect computes, view holes) and — DOM output — lowered
   * further on the client: setup creations become direct primitive calls,
   * effect halves plain effect callbacks, operation-free events and setups
   * lose their block, and constructors target their compiled-only entries
   * (`$componentCompiled`, `syncBlock`, …) so a fully compiled module does
   * not retain the generator driver. `true` also fuses plain `$` blocks;
   * `false` opts out of all of it (the plain lowering).
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
   * Generator blocks v2: the helper summaries of imported modules (each
   * module's `helperSummary`), keyed by the import source as written or by
   * the imported module's path (matched against this module's relative
   * imports, resolved from `filename`). A call site of a summarized helper
   * whose host the summary admits calls the helper's lowered twin. See
   * `@solidjs/compiler/helpers-build`.
   */
  helperSummaries?: Record<string, HelperSummary> | null;
}

/** A module's exported helper generators with a lowered twin. */
export type HelperSummary = Record<
  string,
  { lowered: string; hosts: ("setup" | "view" | "memo" | "effect" | "event")[] }
>;

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
  /** Generator blocks v2: the module's exported helper twins, when it has any. */
  helperSummary?: HelperSummary;
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

/** Options of `compileIslands` (compiled islands over the v2 block graph). */
export interface CompileIslandsOptions {
  filename?: string;
  /** Prefix of the module's island ids (unique per app). */
  idPrefix?: string;
  /** Tier runtimes the activation chunks import. */
  t0Module?: string;
  kernelModule?: string;
  coreModule?: string;
  /** Bind tier-1 islands to the core (a page that loads it anyway). */
  tier1Core?: boolean;
  /** Raise every island to at least this tier. */
  minTier?: 0 | 1 | 2;
  /** Instrumented output (labelled tier-0 cells, reads through `get`). */
  debug?: boolean;
  /** Dev builds: chunks also export `verify(anchor)` (the dev verifier). */
  verify?: boolean;
  /** Probe cell hosts (`object.method`), e.g. the conformance harness's `h.signal`. */
  probeHosts?: string[];
  moduleName?: string;
  /**
   * Sources of relatively imported modules whose factories, helper
   * generators or components the module's islands are compiled with
   * (cross-module inlining; the bundler plugin passes those its
   * `islandExports` summaries name).
   */
  imports?: { specifier: string; filename: string; code: string }[];
}

export interface IslandExports {
  exports: {
    name: string;
    kind: "component" | "factory" | "helper" | "function" | "value";
  }[];
  imports: { specifier: string; names: string[] }[];
}

/** A module's islands summary (exports by kind, relative imports). */
export function islandExports(code: string, options?: { filename?: string }): IslandExports;

export interface CompileIslandsResult {
  /** String-template server module (or the hydratable SSR compile on fallback). */
  server: string;
  /** On fallback: the hydratable DOM compile. */
  client: string | null;
  /** One activation module per island group. */
  chunks: { id: string; code: string }[];
  manifest: {
    version: 1;
    module: string | null;
    fallback: string | null;
    /** A `<Loading>` over server data streams its content as a chunk. */
    streams: boolean;
    islands: Array<{
      id: string;
      root: string;
      members: string[];
      tier: 0 | 1 | 2;
      analysisTier: 0 | 1 | 2;
      ownTiers: Record<string, number>;
      why: string[];
      runtime: string;
      cells: string[];
      events: string[];
      windowEvents: string[];
      anchor: "element" | "comment";
      nests: boolean;
      activation: "lazy" | "load";
      preventDefault: boolean;
      /** Its static paths cross a streamed boundary (activate once it lands). */
      waits: boolean;
      serialized: string[];
      notes: string[];
    }>;
    components: Array<{
      name: string;
      class: "inert" | "island-root" | "island-member";
      islands: string[];
    }>;
  };
  /** Why the module falls back to hydration, when it does. */
  fallback: string | null;
}

export function compileIslands(code: string, options?: CompileIslandsOptions): CompileIslandsResult;
