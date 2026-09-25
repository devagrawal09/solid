# Track C: Strict Multi-Module Summaries, Linker, and Cold Event-Domain Extraction

Status (2026-09-25): implemented as an experiment on `claude/track-c-cold-event-domains` (base `experiment/iterable-signals`). This covers the strict multi-module pipeline from [`typed-generator-compiler.md`](./typed-generator-compiler.md) ("Strict Multi-Module Pipeline") and its first consumer, optimization slice 3 (cold event-domain extraction). Resumability (slice 8) and deferred JSX branches are out of scope and not implemented.

## Pipeline

```text
authored module ──► compiler summarizeModule ──► solid-behavior-summary ─┐
                └─► solid-tsc (projected program) ──► typed facts ───────┴─► solid-module-summary (per module)
library dist JS ──► summarizePackage ──► solid-library-summary (shipped with the package)

bundler buildStart ──► loadGraph (per environment: client, server)
                   ──► analyze: resolution, event-only proofs, fixed-point hot|cold|shared|unknown, domains
                   ──► planExtraction (client): shells, cold block / residue / domain modules
                   ──► solid-link-manifest (emitted asset)
```

| Piece | Location |
| --- | --- |
| Behavioral summary (Rust) | `packages/compiler/src/summary.rs`, `summarizeModule()` |
| Typed summary | `packages/typecheck/src/summary.js`, `solid-tsc --solidSummaries <dir>` |
| Linker analysis | `packages/linker/src/{load,analyze,manifest}.js` |
| Extraction and runtime | `packages/linker/src/{extract,runtime,plugin}.js` |
| Benchmarks | `packages/linker/bench/{generate,run,todomvc}.mjs`, results in `packages/linker/bench/results/` |

## Schemas

Every document carries `schema` and `version`. A consumer that sees a different schema or version treats the input as missing, so it becomes `unknown`. Positions are UTF-16 offsets (`start`, `end`) plus a 1-based `line` and `column` of `start`. Output is deterministic: source order, or sorted order where source order means nothing. There are no timestamps and no absolute paths.

### `solid-behavior-summary` v1 (compiler)

Top level:

- `directives`: module directives.
- `serverFunctions`: the number of `"use server"` functions.
- `imports[]`: each entry has `source`, `kind` (static or type), and `specifiers[]` (`imported`, `local`, `type`, `used`, `span`).
- `dynamicImports[]`: each entry has `source` (`null` when not a literal), `lazy`, and `owner`, the module-level binding whose code contains it.
- `exports[]`: each entry has `exported` and a `kind` of `local` (with `local`), `reexport` (with `source` and `imported`), `namespace`, or `star`.
- `bindings[]`: module-level value bindings, each with `name`, `kind`, `statement` (index), `statementSpan`, `exported`, `mutated`, `refs[]` (`name`, `count`), `effects`, `component`, `block`, `action`, and `sites[]` for imports.
  - `refs` counts value references to other module-level bindings in the declaring statement; type positions are excluded.
  - `effects` is true when evaluating the statement can run code. Calls, `new`, member reads, and non-builtin class heritage all count as effects.
- `topLevel`: `effects`, `refs[]` of statements that bind nothing, and `sideEffectImports[]`.
- `components[]`: `name`, `span`, `props` (identifier, destructured, or none), `propUses[]` (`name`, `uses[]`), and `propsEscapes[]`.
  - The `uses` strings are `pathRead`, `domEvent:<event>`, `componentProp:<Tag>.<prop>`, `delegated`, `call`, `host:<host>`, `argument:<callee>`, `attribute:<name>`, `alias`, `returned`, `assigned`, `read`, and `jsxChild`.
- `eventBindings[]`: every JSX `on*` or `on:`/`oncapture:` attribute and every spread.
  - Fields: `element`, `intrinsic`, `event`, `capture`, `delegated`, and `value`.
  - `value.kind` is `block` (with id), `binding` (with scope), `propMember` (with path), `member`, `callback`, `tuple`, `literal`, `spread`, or `unknown`.
  - Also recorded: `owner`, and the enclosing `boundaries[]` (`Errored`/`Loading`, excluding a boundary's own `fallback`).
- `blocks[]`: see below.
- `unknowns[]`: `eval`, `with`, `newFunction`, `require`, `importMeta`, `topLevelAwait`, `dynamicImportNonLiteral`, and `exportStar`, each with a span.
- `completeness`: `unknown` when the module has `eval`, `with`, `new Function`, `require`, or a non-literal `import()`; `bounded` for any other unknown or a server function; otherwise `exact`.
- Each component also records owner edges: `renders[]` (`component`, the `boundaries` between them, innermost first, and `span`) and `creations[]` (runtime creator calls in its own body, outside `$` bodies).

Each block records:

- `id` (`b<n>`), `span`, `name`, `owner`, `ownerIsComponent`, `nestedIn[]`, and `opaque` (the argument is not an inline function).
- `body`:
  - `span`, `bodySpan`, `paramsSpan`, `generator`, `async`, `arrow`, `paramCount`, and `input` (the first parameter's name, or `<pattern>`).
  - `ops`: `values`, `paths` (`root`, `keys`, `prop`), `storeReads`, `waits`, `raises`, `attempts`, `writes`, `calls`, `unknownYields`, `plainYields`, `performs`, `awaits`, and `throws`.
  - `captures[]`: `name`, `scope` (import, module, param, local, or global), `kind`, `declaration`, `declaredIn`, `props`, `assigned`, `mutatedElsewhere`, `uses`, and `block`.
  - `escapes`: `this`, `arguments`, `eval`, `newFunction`, `with`, `assignsCapture`, and `importMeta`. `this` includes an arrow body's lexical `this`.
  - `nestedBlocks` and `dynamicImports[]`.
  - `creations[]`: runtime creator calls in the body (`create*`, `$`, `action`, `lazy`, `onSettled`, `onCleanup`, `render`), with `callee` and `span`.
  - `externalCalls[]`: the callee text of every call to something that is not a runtime import. Event-method calls are excluded because event usage records them.
  - `completeness` and `completenessReasons[]`, one of three verdicts:
    - `exact`: only direct operations and runtime calls.
    - `bounded`: the body also calls code this summary does not describe. Reasons: `externalCalls`, `attempt`, `delegation`, `valueOperand`, `thisOrArguments`, `await`.
    - `unknown`: something hides effects. Reasons: `eval`, `with`, `newFunction`, `unknownYield`, `plainYield`, `dynamicImport`.
  - `event`: counts of `preventDefault`, `stopPropagation`, `stopImmediatePropagation`, `returnValue`, `currentTarget`, and `target`; the lists `members[]`, `methods[]`, and `escapes[]`; `deferredUses`; `propagationSensitive`; and `prelude`.
  - `prelude` has `statements[]` (kind `preventDefault`, `stopPropagation`, `stopImmediatePropagation`, or `guardReturn`, with a span) and `end`.
- `hosts[]`: the hosts derived from the sites: `event`, `prop:<Component>.<prop>`, `reactive:<host>`, `jsx`, `delegated`, `exported`, and `unknown`.
- `sites[]`: every place the block value flows. The kinds are `domEvent` (`element`, `event`, `capture`, `delegated`, `boundaries`), `componentProp` (`component`, `prop`, `event`, `boundaries`), `host`, `delegated`, `wrapped`, `argument`, `invoked`, `returned`, `alias`, `exported`, `reassigned`, `unused`, and `escape` (`how`).

### `solid-module-summary` v1 (solid-tsc)

The document holds `module` (a root-relative path), `sourceHash` (sha256 of the authored text), `behavior` (the summary above), and `types`. The `types` object contains:

- `typeErrors`.
- `imports[]`: `source`, `resolvedFile`, `external`, and `specifiers[]` (`local`, `imported`, `resolved`, `type`, `brands`).
  - `resolved` is `{ file, external, name, position, kind }`. It is followed through renaming re-exports and `export *`; positions are authored.
- `exports[]`: `name`, `value`, `resolved`, and `reexport`.
- `blocks[]`: `id`, `resolved`, `type`, `brands`, `block`, `value`, `reads`, `tasks`, `failures`, `writes`, `input`, `inputIsEvent`, `hasTasks`, `hasFailures`, `hasWrites`, `mismatches[]`, `consistent`, `captures[]`, and `paths[]`.
  - `captures[]` entries have `name`, `type`, `brands`, and `serializable`.
  - `paths[]` entries have `root`, `keys`, `kind`, `rootType`, `pathType`, and `valueType`.
- `components[]`: `name`, `propsType`, and `props[]` (`name`, `type`, `optional`, `brands`).
- `jsxSites[]`: `element`, `attribute`, `expected` (the instantiated contextual prop type), `actual`, and `brands`.

Typed block facts also carry `completeness` and `completenessReasons`: the compiler's verdict, with `valueOperand` discharged when every `yield* x` operand is a branded accessor. The linker uses the typed verdict when present.

Brands are validated structurally: `block` (the `BLOCK` symbol property), `accessor` (nullary and iterable), `setter`, `store`, `action`, `props`, `domNode`, `function`, `primitive`, and `unknown`. `mismatches` lists behavior-to-type obligations that failed: `writesNotTyped`, `tasksNotTyped`, `failuresNotTyped`, and `missingBlockBrand`.

The `solid-summary-index` records `typescript` (the version) and `modules[]` (`module`, `file`, `sourceHash`).

### `solid-library-summary` v1

The document holds `name` and `modules`, a map from package-relative JS path to `{ sourceHash, behavior }`. It is referenced from the package's `package.json` field `"solidSummary"` and written by `summarizePackage(dir)`. It describes the published JavaScript that actually gets bundled.

### `solid-link-manifest` v1

The manifest holds `environment`, `entries[]`, `nonLiteralDynamicImport`, `lazyRoots[]`, and these sections:

- `modules[]`: `module`, `kind` (app, library, or runtime), `status`, `typedStatus`, `class`, `roots[]`, and `residue[]`.
- `bindings[]`: non-hot module-level bindings, with `class`, `moved`, and `pin`.
- `blocks[]`: `key`, `module`, `id`, `name`, `owner`, `class` (hot, cold, or unknown), `reasons[]`, `events[]`, `domain`, `prelude[]`, and `snapshot[]`.
- `domains[]`: `id`, `chunk`, `roots[]`, `blocks[]`, `sourceBytes`, and `prefetch`.
- `stats`: `modules`, `blocks`, `domains`, `movedStatements`, `iterations`, and `timings`. Ignore `timings` when comparing manifests.

## Linker analysis

Each environment graph (client, server) is loaded and classified independently, from its own entries and with its own resolution conditions.

1. **Loading.** The linker crawls from the entries through the bundler's resolver. Application modules are summarized from the exact text being bundled, and typed summaries are joined by path and hash.
   - A module owned by another package (`node_modules` or a linked workspace package) is a library. It needs a valid `solid-library-summary` whose hashes match the bundled files; otherwise its status is `missingSummary`, `staleSummary`, or `incompatibleSummary`.
   - Runtime packages (`solid-js`, `@solidjs/*`) are hot and never crawled.
2. **Resolution.** Import bindings resolve through re-exports, `export * as`, and `export *` to a declaring module and binding. The modules passed through (barrels) are recorded. Every app import is cross-checked against solid-tsc's resolved identity by file and position; a disagreement makes the binding unknown and its capturing blocks unknown.
3. **Event-only proofs.** A block is a candidate when every one of its sites is a DOM event sink. A sink can be reached in three ways:
   - directly;
   - through a component prop whose every use binds a DOM event, recursively and across modules, with the typed `EventBlock` brand on the prop;
   - through an export whose every importer's uses are such sites.

   A proof requires valid typed facts (strict mode) with consistent block types, completeness other than `unknown`, no escapes, and no mutable captures. Every captured import must resolve to summarized code or the runtime; an unresolved import (`unresolvedImport:<name>`) or a library without a valid summary (`unknownLibrary:<name>`) keeps the handler inline. The event object must not escape and may only be accessed by name (no event methods, no computed members). Propagation control must be fully replayable as a prelude. A destructured event parameter or an expression body is refused. A module that is opaque, contains server functions, or where a non-literal dynamic import could reach an exported block makes its blocks unknown.
4. **Fixed point.** The labels HOT, COLD, and UNKNOWN propagate over two kinds of edges. Module evaluation reaches effectful statements, top-level references, dependencies with effects, and literal dynamic imports, with lazy targets exposing their whole namespace. Binding references reach the declaring statement's references and resolved import targets, plus the barrels they pass through.
   - Phase A runs HOT and UNKNOWN from the roots: entries, entry exports, opaque modules, and every export when a non-literal dynamic import exists. Phase B runs COLD from the extracted bodies' captures.
   - References inside an extracted body carry only COLD. A module already evaluated hot does not pass COLD on through its evaluation edges.
   - Cold-only statements of hot-evaluated modules become residue candidates unless something pins them. The pins are: shared statements, default exports, effects, `import.meta`, actions, imports, re-exported bindings, importers that are not generated or not hot, and a statement that contains a shell.
   - A pinned binding is re-rooted HOT and propagation re-runs.
   - After clustering, a cold dependency that two or more domains reach and that is under `sharedColdBytes` (default 4 KiB) is retained hot. Otherwise it would become a chunk of its own, costing an extra round trip. The fixed point then re-runs.

   Classes: `unknown` means the label includes UNKNOWN, or the module is opaque. `shared` means both HOT and COLD, `hot` and `cold` mean only that label, and `unused` means neither.
5. **Domains.** Seeds are the owning component per root set, which is the set of entries and lazy routes whose static graph contains the module. Seeds that share a cold dependency are merged, and merged groups are packed in path order up to `maxDomainBytes` (default 48 KiB of body source). A route's cold code never shares a chunk with another route's.

## Extraction semantics (slice 3)

- **Shell.** The block is replaced in place by `coldEvent(domain, key, env, prelude, snapshot)`, a `$` block created at the same point, so it has the same owner and the same error boundary.
  - Captured locals are passed as `env = () => [a, b]` and read at event time, as the inline body read them.
  - Imports are re-imported by the cold module. Bindings moved to a residue are imported from the residue module.
- **Loaded path.** The prelude runs, then `dispatchBlock(coldBlock, event, owner)` runs synchronously in the same dispatch under the event host. Writes, typed failures, and async rejections route exactly as the inline block's did.
- **Miss path.** The prelude still runs synchronously against the live event, so `preventDefault()`, `stopPropagation()`, and guard returns keep their effect. The rest runs when the domain chunk arrives, against a snapshot of the event members the body reads (`type` plus the members recorded). If the owner has been disposed by then, the deferred run is dropped. A load failure routes to the owner's boundary.
  - **Documented deviation.** Reads through snapshotted DOM references, such as `currentTarget.value`, observe the DOM when the chunk arrives. After a dispatch, a native `currentTarget` is `null`, so the snapshot is strictly more usable than the live event. Prefetching (`idle`, `intent`, or `load`) keeps misses rare.
- **Refused, stays hot.** Handlers stay inline when they reach a wrapper: a component that delegates to the prop from its own block (`yield* call(props.onPress, e)`), or any function the handler is passed through (`onClick={wrap(handler)}`). They also stay inline when they:
  - control propagation after a read, or conditionally outside the prelude;
  - use event methods (`composedPath()`) or computed event members;
  - pass the event object on, including `call(inner, e)`;
  - assign captured or module state;
  - are delegated to by another block;
  - use `this` or `arguments`;
  - create blocks.
- **Code generation.** Cold block modules sit beside their source file (`<file>__solid_cold_<id>.<ext>`), so relative imports are unchanged; residues sit alongside (`<file>__solid_residue.<ext>`). Import specifiers used only by extracted code are dropped, and a bare import stays when the target has effects or is unknown. Modules retained for chunking are pinned from the entry with `coldRetain(namespace)`, which no bundler can tree-shake. All generated modules carry hires source maps back to the authored file.
- **Bundling.** Each domain is a plain dynamic-import target, `<root>/.solid-cold/cold-<id>.js`, so the bundler emits one chunk per domain containing exactly what only that domain reaches. Emitting the domains as chunks, or using `manualChunks`, made them independent entries: shared modules and the runtime split into extra chunks, and Rollup's `experimentalMinChunkSize` merged domains back into their importers. Both were rejected.
- **HMR and dev.** The plugin is `apply: "build"`, so dev serve and HMR never see extracted code. A watch rebuild re-runs the whole analysis. The library-summary cache is keyed by file modification time.
- **Action and error identity.** Registered actions and error classes are created by module evaluation. An effectful statement never moves, so each has exactly one instance, and cold code imports it. Errors thrown by cold bodies reach the same `Errored` boundary; `tests/extract.test.js` checks this on hits, misses, and load failures.

## Measurements

See "Results" below. The raw data is in `packages/linker/bench/results/results.json` and `packages/linker/bench/results/todomvc.json`.

<!-- RESULTS -->
