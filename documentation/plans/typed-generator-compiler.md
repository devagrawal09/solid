# `$()` Typed Reactive Blocks

## Exploration Status

Status as of 2026-09-25: the design remains experimental, but the baseline and optimization prototypes are now published on the fork. The end-to-end baseline covers typed blocks, host enforcement, direct typed store/prop paths, compiler lowering, projected TypeScript checking, block-derived signals/stores, DOM event dispatch, and a converted TodoMVC example. Tracks A-E and the semantic conformance harness have pushed results; independent review classifies C, D, and E as fix-first rather than integration-ready.

The production proposal has two modes only:

- **Compat** transforms supported blocks and retains runtime generator fallbacks and ordinary JavaScript interoperability.
- **Strict** requires the complete application graph to use typed generator boundaries, rejects unknown or unsupported effects at build time, omits runtime fallback, and automatically selects the fastest and smallest safe runtime and application chunks for the proven capability graph.

Current exploration work:

- Direct path implementation is complete and verified: `yield* store.user.name`, indexed store paths, and `yield* props.count` carry root/path metadata.
- `solid-tsc` provides pre-typecheck source projection, mapped diagnostics, and declaration emit because stock TypeScript cannot type the authored direct-path syntax by itself.
- Runtime-size and app-code partitioning prototypes are complete on Tracks A-E. Their measurements and integration decisions are recorded below.
- The read-only strict-mode SSR/hydration investigation is complete. JSX blocks had a hydration-id parity defect; compiler-emitted creation scopes now fix it (Track D prerequisite, `track-d-hydration.md`).
- `packages/web/test/conformance/` compares handwritten, runtime-generator, compiler-lowered, and host-fused behavior across client, SSR, and hydration traces.
- Required performance measurements are documented below; optimized mode is not ready to become the default until remaining review blockers are fixed and measurements reproduce on the integrated graph.

## Recent Changes

### 2026-09-25 (strict-solid-tsx)

- Added the first generator-free strict slice: `$(fn)` with an ordinary callback is a compilation marker that is analyzed for its statically known host (`createMemo`, `createSignal(fn)`, `createEffect` / `createRenderEffect` compute, DOM `on*` attributes) and erased, with a sidecar graph summary and `[STRICT_…]` diagnostics. See [strict-solid-tsx.md](./strict-solid-tsx.md). Generator blocks are unchanged.

### 2026-09-25

- Published the semantic conformance harness at `fe6bd41f`: 15 scenarios across 12 modes, 109 focused tests, structured traces, explicit intentional differences, pinned known defects, and mutation tests for cleanup, subscriptions, duplicate writes, stale commits, owner routing, and hydration IDs.
- Completed Tracks A-E. Track A keeps the async-free core experiment but iterates on the local status-free path; Track B keeps allocation-free paths and handle stores as an opt-in while iterating on compatibility cost; Tracks C-E require fixes before integration.
- Independently reviewed C, D, and E together. Track C changes module evaluation and event behavior in several cases; Track D's ID-parity fix held but replay/inert-region lowering has SSR and hydration correctness failures; Track E's universal refactor is conservative but selected production entries need validation, schema/version checks, and safer code generation.
- Confirmed that Solid server components couple server and client through server-function IDs, SSR slot scopes, claims, serialized arguments/promises/store traces, and live holes. Whole-graph optimizations therefore need a coordinated cross-environment boundary graph, not two unrelated reachability results.
- Deferred Wasm lowering. The only plausible initial subset is an exact, synchronous, non-throwing, numeric/boolean client leaf behind a JavaScript tracking shim; typical `$` bodies are too small, and server components already move suitable work off the client.
- Defined a proposed generator-free Strict Solid TSX frontend: non-generator `$(() => {})` marks one function for mandatory strict compilation while its statically known consumer determines the host; `"use solid strict"` is the proposed component/module-wide form. This is design work, not implemented behavior.
- Chose a shared compiler graph plus `solid-tsc`/language-server projection instead of attempting to encode complete effect graphs in public TypeScript generics. Detailed facts belong in versioned sidecar summaries; declarations carry only small public capability contracts.
- Classified graph completeness as `exact | bounded | unknown`. Conditional or data-dependent reads may be bounded without being safe for static subscription replacement; unknown edges retain general behavior in compat and are rejected when strict compilation needs a complete proof.
- Deferred the proposed component/setup `$()` host, yielded reactive creation, direct `yield* Context`, and provider-dominance checking. Ordinary `useContext` during setup remains the current model, and event hosts must capture setup-resolved values rather than introducing event-time context.
- Corrected the async ownership rule: owned reactive creation after suspension is not inherently invalid. It is safe only when the driver restores the captured owner, stale flights cannot resume, and disposal/commit timing remains equivalent. Parent reactive reads after suspension remain invalid.
- Added metadata-preserving block overloads for computed `createSignal`, `createStore`, `createProjection`, and `createOptimisticStore`.
- Added direct typed property reads for stores and props with `StoreRead<Root, Path>`, `PropRead<Root, Path>`, `PathValue`, and `PathResult`.
- Added runtime store path tokens, strict unread/direct-use diagnostics, and exact tracked re-walks through the existing store proxy.
- Added compiler lowering for supported member paths before JSX lowering.
- Added `@solidjs/typecheck` and its `solid-tsc` CLI for projected checking, mapped diagnostics, declaration emit, and separate consumer compilation.
- Kept `readStore(store, selector)` for structural reads such as `map`, `filter`, and `every`.
- Added `examples/todos-blocks`, converted applicable reactive, JSX, event, signal, store, and path reads to typed blocks.
- Fixed result-shape probing so blocks may return store proxies without triggering strict direct-read diagnostics.
- Replaced the earlier public `strict | warn | loose` proposal with production `compat | strict` modes; implementation switches remain experimental controls.
- Added required measurements for untransformed runtime overhead, compiler-transform overhead, projected typechecking, optimized runtime performance, and bundle size.
- Completed read-only studies of runtime slicing and app-dominated cold-code partitioning, including chunk clustering, prefetch policies, safety constraints, and benchmark gates.
- Completed a strict SSR/hydration study covering wire serialization, hydration-specific JavaScript, client execution, code/data segment alignment, and resumability limits; identified JSX-block hydration-id parity as a critical blocker.
- Selected cold event-domain extraction and resumable event blocks as the two app-bundle prototypes. Deferred JSX/feature-region splitting is not part of the proposal; existing explicit `lazy()` behavior remains available without strict-mode automation.

## Detailed Prototype Inventory

### Runtime And Types

- `@solidjs/signals` exports `$`, typed blocks, iterable signal accessors, task/failure/write/call operations, loading/error handlers, and direct path operations.
- Blocks carry separate `Reads`, `Tasks`, `Failures`, `Writes`, and `Input` categories, including transitive async/error metadata from readable values.
- Reactive hosts reject writes; JSX hosts admit direct reads only; event hosts admit reads, tasks, failures, and writes.
- `createMemo`, computed `createSignal`, effects, and block-derived stores/projections preserve block metadata.
- DOM event blocks preserve their creation owner through forwarding and route synchronous or asynchronous failures to the captured error boundary.
- Store writes remain explicit through `write(setStore, updater)`; setters do not become context-sensitive.

### Compiler And Typechecking

- The Rust compiler recognizes imported `$` blocks and lowers a conservative generator subset before JSX lowering.
- Supported signal and path reads lower through `perform`; unsupported blocks fall back in compat mode and are intended to fail the build in strict mode.
- Direct paths lower to `readPath(root, keys)` or `readProp(props, keys)` operations.
- `solid-tsc` projects direct path expressions into typecheck-only operations while preserving authored diagnostic positions.
- Emitted declarations contain ordinary public path-operation types, so downstream consumers can use stock TypeScript.
- No language-service plugin exists yet; editors may report errors on authored direct-path syntax even when `solid-tsc` succeeds.
- `solid-tsc --build` and watch mode are not implemented.

### Examples And Verification

- `examples/todos-blocks` exercises transformed blocks, JSX reads, events, stores, direct paths, structural selectors, loading, errors, and runtime fallback coverage.
- The direct-path pass reported green signals, compiler Rust/fixture, Solid, web client, SSR, hydration, `packages/typecheck`, TodoMVC typecheck/test/build, and formatting suites.
- Runtime/transform equivalence, host rejection, root/path inference, diagnostic remapping, declaration emit, and separate consumer compilation have focused coverage.
- `packages/web/test/conformance/` is a semantic conformance harness: canonical scenarios run through handwritten Solid, the `$` runtime driver, compiler-lowered and host-fused output, SSR and hydration, compared as structured traces with explicit per-mode expectations. Its generated `COVERAGE.md` lists pinned baseline defects (dynamic-index host fusion, JSX-block hydration keys, the server accessor iterator).

### Strict SSR And Hydration Findings

- Current SSR serializes async memo/signal results, async projections, iterable results, errors, loading/stream sentinels, and asset maps. Plain signals, synchronous memos, and plain stores are generally recreated by client execution rather than serialized as application state.
- Current hydration re-runs the component tree, creates owners and computations, reconnects dependencies, and executes binding computations; it primarily avoids redundant DOM creation and writes.
- Returned JSX `$` blocks consumed hydration IDs differently on server and client. Strict mode makes these blocks pervasive, so parity was a release blocker. It is fixed: every JSX-producing block reserves its id scope at creation on both sides (`blockScope`; see `track-d-hydration.md` and `hole-owner-id-matrix.md`).
- Root/path metadata can help project async/store payloads and align cold code chunks with cold data segments, but it does not prove object identity, alias safety, serializability, or closure resumability.
- Static components with no client-live behavior are candidates for omitted hydration code only after compiler reachability, refs/directives/context, boundary, and descendant-interactivity proofs are complete.
- Resumable event blocks require every capture to be addressable by a stable root/path, constant, or registered action. Arbitrary closures, DOM nodes, owners, setters, and non-serializable objects remain blockers.
- Streaming, `Loading`, `Errored`, transitions, portals, custom elements, directives, and client-only sources require explicit capability and identity handling; absence of `Writes` alone never proves hydration can be skipped.

### App Bundle Prototype Priorities

The two proposed app-code slicing experiments are:

1. **Cold event-domain extraction.** Move an event block and its cold-only import/call graph into a clustered interaction chunk. Prefetch on route load, idle, visibility, hover, or focus so normal events remain synchronous once interaction is possible.
2. **Resumable event blocks.** Avoid hydrating the creating component when every handler capture is addressable as a stable root/path, constant, serialized value, registered action, and boundary coordinate. Emit an event coordinate in server HTML and load the shared event chunk on demand or through prefetch. The manifest must include the nearest statically proven error-boundary coordinate so a rejected resumed handler routes directly without recreating its component owner chain.

Resumability must reject arbitrary closures, mutable locals, DOM-node captures, unregistered setters, owners, and non-serializable objects. Handlers requiring immediate `preventDefault` or propagation control need a small synchronous shell or must be loaded before interaction. Direct boundary coordinates apply only to resumed event failures; ordinary reactive pending/error status must still propagate through actual dependency consumers because one source can feed multiple boundaries. Error routing, ownership, cleanup, hydration IDs, and action identity must remain equivalent to ordinary hydration.

Compiler-created deferred JSX or feature regions are explicitly out of scope. Strict mode does not turn a synchronous branch into an asynchronous one. Applications may continue to opt into existing `lazy()` and `Loading` behavior directly.

### Strict Multi-Module Pipeline

Strict optimization includes both TypeScript and bundler/linker phases:

1. **Source compiler summaries** record behavioral facts visible in implementations: block effects, captures and escapes, component prop usage, event forwarding, boundary relationships, direct paths, and unknown operations.
2. **`solid-tsc` typed summaries** attach resolved symbol identity across imports/re-exports, instantiated generic and prop types, typed root/path metadata, and validated branded contracts for addressable captures, registered actions, serializable values, and compiled libraries. TypeScript narrows and diagnoses candidates but does not by itself prove runtime behavior.
3. **Bundler/linker analysis** joins summaries over the complete server and client module graphs, propagates `hot | cold | shared | unknown` reachability to a fixed point, computes capability absence, clusters cold event domains, emits resumable-event and hydration manifests, and selects runtime entries. Server and client graphs are analyzed independently.

Missing, incompatible, or escaped metadata becomes `unknown` and conservatively retains hot code, data, hydration, and general runtime capabilities. Published strict-compatible libraries must ship linkable summaries alongside declarations and JavaScript.

### Optimization Prototype Slices

The eight measured optimization slices are:

1. **Synchronous status-free fast paths.** Skip async shape probes and erase pending/error channels for computations proven synchronous and non-throwing, with development verification. This begins with local compiler facts and gains cross-module precision from typed summaries.
2. **Proxy-free strict stores.** Stage 1 lowers typed paths to allocation-free internal store-handle reads. Stage 2 uses TypeScript escape contracts and linker analysis to keep store handles across compiled modules, lazily materialize a compatibility proxy only at unknown boundaries, and omit proxy creation/runtime entirely when a store never escapes compiled operations. Structural reads, getters, identity, aliases, pending/optimistic views, writes, and tracking must remain equivalent or deoptimize.
3. **Cold event-domain extraction.** Use linker hot/cold/shared reachability to move event-only blocks and their cold transitive dependencies into clustered interaction chunks with measured prefetch policies.
4. **Async-free reactive core.** Aggregate synchronous capability proofs over a complete server or client graph, then remove Promise/async-iterator handling, pending-source tracking and propagation, cancellation, async transitions, `NotReadyError`, and related helpers. This applies independently of whether the graph hydrates.
5. **Server-authoritative replay elimination.** Use source-authority, setter-escape, and server/client analysis to adopt proven server values and rendered branches without rerunning their fetches, projections, sorting, formatting, or binding setup on the client; retain hydration only for independently live descendants.
6. **Inert-region hydration elimination.** When coordinated server/client analysis proves a rendered region has no client-live reads, writes, events, refs, directives, context, boundaries, cleanup, or interactive descendants, emit plain server HTML and omit its client component code, hydration keys, owner creation, and DOM claiming.
7. **Capability-selected hydration runtime.** Generate a client hydration/bootstrap entry containing only the adapters and protocols required by the final client manifest, such as stream ledgers, loading/error marker adoption, store hydration adapters, lazy asset maps, delegated event types, and SSR-source adoption policies. This slice does not remove the underlying reactive implementations of those features.
8. **Resumable event blocks.** Combine event chunking, addressable captures, registered actions, stable store/root paths, error-boundary coordinates, and server/client event manifests to run handlers without hydrating their creating components.

Generator lowering, host fusion/block erasure to handwritten-equivalent Solid, and exclusion of the runtime generator fallback are strict-mode correctness and code-generation parity requirements, not optimization slices. Compat may retain block abstractions and fallback support where needed; strict must reject unsupported blocks and introduce no measurable overhead for qualifying code. Their transform cost, runtime parity, allocations, and compatibility bundle cost remain required acceptance measurements.

### Published Prototype Results

All optimization tracks have published reviewable branches from baseline `1fc0b873`. These remain experiments, not accepted baseline changes.

| Track       | Head       | Scope                                                      | Current decision                                                           |
| ----------- | ---------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| A           | `0f97a4f4` | Synchronous status-free paths and async-free core          | Stage 1 **ITERATE**; Stage 2 **KEEP as experimental**                      |
| B           | `6fb67597` | Proxy-free strict stores                                   | **KEEP as experimental opt-in; iterate on compatibility cost**             |
| C           | `95389304` | Summaries, linker, and cold event extraction               | **FIX FIRST**                                                              |
| D           | `f855369a` | Hydration-ID parity, replay elimination, and inert regions | ID parity held; slices 5-6 **FIX FIRST**, with slice 6 rejected as written |
| E           | `44abd1eb` | Capability-selected hydration runtime                      | **FIX FIRST**                                                              |
| Conformance | `fe6bd41f` | Cross-mode semantic oracle                                 | Keep and extend                                                            |

Track A's local status-free hook fired on none of 14 real blocks, made updates slower, and cost 374 B gzip; the shape needs another iteration. Its complete-graph async-free runtime reduced the measured client gzip by 12.3%, server gzip by 18.1%, and update instruction counts by 12-19%, while refusing graphs that touch async capabilities.

Track B's fixed-arity handle paths removed per-read allocations and measured at 0.66-0.76x handwritten proxy-read time for representative dynamic/four-key paths. Handle-rooted Stage 2 reads measured at 0.62-0.69x handwritten, with lower mount allocation and update time, but adds compatibility/runtime bytes and a 37% transform-time increase on the store-dense opt-in benchmark. Unknown uses must still materialize the lazy compatibility proxy.

Track C, D, and E were reviewed independently and in a combined worktree. Their focused suites passed, but semantic repros prevent acceptance:

- Track C can delay imported top-level effects and moved initializers, corrupt guards through text replacement, drop a first event while its chunk loads, reorder handlers, collapse queued input snapshots, and move or leak `"use server"` code unless server directives are pinned.
- Track D's hydration-ID parity commit held. Replay sealing still needs serializability and purity proofs and can hoist before local declarations. Inert-region objects escape fragment-child sites and can reach DOM insertion as non-Nodes, crashing SSR or halting client reactivity.
- Track E's universal installer split is conservative, but selected production entries can fail silently outside error boundaries. Generated comments need line-terminator escaping, input envelopes need schema/version validation, D's sealed values need an explicit capability, and the universal path adds about 720 B before selection pays it back.
- C and E currently use different manifest conventions. The shared contract must define one versioned envelope rather than relying on E's conservative fallback as the permanent integration.

The generator-free frontend remains an active cloud prototype, but `experiment/strict-solid-tsx` still points at baseline `1fc0b873`; no implementation commit is published yet. The separate local host-fusion baseline measured 7.3% less unminified output for the memo/effect fixture and 17.9% for the direct-path fixture.

### Semantic Conformance Harness

`packages/web/test/conformance/` runs 15 scenarios across 12 modes and three environments. It uses the actual compiler transform, controlled async settlement, structured traces, committed handwritten references, exact intentional-difference declarations, and known-defect expectations that fail when a defect unexpectedly disappears. Its mutation tests prove detection of missing cleanup, unconditional branch reads, duplicate event writes, stale async commits, owner mismatch, and hydration-ID mismatch.

Current pinned defects are:

- Dynamic-index host fusion can emit invalid `store.items[].name` syntax.
- A component returning a `$` JSX block can allocate its hydration keys after sibling components, producing a tag mismatch and halting hydration.
- The server signal iterator yields a bare accessor rather than a read operation, so an uncompiled server `$` block fails; blocks containing `wait` cannot currently compile away and therefore cannot render asynchronously on the server.

The harness also records that handwritten Solid reruns an async memo fetch during hydration and discards the restarted result. Server-authoritative replay elimination is therefore a new behavior requiring an explicit proof, not a description of current hydration.

### Server Components And Wasm

Solid server components do not form unrelated server and client graphs. The linker must preserve and join at least these boundary edges: file-path-derived server-function IDs, server-rendered client slots and their `sc-*` hydration scopes, event claims in server markup, serialized slot arguments/promises/store traces, and live-hole reruns while a response remains open. Environment-specific reachability remains useful, but whole-graph optimization decisions require a coordinated boundary table.

The current server `$` export also reuses a driver whose owner helpers come from the client reactive core. Before async continuation ownership can be claimed on the server, the driver needs an environment-correct owner interface and stale-flight tests under live-hole reruns. Summary schemas must identify server directives/actions, client slots, claims, frame/occurrence coordinates, serialization obligations, environment availability, and cross-environment authority.

Wasm is deferred rather than added as a ninth optimization slice. A future opt-in experiment may consider exact, synchronous, non-throwing numeric/boolean client leaves: JavaScript performs tracked reads and result publication while Wasm receives only scalar inputs. Conditional reads, stores/proxies, custom equality, owned creation, async, errors, strings, and objects remain outside that subset. There is no current server/edge case that improves on ordinary server execution, and typical `$` bodies are too small to amortize the JS/Wasm boundary and module cost.

### Remaining Work

- Fix and independently re-review the C, D, and E semantic blockers before merging any optimization track into the baseline.
- Integrate Track A Stage 2 and Track B only behind their proven complete-graph/escape gates, then rerun the conformance and benchmark matrices on the combined graph.
- Implement and validate the two production modes as whole-application build contracts, including `solid-tsc` typed-summary emission and bundler/linker fixed-point analysis.
- Add editor language-service support for projected direct-path syntax.
- Prototype the non-generator `$(() => {})` strict marker and `"use solid strict"` lexical opt-in using the shared analyzer; preserve generator overloads and reject ambiguous hosts or unknown escapes rather than adding another fallback.
- Define and publish the `exact | bounded | unknown` graph-summary schema, stable symbol identity, versioning, and the small branded contracts exposed in declarations.
- Share one analyzer and diagnostic mapping implementation among the production compiler, `solid-tsc`, and the custom Solid language server.
- Keep the component/setup host, yielded creation, direct yielded context, and provider-dominance diagnostics deferred until render/owner summaries and child-slot contracts exist.
- If post-suspension creation is implemented, restore the captured owner on continuation, preserve stale-flight exclusion, and decide immediate versus commit-atomic child visibility.
- Extend the conformance harness with streamed shell/chunk hydration, transitions, optimistic writes, keyed lists, concurrent event adapters, `call()` composition, projections, and server-component frames.
- Redesign and remeasure cold event-domain extraction after fixing evaluation order, AST guard lowering, queued-event semantics, and server-directive pinning; keep resumable events deferred.
- Define the coordinated server/client boundary graph and environment-correct server ownership interface before enabling whole-graph SSR or server-component optimizations.
- Decide which runtime slicing, SSR serialization, and hydration specializations earn integration after fixes reproduce under the combined harness and benchmark matrix.
- Define compatibility and publication policy for libraries that cannot provide strict capability manifests.

## Core Goal

Build `$()` into Solid as a typed effect boundary for reactive code.

```tsx
function Component(props) {
  return $(function* () {
    return <div>{yield* props.user.name}</div>;
  });
}
```

The primary purpose is not generator ergonomics. It is to let TypeScript track:

- Every reactive dependency
- Direct asynchronous work
- Possible errors
- Signal writes
- Transitive effects from other signals and blocks

Signals remain usable as ordinary accessors outside strict `$` blocks:

```ts
count();
```

Inside an exact `$` block, signals are read through:

```ts
yield * count;
```

## Alternative Frontend: Strict Solid TSX

Generators are useful as an explicit prototype syntax, but they are not required for the compiler-driven model. A proposed alternative keeps ordinary Solid TypeScript and marks only the functions that must be completely understood:

```tsx
const doubled = createMemo($(() => count() * 2));

createEffect(
  $(() => {
    console.log(doubled());
  })
);

const user = createAsync(
  $(async () => {
    const id = userId();
    return fetchUser(id);
  })
);

<button onClick={$(() => setCount(value => value + 1))}>Increment</button>;
```

For a non-generator function, `$` is a strict compile marker rather than a new memo, effect, event, or runtime host. The statically known consumer determines execution semantics:

| Consumer                     | Host           | Read behavior                            |
| ---------------------------- | -------------- | ---------------------------------------- |
| `createMemo`, `createEffect` | reactive       | tracked for that computation             |
| `createAsync`                | async reactive | tracked before first suspension          |
| JSX event attribute          | event          | one-shot, untracked                      |
| JSX dynamic insertion        | JSX            | tracked by the generated insertion owner |

A marked callback must have one unambiguous host. Passing the same function to both a memo and an event, forwarding it through an unknown helper, or allowing it to escape without a summary makes the host `unknown` and is rejected in strict mode. Plain `$` should not guess a default host. Explicit forms such as `$event` or `$memo` may be considered only if contextual inference proves insufficient.

The marker can be typed as an identity for ordinary value checking:

```ts
declare function $<F extends (...args: any[]) => any>(fn: F): F;
```

That declaration does not infer effects from the function body. The compiler, `solid-tsc`, and language server perform that analysis. Strict output erases the marker and must either produce ordinary handwritten-equivalent Solid code or fail with a source-located diagnostic; it must not retain the generator interpreter or silently switch to another fallback. Existing generator `$` overloads remain separate and unchanged.

### Wider Opt-In

The proposed function- and module-wide spelling is a valid JavaScript directive:

```tsx
function Counter() {
  "use solid strict";

  const [count, setCount] = createSignal(0);
  const doubled = createMemo(() => count() * 2);

  return <button onClick={() => setCount(value => value + 1)}>{doubled()}</button>;
}
```

```tsx
"use solid strict";

// Every compiler-recognized component, reactive callback, JSX insertion, and
// event callback in this module is subject to strict analysis.
```

The lexical rule is preferred: a strict component or module makes statically recognized nested hosts strict, while `$(() => {})` remains the incremental single-function opt-in. `"use strong"` was considered but rejected as too vague.

### Strict Subset

The first useful subset should accept:

- Direct calls to statically resolved Solid reactive APIs.
- Direct signal accessor calls and statically recoverable store paths.
- Ordinary synchronous helpers after reactive inputs have been read to plain values.
- Structured conditionals and loops while preserving runtime tracking when the active dependency set is data-dependent.
- Normal `async`/`await` with parent dependencies read before the first suspension.
- Static JSX components and finite component unions.
- Local event handlers with one statically known event use.

It should conservatively reject or mark unknown:

- Aliased or dynamically selected reactive factories without summaries.
- Reactive accessors, stores, callbacks, owners, or setters passed into unsummarized helpers.
- Callbacks retained by unknown code or used as multiple host kinds.
- Arbitrary dynamic components, registries, reflection, proxies, or `eval`.
- Child render functions whose invocation/owner contract is unknown.
- Imported libraries without compatible, versioned graph summaries when a complete proof is required.

Reading first is the standard escape hatch for an ordinary helper:

```ts
createMemo($(() => formatPrice(total(), currency())));
```

The helper receives plain values. Passing `total` itself would expose a reactive capability to unknown code and must deoptimize or fail.

### Graph Completeness

Every analyzed region has one completeness classification:

- **`exact`**: every relevant host, effect, ownership edge, and escape is resolved.
- **`bounded`**: the compiler knows a finite conservative set of possibilities, but the active runtime graph may be a subset.
- **`unknown`**: at least one relevant edge cannot be resolved.

For example:

```ts
createMemo($(() => (enabled() ? first() : second())));
```

The static may-read set is bounded to `enabled | first | second`, but ordinary Solid subscribes only to the branch taken on a run. The compiler may use the bounded set for capability and reachability analysis, but it must retain runtime dependency tracking unless it emits a branch-sensitive subscription plan proven equivalent. Static may-read information alone does not justify subscribing to every possible source.

An arbitrary callback registry is `unknown`, not bounded:

```ts
registerSomewhere($(() => count()));
```

Compat retains general runtime behavior at unknown boundaries. Strict rejects an unknown edge whenever host fusion, fallback removal, hydration elimination, runtime selection, or another whole-graph decision depends on completeness.

### Shared Analyzer And Language Server

Stock TypeScript can infer the values returned by marked callbacks, but it cannot infer an effect type from a function body. A custom Solid language server and `solid-tsc` should share the compiler analyzer and project a virtual typecheck-only program. Conceptually:

```ts
const doubled = __strongMemo<
  number,
  {
    host: "memo";
    reads: CountSymbol;
    writes: never;
    creates: never;
    completeness: "exact";
  }
>(() => count() * 2);
```

The authored file remains ordinary TSX. The virtual projection supplies diagnostics, hover information, navigation, and small branded contracts. The same analyzer must run in the production compiler and `solid-tsc`; editor-only guarantees are insufficient for CI.

Use three storage layers:

1. Ordinary TypeScript types for values, props, return values, and event parameters.
2. Small public brands for facts generic APIs genuinely constrain, such as capabilities, requirements, resumability, and `exact | bounded | unknown`.
3. Versioned sidecar summaries for the full graph: hosts, reads, writes, paths, creations, ownership, escapes, render edges, source sites, async phases, and server/client reachability.

Do not place the complete graph in declaration generics. Large transitive graph types would increase declaration size, inference cost, hover noise, and deep-instantiation failures. Symbol identity in summaries must follow resolved TypeScript symbols across aliases and re-exports rather than relying only on source text or value structure.

The language server can expose compiler facts directly:

```text
doubled
  host: memo
  reads: count
  owner: Counter
  completeness: exact
```

Useful operations include going to a dependency, finding readers/writers, showing ownership, explaining hydration requirements, and tracing the edge that made a graph unknown.

### Soundness Boundaries

The strict model does not make arbitrary JavaScript statically exact. Its guarantee comes from rejecting unresolved cases. Important boundaries are:

- Conditional reads produce a may-read graph, not necessarily the active subscription graph.
- Higher-order helpers need effect-polymorphic summaries describing when callbacks run and which ownership they preserve.
- Dynamic property access may collapse an exact path to a wildcard such as `user.*`.
- Runtime-sized loops can describe an access pattern without identifying every concrete source.
- Dynamic components, portals, render props, and arbitrary `children` need explicit owner/child-slot contracts.
- Async continuation ownership must be restored by the runtime; graph metadata alone does not prevent leaks.
- Fusion must preserve equality, laziness, scheduling, error routing, suspense, transitions, cleanup, and development hooks.
- Missing or incompatible library summaries become unknown.
- Stable symbol identities must survive package builds, aliases, re-exports, and duplicated packages.
- Mixed strict/opaque code may preserve ordinary Solid behavior while preventing whole-graph optimization.

### What The Strict Graph Unlocks

Capabilities arrive at different proof levels rather than all at once:

- A local exact graph enables generator-free lowering, direct diagnostics, direct fixed-dependency subscriptions where unconditional, and safe memo/JSX fusion.
- Exact store paths enable handle reads and can contribute to proxy elimination when escape analysis also succeeds.
- Exact ownership and escape edges enable dead reactive-node removal and lifetime diagnostics.
- Exact event captures and transitive imports enable cold event chunks; addressable captures and boundary coordinates are later prerequisites for resumable events.
- Complete server/client component graphs enable server-authoritative replay elimination and inert-region hydration removal.
- Complete capability manifests enable smaller hydration/bootstrap runtimes and, when the entire selected graph is synchronous, an async-free reactive core.
- The language server can explain reruns, ownership, hydration, deoptimizations, and unknown edges using the same facts that drive code generation.

These are opportunities, not automatic consequences of marking a function. Every optimization retains its own semantic proof and measurement gate.

## Three Host Contexts

The same `$()` construct is used in three contexts. The consuming host determines which effects are legal.

| Context              | Reads | Direct async | Explicit errors | Writes |
| -------------------- | ----: | -----------: | --------------: | -----: |
| Reactive computation |   Yes |          Yes |             Yes |     No |
| JSX block            |   Yes |           No |              No |     No |
| Event block          |   Yes |          Yes |             Yes |    Yes |

### Reactive Computations

Reactive computations include memos and similar derived computations:

```ts
const userLabel = createMemo(
  $(function* () {
    const user = yield* userSignal;
    const permissions = yield* loadPermissions(user.id);
    return formatUser(user, permissions);
  })
);
```

They may:

- Read signals
- Perform typed async work
- Propagate typed errors
- Compose other blocks

They may not write signals.

### JSX Blocks

JSX blocks may directly yield signal reads only:

```tsx
function User(props) {
  return $(function* () {
    const user = yield* props.user;
    return (
      <article>
        <h1>{user.name}</h1>
        <span>{yield* props.status}</span>
      </article>
    );
  });
}
```

They may not directly:

- Start a task
- Yield a Promise
- Explicitly raise an error
- Write a signal

A signal read by JSX may itself carry async and error metadata. Therefore a read-only JSX block can still be pending or error-typed.

```ts
props.user: AsyncSignal<User, NetworkError>
```

Reading it contributes:

```text
Reads: props.user
Derived async: true
Derived errors: NetworkError
```

No Promise appears inside JSX. When the signal is ready, `yield* props.user` returns `User`.

When pending, rendering goes through `Loading`. When failed, the error goes through `Errored`.

### Event Blocks

Events allow the complete effect set:

```tsx
const save = $(function* (event: SubmitEvent) {
  const draft = yield* draftSignal;
  const result = yield* saveDraft(draft);
  yield* write(savedDraft, result);
});

<button onClick={save}>Save</button>;
```

Events may:

- Read signals
- Wait for pending signals
- Perform typed async work
- Propagate typed errors
- Write signals
- Compose other event blocks

An event read is one-shot. It does not make the event rerun reactively.

If a read signal is pending, the event waits for it while the current UI remains mounted.

## Deferred Component Host, Creation, And Context

A fourth one-shot component/setup host was explored:

```tsx
const Profile = $(function* Profile() {
  const auth = useContext(AuthContext);

  return $(function* () {
    return <h1>{yield* auth.user.name}</h1>;
  });
});
```

Its intended role is to run setup once, create owned reactive scopes, and return a separate reactive JSX block. Component and reactive hosts may create owned computations; JSX and event hosts may not. An explicit yielded creation operation was considered because plain `yield* createMemo(...)` is ambiguous when accessors are themselves iterable reads.

This host and yielded creation remain deferred. The generator-free strict frontend can first analyze ordinary component setup and existing `createMemo`/`createEffect`/`createAsync` calls without introducing a new runtime operation.

### Creation After Suspension

Owned creation after suspension is not rejected merely because previous children are disposed at recompute. Existing recomputation stages old children for disposal separately from children created by the new execution. A superseded block flight is already marked stale and must close rather than resume.

The missing requirement is owner restoration: a Promise continuation runs after the original reactive stack exits, so the block driver must capture the run owner and resume through `runWithOwner(owner, ...)`. This restores ownership without reopening parent dependency tracking. Therefore the intended rules are:

- Parent signal reads after first suspension remain invalid because the parent tracking frame has ended.
- Context lookup after suspension would be an owner lookup rather than a dependency read, but direct yielded context is deferred for other reasons.
- A newly created child computation after suspension may establish its own dependencies.
- A stale or disposed flight must never resume to create children.
- Immediate versus commit-atomic visibility of post-suspension children remains a separate semantic decision; commit-atomic creation would need a per-flight staging owner.

### Context Decision

Direct `yield* Context` and a `ContextReadOp` were considered, then removed from the current scope. Context continues to use ordinary setup-time Solid semantics:

```tsx
function SaveButton() {
  const auth = useContext(AuthContext);

  const save = $(() => saveUser(auth.user));
  return <button onClick={save}>Save</button>;
}
```

Event execution has no ambient context owner in current Solid. Event blocks therefore must not introduce event-time context lookup. They capture values resolved during component/setup execution, which matches ordinary Solid closure behavior and prevents forwarding from rebinding context.

Future provider validation remains compiler tooling work even with ordinary `useContext`:

- A component inherits requirements from direct setup reads, owned creations, returned render blocks, and rendered child components.
- Provider satisfaction follows owner/provider child-slot dominance, not DOM ancestry.
- Static JSX child edges are recoverable by compiler analysis, but ordinary TypeScript collapses JSX expressions to `JSX.Element` and loses requirement metadata.
- TSRX's structured render tape is a better direct source of child, provider, control-flow, and boundary edges, although its current typecheck projection still emits ordinary TSX.
- Dynamic components, arbitrary children, portals, escaped callbacks, and unresolved libraries become bounded or unknown according to the available contracts.
- Stock `tsc` cannot enforce provider dominance; `solid-tsc` and the Solid language server must report the mapped diagnostic.

Until that full render/owner summary exists, direct yielded context and type-level provider enforcement should not be added.

## What `$()` Returns

`$()` returns a branded computation description, called a block.

Conceptually:

```ts
interface Block<
  Value,
  Reads = never,
  Tasks = never,
  Failures = never,
  Writes = never,
  Input = unknown
> {
  (input?: Input): [Tasks] extends [never] ? Value : Promise<Value>;
  readonly [BLOCK]: true;
  readonly [META]: {
    readonly reads: Reads;
    readonly tasks: Tasks;
    readonly failures: Failures;
    readonly writes: Writes;
  };
  [Symbol.iterator](): Generator<Effect, Value, unknown>;
}
```

Effect precision (`exact`, `dynamic`, or `unknown`) is a separate trust classification proposed for compiler/runtime interoperation. It is not yet part of the prototype's `Block` generic parameters.

Derived metadata includes:

```ts
Dependencies = Reads | TransitiveDependenciesOf<Reads>;

Async = HasTasks<Tasks> | AsyncOf<Reads>;

Errors = ExplicitErrors | ErrorsOf<Tasks> | ErrorsOf<Reads>;
```

This distinction is important for JSX. A JSX block can have `Tasks = never` while still having `Async = true` because it reads an async signal.

## Block Consumption

A block can be passed directly to a host:

```ts
const doubled = $(function* () {
  return (yield* count) * 2;
});

const value = createMemo(doubled);
```

Ordinary callbacks remain supported:

```ts
const value = createMemo(() => count() * 2);
```

A block should not be called from an ordinary reactive callback:

```ts
createMemo(() => doubled()); // invalid or returns a generator
```

Instead, pass it directly or compose it through `yield*`:

```ts
const description = $(function* () {
  const value = yield* doubled();
  const label = yield* labelSignal;
  return `${label}: ${value}`;
});
```

This composition carries all transitive effects into `description`.

## No Separate `$$()`

Events do not need a second sigil.

The block declares effects. The host interprets them.

```text
createMemo(block)       → reactive interpretation
JSX returns block       → render interpretation
onClick={block}         → event interpretation
yield* block()          → parent interpretation
```

Event-specific behavior can use named adapters:

```tsx
<button onClick={latest(save)}>Save</button>
<button onClick={queue(save)}>Save</button>
<button onClick={exhaust(save)}>Save</button>
```

## Event Prop Forwarding

A component forwards an event block like any other prop:

```tsx
const save = $(function* (event: MouseEvent) {
  const draft = yield* draftSignal;
  yield* saveDraft(draft);
});

<Child onPress={save} />;
```

```tsx
function Child(props: { onPress: EventBlock<MouseEvent> }) {
  return <button onClick={props.onPress}>Save</button>;
}
```

The same branded value travels through the component tree. Only the final DOM binding interprets it.

```text
Parent block
→ Child prop
→ Wrapper component
→ DOM event binding
→ Event interpreter
```

At the DOM sink, Solid captures:

- Owner
- Error boundary
- Loading or transition context
- Cancellation scope
- Event concurrency policy

### Wrapping Events

A child can create a new block and delegate to the parent block:

```tsx
function ConfirmButton<Handler extends EventBlock<MouseEvent>>(props: { onPress: Handler }) {
  const wrapped = $(function* (event: MouseEvent) {
    const confirmed = yield* confirmOperation("Continue?");

    if (confirmed) {
      yield* props.onPress(event);
    }
  });

  return <button onClick={wrapped}>Save</button>;
}
```

The wrapper accumulates the effects of `confirmOperation` and `props.onPress`.

Ordinary callbacks remain compatible for transparent forwarding. Invoking an arbitrary ordinary callback from a strict block is unsafe because it may hide reads, writes, async work, or errors.

## Pending JSX Reads

JSX does not suspend a generator across a Promise.

```tsx
const View = $(function* () {
  return <div>{(yield* user).name}</div>;
});
```

If `user` is ready:

```text
driver reads user
→ generator receives User
→ JSX completes
```

If `user` is pending:

```text
driver reads user
→ signal reports pending
→ block execution stops
→ Loading handles pending state
→ signal resolves
→ block reruns from the beginning
```

This matches Solid’s reactive execution model and avoids retaining generator stacks during rendering.

## Event Pending Reads

Events behave differently:

```ts
const submit = $(function* () {
  const session = yield* sessionSignal;
  const result = yield* submitForm(session);
  yield* write(lastResult, result);
});
```

If `sessionSignal` is pending, the event execution can pause until it becomes ready.

Async continuations must resume under the owner and boundary captured when the event reached the DOM.

## Loading And Error Boundaries

A block carries derived async and error information.

```ts
const view = $(function* () {
  return <UserCard user={yield* userSignal} />;
});
```

If `userSignal` is `AsyncSignal<User, NetworkError>`, then `view` is effectively:

```ts
Block<
  JSX.Element,
  {
    async: true;
    errors: NetworkError;
  }
>;
```

### Loading

`Loading` consumes the pending effect:

```ts
const loaded = Loading(view, () => <Spinner />);
```

The returned block has:

```text
Async: false
Errors: NetworkError
```

### Errored

`Errored` handles selected errors:

```ts
const safe = Errored(
  loaded,
  handle(NotFoundError, () => <NotFound />)
);
```

The result carries:

```ts
Exclude<OriginalErrors, NotFoundError>;
```

Unmatched errors must be rethrown to the next boundary.

Fallback blocks can introduce their own dependencies, async state, and errors.

### JSX Type Erasure

TypeScript often reduces JSX component expressions to the global `JSX.Element`, losing generic return metadata.

Function-style composition is therefore the safer initial API:

```ts
const safe = Errored(Loading(view, Spinner), handle(NotFoundError, NotFound));
```

Typed `<Loading>` and `<Errored>` syntax may require compiler support or changes to Solid’s JSX types.

## TypeScript Host Enforcement

TypeScript does not have to classify the block when `$()` is called. It records all effect categories.

Hosts constrain the block later:

```ts
type ReactiveBlock = Block<any, any, any, any, never, any>;
```

```ts
type JSXBlock = Block<JSX.Element, any, never, never, never, void>;
```

```ts
type EventBlock<Event> = Block<any, any, any, any, any, Event>;
```

A JSX block that directly starts a task is not assignable to `JSX.Element`.

A reactive block containing writes is not accepted by `createMemo`.

An event block accepts every effect category.

## Direct Store And Prop Paths

Strict blocks support direct typed property reads without a user-facing lens, property wrapper, `readProp`, or selector helper:

```tsx
const name = yield * store.user.name;
const first = yield * store.items[0].name;
const current = yield * store.items[index];
const count = yield * store.items.length;
const label = yield * props.label;
```

### Path Types

Each direct read records its root and path:

```ts
StoreRead<typeof store, readonly ["user", "name"]>;
StoreRead<typeof store, readonly ["items", number]>;
PropRead<typeof props, readonly ["label"]>;
```

`PathValue<Root, Path>` walks the path to infer the selected value. `PathResult<Root, Path>` additionally reads through a signal accessor or block stored at the selected path, matching the value behavior of `yield*`. Async and error coloring carried by that readable value propagates transitively.

The static path supports property names, numeric indices, tuple positions, array `length`, index signatures, and simple dynamic identifier keys. A path is compile-time capability metadata; the actual store nodes and mounted prop instance remain runtime identities.

### Store Runtime

During runtime generator execution, the store proxy returns a deferred path token while strict block scope is active:

```text
store.user      -> token(root, ["user"])
.user.name      -> token(root, ["user", "name"])
yield*          -> StoreRead(root, path)
driver           -> tracked walk through the real store proxy
```

The tracked re-walk uses the existing store machinery, which remains authoritative for exact property, structural, index, dynamic-key, alias, and shared-reference behavior. Outside a strict block, the same store proxy returns ordinary values.

A token used as an ordinary value throws `[DIRECT_READ_IN_BLOCK]`. A token created but never yielded throws `[UNREAD_PATH]`. Aliases can extend a token:

```ts
const user = store.user;
const name = yield * user.name;
```

Destructuring resolves ordinary values rather than retaining a path token and should not be used to express a typed path read.

### Compiler Lowering

The generator transform runs before JSX lowering and rewrites supported paths approximately as:

```js
_$perform(_$readPath(store, ["user", "name"]));
_$perform(_$readPath(store, ["items", index, "name"]));
_$perform(_$readProp(props, ["label"]));
```

Bare identifiers retain their existing signal-accessor or block-delegation meaning. Member paths read the value at the path; explicit block invocation remains `call(block, input)`.

Props are ordinary compiler-emitted getter objects rather than store proxies. Direct prop paths therefore require compiler lowering; the lowered `readProp` operation invokes the real getter under permitted read scope so Solid tracks its exact underlying signals or stores.

### Projected Typechecking

Stock TypeScript checks the authored operand before Solid's runtime transform, so it cannot infer that a plain string or number is a path operation. The prototype adds `@solidjs/typecheck` and the `solid-tsc` CLI.

For typechecking only, `projectBlocksForTypecheck` inserts an operation with the authored expression retained as a witness:

```ts
yield * __solid_readPath(store, ["items", index, "name"], store.items[index].name);
yield * __solid_readProp(props, ["count"], props.count);
```

This provides root/path metadata and selected-value inference while mapping diagnostics back to the authored source location. Declaration emit contains ordinary public `StoreRead` and `PropRead` types, so downstream consumers can compile separately with stock TypeScript.

Current tooling limitations:

- Editors still diagnose authored direct paths because no language-service plugin ships yet; `solid-tsc` is the source of truth.
- `solid-tsc --build` and watch mode are not implemented.
- Optional chains, method calls, complex computed expressions, and paths rooted in `splitProps` or `mergeProps` results are conservatively refused by projection/lowering.
- Unsupported forms remain errors or runtime fallbacks in compat experiments; strict production mode must reject them at build time.

### Structural Store Reads

Direct paths intentionally cover property paths, not arbitrary collection programs. `readStore(store, selector)` remains for structural operations:

```tsx
const names = yield * readStore(store, state => state.items.map(item => item.name));
const visible = yield * readStore(store, state => state.items.filter(matchesFilter));
```

The selector executes once under permitted read scope, and the existing proxy records the exact runtime properties and structure it touches. Its type metadata records the store root and inferred result rather than a fabricated static path for arbitrary JavaScript.

### Block-Derived Stores

Function-form stores and projections accept no-write blocks and preserve their metadata:

```ts
const projected = createProjection(
  $(function* (draft: State) {
    draft.name = yield* sourceStore.name;
  }),
  seed
);

const [writable, setWritable] = createStore(block, seed);
const [optimistic, setOptimistic] = createOptimisticStore(block, seed);
```

`BlockStore<B, T>` is an ordinary projection proxy intersected with phantom `BlockMetadata<B>`; no runtime metadata property is added. Reading it through a direct path or `readStore` carries its source block's async/error metadata transitively. Blocks containing `Writes` are rejected by these reactive hosts.

### Store Writes

Store writes remain explicit event operations:

```ts
const addItem = $(function* () {
  yield* write(setStore, draft => {
    draft.items.push(item);
  });
});
```

Reactive and JSX hosts reject this block because its `Writes` category is non-empty. Store setters do not become context-sensitive.

## Strictness And Interoperability

Completely forbidding ordinary JavaScript would make interoperation expensive. Blocks should carry an effect-precision level:

```ts
type Precision = "exact" | "dynamic" | "unknown";
```

### Exact

All effects use typed operations:

```ts
const value = yield * signal;
const result = yield * task;
yield * write(target, result);
```

TypeScript and the compiler know the complete declared effect set.

### Dynamic

The compiler or runtime recognizes direct operations:

```ts
signal();
setSignal(value);
await promise;
throw error;
```

The runtime can preserve behavior, but TypeScript may not infer the complete effect set.

### Unknown

Arbitrary upstream code may contain hidden effects:

```ts
legacyFunction();
```

The runtime remains correct by falling back to ordinary tracking, but exhaustive guarantees and static optimizations are unavailable.

### Compiler Modes

The implementation currently exposes several independent switches to explore the design space: runtime versus transformed execution, warning and guard levels, optimization flags, and individual feature experiments. These are development controls, not the proposed production API.

The production proposal has only two modes:

```ts
solid({
  mode: "compat" | "strict"
});
```

#### Compat

Compat mode supports incremental adoption and external JavaScript:

- Supported `$` blocks may still be transformed for performance.
- Generator blocks that cannot be transformed use the runtime driver and operation fallbacks.
- Ordinary Solid accessors, callbacks, components, and untyped libraries remain valid.
- Unknown modules and dynamic imports force conservative runtime feature inclusion.
- Development diagnostics may report lost effect precision without making the build fail.

Compat guarantees correct behavior, not complete effect knowledge or the smallest possible runtime.

#### Strict

Strict mode is a whole-application contract, not a per-file lint level:

- Every reactive or effectful application boundary must use typed generator blocks with strict host and read/write rules.
- All application modules, route chunks, workers, and participating libraries must be compiled in strict mode or provide a trusted strict capability manifest.
- Unsupported generator forms, hidden effects, ordinary reactive reads inside blocks, unknown effectful callbacks, and unclassified dynamic imports are build errors.
- As a baseline strict-mode requirement rather than an optimization slice, runtime generator fallback is not shipped. A block that cannot be lowered fails the build instead of deoptimizing.
- Client and server graphs are checked and specialized independently.
- Development builds verify compiler claims and fail loudly on metadata or capability mismatches.

With the complete application graph proven strict, Solid automatically selects specialized block hosts and runtime entry points, removes unused interpreters and feature modules, and applies safe application-code splitting. Strict mode produces the fastest and smallest build available for that application's proven capabilities without requiring users to configure individual optimization flags.

Libraries that cannot satisfy the strict contract require compat mode; strict mode does not silently place them behind a fallback boundary.

### Legacy Adapters

Existing upstream code should be adapted at its boundary rather than rewritten completely:

```ts
const loadUser = task(legacyLoadUser, {
  errors: [NetworkError]
});
```

Unknown calls can be explicit:

```ts
yield * unsafeCall(legacyFunction);
```

Unknown effects remain in the block’s type. `Errored` cannot claim that every error was handled while `unknown` remains.

## Runtime Mode

Runtime mode is an implementation path used by compat mode and by experiments; it is not a separate production mode. It requires no `$` transform.

Signals implement an iterator:

```ts
signal[Symbol.iterator]();
```

The iterator yields a typed read operation and returns the signal’s value.

The `$` driver:

- Executes the generator
- Resolves yielded signal reads
- Tracks dependencies
- Handles typed tasks
- Routes errors
- Processes writes in event blocks
- Preserves ownership
- Cancels stale async work
- Validates host capabilities in development

Ordinary accessor calls remain supported outside exact `$` blocks.

A development guard can detect direct reads inside strict blocks. Loose blocks permit them and fall back to normal runtime tracking.

## Transform Mode

Transform mode is an implementation path used by both production modes. It removes generator overhead while preserving behavior. Compat may fall back when lowering is unsafe; strict mode rejects the same block at build time.

```ts
$(function* () {
  const count = yield* countSignal;
  return count * 2;
});
```

becomes approximately:

```ts
$compiled(() => {
  const count = countSignal();
  return count * 2;
});
```

The block brand remains because hosts still need:

- Ownership
- Error routing
- Pending behavior
- Event policy
- Effect metadata

The transform must run before JSX lowering:

```tsx
$(function* () {
  return <div>{yield* count}</div>;
});
```

becomes ordinary fine-grained Solid JSX:

```tsx
$compiled(() => {
  return <div>{count()}</div>;
});
```

The JSX compiler can then generate normal insertion effects.

### Safe Transform Restrictions

A first transform should only lower operations it can identify safely.

Unsupported delegation, unknown calls, computed access, or unusual generator control flow should remain on the runtime path rather than being partially transformed.

Runtime and transformed behavior must be tested for equivalence.

## Optimize Mode

Optimize mode is currently an experimental switch. In the production proposal, its proven optimizations are selected automatically by strict mode rather than exposed as a third public mode. It may eventually use static effect and dependency information for deeper specialization.

The central correctness distinction is:

```text
Exact dependencies
Candidate dependencies
Conditional dependencies
Dynamic or unknown dependencies
```

A dependency appearing under a branch is not necessarily active on every execution.

Static metadata must not replace Solid’s dynamic tracking unless the dependency set is proven exact.

## Required Performance Measurements

Performance claims for `$` require three separate measurements. They must not be collapsed into one transformed-demo result.

### Runtime Fallback Overhead

Measure `$` with generator transformation completely disabled against equivalent idiomatic Solid code. This establishes the cost and viability of the runtime fallback rather than treating it only as a correctness path.

Required cases:

- Block creation and first execution.
- Steady-state updates with one read, multiple reads, conditional reads, and nested block delegation.
- Reactive computations, JSX blocks, and event blocks.
- Synchronous store/prop path reads and selector-based structural store reads.
- Allocation rate, retained memory, and owner/link counts in addition to wall time.
- Development guards measured separately from production runtime behavior.
- Minified and gzipped cost of retaining the generator driver and fallback operations.

Each case must compare hand-written accessors, untransformed `$`, and the same workload after transformation.

### Compiler Transform Overhead

Measure the incremental compile-time cost of enabling the `$` transform, independent of runtime results. Extend the compiler benchmark with identical inputs compiled with and without generator/path lowering.

Required workloads:

- Existing many-small-file fixture corpus.
- Existing approximately 128 KB and 1 MB single-module workloads.
- Synthetic modules with low, representative, and dense `$` block usage.
- Supported blocks, unsupported blocks that must bail out, JSX blocks, event blocks, and direct store/prop paths.
- Cold process startup and warmed in-process throughput.
- Wall time, throughput, peak memory, emitted byte count, and source-map size.
- Pre-typecheck projection and projected TypeScript checking measured separately from runtime-code transformation.

Results must report absolute time and the delta from the same compiler configuration with `$` processing disabled.

### Optimized Runtime Performance

Measure transformed and metadata-specialized `$` against both untransformed `$` and equivalent hand-written Solid output. The optimized path is successful only when it approaches or improves on the hand-written baseline without changing behavior.

Required coverage:

- Signals graph creation, one-to-one updates, fan-out, diamond propagation, and avoidable recomputation.
- DOM mount/clear, full replacement, partial row updates, keyed reverse/shuffle, and dynamic component paths.
- Event dispatch, forwarded/wrapped handlers, first interaction, and repeated interaction.
- Store projection, sparse path updates, structural selectors, and keyed reconciliation.
- Async task, loading, error, cancellation, and transition paths when their features are retained.
- SSR rendering and hydration startup.
- Production bundle size for read-only, event-only, synchronous-only, store-using, and full-feature applications.

The comparison matrix is:

| Variant         | Purpose                                                |
| --------------- | ------------------------------------------------------ |
| Idiomatic Solid | Hand-written performance floor                         |
| Runtime `$`     | Cost of no transformation                              |
| Transformed `$` | Cost after generator removal                           |
| Optimized `$`   | Benefit of metadata specialization and feature pruning |

### Measurement Discipline

- Run production artifacts for runtime and size measurements.
- Use repeated samples, medians, spread/RME, pinned Node/browser versions, machine details, and commit SHA.
- Use the in-repo Vitest/CodSpeed suites for fast regression detection and validate retained optimizations against the relevant Tier-2 suite.
- Run runtime/transform equivalence and correctness suites before accepting a performance result.
- Record regressions as well as wins; an optimization is not retained solely because a synthetic `$` microbenchmark improves.
- Do not enable optimized mode by default until all three measurement groups have reproducible baselines.

## Compiler-Emitted Metadata

Production metadata should be compact, likely a bitfield:

```js
$(compiledBody, flags);
```

Possible flags include:

- Body already lowered
- Has direct tasks
- Has explicit errors
- Has visible writes
- Reads are exact
- Reads are conditional
- Reads are dynamic
- Host is reactive, JSX, or event
- Creates owned nodes
- Metadata schema version

Development builds can emit removable diagnostics metadata:

```js
{
  id: "UserView#3",
  location: "UserView.tsx:12",
  host: "jsx",
  reads: [user, theme],
  tasks: 0,
  errors: [NetworkError],
  writes: []
}
```

Absent or untrusted metadata falls back to normal runtime behavior.

## Runtime Uses Of Metadata

Useful runtime optimizations include:

- Skip generator and iterator probing for lowered blocks.
- Skip generic direct-task handling when safely proven absent.
- Erase pending and error status channels from computations proven synchronous and non-throwing; retain development assertions for violated proofs.
- Select the correct host interpreter immediately.
- Configure event concurrency and ownership.
- Produce source-level diagnostics.
- Compare candidate dependencies against actual reads.
- Deoptimize only the affected block after HMR or mismatch.
- Improve devtools with reads, writes, async work, and errors.

Static dependency arrays are less promising because Solid’s existing stable dependency reconciliation already reuses links without allocation.

## Compile-Time-Only Optimizations

The compiler is best positioned to:

- Remove generators.
- Replace `yield* signal` with direct accessor reads.
- Hoist JSX reads into fine-grained DOM effects.
- Reject illegal host effects.
- Replace generic `perform(signal)` calls with direct access when identity is known.
- Lower event blocks into specialized event execution.
- Remove runtime guards that have been statically proven unnecessary.
- Eliminate unused feature modules from the application runtime.

Whole-program memo fusion and dead reactive-read elimination are dangerous because unused reads can still be semantically meaningful dependencies.

## Compiler And Runtime Cooperation

Promising joint protocols include:

### Hint And Verify

The compiler emits a fast-path flag. Development runtime verifies it.

This follows the same pattern as Solid’s existing synchronous-node checks.

### Candidate Versus Actual Reads

The compiler provides possible reads. Runtime tracks actual reads.

This supports diagnostics such as:

```text
Declared read was conditional and not active.
Read occurred inside an opaque callback.
Read occurred after an async boundary.
```

### Per-Block Deoptimization

A metadata mismatch disables optimization for one block rather than the whole application.

### HMR

Hot replacement clears trusted static flags and returns the block to dynamic tracking until revalidated.

### Event Specialization

Compiler identifies event blocks. Runtime supplies:

- Ownership
- Cancellation
- Concurrency
- Error routing, including direct boundary coordinates for resumable handlers
- Batched writes

## Bundle-Size Specialization

If the compiler proves an application contains no async behavior, the bundle should be able to exclude async runtime support.

Potential removable functionality includes:

- Promise and AsyncIterable handling
- Pending-source bookkeeping
- `NotReadyError` handling
- Async status propagation
- Loading boundaries
- Stale-flight cancellation
- Async helpers such as `isPending`, `latest`, and `resolve`
- Async transition scheduling

Per-block flags alone cannot tree-shake this code. Solid needs tree-shakeable runtime modules or build-time feature constants. Within a full runtime, proven synchronous/non-throwing nodes should also use a status-free recomputation path so normal creation and updates do not pay pending/error bookkeeping costs. This does not bypass dependency propagation for nodes that can actually suspend or fail.

Possible runtime modules:

```text
@solidjs/signals/core
@solidjs/signals/async
@solidjs/signals/events
@solidjs/signals/transitions
```

The compiler or bundler can produce an application capability manifest:

```js
{
  async: false,
  errors: true,
  events: true,
  writes: true,
  transitions: false
}
```

Server and client bundles should be analyzed independently.

Unknown blocks, third-party libraries, dynamic imports, or normal callbacks returning Promises force conservative inclusion of async support.

Development builds should throw when an application violates an asserted feature set.

## Optimizations Probably Not Worthwhile

The Fable investigation recommends against:

- Pre-linking graph edges
- Production dependency arrays
- Compile-time graph heights
- Static error-boundary masks
- Runtime registration manifests
- Alternate lightweight graph-node shapes
- Replacing linked dependencies with indexed arrays
- Compile-time memo fusion
- Dead reactive-read elimination
- Skipping pending checks solely because a block has no direct task

Most of these conflict with runtime instance state, dynamic dependencies, tree shaking, or Solid’s existing efficient graph.

## Broader Opportunities

The typed block model may enable:

- Exhaustive loading and error boundaries
- Structured concurrency and cancellation
- Parallel, queued, latest, and exhaust event policies
- Transactional writes
- Optimistic updates
- Typed recovery
- SSR streaming manifests
- Better hydration and preloading
- Server/client capability enforcement
- Worker execution for pure blocks
- Deterministic tests with injected effects
- Time-travel and replay
- Dependency and error graph visualization
- Precise performance attribution
- Scheduling priorities
- Typed library contracts
- Route-level effect manifests
- Automatic runtime feature selection

The larger model is similar to algebraic effects: `$` blocks declare operations, and Solid hosts interpret them differently.

## Major Risks And Open Questions

- TypeScript does not track thrown exceptions natively.
- Arbitrary functions may hide reads, writes, Promises, and errors.
- JSX may erase generic block return types.
- Direct prop/store paths require projected typechecking; editor language-service support is still missing.
- Static root/path metadata cannot prove runtime aliases, shared-reference identity, or serializability.
- JSX-block hydration-id parity is fixed for hydratable native-compiler builds. Babel-JSX mode and `generators: false` still carry the original drift.
- Direct reads after native `await` cannot safely use global tracking.
- Event errors occur after render and require captured boundary routing.
- Event concurrency needs explicit defaults.
- Async signal creation needs a precise typed source API.
- Separate compilation limits whole-program guarantees.
- Dynamic imports complicate runtime feature removal.
- Compiler metadata and TypeScript metadata can disagree.
- HMR must invalidate trusted optimization flags.
- Strict mode needs good diagnostics and escape hatches.
- Runtime mode and transform mode must remain behaviorally identical.
- Replacing actions entirely requires matching their transaction and cancellation semantics.

## Strict Baseline: Compiler Host Fusion and Block Erasure

### Design

When a typed `$()` block is consumed by a statically known host
(`createMemo`, `createEffect`, `createRenderEffect`), the compiler erases the
`$()` wrapper and replaces every `_$perform(accessor)` call with a direct
`accessor()` invocation. Path reads (`_$readPath`, `_$readProp`) are erased to
member expressions (e.g. `store.user.name`, `props.count`).

**Safety invariant:** without the `$` block wrapper the block guard is never
raised, so `readGuarded` is a no-op and `_$perform(x)` === `x()`. Path tokens
are never created because store proxies return normal values when no guard is
active. The fusion pass only fires when every `_$perform` argument in the
function body is "fully erasable" — identifiers, non-optional member
expressions, or `_$readPath`/`_$readProp` calls with an identifier root and
string/number/identifier literal keys. It bails when the body contains
`readStore`, `raise`, `attempt`, `write`, `call`, or any other non-trivial
perform argument.

The pass runs **after** the generator transform and **before** JSX lowering.

### Implementation

Behind the `hostFusion: true` compiler option (default `false`). Requires
`generators: true`.

**Changed files:**

- `packages/compiler/src/generators.rs` — `fuse_host_blocks()` pass (~250 lines), 6 unit tests (3 positive, 3 negative)
- `packages/compiler/src/compiler.rs` — `host_fusion` option in `CompileOptions`, fusion pass call site
- `packages/compiler/src/config.rs` — `host_fusion: Option<bool>` in NAPI `TransformOptions`
- `packages/compiler/src/node_adapter.rs` — `host_fusion` plumbed in `core_options()`
- `packages/compiler/src/shared/ast.rs` — `argument_to_expression()` helper
- `packages/compiler/types.d.ts` — `hostFusion?: boolean` in TypeScript types
- `packages/compiler/index.js` — `hostFusion` added to `nativeOptionKeys`
- `packages/compiler/__tests__/generators-fixtures.test.js` — 5 fusion contract tests
- `packages/compiler/__tests__/generators/fixtures/fusion-memo-effect/` — fusion fixture
- `packages/compiler/__tests__/generators/fixtures/fusion-paths/` — path-read fusion fixture
- `packages/compiler/__tests__/generators/fixtures/fusion-bail-standalone/` — negative fixture

### Test Results

**Rust unit tests:** 72 passed, 0 failed (15 generator tests including 6 new fusion tests)

```
cargo +1.97.1 test -- --test-threads=1
```

**JS fixture tests:** 5823 passed, 0 failed, 28 skipped (40 test files)

```
npx vitest run
```

**Fusion-specific contract tests (5):**

- erases `$()` wrapper and perform calls when consumed by createMemo/createEffect
- erases path reads to member expressions
- does NOT fuse standalone blocks (no known host)
- is off by default even when generators are on
- produces strictly smaller output than non-fused for the same input

### Measurements

**Environment:** macOS Darwin 25.5.0, Rust 1.97.1, Node.js v24.18.0

#### Emitted output size (unminified)

| Fixture                                               | Without fusion | With fusion | Savings          |
| ----------------------------------------------------- | -------------- | ----------- | ---------------- |
| memo-effect (3 blocks: createMemo×2 + createEffect×1) | 742 bytes      | 688 bytes   | 54 bytes (7.3%)  |
| paths (2 blocks: createMemo with readPath + readProp) | 363 bytes      | 298 bytes   | 65 bytes (17.9%) |

#### Code-body parity with handwritten Solid

Function bodies are **identical** to handwritten Solid (verified line-by-line).
The only remaining overhead is unused import specifiers (`$`, `perform as
_$perform`, `readPath as _$readPath`, `readProp as _$readProp`) left behind
because the fusion pass does not yet clean up the import declaration. These are
eliminated by bundler tree-shaking/dead-code elimination.

#### Runtime overhead erasure

Per fused block, the following runtime operations are eliminated at compile time:

- 1× `$(fn)` call → `fn` (no block allocation, no `createComputation` overhead in `$`)
- N× `_$perform(accessor)` → `accessor()` (no `readGuarded` call, no guard check)
- M× `_$readPath(root, keys)` → `root.key1.key2...` (no path-token allocation)
- M× `_$readProp(props, keys)` → `props.key` (no prop-token allocation)
- 0× `renderBlock`/`isBlock` check at host insertion (the value is a plain function, not a block)

### Known Limitations

1. **Unused import specifiers remain.** The fusion pass does not strip `$`,
   `perform`, `readPath`, `readProp` from the import declaration when all their
   call-site usages are erased. A follow-up could add an import-cleanup
   sub-pass; in practice bundlers handle this.

2. **JSX host fusion not attempted.** JSX children that are `$()` blocks go
   through `renderBlock` detection at insert time. Fusing those requires
   coordinating with the JSX transform's template-creation logic and is scoped
   for a later prototype.

3. **JSX `$` hydration-ID parity is already known broken.** This prototype does
   not conceal or paper over that issue.

### Decision

**KEEP as a strict baseline** — the host-fusion prototype demonstrates the required code-generation parity:

- The fused output is **identical** to handwritten Solid (ignoring import
  specifiers that tree-shaking removes).
- The pass is safe: it only fires when the entire block body is provably
  erasable, and bails conservatively on any non-trivial construct.
- The implementation is ~250 lines of Rust, gated behind an off-by-default
  flag, with zero impact on existing behavior.
- Output size reduction is 7–18% per fused block depending on path-read density.
- Runtime overhead (block allocation, guard checks, path-token allocation) is
  fully eliminated for fused blocks.
