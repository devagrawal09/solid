# Size: pay-for-what-you-use reactive core (Step 1)

Goal: get Solid 2's always-retained reactive core close to Marko 6's model, where optional
features live in modules that only get imported when the compiled output uses them. This note
records the baseline, where the core-floor bytes go, the one contained change made in this step,
and a ranked list of what to do next.

All numbers are brotli bytes of the esbuild-minified bundle (size-limit v12, the same scenarios
as `scripts/size/.size-limit.js`), measured on this Linux box after `pnpm build` of
signals/solid/web. The compiler package does not build here (no native or wasi binary), so
`packages/web` vitest suites cannot load; see "Verification".

## Baseline (before the change)

| scenario | brotli B |
| --- | --- |
| signals: core floor (createSignal/Memo/Effect/Root/flush) | 8571 |
| signals: + createStore | 17178 |
| signals: + isPending/latest | 10866 |
| app: render + one signal | 11596 |
| app: hydrating (no stores) | 19032 |
| app: hydrating + every store family | 30239 |
| app: CSR Show/For/Loading/Errored/lazy | 14374 |
| app: CSR observe tier | 15757 |
| app: CSR observe + attribution | 27276 |
| frames: eager client consumer | 11372 |

Several of these are above the caps committed in `.size-limit.js` in this environment (floor by
121 B, simple app by 446 B, createStore by 1.83 KB). The caps were set from CI artifacts; this
box's toolchain output is a little larger. I did not touch any cap (see "Limits").

## Attribution of the core floor

Method: bundle `{ createSignal, createMemo, createEffect, createRoot, flush }` from
`dist/prod/index.js` with esbuild (minified, metafile), then bundle the same imports from the
async-free build `dist/sync/index.sync.js` (`__ASYNC__ = false`, Track A). The sync build is the
upper bound on what can be made pay-for-use: it is exactly the async/pending/transition/lane
code folded out.

Minified bytes per module (full -> sync build):

| module | full | sync | async-only |
| --- | --- | --- | --- |
| core/async.js | 4410 | 720 | 3690 |
| core/scheduler.js | 6713 | 4263 | 2450 |
| core/core.js | 6482 | 4501 | 1981 |
| core/lanes.js | 761 | 42 | 719 |
| core/error.js (NotReadyError) | 339 | 169 | 170 |
| owner / heap / graph / effect | 4456 | 4223 | 233 |
| total | 23786 | 14834 | 8952 |

Brotli: floor 8616 -> 5633 (-2983, -34.6%). Simple app (render + one signal) 11460 -> 8716
(-2744, -24%). Of the simple app, `web.js` alone is about 7.0 KB minified, a separate target.

Largest retained functions (esbuild minify-syntax, unmangled, so relative size only) and whether
they exist only for async/pending/transitions/optimistic/lanes:

| function | bytes | async-only? |
| --- | --- | --- |
| handleAsync (promise / AsyncIterable flights) | 3733 | yes |
| GlobalQueue class (flush/notify/initTransition) | ~8900 | about 2.4 KB of it is transitions/lanes/stash |
| recompute | 4447 | about 2 KB of arms are `__ASYNC__` branches (loading window, lanes, pending sources, transition adoption) |
| read | 2533 | about 0.7 KB of pending / held-truth / latest arms |
| notifyStatus / clearStatus / setPendingError | 1249 / 346 / 258 | mostly (error status shares them) |
| settlePendingSource, releaseSettledDependents, settleErroredDependents, forEachDependent, addPendingSource, parkLoadingWindow | 636 / 277 / 244 / 192 / 119 / 137 | yes |
| mergeTransitionState, transitionComplete, commitPendingNode(s), runInTransition, reporterBlocksSource, heldFromStale, suppressComputedRecompute | 449 / 354 / 445+230 / 196 / 287 / 203 / 187 | yes |
| assignOrMergeLane + mergeLanes + resolveTransition | 405 + 240 + 210 | yes (moved off the floor by this change) |
| NotReadyError | 355 | yes |

Key structural finding: everything async is anchored by ONE hard reference, recompute's call
`handleAsync(el, fnResult)`, plus the always-present `GlobalQueue` class methods (flush, notify,
initTransition), which are not tree-shakeable because they are class methods. The existing hook
pattern (`GlobalQueue._xxx`, installed by `installOptimisticEngine` / verdict.ts) already keeps
optimistic, verdict, affects and boundaries off the floor (the treeshake test confirms
`core/optimistic.ts`, `core/verdict.ts`, `core/action.ts` are absent). What remains is the layer
under handleAsync: pending status, settle walks, transitions, lane bookkeeping.

Experiment (not committed): turning recompute's `handleAsync` call into a hook (no installer)
took the floor from 8567 to 7586 (-981 B, -11%) with everything else unchanged. That is the
ceiling for the handleAsync anchor alone, before the follow-on shaking of the settle walks.

## Why handleAsync itself was not moved

A memo's compute function can return a Promise or AsyncIterable at any time, and the floor's
`createMemo` must handle it. There is no import that exists exactly when an app "uses async":
`createMemo(async () => ...)` needs nothing beyond `createMemo`. Installing handleAsync from a
side-effect in any module the floor already retains gives no saving; installing it from a module
the floor does not retain changes behavior for hand-written apps that use an async memo without
importing another async API. That needs a capability signal from the compiler (an emitted
`import "@solidjs/signals/async"` when a compute may return a thenable, or the existing
`sync` option meaning "proven plain values"), which is the Track A / typed-generator work, not a
library-only change. So the semantics-preserving move in this step is the part whose trigger IS
knowable from state only the engine can create.

## The change made

Lane routing code is reachable from the core only when a lane or an override exists, and both are
created only by `optimistic.ts` (`_optimisticLane` and `_overrideOwner` are assigned only there and
in `assignOrMergeLane` itself; `installOptimisticEngine()` runs before any optimistic node exists,
by verdict.ts at module top level and by createOptimistic / createOptimisticStore at first call).
Yet `scheduler.ts` (`insertSubs`) and `async.ts` (`notifyStatus`, `handleAsync`) hard-imported
`assignOrMergeLane` (which pulls `mergeLanes`) and `resolveTransition`, keeping about 700
minified bytes of lane merge code on every floor.

- `scheduler.ts`: two new hook slots `GlobalQueue._assignLane` and `GlobalQueue._resolveTransition`
  (installed by the engine), and `transitionOf(el)`, which returns `el._transition` when no engine
  is installed (identical to the old `resolveTransition` result when no override or lane exists)
  and defers to the engine's `resolveTransition` otherwise. `insertSubs` calls
  `GlobalQueue._assignLane!` under its existing `optimistic && sourceLane` gate.
- `async.ts`: `resolveTransition(el)` -> `transitionOf(el)` (three sites); `assignOrMergeLane`
  -> `GlobalQueue._assignLane!` under the existing `lane && !blockStatus` gate (lane comes from
  `resolveLane`, so it is non-undefined only with the engine).
- `optimistic.ts`: `installOptimisticEngine` also installs the two hooks.
- `tests/treeshake.test.ts`: the sync-entry marker list used `function assignOrMergeLane` as a
  "present in the full floor" marker, which is no longer true by design. It is replaced by
  `function resolveLane` (still present in the full floor, absent from sync), and a new assertion
  requires that `assignOrMergeLane`, `mergeLanes` and `resolveTransition` are NOT in the full
  floor. No assertion was loosened; one was added.

No behavior changes: with the engine installed the same functions run with the same arguments;
without it the call sites are unreachable (gates unchanged) or fall through to `el._transition`.

## New numbers

| scenario | before | after | delta |
| --- | --- | --- | --- |
| signals: core floor | 8571 | 8438 | -133 |
| signals: + createStore | 17178 | 17041 | -137 |
| signals: + isPending/latest | 10866 | 10909 | +43 |
| app: render + one signal | 11596 | 11434 | -162 |
| app: hydrating (no stores) | 19032 | 18892 | -140 |
| app: hydrating + every store family | 30239 | 30259 | +20 |
| app: CSR Show/For/Loading/Errored/lazy | 14374 | 14246 | -128 |
| app: CSR observe tier | 15757 | 15602 | -155 |
| app: CSR observe + attribution | 27276 | 27142 | -134 |
| frames: eager client consumer | 11372 | 11372 | 0 |

Scenarios that install the optimistic engine (isPending/latest imports verdict.ts; the
every-store-family hydrating app imports createOptimisticStore) pay the two hook stores and
`transitionOf` (+20 to +43 B); those are the scenarios that use the feature, which is the intended
direction of the trade. The floor and everything lacking optimistic state save 130 to 160 B.

Limits: the floor now measures 8438 B here, under its 8.45 KB cap, the only cap I could move
without guessing at CI output. I did not lower any cap: the baseline here already exceeded
several caps, so this box does not reproduce CI numbers exactly and a ratchet from local numbers
could break CI. Re-ratchet from CI artifacts (expected about -130 B on floor, -160 B on the simple
app).

## Verification

- `pnpm --filter @solidjs/signals test`: 1863 passed, 5 skipped, 0 failed across 164 files
  (one first-run failure of `attribution-holds` "longHolds: false records the tail", a 30 ms timing
  threshold that measured 29.6 ms; it passed on three reruns and is unrelated to lanes).
  `tests/treeshake.test.ts`: 8/8 pass.
- `packages/solid` tests: 600 passed (23 files).
- `packages/web` tests: 15 files, 227 tests pass; 66 files fail to LOAD because
  `@solidjs/compiler` has no native or wasi binary in this environment (identical without the
  change; environmental, not a test failure).
- `prettier --check` clean on all changed files. `tsc --noEmit` reports only pre-existing errors in
  test files (unrelated to these edits).

## Ranked next candidates

1. Hook `handleAsync` (and everything only it reaches) behind a capability import. Measured
   ceiling for the anchor alone: -981 B on the floor; with follow-on shaking of the settle walks
   (`settlePendingSource`, `releaseSettledDependents`, `forEachDependent`, `addPendingSource`,
   `parkLoadingWindow`, `releaseFlightTeardown`) and `NotReadyError` plausibly -1.4 to -2.0 KB.
   Needs the compiler (or an explicit sync memo option) to say when a compute may return a
   thenable; without it, behavior changes for async memos with no other async import. Fits the
   `typed-generator-compiler.md` capability linker: emit `import "@solidjs/signals/async"` when
   the graph is not proven sync. Highest value, needs a semantics ruling.
2. Move transition machinery off `GlobalQueue`'s always-retained methods: `initTransition`,
   `stashQueues/restoreQueues`, and the transition/lane branches inside `flush` and `notify`,
   plus module functions they pull (`mergeTransitionState`, `transitionComplete`,
   `commitPendingNode(s)`, `runInTransition`, `transitions` set). Class methods cannot shake, so
   install them as hooks from the module that creates the first transition (handleAsync / action /
   optimistic). About 0.6-0.9 KB; safe by the same argument as this change, because transitions
   only exist once an async or optimistic module is loaded, except that handleAsync currently
   counts as such a module, so it composes with candidate 1.
3. Peel the pending-status arms out of `read()` and `recompute()`: the `_pendingSources`,
   held-truth, loading-window and `notifyEffectStatus` paths (about 0.7 KB unmangled in `read`,
   about 2 KB of `__ASYNC__` arms in `recompute`), via a second compiled recompute in the style of
   `status-free.ts` (which already ships as a hook-installed specialization). About 0.4-0.6 KB.
4. Slim `web.js` for the render + one signal app: it is about 7.0 KB minified of the 11.4 KB
   simple-app total, the largest single block once the core is diet-fed. Not core-related, but at
   about 2 KB brotli it is the next biggest lever toward the Marko comparison.
5. Split `notifyStatus`/`clearStatus` so the error-only half stays on the floor and the
   pending-only half moves with candidate 1 (about 100-150 B), and fold `NotReadyError` /
   pending status constants behind the same import (about 60 B).

Reproduction helpers used (kept out of the repo): an esbuild script that bundles the floor
scenario from `dist/prod/index.js` versus `dist/sync/index.sync.js` with `--metafile` and prints
`bytesInOutput` per module and brotli of the result.
