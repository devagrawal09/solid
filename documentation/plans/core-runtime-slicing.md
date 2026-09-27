# Core Runtime Slicing: Pay Only for the Features the Graph Uses

Status as of 2026-09-27. A design, measured, with a working prototype: link-time feature switches in `@solidjs/signals`, selected per application by the capability linker, plus one decoupling fix in `solid-js`. The published default build is unchanged: with every switch on, the core floor is byte-identical to the unswitched core. Raw data is in [`core-runtime-slicing/`](./core-runtime-slicing/).

## Question

`@solidjs/signals` already pays for use in three ways:

- **Import reachability.** Feature modules (stores, boundaries, `mapArray`, `affects`, verdicts, the optimistic engine, context, actions) shake out of a bundle that does not import them. This is guarded by `tests/treeshake.test.ts`.
- **Install-on-use hooks.** A feature module installs its logic into `GlobalQueue` hook slots at first use (`installOptimisticEngine`, `installAuthoritativeRead`, `statusFree`). The core keeps only a null check.
- **One whole-graph slice.** Track A's async-free entry (`@solidjs/signals/sync`, `__ASYNC__ = false`) is chosen by the capability linker when it proves the graph async-free.

What remains is the part no import can remove: each feature's **seams** inside the shared hot modules. These are branches in `read`, `setSignal`, `recompute`, `insertSubs`, `markNode` and `flush`, terms in node literals, and fields on every node. This study asks four questions:

- Which features own which seams, and what do they cost?
- Can seams be sliced per feature, chosen by the compiler from facts about the application graph, without a separate build per feature combination?
- What does slicing buy in bytes and hot-path instructions?
- What else couples features into apps that do not use them?

## Summary

- **Largest win: a decoupling fix.** Every solid-js app shipped the whole store, about 24 kB min / 8 kB gz. The cause was a module-scope `setBlockPrimitives({ …, createStore, … })` in the flat `dist/solid.js`, whose table also names the core `createStore`. The fix makes block-primitive registration lazy. On `examples/sierpinski`, a signals-only app, the bundle drops from **65,914 to 36,018 B min (−45%) and from 24,108 to 14,121 B gz (−41%)**, with no linker involved.
- **Link-time feature switches.** Six switches cover the core seams of six features: `OPTIMISTIC`, `VERDICTS`, `STORES`, `SNAPSHOTS`, `ITERABLE` and `COMPILED_SEAMS`. They live in one module, `src/core/features.ts`. The published trees keep that module as a real file; the capability linker substitutes it for a graph it proved never uses a feature, and the app bundler folds the constants. No build-per-combination, and no global defines inside `node_modules`.
- **Floor savings.** On the full runtime, all switches off remove 2,607 B min (−11.5%) and 1,023 B gz from the five-primitive floor. On the async-free runtime they remove 787 B (−6.0%). Deriving `OPTIMISTIC`/`VERDICTS` from `__ASYNC__` alone shrank the existing sync floor by a further 631 B. App-shaped fixtures shrink by 8% (async app, no optimistic) to 34% (sync app, no stores).
- **Hot path.** With all switches off, the full runtime runs 5.7% fewer instructions on creation, 9.3% fewer on write propagation and 12.2% fewer on tracked reads. The sync runtime runs 1.4%, 4.9% and 7.3% fewer (cachegrind, stable). A store-free graph also gives every signal a smaller, uniform shape: 10 fields instead of 13.
- **Behaviour.** A census differential runs the whole signals suite (1,922 tests) under every switch configuration. Every test that does not use a switched-off feature passes unchanged, and the tests that do use it fail with the switch off. So the switches are real, and they are safe for graphs that do not use the feature.
- **Remaining couplings, measured.**
  - `@solidjs/web`'s `insert` retains the `$` driver in every app.
  - `createStore` statically couples `reconcile`/`projection` (≈12.7 kB rendered).
  - `store/next/store.ts` carries transaction machinery that the async-free runtime cannot use and that `__ASYNC__` does not gate.
  - The verdict layer requires the optimistic engine.

## 1. Feature coupling in the core

### Node shapes

Production node literals are listed field by field and grouped by the feature that needs each field. Kernel fields are needed by any reactive graph. Everything else is per feature.

| Node                  | Fields | Kernel                                                                                                                                   | Owned by a feature                                                                                                                                                                                                                                                                                                                              |
| --------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| signal                |     13 | `_equals _config _value _subs _subsTail _time _pendingValue _notifiedAt _x`                                                              | **stores**: `_firewall _nextChild _prevChild`; **transitions**: `_transition`                                                                                                                                                                                                                                                                   |
| computed (memo)       |     29 | value/dep/sub links, heap links (`_height _nextHeap _prevHeap`), `_fn _flags _depGen _time _pendingValue _notifiedAt _equals _config _x` | **owner tree**: `_parent _firstChild _nextSibling _prevSibling _childCount _disposal`, **hydration ids**: `id`; **context**: `_context`; **boundaries**: `_queue`; **async/errors**: `_statusFlags`, `_loading`; **transitions**: `_transition`                                                                                                 |
| effect                |     36 | computed + `_modified _prevValue _effectFn _errorFn _cleanup _type`                                                                      | **transitions**: `_valueTransition` (contested effects, #3322)                                                                                                                                                                                                                                                                                  |
| extension `_x` (lazy) |     22 | `_unobserved`, `_error`, `_notifyStatus`, zombie staging `_pendingDisposal _pendingFirstChild`                                           | **optimistic**: `_overrideValue _overrideOwner _overrideTime _overrideStamp _optimisticLane _parentSource`; **verdicts**: `_pendingSignal _latestValueComputed _companionChildren`; **async**: `_inFlight _flightTeardown _blocked _pendingSources _reask`; **affects**: `_affectsCount`; **stores**: `_child`; **snapshots**: `_snapshotValue` |

The cold extension (stage-3 §12) and the `_config` presence bits already keep optional _state_ off most nodes. What they cannot remove is the _test_ for that state: each presence bit is still read on the hot path, and each optional slot in a literal is still allocated. Slicing removes both.

### Feature × module matrix

Legend:

- **M**: the feature's own module; it shakes out by import reachability.
- **H**: a `GlobalQueue` hook slot filled at first use; the core keeps a null check.
- **S**: inline seams in a shared module (the count of seam sites follows).
- **F**: fields on every node.

Byte costs use the ESM-minified floor fixture (the five primitives), with gzip in parentheses. _Opt-in_ is what importing the feature's API adds. _Seams_ is what the feature costs the floor even when unused, which is what a switch removes.

| Feature                                                      | core.ts                                                              | scheduler.ts                                            | async.ts                                         | heap/graph                                              | other core                                | own modules                                                            | F                                    |                            Opt-in cost |                           Seams in floor | Selected by                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ | -------------------------------------: | ---------------------------------------: | ---------------------------------------------------------------------- |
| **Async / pending**                                          | S (recompute probe, catch arms, read pending branch)                 | S (pending nodes, transition held flush)                | M+S (handleAsync, settle walks)                  | S (`_inFlight`)                                         | effect.ts S                               | —                                                                      | `_loading`, 5 ext                    |                                      — |       **9,521 (3,593)** with transitions | `__ASYNC__` (sync entry)                                               |
| **Transitions**                                              | S (`_transition` checks, `heldFromStale`, `runInTransition`)         | S (110 refs: `Transition`, stash, merge, adoption)      | S (`settleTransition`)                           | —                                                       | effect.ts S                               | —                                                                      | `_transition` ×2, `_valueTransition` |                                      — |                             inside async | `__ASYNC__`; not separable from async (any async landing may open one) |
| **Optimistic / lanes**                                       | S (59 refs: override read, lane recompute, supersession, held truth) | S (35 refs: lane effect queues, reversion, held reveal) | S (override landing, lane routing)               | —                                                       | lanes.ts (in floor: `activeLanes`)        | optimistic.ts M+H, store/next/optimistic.ts M                          | 6 ext, 5 bits                        | 3,792 (1,269); optimistic store 33,237 |                          **1,622 (644)** | switch `OPTIMISTIC`                                                    |
| **Verdicts** (`isPending`/`latest`)                          | S (latest/probe windows, fresh record)                               | S (companion sync)                                      | S (companion walks)                              | —                                                       | —                                         | verdict.ts M+H (loads optimistic.ts)                                   | 3 ext, 2 bits                        |                          7,399 (2,613) |                                 144 (46) | switch `VERDICTS`                                                      |
| **Actions**                                                  | —                                                                    | S (provenance `origin`, transaction entry)              | —                                                | —                                                       | —                                         | action.ts M                                                            | —                                    |                              778 (304) |                             inside async | import                                                                 |
| **Stores / projections**                                     | S (34 refs: firewall read, slot/firewall creation)                   | S (transient store nodes, sweep)                        | S (firewall child walks)                         | S (`markNode` FW walk, `adjustHeight`, slot unobserved) | —                                         | store/ M (24,121 (7,805))                                              | **3 per signal**, 1 ext, 3 bits      |                         24,121 (7,805) |                            **518 (164)** | switch `STORES`                                                        |
| **Boundaries** (Loading/Errored/Reveal)                      | —                                                                    | S (`_children`, `checkBoundaryChildren`)                | S (`statusNotifierOf`)                           | —                                                       | —                                         | boundaries.ts M                                                        | `_queue`                             |                  2,534 / 2,603 / 2,333 |              small (queue children loop) | import                                                                 |
| **Context**                                                  | —                                                                    | —                                                       | —                                                | —                                                       | —                                         | context.ts M                                                           | `_context`                           |                              559 (210) |                    ≈0 (inherited object) | import                                                                 |
| **Owner tree / cleanup**                                     | S (children, zombie staging)                                         | S (zombie queue)                                        | —                                                | S (`disposeChildren`)                                   | owner.ts (kernel)                         | —                                                                      | 7 fields + 2 ext                     |                                 kernel |                                   kernel | — (H8b: detached nodes, compiler)                                      |
| **Effects vs render effects**                                | S (`_type`, stale mode, direct commit)                               | S (render/user queues)                                  | —                                                | —                                                       | effect.ts (kernel)                        | —                                                                      | 7 effect fields                      |                                 kernel |                                   kernel | —                                                                      |
| **Generator driver / blocks**                                | —                                                                    | —                                                       | —                                                | —                                                       | signals.ts S (accessor `Symbol.iterator`) | generator.ts M (`$` driver 5,827), block-api.ts M (35,767 incl. store) | —                                    |                         5,827 / 35,767 |                             **186 (77)** | switch `ITERABLE`                                                      |
| **Hydration snapshots**                                      | S (read substitution, creation capture)                              | S (`insertSubs` snapshot-stale)                         | —                                                | —                                                       | —                                         | (API in core.ts: 831)                                                  | 1 ext, 2 bits                        |                              831 (339) |                                  85 (41) | switch `SNAPSHOTS`                                                     |
| **Hydration ids**                                            | S (`inheritId` per computed)                                         | —                                                       | —                                                | —                                                       | owner.ts                                  | —                                                                      | `id`                                 |                                     21 | creation cost (H8b: −18% mount with ids) | — (future `IDS` switch)                                                |
| **Compiled seams** (status-free, effect `equals`, `noThrow`) | S (recompute dispatch, literal terms)                                | —                                                       | —                                                | —                                                       | —                                         | status-free.ts M+H                                                     | 2 bits                               |                            1,178 (398) |                                 140 (57) | switch `COMPILED_SEAMS`                                                |
| **External sources**                                         | S (null check)                                                       | S (hook slots)                                          | —                                                | —                                                       | —                                         | external.ts M                                                          | —                                    |                              757 (295) |      **0** (already a folded null check) | import (no switch: nothing to remove)                                  |
| **affects()**                                                | —                                                                    | S (batch `_affectsNodes`, now `__ASYNC__`-gated)        | S (mark walks)                                   | —                                                       | —                                         | affects.ts M                                                           | 1 ext                                |                          2,666 (1,013) |                             inside async | import                                                                 |
| **Errors / error status**                                    | S (catch arm, retry)                                                 | —                                                       | S (`clearStatus`, `notifyStatus`, errored sweep) | —                                                       | —                                         | —                                                                      | `_statusFlags`, 2 ext                |                                 kernel |          kernel (kept by the sync entry) | —                                                                      |
| **Dev diagnostics / attribution**                            | S (`__DEV__`/`__OBSERVE__` arms)                                     | S                                                       | S                                                | —                                                       | dev.ts                                    | attribution engine (own entry)                                         | `_name` (observe)                    |                                      — |                   0 in prod (build tier) | build tier (`dev` / `observe` / `prod`)                                |

Where the floor goes (rendered, pre-minify bytes of the full floor → the sync floor): scheduler.ts 24,168 → 14,623, core.ts 21,315 → 14,731, async.ts 14,035 → 1,858, owner.ts 4,268, heap.ts 3,570, graph.ts 2,838, effect.ts 2,694, lanes.ts 2,190 → 0. The async capability (async + transitions + the async-only optimistic seams) is 42% of the full floor; everything else in the sync floor is kernel plus the switchable seams.

### Hot-path branches per feature (unused feature, per operation)

| Hot function                    | Stores                                                         | Optimistic                                                                       | Verdicts                                                        | Snapshots                                              | Compiled seams                       | Iterable                             |
| ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ | ------------------------------------ |
| `read()`                        | `_firewall` load + `owner === el` test; errored-owner redirect | override slot load (fast path), lane test ×2, held-truth bit                     | `latestReadActive`, `pendingCheckActive` tests (entry and exit) | `_snapshotValue` load, `snapshotCaptureActive` test ×2 | —                                    | —                                    |
| `readNodeFast()` (store traps)  | `_firewall` load                                               | override load, lane test                                                         | 2 flag tests                                                    | 2 tests                                                | —                                    | —                                    |
| `setSignal()`                   | —                                                              | `CONFIG_OPTIMISTIC` mask, lane test in the staged fast path                      | companions mask                                                 | —                                                      | —                                    | —                                    |
| `insertSubs()` (per write)      | —                                                              | source-lane computation (mask + load + global), per-subscriber optimistic branch | —                                                               | snapshot mask + load, per-subscriber scope test        | —                                    | —                                    |
| `markNode()` (per sub edge)     | `CONFIG_FW_CHILDREN` mask                                      | —                                                                                | —                                                               | —                                                      | —                                    | —                                    |
| `updateIfNecessary()` (per dep) | `_firewall` load                                               | —                                                                                | —                                                               | —                                                      | —                                    | —                                    |
| `recompute()`                   | —                                                              | dirty-lane and override tests, lane adoption, supersession                       | companion sync (transition-held)                                | —                                                      | status-free mask, effect-equals term | —                                    |
| node creation                   | 3 literal slots per signal                                     | —                                                                                | —                                                               | capture test per node (+ scope term)                   | `noThrow` term                       | `Symbol.iterator` store per accessor |
| `flush()` / finalize            | transient-store sweep                                          | optimistic batch, lanes, held reveal, optimistic stores                          | —                                                               | —                                                      | —                                    | —                                    |

### Couplings found outside the core seams

1. **Every solid-js app shipped the store (fixed here).** `solid-js/src/client/hydration.ts` called `setBlockPrimitives({ createSignal, createMemo, createStore, createEffect })` at module scope. `dist/solid.js` is one flat file, so a top-level call can never be shaken, and the block API's primitive table (`block-api.ts`) names the core `createStore` as well. Exporting `setBlockPrimitives` alone costs **+24.5 kB min / +8.0 kB gz**. The fix registers the primitives lazily, from the solid-js block constructors (`client/blocks.ts`), so an app that never calls one never references the table. `test/store-pay-for-use.spec.ts` guards it against the built artifacts.
2. **`@solidjs/web` retains the `$` driver in every app.** `insert` and event binding call `isBlock`, `renderBlock` and `dispatchBlock` (`web/src/client.ts`), so `generator.js` ships in apps without blocks: 10.7 kB rendered in sierpinski, 21.6 kB in todos. The fix is an install-on-use hook: `isBlock` stays a symbol test, and the first `$`/`$component` installs the renderer and dispatcher into a slot that `insert` reads. It needs `generator.ts` (concurrent work), so it is proposed rather than built.
3. **`createStore` statically couples `reconcile` and `projection`.** The derived overload `createStore(fn, seed)` brings `store/next/projection.ts` and `reconcile.ts`: 12.7 kB rendered, roughly 22% of the store. This was a deliberate ruling for API symmetry (#2883). The compiler can split it by rewriting the derived form to its own import.
4. **The store's transaction machinery is not gated by `__ASYNC__`.** Held adoptions, folds, staged truth and overlay layers in `store/next/store.ts` (2,818 lines, 40 kB rendered) ship in the async-free runtime, which can never exercise them. The "sync app + stores" fixture is 44 kB min; the store is 55% of it.
5. **The verdict layer requires the optimistic engine.** `isPending`/`latest` companions are optimistic nodes, by design (#2887), so an `isPending` user pays verdict + engine (7.4 kB), and `VERDICTS` on forces `OPTIMISTIC` on.

## 2. Architecture

### Layers

```
                    ┌───────────────────────────── app graph ─────────────────────────────┐
  proven by linker  │ async │ optimistic │ verdicts │ stores │ snapshots │ blocks │ seams  │
                    └───┬───┴─────┬──────┴────┬─────┴───┬────┴─────┬─────┴───┬────┴───┬────┘
  selection         entry     switch       switch    switch     switch    switch   switch
                    (sync)    OPTIMISTIC   VERDICTS  STORES     SNAPSHOTS ITERABLE COMPILED_SEAMS
  ─────────────────────────────────────────────────────────────────────────────────────────────
  feature modules   async.ts  optimistic.ts verdict.ts store/   (core API) generator.ts status-free.ts
  (import/hook)     action.ts lanes.ts                 map.ts              block-api.ts
                    boundaries.ts affects.ts context.ts external.ts
  ─────────────────────────────────────────────────────────────────────────────────────────────
  kernel            signal · memo · effect · render effect · owner tree/cleanup · heap · batch/flush · errors
```

A feature is sliced by the cheapest mechanism that removes it completely:

1. **Import reachability.** This is for a feature that is its own API: boundaries, context, `mapArray`, `affects`, actions, external sources. It needs no proof: an unimported module is gone. It stays the default.
2. **Install-on-use hook.** This is for a feature whose _logic_ runs inside the core, such as the optimistic engine, the verdict layer or the status-free recompute. The logic moves to its module and the core keeps a null-checked slot. The slot costs about 5–20 bytes and one load per use site.
3. **Link-time switch.** This is for the seams no hook can remove: the tests guarding the slots, node-literal fields, and presence bits read per operation. It needs a whole-graph proof.
4. **Entry selection.** This is for a capability whose removal restructures many functions at once. Async is the one case, and `__ASYNC__` also gives rollup `tryCatchDeoptimization: false` pre-pruning.

### Link-time switches: how they work

The core imports its switches from one module, `src/core/features.ts`, in which every switch defaults to `true`:

```ts
export const OPTIMISTIC = __ASYNC__; // an async capability: off in the sync entry
export const VERDICTS = __ASYNC__;
export const STORES = true;
export const SNAPSHOTS = true;
export const ITERABLE = true;
export const COMPILED_SEAMS = true;
```

A seam is written `STORES && …`, `(!OPTIMISTIC || …)` or `STORES ? literalWithSlots : literalWithout`. Three properties make one published tree sliceable at app link time:

1. **An app bundler folds an imported constant.** Rollup propagates `export const X = false` across modules and removes dead branches outside `try` blocks. The minifier folds the rest, including branches inside `try` and the functions they alone reached. An ESM chunk minify, as done by Vite's esbuild or terser with `module`, inlines module-scope constants. A scratch experiment (`if (STORES && …)` inside a `try`, `STORES` imported) confirmed both halves.
2. **The published trees do not fold them.** If the library build saw `STORES = true`, rollup would rewrite `STORES && x` to `x` and bake the default into `dist/`. `rollup.config.js` therefore keeps `core/features.js` **external** in the per-module trees (`prod`, `observe`, `sync`) and emits it as a plain file with the tier's defaults. The external id is the src-mirrored path, because rollup renders an absolute external relative to the importer's _source_ location. The flat dev files inline it; dev is never sliced.
3. **The linker substitutes it.** `solidCapabilities` (`packages/compiler/capabilities.js`) resolves `./features.js`, imported from inside `@solidjs/signals/dist/<tier>/core/`, to a virtual module that has the proven switches turned off. The substitution works with the async-free entry as well: `dist/sync/core/features.js` is the same file with `OPTIMISTIC`/`VERDICTS` already false.

**Why not the alternatives.**

- _One entry per combination_: six switches plus async give 128 trees, and the linker could only ever pick among published ones.
- _Global defines_ such as `__STORES__`: a published file with a free identifier throws a ReferenceError for any consumer without the define.
- _Runtime flags_: they keep the test and never remove bytes.

The features module gives any combination and costs the default nothing.

**The `try` rule.** Rollup deoptimizes `try` blocks, so a `true` switch referenced inside a `try` survives as a reference in the published default. This costs nothing in a real app (the minifier inlines it), but +6 B per site in `treeshake.test.ts`'s harness, whose minify leaves top-level constants alone. The prototype keeps switches out of `try` blocks. Four sites were left on their existing bit test instead, with a comment: the lane effects in `flush`, the lane settle in `recompute`, and the effect-equals term. Each is dead at runtime when its switch is off, and measured at ≈0 bytes.

### What the linker must prove, per switch

A switch goes off only when the graph is **fully known** (every module summarized or covered by a manifest, every dynamic import classified) and none of these facts hold:

| Switch           | On when                                                                                                                                           | Fact source today                   | Fact source with v2 block typing                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPTIMISTIC`     | `createOptimistic`, `createOptimisticStore` imported, or `VERDICTS` on                                                                            | manifests' `featureExports`         | same                                                                                                                                                                                                                                              |
| `VERDICTS`       | `isPending`, `latest` imported                                                                                                                    | manifests                           | same                                                                                                                                                                                                                                              |
| `STORES`         | any store constructor/reader imported (`createStore`, `createProjection`, `$store`, `readStore`, path/handle readers, `reconcile`, `snapshot`, …) | manifests                           | `CreateOp<"store">` / `StoreReadOp` in any block's effect union                                                                                                                                                                                   |
| `SNAPSHOTS`      | `hydrate` (or the hydration runtime installers) imported                                                                                          | manifests (`@solidjs/web: hydrate`) | same (a graph fact, not a block fact)                                                                                                                                                                                                             |
| `ITERABLE`       | a block API is imported, or any app module contains `yield*`                                                                                      | manifests + a source scan           | **residual generators**: blocks the compiler could not lower (async `attempt` in memo/event bodies) keep generators at runtime; fully lowered effect/setup/view bodies do not. Zero residual generators turns `ITERABLE` off even for block apps. |
| `COMPILED_SEAMS` | the build's compiler passes may emit `noThrow`/`equals`/`statusFree`                                                                              | a linker option (default on)        | per-module compiler summary: did this module's lowering emit a seam?                                                                                                                                                                              |

Library manifests (`capabilities.json` of `@solidjs/signals`, `solid-js` and `@solidjs/web`) gained `featureExports`. The Track A manifests already hold the async facts; the new field maps each switch to the exports that need it. A namespace import uses every listed feature, and a package with a manifest but no `featureExports` keeps every switch on. The linker's report (`capabilities-report.json`) records, per switch, whether it stays on and the first reasons why.

**v2 block typing as the fact source.** A v2 block's type is the union of the operations it yields: `ReadOp<Source>`, `WriteOp<Setter>`, `CreateOp<Kind>`, `CleanupOp`, `ContextOp`, `FlushOp`, `RaiseOp<E>` and async `attempt`. From that union come `Pending` and `Failures`. Each per-feature question maps onto that union:

- A block **creates a store** iff its union has `CreateOp<"store">`.
- It **reads a store path** iff it has `StoreReadOp`.
- It **can suspend** iff it is `Pending`. This is the whole-graph async proof, per block rather than per module.
- It **can fail** iff `Failures ≠ never`. A graph with no failures and no error boundary is the precondition for a future error-channel switch.
- It **needs the driver at runtime** iff lowering left it a generator.

`solid-tsc --capabilities` already emits typed verdicts per compute. Extending it with per-module unions of `CreateOp` kinds and residual-generator counts gives the linker exact facts where manifests and imports give conservative ones. A module that imports `$store` but never creates one would then keep `STORES` off.

### Hot-path implications

- **Monomorphic, smaller shapes.** With `STORES` off, `signal()` builds a 10-field literal instead of 13, so every signal in the graph shares one smaller hidden class. `read()` and `markNode` stop probing `_firewall` and `CONFIG_FW_CHILDREN`. This is the "node shapes that don't carry optional fields" goal, reached without two shapes coexisting: a switch picks the literal at link time, so no graph ever mixes them. The stage-3 lesson still holds. Presence bits on `_config` beat missing-property reads _within_ one runtime. A switch removes the bit test and the slot together, which neither presence bits nor `_x` can do.
- **Fewer tests per operation.** `insertSubs` computes the source lane and snapshot state once per write and tests an optimistic flag per subscriber. `read()` tests up to eight feature conditions before its fast path. With every switch off these fold away. Measured with instruction counts, write propagation runs 9.3% fewer instructions and tracked reads 12.2% fewer on the full runtime. On the async-free runtime the figures are 4.9% and 7.3%; it had already dropped much of this.
- **What slicing cannot buy.** The heuristic-oracles ledger stands. Memo fusion, typed text writes, store scalar replacement and detached nodes are per-node compiler facts, worth 20–70% per site. A slice is a whole-graph fact worth single digits on the hot path, and more in bytes. The two compose. A slice also makes a per-node shortcut cheaper to _guard_: in a store-free graph, H1/H8b never need to consider firewalls.

### Hydration interplay

- **`SNAPSHOTS` is a client-graph fact.** Snapshot capture runs only while hydrating: `setSnapshotCapture(true)` is reached from `hydrate` and the hydration runtime. A client that only `render`s never captures, and a server graph never does. Islands and late-island hydration import `hydrate`, so they keep it on. The capability linker already runs per graph (client and server), so the server can slice independently.
- **No switch may change hydration-id consumption.** Server and client must consume child ids in lockstep. None of the six switches touches `inheritId`/`getNextChildId`. `STORES` off changes only signal literals, and signals consume no ids. A future `IDS` switch (client-only render graphs: no `id` slot, no `inheritId` per computed) is sound only for graphs that never hydrate. Its value is the H8b measurement: −18% mount for nodes carrying ids.
- **Streaming and async hydration keep async.** A hydrating graph that streams async content is not async-free, so it keeps the full entry. Its slices are the non-async switches.

## 3. Prototype

What landed:

- **`@solidjs/signals`**
  - `src/core/features.ts`: the switches.
  - About 80 seam gates in `core.ts`, `scheduler.ts`, `async.ts`, `heap.ts`, `graph.ts` and `signals.ts`.
  - `featureExcluded` (`[FEATURE_EXCLUDED]`) guards at every switched feature's entry points: store slot/firewall creation, `optimisticSignal`/`Computed`, `createOptimisticStore`, `isPending`/`latest` windows, and `setSnapshotCapture(true)`. A wrong proof therefore fails loudly, like the sync entry's `[ASYNC_CAPABILITY_EXCLUDED]`.
  - `markFeature` census marks (`__TEST__` only).
  - `rollup.config.js`: the external features module.
  - Scripts: `slices.mjs` (bytes), `slices-differential.mjs` (behaviour) and `slices-bench.mjs` (wall time and instruction counts).
  - Tests: `tests/slices.test.ts`.
- **`@solidjs/compiler`**: the linker's feature proof (`proveFeatures`), graph-completeness classification of reasons, the features-module substitution, and options `features` and `compiledSeams`.
- **`solid-js`**: lazy block-primitive registration (`client/blocks.ts`) and `test/store-pay-for-use.spec.ts`.
- **Manifests**: `featureExports` in the three `capabilities.json`.
- **Scripts**: `scripts/slices/measure-apps.mjs` (example apps).
- **`examples/sync-blocks`**: selects the slice through its existing linker plugin. The feature switches are on by default in `solidCapabilities`.

### Behaviour: census differential

`node packages/signals/scripts/slices-differential.mjs` runs three passes:

1. It runs the suite on the full runtime with the census on. Every test records the features it touched.
2. For each configuration, it runs the suite with those switches off, skipping only the tests that touched them. Every other test must pass.
3. For each configuration, it runs the suite again **without** the skip. The feature-using tests should now fail: the sensitivity check that the switch removes real behaviour.

1,922 tests. The census marked OPTIMISTIC on 519 of them, STORES on 439, VERDICTS on 302, ITERABLE on 48, SNAPSHOTS on 20 and COMPILED_SEAMS on 16.

| Configuration                   | Passed | Skipped (use the feature) | Regressions | Sensitivity: feature-using tests failing with the switch off              |
| ------------------------------- | -----: | ------------------------: | ----------: | ------------------------------------------------------------------------- |
| full −OPTIMISTIC (and VERDICTS) |  1,403 |                       521 |       **0** | 518 / 520                                                                 |
| full −VERDICTS                  |  1,621 |                       303 |       **0** | 300 / 302                                                                 |
| full −STORES                    |  1,483 |                       441 |       **0** | run hangs (a store test never settles once stores throw)                  |
| full −SNAPSHOTS                 |  1,903 |                        21 |       **0** | 20 / 20                                                                   |
| full −ITERABLE                  |  1,875 |                        49 |       **0** | 42 / 48                                                                   |
| full −COMPILED_SEAMS            |  1,907 |                        17 |       **0** | 7 / 16 (fast paths: off takes the ordinary path, so mostly still correct) |
| full −all                       |  1,108 |                       816 |       **0** | 785 / 815                                                                 |
| sync −all                       |    709 |                     1,215 |       **0** | 480 / 506                                                                 |

### Bytes

The core floor (five primitives), ESM-minified as an app build does, is in the table below. "harness" is `treeshake.test.ts`'s minify, whose ceilings still hold: the all-on floor measures 23,090 B, identical to the unswitched core.

| Runtime | Switches off   | harness |    min |    gz |               Δ min |       Δ gz |
| ------- | -------------- | ------: | -----: | ----: | ------------------: | ---------: |
| full    | –              |  23,090 | 22,659 | 9,094 |                   0 |          0 |
| full    | OPTIMISTIC     |  21,430 | 21,037 | 8,450 |      −1,622 (−7.2%) |       −644 |
| full    | VERDICTS       |  22,938 | 22,515 | 9,048 |        −144 (−0.6%) |        −46 |
| full    | STORES         |  22,552 | 22,141 | 8,930 |        −518 (−2.3%) |       −164 |
| full    | SNAPSHOTS      |  22,993 | 22,574 | 9,053 |         −85 (−0.4%) |        −41 |
| full    | ITERABLE       |  22,904 | 22,473 | 9,017 |        −186 (−0.8%) |        −77 |
| full    | COMPILED_SEAMS |  22,928 | 22,519 | 9,037 |        −140 (−0.6%) |        −57 |
| full    | all            |  20,390 | 20,052 | 8,071 | **−2,607 (−11.5%)** | **−1,023** |
| sync    | –              |  13,412 | 13,138 | 5,501 |                   0 |          0 |
| sync    | STORES         |  13,018 | 12,762 | 5,376 |        −376 (−2.9%) |       −125 |
| sync    | SNAPSHOTS      |  13,315 | 13,053 | 5,471 |         −85 (−0.6%) |        −30 |
| sync    | ITERABLE       |  13,226 | 12,952 | 5,415 |        −186 (−1.4%) |        −86 |
| sync    | COMPILED_SEAMS |  13,250 | 12,998 | 5,451 |        −140 (−1.1%) |        −50 |
| sync    | all            |  12,573 | 12,351 | 5,191 |    **−787 (−6.0%)** |   **−310** |

The sync floor itself moved from 14,043 to 13,412 (harness). `OPTIMISTIC`/`VERDICTS` derive from `__ASYNC__`, so optimistic batches, optimistic stores, lanes, companions and the re-ask clear in `insertSubs` now fold out of the async-free runtime. The existing Track A build kept them. The existing 14,700 ceiling is untouched.

App-shaped fixtures pull in the runtime pieces a component tree needs: control flow, boundaries and context. Each compares the full runtime with the slice a linker would select.

| Fixture                                |   Full min / gz | Slice             |  Slice min / gz |       Δ gz |
| -------------------------------------- | --------------: | ----------------- | --------------: | ---------: |
| sync app, no stores                    | 30,400 / 12,107 | sync, −4 switches |  20,086 / 8,146 | **−32.7%** |
| sync app + stores                      | 54,517 / 19,941 | sync, −3 switches | 44,466 / 16,142 |     −19.1% |
| async app (`Loading`, no optimistic)   | 31,269 / 12,445 | full, −6 switches | 28,679 / 11,439 |      −8.1% |
| async app + `isPending`                | 38,676 / 15,010 | full, −4 switches | 37,735 / 14,701 |      −2.1% |
| async app + actions, optimistic stores | 69,460 / 25,190 | full, −3 switches | 69,043 / 25,043 |      −0.6% |

Example apps are built with `vite build` using each example's own config (native compiler, `@solidjs/vite-plugin`) against the built packages. The columns are:

- **HEAD**: solid-js before the decoupling fix.
- **decoupled**: this branch, no linker.
- **async linker**: Track A as shipped.
- **sliced**: this branch's linker.

Values are min / gz bytes of emitted JS.

| Example                                   |            HEAD |       decoupled |    async linker |              sliced | sliced vs HEAD (gz) | Linker decision                                                    |
| ----------------------------------------- | --------------: | --------------: | --------------: | ------------------: | ------------------: | ------------------------------------------------------------------ |
| sierpinski (signals, `Loading`)           | 65,914 / 24,108 | 36,018 / 14,121 | 36,018 / 14,121 | **33,457 / 13,143** |          **−45.5%** | full entry; off: OPTIMISTIC, VERDICTS, STORES, SNAPSHOTS, ITERABLE |
| sync-blocks (blocks, `$store`)            | 76,023 / 27,656 | 76,146 / 27,691 | 66,632 / 24,281 |     66,527 / 24,237 |              −12.4% | async-free; off: OPTIMISTIC, VERDICTS, SNAPSHOTS                   |
| todos (stores, actions, optimistic store) | 88,269 / 31,857 | 86,995 / 31,458 | 86,995 / 31,458 |     86,735 / 31,405 |               −1.4% | full entry; off: VERDICTS, SNAPSHOTS, ITERABLE                     |
| todos-blocks (blocks, stores, optimistic) | 94,448 / 33,916 | 94,517 / 33,942 | 94,517 / 33,942 |     94,279 / 33,905 |               −0.0% | full entry; off: VERDICTS, SNAPSHOTS                               |

Notes:

- The block apps grow by 70–120 B from the solid-js wrappers.
- The apps that use everything gain little: the slice is exact, and they use the features. Their remaining weight is the store (≈95 kB rendered in every store app), the `$` driver and the async machinery. Those are the next targets: couplings 2–4 above.
- sync-blocks already had its large win from Track A's entry. Slicing adds `SNAPSHOTS`, plus the `OPTIMISTIC`/`VERDICTS` folds inside the sync tree.

### Hot path

Instruction counts, from `node packages/signals/scripts/slices-bench.mjs --icount`. The method is the heuristic-oracles harness's:

- Node runs `--predictable --single-threaded` under cachegrind.
- The warmups are 300 for create and 2,000 for update and read.
- The result is (Ir(2·ops) − Ir(ops)) / ops.

The three scenarios are:

- **create**: 2,000 signals, memos and effects under a root, then dispose.
- **update**: one source feeding 1,000 memos and 1,000 effects; one write per op.
- **read**: a memo over 200 signals.

| Slice                  |             create |            update |            read |
| ---------------------- | -----------------: | ----------------: | --------------: |
| full                   |         13,004,017 |         4,483,279 |          96,489 |
| full, all switches off | 12,260,361 (−5.7%) | 4,067,487 (−9.3%) | 84,734 (−12.2%) |
| sync                   |         11,857,161 |         3,673,865 |          88,848 |
| sync, all switches off | 11,696,470 (−1.4%) | 3,493,705 (−4.9%) |  82,357 (−7.3%) |

Per-switch attribution (full runtime, one switch off at a time):

| Slice                |             create |            update |           read |
| -------------------- | -----------------: | ----------------: | -------------: |
| full                 |         13,004,068 |         4,483,304 |         96,472 |
| full −OPTIMISTIC     | 12,747,708 (-2.0%) | 4,307,709 (-3.9%) | 92,696 (-3.9%) |
| full −VERDICTS       | 12,874,300 (-1.0%) | 4,442,160 (-0.9%) | 94,987 (-1.5%) |
| full −STORES         | 13,121,207 (+0.9%) | 4,409,946 (-1.6%) | 91,516 (-5.1%) |
| full −SNAPSHOTS      | 12,988,151 (-0.1%) | 4,455,434 (-0.6%) | 94,891 (-1.6%) |
| full −ITERABLE       | 13,016,297 (+0.1%) | 4,483,240 (-0.0%) | 96,490 (+0.0%) |
| full −COMPILED_SEAMS | 12,926,157 (-0.6%) | 4,464,305 (-0.4%) | 96,373 (-0.1%) |

The switches compose. Most of the combined gain comes from `OPTIMISTIC`: the source-lane computation and per-subscriber branch in `insertSubs`, and the override and lane tests in `read()`. `STORES` contributes on reads (the `_firewall` probe and `owner` redirect). Its +0.9% on creation, despite a smaller signal literal, is within this scenario's JIT variance and is not explained. `ITERABLE` is a creation-time property store, invisible here.

Wall time on the shared 4-core VM, three interleaved runs of 9–11 rounds each, was noisy but never slower: full, all off, create −2% to −19%, update −13% to −24%, read −18% to −28%. The instruction counts above are the numbers to trust.

## 4. Migration plan

1. **Land the switches and the solid-js decoupling (this branch).** The default build is byte-identical, the linker is opt-in (`solidCapabilities`), and the census differential joins CI next to Track A's `sync-differential`.
2. **Shape slicing for the async-free runtime.**
   - Drop `_transition`, `_loading` and `_valueTransition` from the sync literals: every read is already `__ASYNC__`-gated or folds to a constant.
   - Give the sync runtime its own extension shape without the 11 async/optimistic/verdict slots.
   - Estimated from the field counts: −3 fields per memo, −11 per extension.
3. **The store kernel.**
   - Gate `store/next/store.ts`'s transaction machinery (held adoptions, folds, staged truth, overlays) on `__ASYNC__` and `OPTIMISTIC`.
   - Move the derived `createStore(fn)` overload behind a compiler rewrite to `createProjection`, so plain stores stop carrying `reconcile`/`projection` (≈12.7 kB rendered).
   - The store is the single largest remaining cost in every store app.
4. **Driver on use.** `@solidjs/web` binds blocks through a slot that the first `$`/`$component` fills, so apps without blocks shed `generator.js`: 10–21 kB rendered per app. This coordinates with the generator-blocks work.
5. **Typed facts.**
   - `solid-tsc --capabilities` and the compiler summary emit per-module feature facts: `CreateOp` kinds, store reads, residual generators and emitted compiled seams.
   - The linker then turns `STORES`/`ITERABLE`/`COMPILED_SEAMS` off per fact instead of per import.
   - This is the step that makes block apps sliceable.
6. **More switches, each measured first.** Candidates:
   - `IDS` (client-only render graphs);
   - an error-channel switch for graphs with no failures and no `Errored`;
   - boundary queues (`_queue`, `_children`) for graphs without boundaries.

   The heuristic-oracles rule applies: price the switch before building its proof. `EXTERNAL` was priced at 0 B and dropped.

## 5. Risks

- **Proof soundness rests on manifests.**
  - A missing export in `featureExports` switches a used feature off.
  - Mitigations:
    - Every switched feature's entry points throw `[FEATURE_EXCLUDED]`, so a wrong proof fails loudly.
    - The census differential checks the runtime side.
    - Manifest entries should get the same equality test Track A has (`tests/sync-entry.test.ts`) against the source exports.
  - One path is silent: `COMPILED_SEAMS` off with a compiled `noThrow` node. It takes the ordinary path, so it is only slower, never wrong.
- **Dev never runs the slice.** Dev and test builds resolve the flat dev file, where the switches are inlined `true`. A slice is exercised only by the prod build and by the differential. An opt-in "test against the prod slice" mode for examples would close the gap.
- **Bundler dependence.** Folding relies on cross-module constant propagation plus an ESM-aware minifier: Vite/rollup with esbuild or terser. Other bundlers that do not inline module constants keep the tests but lose no behaviour. The linker is a Vite/Rollup plugin today.
- **The `try` rule** is easy to break silently. A switch inside a `try` costs harness bytes in the default build. `treeshake.test.ts`'s floor ceiling catches it at +6 B per site, and the `slices.test.ts` markers catch a seam that stops folding.
- **Semantics of lazy block-primitive registration.** A hydrating app that imports `$signal`/`$store`/`$memo`/`$effect`/`effectBlock` from `@solidjs/signals` directly, bypassing solid-js, gets the core primitives until a solid-js block constructor has run. Before, merely importing solid-js registered the hydration-aware ones. Compiler output keeps the user's import source, so this needs a hand-written import of the low-level package in a hydrating app.
- **Combinatorics in testing.** Six switches give 64 configurations. The differential runs the eight that matter (each alone, all off, sync all off). Switches are independent by construction: each gates only its own seams, and `OPTIMISTIC` off forces `VERDICTS` off. Pairwise runs would add 15 configurations if interactions appear.

## 6. Open questions

1. Should the linker's feature slicing default on? It is the same trust model as the async-free entry, which is already opt-in per app.
2. Is a store kernel without transaction machinery (migration step 3) acceptable as a sync-runtime-only shape? Or should the store's optimistic layers become their own install-on-use module in every runtime?
3. The verdict → optimistic-engine coupling (#2887) makes `isPending` cost 7.4 kB. Is a lane-free companion implementation worth a design round?
4. Could `@solidjs/web`'s block binding (coupling 2) move to an install-on-use slot in the next generator-blocks iteration?
5. Could per-module compiler facts (step 5) ride the existing `summarizeCapabilities` summary? Or do they need the typed summary, because `CreateOp` kinds are type-level?

## Reproduce

```sh
pnpm --filter @solidjs/signals build          # dist/prod, dist/observe, dist/sync (+ core/features.js)
pnpm --filter solid-js build && pnpm --filter @solidjs/web build
(cd packages/compiler && RUSTUP_TOOLCHAIN=1.95 pnpm build)   # the native compiler (rustc ≥ 1.95)
cd packages/signals
node scripts/slices.mjs --modules --json ../../documentation/plans/core-runtime-slicing/bytes.json
node scripts/slices-differential.mjs --out ../../documentation/plans/core-runtime-slicing/differential.json
node scripts/slices-bench.mjs --icount           # and --each for attribution
npx vitest run tests/slices.test.ts tests/treeshake.test.ts
cd ../..
(cd examples/sync-blocks && pnpm summary)       # its typed summary
node scripts/slices/measure-apps.mjs --out documentation/plans/core-runtime-slicing/apps.json
```

Environment: Node v22, Vite 7/rollup 4, esbuild minify, Valgrind 3.22 (`cachegrind --cache-sim=no`), on a shared 4-core cloud VM.
