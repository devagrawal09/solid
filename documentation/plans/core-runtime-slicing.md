# Core Runtime Slicing: Pay Only for the Features the Graph Uses

Status as of 2026-09-27. A design, measured, with a working prototype: link-time feature switches in `@solidjs/signals`, selected per application by the capability linker, plus one decoupling fix in `solid-js`. The published default build is unchanged: with every switch on, the core floor is byte-identical to the unswitched core. Raw data is in [`core-runtime-slicing/`](./core-runtime-slicing/).

Update 2026-09-28: couplings 2 and 3 are fixed and the linker proves its switches from each module's compiled output (migration steps 3b, 4 and 5). See [§7 Landed](#7-landed-bundle-slicing-from-compiler-facts).

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
  - `@solidjs/web`'s `insert` retains the `$` driver in every app. _(Fixed, §7.)_
  - `createStore` statically couples `reconcile`/`projection` (≈12.7 kB rendered). _(Fixed for compiled call sites, §7.)_
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
- **Semantics of lazy block-primitive registration.** A hydrating app that imports `$signal`/`$store`/`$memo`/`$effect`/`effectBlock` from `@solidjs/signals` directly, bypassing solid-js, gets the core primitives until a solid-js block constructor has run. Before, merely importing solid-js registered the hydration-aware ones. Compiler output keeps the user's import source, so this needs a hand-written import of the low-level package in a hydrating app. **Resolved:** the compiler re-sources those imports to `solid-js` in hydrating builds (`hydration_imports.rs`), so compiled apps always get the hydration-aware primitives.
- **Combinatorics in testing.** Six switches give 64 configurations. The differential runs the eight that matter (each alone, all off, sync all off). Switches are independent by construction: each gates only its own seams, and `OPTIMISTIC` off forces `VERDICTS` off. Pairwise runs would add 15 configurations if interactions appear.

## 6. Open questions

1. Should the linker's feature slicing default on? It is the same trust model as the async-free entry, which is already opt-in per app. _(§7: yes inside the linker — features and compiled facts default on; the Vite plugin, which lives in `solidjs/solid-vite-plugin`, still has to add the linker to its build path.)_
2. Is a store kernel without transaction machinery (migration step 3) acceptable as a sync-runtime-only shape? Or should the store's optimistic layers become their own install-on-use module in every runtime?
3. The verdict → optimistic-engine coupling (#2887) makes `isPending` cost 7.4 kB. Is a lane-free companion implementation worth a design round?
4. Could `@solidjs/web`'s block binding (coupling 2) move to an install-on-use slot in the next generator-blocks iteration? _(Done, §7.)_
5. Could per-module compiler facts (step 5) ride the existing `summarizeCapabilities` summary? Or do they need the typed summary, because `CreateOp` kinds are type-level? _(§7: neither. The facts that decide switches are facts about the code that runs, so they come from the compiled output (`summarizeCompiled`), which the linker reads through the bundler. `CreateOp` kinds appear there as the creation calls lowering emits.)_

## 7. Landed: bundle slicing from compiler facts

Status 2026-09-28 (Track B of the Generator Blocks v2 compiler work). Four changes, each measured on the example apps below:

1. **Compiled facts.** The linker proves the switches from what each application module compiles to, not from what it imports.
2. **Block rendering on use.** `@solidjs/web` and the `solid-js` boundaries no longer retain the block host machinery (coupling 2).
3. **Store forms.** The compiler splits `createStore` into its plain and derived forms, so plain stores stop carrying projection and reconcile (coupling 3).
4. **Default on.** Feature slicing and compiled facts are the linker's defaults. Adding the linker to `@solidjs/vite-plugin`'s build path is an upstream change. It is written and verified, and waits for a push (§7.4).

### 7.1 Per-module compiled facts

`summarizeCompiled(code)` (`packages/compiler/src/compiled_facts.rs`) reads one module's compiled output and reports:

| Fact                                | What it is                                                                                                                                                           | Switch it decides                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `uses`                              | Per import source, the names the output references. An import that lowering left unreferenced is not a use; a referenced namespace import or an `export *` is `"*"`. | `OPTIMISTIC`, `VERDICTS`, `STORES`, `SNAPSHOTS`, through the manifests' `featureExports` |
| `creates`                           | Creation calls by kind: `signal`, `memo`, `store`, `projection`, `optimistic`, `optimisticStore`, `effect`. This is the runtime face of the `CreateOp` kinds.        | reported                                                                                 |
| `storeReads`                        | Calls of the store and path readers (`readStore`, `readPath*`, `readHandle*`, `readBorrowed`, `readProp`).                                                           | reported; the readers alone never turn `STORES` on                                       |
| `residualGenerators`, `delegations` | Generator functions left in the output (bodies the compiler could not lower, and hand-written generators), with the `yield*` count of each.                          | `ITERABLE`: on iff some module keeps a `yield*`                                          |
| `seams`                             | Compiled seams the output requests: `statusFree`, `isEqual` (memo fusion), a `noThrow` option key, and effect options that carry or may carry `equals`.              | `COMPILED_SEAMS`: on iff some module requests one                                        |

How the linker uses them (`packages/compiler/capabilities.js`):

- **When.** In a build, the proof runs when the runtime's `core/features.js` is first resolved. By then every plugin's `buildStart` has run. The linker loads each application module through the bundler (`this.load`), so the facts describe exactly the code the bundle includes, after every transform. Only runtime modules import `features.js`, and application transforms never wait on it, so the wait cannot deadlock.
- **Generated entries.** Modules the bundler makes up, such as the start-mode `virtual:solid-ssr-entry-client.tsx`, are summarized from their loaded code. The graph therefore stays fully known.
- **Fallback.** A module whose output cannot be read is judged by its authored imports, as before. `COMPILED_SEAMS` then falls back to the `compiledSeams` option.
- **Scope.** The asynchronous-entry proof (`buildStart`) is unchanged. Test runs (vitest) keep the authored-import proof. `compiledFacts: false` restores it in builds.
- **Report.** `capabilities-report.json` gains `facts` (a per-graph summary) and `featureGaps` (what kept the feature proof's graph from being fully known).

Soundness:

- The compiled output is the module. A name it does not reference cannot run, and a `yield*` it does not contain cannot iterate an accessor.
- With `ITERABLE` off, `perform(accessor)` loses only its fast-path test. It falls through to `readGuarded(accessor)`, which gives the same value.
- The path readers read whatever they are given. A store needs a store creation somewhere in the graph, and that creation keeps `STORES` on.
- Compiled uses are resolved like authored imports. A package without a manifest leaves the graph not fully known, which keeps every switch on.

This is the migration plan's step 5, and it answers the switch table's "fact source with v2 block typing" column. The facts come from the compiled output, not from the type-level union: the output already names every creation, read and residual generator.

### 7.2 Block rendering on use (coupling 2)

`packages/signals/src/block-hooks.ts` holds `renderBlock`, `dispatchBlock` and `lazyView` as ESM live bindings. The package index exports these bindings. `$` assigns them with `installBlockRenderer(…)` in its one-time setup, next to the generator hook and the path tokens.

Every renderer call site sits behind `isBlock(value)` or `inBlock()`:

- `@solidjs/web`'s `insert`, `addEvent` and delegated events;
- `flatten`;
- the `solid-js` `Loading` and `Errored` boundaries, through `lazyView`.

A block exists only after `$` has run, so the binding is always installed when it is read. Consumers call the real function directly; no forwarding frame is added. Dev builds explain a premature call (`[BLOCK_RUNTIME_MISSING]`).

Effect: apps that build no block drop `runBlockAs`, the host rules, `reportBlockError`, `readGuarded`, `lazyView` and the view iterator. In rendered bytes (comments included), `generator.js` goes from 12.4 to 7.0 kB in todos and effect, and from 11.9 to 6.5 kB in sierpinski. The rest is the accessor iterator plus `isBlock` and `inBlock`. With `ITERABLE` off it goes from 6.2 to 0.9 kB in todos and from 5.8 to 0.4 kB in sierpinski. The new `block-hooks.js` adds 1.4 kB rendered, mostly comments. `tests/treeshake.test.ts` pins this.

**Handoff to the compiled-only constructors (Track A).** `renderBlock` and `dispatchBlock` never reference the driver: they run the block under a host. The driver stays in fully compiled block apps only because compiled output imports `$` and `perform`. A compiled-only block constructor must call `installBlockRenderer(renderBlock, dispatchBlock, lazyView)` before its first block escapes, as `$` does. With that, a fully compiled block app sheds the driver with no further renderer change.

### 7.3 Store forms (coupling 3)

- **Runtime.** `@solidjs/signals` and `solid-js` export `createPlainStore(value, options?)` and `createDerivedStore(fn, seed, options?)`. The `solid-js` derived constructor is hydration-aware exactly like `createStore(fn, seed)`, and the server entry exports both constructors. `createStore` still accepts both forms at runtime. `$store(value)`, the plain form only, now creates through `createPlainStore`, both in `@solidjs/signals` and in the `solid-js` wrapper's registration.
- **Compiler.** `storeForms` (default on, every generate; `packages/compiler/src/store_forms.rs`) rewrites a `createStore` call whose first argument settles the form. The argument is looked at through parentheses, `as`, `satisfies` and `!`:
  - A function, an arrow, a `$(…)` block, a function declaration, or a `const` bound to one of these becomes `createDerivedStore`.
  - An object, array, primitive or template literal, or a `const` bound to one of these becomes `createPlainStore`. At runtime a non-function always takes the plain branch, so this rewrite cannot change behavior.
  - Anything else keeps `createStore`: parameters, imports, call results and spreads.
- **Guards.** `test/store-pay-for-use.spec.ts` pins that the plain constructors ship no `projection.js` or `reconcile.js`, with `createStore` and `createDerivedStore` as positive controls.
- **Effect.** sync-blocks, the only example whose stores are all plain, drops reconcile (18.4 kB rendered) and projection (8.2 kB rendered): **−5.5 kB min / −1.8 kB gz** before any slicing. todos and todos-blocks derive an optimistic store, so they legitimately keep both.

### 7.4 Default on

- **Why it is safe.** The census differential below has 0 regressions in every configuration. `smoke-apps.mjs` builds sync-blocks, todos-blocks, todos and sierpinski with the linker defaults, then runs each app's main flow on the **sliced production bundle** in jsdom. All four pass, including sync-blocks with `ITERABLE` and `COMPILED_SEAMS` off in a block app. This closes the "dev never runs the slice" gap from §5 for these apps.
- **What landed.** Inside `solidCapabilities`, feature slicing (`features`) and compiled facts (`compiledFacts`) are on by default. Each has an opt-out.
- **The plugin's build path: implemented upstream, awaiting a push.** `@solidjs/vite-plugin` lives in `solidjs/solid-vite-plugin`, and the workspace consumes `3.0.0-next.35` from npm. The change is written against its `next` branch (`3.0.0-next.46`) as local branch `capabilities-linker`, commit `3e9eb16`. This session has no push access to that repository, so the change is in [`vite-plugin-capabilities.patch`](./vite-plugin-capabilities.patch) (`git am` on `next`), waiting for someone with access to push it and open the PR.
  - **Option.** `solid({ capabilities?: boolean | CapabilitiesOptions })`, default `true`; `false` opts out. The object form forwards `features`, `compiledFacts`, `compiledSeams`, `typedSummary`, `report` and `entries` to `solidCapabilities`. `server: true` also links server environments.
  - **Scope.** `vite build` only: dev and vitest keep the full runtime. Client environments only by default. Server bundles never reach a browser, so slicing them buys little, and the runtime is often externalized from them, where the linker's resolution does not apply. `smoke-apps.mjs` exercises client bundles only. The linker already proves each graph on its own, so `server: true` is safe to add later.
  - **Wiring.** A `solid:capabilities-linker` plugin (`enforce: "pre"`, last in the plugin array) uses `applyToEnvironment` to return a fresh `solidCapabilities()` for each client build environment. That covers plain builds, builder mode and start mode on Vite 7+, and each environment's proof keeps its own state. Environment-scoped plugins get no config-level hooks, so the environment's resolved config is passed to the linker's `configResolved`. The linker takes its entries from the build input, including generated start-mode entries (§7.1).
  - **Coexistence.** If a config already has a plugin named `solid:capabilities` (sync-blocks' config, `measure-apps.mjs`, `smoke-apps.mjs`), the plugin's own linker stands down, so hand-wired options such as `typedSummary` win. The linker is imported lazily from `@solidjs/compiler/capabilities`, which the plugin already depends on. The published compiler (`2.0.0-rc.10`) has no such export yet; in that case the build is unchanged and logs one info line, or a warning if `capabilities` was set explicitly.
  - **Tests.** `pnpm test:unit` in the plugin runs `node:test` against a fixture linker, 11 tests, all passing. They cover: default on; `true`; `false` removes the linker; options are forwarded but `server` is not; server builds are skipped by default and linked with `server: true`; builder mode links the client environment once; a hand-wired linker wins; the dev server never links; a compiler without the linker gets an info line by default and a warning when explicit. The plugin's `examples/vite-8` and `examples/start-ssr` still build.
  - **Verification in this workspace.** The workspace cannot run `3.0.0-next.46` as it stands. That version needs Vite 8 (`transformWithOxc`), and it passes `sourceNames` to the compiler, which the workspace compiler rejects (`unknown option`). So the check applied the same compiled `src/capabilities.ts` as a scratch overlay on the installed `3.0.0-next.35` dist, then restored it. Each example was built with its own config through `vite build`, and client JS was counted as `measure-apps.mjs` counts it (min / gz bytes):

    | Example      | npm plugin, plain build | `measure-apps` sliced | patched plugin, plain build | patched, `capabilities` off |
    | ------------ | ----------------------: | --------------------: | --------------------------: | --------------------------: |
    | todos-blocks |         90,295 / 32,437 |       89,902 / 32,331 |         **89,902 / 32,331** |             90,295 / 32,437 |
    | sync-blocks  |        54,955 / 20,220¹ |       54,955 / 20,220 |        **54,955 / 20,220**¹ |            54,955 / 20,220¹ |
    | todos        |         81,610 / 29,534 |       81,081 / 29,365 |         **81,081 / 29,365** |             81,610 / 29,534 |
    | sierpinski   |         35,618 / 14,014 |       32,950 / 12,989 |         **32,950 / 12,989** |             35,618 / 14,014 |
    | hackernews   |       212,841 / 72,656² |     212,841 / 72,656² |       **212,841 / 72,656**² |           212,841 / 72,656² |

    ¹ sync-blocks wires its own linker (with its typed summary) in `vite.config.mjs`, so every column is sliced; the plugin's linker stands down. The `measure-apps.mjs` no-linker baseline is 64,611 / 23,702. For the other four, the npm plain build equals that baseline.
    ² No switch can be proven off: `@solidjs/web/frames` has no manifest (§7.5).

    The patched plain build equals the `measure-apps.mjs` sliced column byte for byte in all five. With `capabilities` off it equals the no-linker baseline. The full CLI `vite build` of hackernews (client and server) links the client environment once and not the server. `node scripts/slices/smoke-apps.mjs` passes, including todos-blocks-mixed. `pnpm test` passes in `examples/todos-blocks` (6) and `examples/sync-blocks` (5). The workspace's `node_modules` were restored afterwards, and the dependency is still `3.0.0-next.35`.

  - **When the workspace moves to a plugin release with this change:** `measure-apps.mjs`'s `baseline` variant will need the plugin's linker turned off. The script passes no plugin options today, so its no-linker column would become sliced. Sync-blocks' hand-wired linker can stay, since the plugin's linker stands down for it, or it can move to `capabilities: { typedSummary: ".solid-capabilities.json", report: "capabilities-report.json" }`.

### 7.5 Bytes

Every example that builds with the repository's harness is measured with `scripts/slices/measure-apps.mjs`:

- **before:** the base commit, `a601739a`;
- **after:** this change;
- **no linker:** a plain `vite build`;
- **sliced:** with `solidCapabilities` (feature slicing on; after this change it also reads compiled facts).

Values are min / gz bytes of emitted client JS (esbuild minify, gzip −9).

| Example           | before, no linker |   before, sliced | after, no linker |        after, sliced | gz vs before sliced | gz vs before no linker | after: switched off                                                         |
| ----------------- | ----------------: | ---------------: | ---------------: | -------------------: | ------------------: | ---------------------: | --------------------------------------------------------------------------- |
| sync-blocks       |   73,700 / 26,755 |  64,085 / 23,308 |  68,129 / 24,921 |  **58,441 / 21,442** |               -8.0% |                 -19.9% | async-free entry; OPTIMISTIC, VERDICTS, SNAPSHOTS, ITERABLE, COMPILED_SEAMS |
| todos-blocks      |   92,034 / 32,984 |  91,796 / 32,946 |  92,154 / 33,055 |  **91,783 / 32,936** |               -0.0% |                  -0.1% | VERDICTS, SNAPSHOTS, COMPILED_SEAMS                                         |
| todos             |   82,168 / 29,699 |  81,750 / 29,588 |  81,274 / 29,388 |  **80,723 / 29,225** |               -1.2% |                  -1.6% | VERDICTS, SNAPSHOTS, ITERABLE, COMPILED_SEAMS                               |
| sierpinski        |   36,202 / 14,204 |  33,639 / 13,231 |  35,286 / 13,885 |  **32,597 / 12,859** |               -2.8% |                  -9.5% | OPTIMISTIC, VERDICTS, STORES, SNAPSHOTS, ITERABLE, COMPILED_SEAMS           |
| hackernews        |  213,015 / 72,721 | 213,015 / 72,721 | 212,155 / 72,447 | **212,155 / 72,447** |               -0.4% |                  -0.4% | none                                                                        |
| hackernews-spa    |  159,104 / 54,724 | 159,104 / 54,724 | 158,244 / 54,427 | **158,244 / 54,427** |               -0.5% |                  -0.5% | none                                                                        |
| notes             |  255,479 / 87,098 | 255,479 / 87,098 | 254,616 / 86,837 | **254,616 / 86,837** |               -0.3% |                  -0.3% | none                                                                        |
| chat              |  185,250 / 62,280 | 185,250 / 62,280 | 184,391 / 62,021 | **184,391 / 62,021** |               -0.4% |                  -0.4% | none                                                                        |
| attribution-lab   |   26,510 / 10,672 |   23,949 / 9,698 |   24,406 / 9,966 |   **21,771 / 8,956** |               -7.7% |                 -16.1% | OPTIMISTIC, VERDICTS, STORES, SNAPSHOTS, ITERABLE, COMPILED_SEAMS           |
| effect            |  233,405 / 79,125 | 233,405 / 79,125 | 232,510 / 78,824 | **232,510 / 78,824** |               -0.4% |                  -0.4% | none                                                                        |
| migrating-element |   42,438 / 16,945 |  39,877 / 15,956 |  41,839 / 16,760 |  **39,151 / 15,700** |               -1.6% |                  -7.3% | OPTIMISTIC, VERDICTS, STORES, SNAPSHOTS, ITERABLE, COMPILED_SEAMS           |

Notes:

- **Why five apps change so little.** Each imports a package that has no capability manifest, so no switch can be proven off (`featureGaps` in the report names it):
  - hackernews, hackernews-spa and notes import `@solidjs/router`;
  - chat imports `marked` and `highlight.js`;
  - effect imports the `effect` library;
  - every start-mode client entry imports `@solidjs/web/frames`, a subpath package of this repository with no manifest of its own. Giving it one is the next cheap step.

  Their generated entries are now summarized (§7.1), so what remains is a gap in the library ecosystem, not in the linker. What these apps gain comes from coupling 2 alone.

- **todos-blocks stays flat.** It keeps `ITERABLE` legitimately: two `$event` bodies wait (`yield* attempt`), and the `useTodos` helper generator stays in the output. (Since [blocks-v2-performance.md](./blocks-v2-performance.md) §10 both compile away — async bodies, context-only helpers, and `filter.ts` compiled too — and the linker switches `ITERABLE` off: 89,888 / 32,313 sliced.) The renderer slot costs block apps about 120 B min in the no-linker build, which `COMPILED_SEAMS` off more than pays back.
- **Not measured.** diagnostics uses Vite 8 / rolldown, and its build fails under this harness's inline config before and after this change. rendering is three SSR configurations without an app entry.

### 7.6 Behaviour

`node packages/signals/scripts/slices-differential.mjs`, run on this change (data: [`differential.json`](./core-runtime-slicing/differential.json), [`differential.txt`](./core-runtime-slicing/differential.txt)). There are 1,952 tests, including the new `block-hooks` tests.

| Configuration                   | Passed | Skipped (use the feature) | Regressions | Sensitivity           |
| ------------------------------- | -----: | ------------------------: | ----------: | --------------------- |
| full −OPTIMISTIC (and VERDICTS) |  1,431 |                       521 |       **0** | 518 / 520             |
| full −VERDICTS                  |  1,649 |                       303 |       **0** | 300 / 302             |
| full −STORES                    |  1,509 |                       443 |       **0** | run hangs (as before) |
| full −SNAPSHOTS                 |  1,931 |                        21 |       **0** | 20 / 20               |
| full −ITERABLE                  |  1,900 |                        52 |       **0** | 45 / 51               |
| full −COMPILED_SEAMS            |  1,935 |                        17 |       **0** | 7 / 16                |
| full −all                       |  1,132 |                       820 |       **0** | 789 / 819             |
| sync −all                       |    733 |                     1,219 |       **0** | 484 / 510             |

An earlier run caught one real defect, in the −ITERABLE configuration. With a pure live binding, `renderBlock($(…))` read the binding before its argument built the first block, so it captured the uninstalled value. The bindings now start as forwarders to the installed implementations. `tests/block-hooks.test.ts` pins the case in a fresh module registry.

Sliced production bundles (`node scripts/slices/smoke-apps.mjs`), each app's main flow in jsdom:

| Example      | Switched off                                              | Flow                                                   |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| sync-blocks  | OPTIMISTIC, VERDICTS, SNAPSHOTS, ITERABLE, COMPILED_SEAMS | add two items, toggle, filter, converter event: ok     |
| todos-blocks | VERDICTS, SNAPSHOTS, COMPILED_SEAMS                       | add two todos through the async action, toggle one: ok |
| todos        | VERDICTS, SNAPSHOTS, ITERABLE, COMPILED_SEAMS             | same flow: ok                                          |
| sierpinski   | all six                                                   | 731 dots render through `Loading` and async memos: ok  |

Test suites:

- `packages/signals`: 175 files, 1,951 passed.
- `packages/solid`: `test` 603 passed; `test-types` clean.
- `packages/web`: only the known `server-functions-adapter-request` failure. `lazy-shell-gating` failed once under full-machine load and passes in isolation, 3 of 3 runs.
- `packages/h`: 61 passed.
- `packages/compiler`:
  - Rust, all three feature configurations: 134, 88 and 127 passed.
  - vitest: 5,912 passed. `tsrx-typecheck-projection` times out at 5 s with the debug binary under load and passes in isolation. The three block-lowering and strict fixtures whose output now shows `createPlainStore` were regenerated with their update commands.
- `examples/todos-blocks` and `examples/sync-blocks`: `pnpm test` passes.

## 8. Frames client switches

The same mechanism, applied to `@solidjs/web/frames`' client (the server-components runtime). Its switches are in `packages/web/frames/src/features.ts`. Every switch is `true` in the published build. The prod client (`frames/dist/client.js`) imports them from a sibling file, `frames/dist/client.features.js`, which rollup keeps external (`framesFeaturesModule` in `packages/web/rollup.config.js`). An app bundler folds them against the published defaults, or against the module the capability linker substitutes. The dev client inlines them and is never sliced.

| Switch             | Removes                                                                                                                                                        | Seams                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `FRAGMENTS`        | Segment reveal and fallback materialization inside frames, the reveal seam (`createLoadingBoundary`), late document boundaries, and the fragment-ledger claims | `chunkToRecords` fragment/reveal, the flush's segment loop, `revealSeam`, `boundaryMayArrive`, `installRevealHook`, `claimRegionFragments` |
| `ASSETS`           | Streamed stylesheet gates, module preloads and preload links                                                                                                   | `chunkToRecords` assets, root-asset accumulation, the flush's asset loop, the style gate                                                   |
| `SLOT_DATA`        | `{$ref}` slot args resolved from the response's data table                                                                                                     | `#resolveArgs`, `#refsUnresolved`, `#refArgsUnchanged`                                                                                     |
| `ASYNC_ARGS`       | `asyncArg` values read through async memos                                                                                                                     | `slotArgsProxy`                                                                                                                            |
| `CONTAINERS`       | Container traces: the materializer install (`materializeContainerTrace`), revive, and identity probes                                                          | `setContainerTraceMaterializer`, host `revive` / `isContainer`, `slotArgsProxy`                                                            |
| `LIVE_PROPS`       | `ctx.onUpdate` live slot props. With it off, an occurrence is re-called when its args change                                                                   | `onUpdate`, the flush's updater branch, `liveSlotProps`                                                                                    |
| `SINGLE_FLIGHT`    | `applyFlightResponse`                                                                                                                                          | the transport's single-flight branch                                                                                                       |
| `FULL_CODEC`       | The lazy codec loader and the response-scoped data tables                                                                                                      | host `prepareData` / `applyData` / `resolve`, `data` chunks                                                                                |
| `HYDRATION_CLAIMS` | Scoped claim renders of hydrated slot fills                                                                                                                    | `claimRender`                                                                                                                              |

The rules are the ones the signals switches follow:

- A switch only removes code.
- A feature reached with its switch off throws `[FEATURE_EXCLUDED]`. Each site is written `if (!X) return featureExcluded("X")`, so the code after the site is dead and the bundler drops it. A bare call does not work: the bundler cannot tell that `featureExcluded` never returns.
- `markFeature` records which tests touch a feature (the census). In the published build it is a no-op.

### 8.1 Proof from compiled server output

What the server can put on the wire is what the client must be able to apply. So the proof reads the server graph: `proveFramesFeatures` in `packages/compiler/capabilities.js`.

1. In the server build, the `solidCapabilities` plugin records each application module's final compiled output (a post transform; virtual entries are included).
2. In `generateBundle` it writes the proof to `node_modules/.cache/solid/frames-features.json` (the `framesProof` option).
3. The client build, run after the server build, resolves `@solidjs/web/frames`' `client.features.js` to a substitute that has the proven switches off.
4. When there is no proof file, the client keeps the published module.

The rules are conservative: a name or shape that may produce the feature keeps the switch on, and a module whose output is unknown keeps every switch on. A _server-component module_ is one whose output has a `"use server"` directive and renders markup.

| Switch on when the server output has…                                                        | Switch                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| a `Loading` / `Reveal` anywhere                                                              | `FRAGMENTS`                                   |
| a server-component module that imports CSS or calls `lazy(`                                  | `ASSETS`                                      |
| a server-component module that takes `props` (it may be handed slots)                        | `SLOT_DATA`, `LIVE_PROPS`, `HYDRATION_CLAIMS` |
| `asyncArg`                                                                                   | `ASYNC_ARGS`                                  |
| a server-component module that creates a store or projection                                 | `CONTAINERS`                                  |
| `frameTransformFlightResult` or `collectFlightData`                                          | `SINGLE_FLIGHT`                               |
| any of `SLOT_DATA` / `ASYNC_ARGS` / `CONTAINERS` (the data table only carries their records) | `FULL_CODEC`                                  |

Here is what the proof decides for the examples, running `scripts/ssr-redesign/frames-proof.mjs` over each example's `src/` compiled with `generate: "ssr"`:

| Example                | Off                                                                      | Kept on, first reason                                                                                          |
| ---------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `hackernews`           | ASSETS, ASYNC_ARGS, CONTAINERS, SINGLE_FLIGHT                            | FRAGMENTS (`app.tsx` `Loading`); the slot trio and FULL_CODEC (`lib/views.tsx`: a server component with props) |
| `notes`                | ASSETS, ASYNC_ARGS, CONTAINERS                                           | SINGLE_FLIGHT (`server-config.ts`), FRAGMENTS, the slot trio, FULL_CODEC                                       |
| `chat`                 | ASSETS, SINGLE_FLIGHT                                                    | everything else (`lib/ai.tsx`: `asyncArg`, a projection, slots)                                                |
| `hackernews-sc-blocks` | all but FRAGMENTS and SINGLE_FLIGHT (moot: it does not load this client) | —                                                                                                              |

The script reads only `src/`. In a real build the plugin also sees the generated server entry. For `hackernews` (`start: {}`), that entry installs the flight transform when `serverFunctions.components` is set, which keeps `SINGLE_FLIGHT` on.

Tests: `packages/compiler/__tests__/frames-features-proof.test.js` (6). It covers each rule over real `generate: "ssr"` output, unknown modules, the substitute module and its guard, and the plugin's server-to-client round trip.

### 8.2 Behaviour: census differential

`node packages/web/scripts/frames-differential.mjs` runs the same protocol as §3 / §7.6. The suite is every client spec that loads the frames runtime:

- `test/frames-*`, `test/lifecycle-matrix`, and the preload-link specs (default config);
- `test/hydration/adopted-*` (hydrate config);
- the new `test/server/frames-single-flight-client.spec.tsx`, the client half of single flight against a real server response.

`test/setup/frames-features.mjs` wires the census (`FRAMES_CENSUS`), the switch substitution (`FRAMES_FEATURES_OFF`) and the subset skip (`FRAMES_FEATURE_SUBSET`) into the three vitest configs. Data: [`frames-differential.json`](./core-runtime-slicing/frames-differential.json). There are 112 tests.

| Configuration     | Passed | Skipped (use the feature) |            Regressions | Sensitivity |
| ----------------- | -----: | ------------------------: | ---------------------: | ----------- |
| −FRAGMENTS        |     98 |                        14 |                  **0** | 12 / 14     |
| −ASSETS           |    108 |                         4 |                  **0** | 3 / 4       |
| −SLOT_DATA        |    102 |                        10 |                  **0** | 10 / 10     |
| −ASYNC_ARGS       |    105 |                         6 | **0** (1 skip cascade) | 6 / 6       |
| −CONTAINERS       |    109 |                         3 |                  **0** | 3 / 3       |
| −LIVE_PROPS       |    103 |                         9 |                  **0** | 7 / 9       |
| −SINGLE_FLIGHT    |    111 |                         1 |                  **0** | 1 / 1       |
| −FULL_CODEC       |    102 |                        10 |                  **0** | 10 / 10     |
| −HYDRATION_CLAIMS |    109 |                         3 |                  **0** | 1 / 3       |
| −all              |     72 |                        40 |                  **0** | 36 / 40     |

**Skip cascade.** `adopted-fallback-residue`'s second test takes the async-arg path only when the file's first test did not run before it. With `ASYNC_ARGS` off the first test is skipped, so the second reaches the switched-off feature. It correctly throws `[FEATURE_EXCLUDED]`. The script reports such a failure as a cascade: an earlier test in the same file used the feature.

**Census marks the first run missed.** The first run found five regressions, all from missing marks: late document boundaries under `FRAGMENTS`, and preload-only asset records applied straight to a frame under `ASSETS`. The marks were added; no switch semantics changed.

**Sensitivity below 100%.** `HYDRATION_CLAIMS` is 1 / 3 because two of its tests pass with fresh renders instead of claims.

### 8.3 Bytes

`node packages/web/scripts/frames-switch-bytes.mjs` measures the published `frames/dist/client.js`. It bundles the client with rollup (node resolution, browser conditions) together with the `solid-js` / `@solidjs/web` parts it pulls in, and leaves the server-function client and the lazy codec external. It substitutes the features module the way the linker does, then applies esbuild minify and gzip. Data: [`frames-bytes.json`](./core-runtime-slicing/frames-bytes.json).

| Configuration                                                       | min KB | gz KB |                    saved gz bytes |
| ------------------------------------------------------------------- | -----: | ----: | --------------------------------: |
| full (published)                                                    |  86.34 | 30.86 |                                 0 |
| −FRAGMENTS                                                          |  83.95 | 30.03 |                               859 |
| −ASSETS                                                             |  84.26 | 30.25 |                               624 |
| −SLOT_DATA                                                          |  86.00 | 30.83 |                                40 |
| −ASYNC_ARGS                                                         |  86.32 | 30.91 |                               −49 |
| −CONTAINERS                                                         |  61.22 | 22.81 |                             8,243 |
| −LIVE_PROPS                                                         |  86.14 | 30.79 |                                74 |
| −SINGLE_FLIGHT                                                      |  85.29 | 30.50 |                               373 |
| −FULL_CODEC                                                         |  86.21 | 30.86 | 4 (+ lazy 6.59 KB gz unreachable) |
| −HYDRATION_CLAIMS                                                   |  85.25 | 30.52 |                               353 |
| −all                                                                |  53.03 | 19.98 |                            11,145 |
| hackernews' proof (−ASSETS, ASYNC_ARGS, CONTAINERS, SINGLE_FLIGHT)  |  57.51 | 21.55 |                             9,542 |
| hackernews' proof in a real build (−ASSETS, ASYNC_ARGS, CONTAINERS) |  58.75 | 22.05 |                             9,027 |

Reading the table:

- **`CONTAINERS` is the large switch.** It removes `materializeContainerTrace` and the projection and store machinery it reaches in `solid-js`. The number is an upper bound: an app that hydrates projections or stores itself keeps most of that code for its own use.
- **`FULL_CODEC` barely changes the eager bytes.** The codec already loads lazily. What the switch removes is the reachability of the 6.59 KB gz decode chunk: with it off, the chunk can no longer load.
- **`ASYNC_ARGS` and `SLOT_DATA` save nothing or cost bytes.** The code they guard is a few lines, and the guard itself costs about 150 bytes (`featureExcluded` and its message) when no other switch pulls it in. They are kept because they are exact statements of what the wire can carry, and they cost nothing once any other switch is off.

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
node scripts/slices/smoke-apps.mjs             # §7: the sliced production bundles run in jsdom
(cd packages/compiler && npx vitest run __tests__/capabilities.test.js)   # §7: the compiled-facts proof
# §8: frames client switches (build packages/web first: frames/dist/client.features.js)
(cd packages/web && node scripts/frames-differential.mjs --out ../../documentation/plans/core-runtime-slicing/frames-differential.json)
(cd packages/web && node scripts/frames-switch-bytes.mjs --json ../../documentation/plans/core-runtime-slicing/frames-bytes.json \
  --off ASSETS,ASYNC_ARGS,CONTAINERS,SINGLE_FLIGHT --off ASSETS,ASYNC_ARGS,CONTAINERS)
node scripts/ssr-redesign/frames-proof.mjs hackernews notes chat hackernews-sc-blocks
(cd packages/compiler && npx vitest run __tests__/frames-features-proof.test.js)
```

For §7's "before" column, check out the base commit (`a601739a`) in a separate worktree, build it the same way, and run the same `measure-apps.mjs` there.

Environment: Node v22, Vite 7/rollup 4, esbuild minify, Valgrind 3.22 (`cachegrind --cache-sim=no`), on a shared 4-core cloud VM.
