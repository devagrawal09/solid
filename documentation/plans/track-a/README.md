# Track A: synchronous status-free fast paths and the async-free reactive core

Track A covers two optimization slices from
[typed-generator-compiler.md](../typed-generator-compiler.md#optimization-prototype-slices):

- **Stage 1 (slice 1)**: synchronous, status-free fast paths for `$` blocks.
- **Stage 2 (slice 4)**: an async-free reactive core, selected over a whole module graph.

Generator lowering, host fusion and fallback exclusion are baselines, not slices. Every
measurement below compares against them.

| Stage | Verdict                 | Summary                                                                                                                                                                                                                                                                                                                          |
| ----- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **ITERATE**             | KEEP the `BLOCK_SYNC` proof and the `syncOnly` host option: probes are skipped, updates are cheaper, bytes are flat. REJECT the status-free recompute (`statusFree`, `CONFIG_NOTHROW`) as built: it costs CPU and bytes, and it proved 0 of 14 real blocks.                                                                      |
| 2     | **KEEP** (experimental) | The linker proves a real app async-free on both graphs and swaps in `@solidjs/signals/sync`: −12.3% client gzip, −18.1% server gzip. It refuses every graph that touches an async capability. It also removes 12 to 19% of update instructions for handwritten and `$` code alike: see [Stage 2 CPU](#cpu-instruction-counts-1). |

All raw data is in this directory. Numbers below are copied from those files.

## Environment

| Item                    | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| CPU                     | Intel Xeon @ 2.10GHz, 4 cores (shared cloud VM)                                |
| Node                    | v22.22.2 (V8 12.4.254.21)                                                      |
| Valgrind                | 3.22.0 (`cachegrind --cache-sim=no`)                                           |
| Bundler for micro sizes | esbuild, minify, esm, es2022                                                   |
| Compression             | gzip level 9, brotli quality 11                                                |
| Runtime tier            | `packages/signals/dist/prod` (full), `packages/signals/dist/sync` (async-free) |

## Commands

Build first: `pnpm --filter @solidjs/signals build` and `pnpm --filter @solidjs/compiler build`.
The compiler needs rustc 1.95 or newer.

| Purpose                              | Command                                                                                                                                                                            | Output                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Stage 1 wall time and allocations    | `node scripts/track-a/bench.mjs --reps 5 --n 1000 --out documentation/plans/track-a/stage1-bench.json`                                                                             | `stage1-bench.json`                                  |
| Stage 1 instruction counts           | `node scripts/track-a/icount.mjs --out documentation/plans/track-a/stage1-icount.json`                                                                                             | `stage1-icount.json`                                 |
| Stage 1 unfused instruction counts   | `node scripts/track-a/icount.mjs --variants transformed,optimizedUnfused,optimizedUnfusedSyncOnly --runtime <stage-1 runtime> --out …`                                             | `stage1-icount-unfused.json`                         |
| Stage 1 sizes                        | `node scripts/track-a/size.mjs --out documentation/plans/track-a/stage1-size.json`                                                                                                 | `stage1-size.json`                                   |
| Compiler overhead                    | `node scripts/track-a/compiler-cost.mjs --out documentation/plans/track-a/compiler-cost.json`                                                                                      | `compiler-cost.json`                                 |
| Stage 2 sizes, module graphs, linker | `node scripts/track-a/stage2.mjs --out documentation/plans/track-a/stage2.json`                                                                                                    | `stage2.json`                                        |
| Stage 2 behavioral differential      | `node scripts/track-a/sync-differential.mjs --out documentation/plans/track-a/stage2-differential.json`                                                                            | `stage2-differential.json`                           |
| Stage 2 wall time and allocations    | `node scripts/track-a/bench.mjs --reps 5 --variants handwritten,fused,optimizedSyncOnly [--runtime packages/signals/dist/sync/index.sync.js] --out …`                              | `stage2-bench-full.json`, `stage2-bench-sync.json`   |
| Stage 2 instruction counts           | `node scripts/track-a/icount.mjs --variants handwritten,transformed,fused,optimizedSyncOnly,optimizedUnfusedSyncOnly [--runtime packages/signals/dist/sync/index.sync.js] --out …` | `stage2-icount-full.json`, `stage2-icount-sync.json` |

### Scenarios and variants

`scripts/track-a/scenarios.mjs` defines four scenarios. Each builds `n` computations under one root.

| Scenario      | What it does                                                 | Proofs expected                              |
| ------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `flags`       | `n` memos `(yield* sel) === i`, each read by a render effect | SYNC and NOTHROW in any module               |
| `typed-arith` | arithmetic over `createSignal(0)` in a `.ts` module          | SYNC and NOTHROW via typed primitive domains |
| `objects`     | blocks returning object literals and arrays                  | SYNC only                                    |
| `unprovable`  | blocks calling an unknown helper                             | none (control: must equal the baseline)      |

| Variant                                         | Meaning                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `handwritten`                                   | idiomatic Solid, no `$`                                                     |
| `transformed`                                   | `$` source, generator lowering only (unfused baseline)                      |
| `fused`                                         | lowering plus host fusion (fused baseline)                                  |
| `optimized`                                     | fused plus `blockProofs` (`statusFree` where SYNC+NOTHROW, else `syncOnly`) |
| `optimizedSyncOnly`                             | `optimized` with every `statusFree` rewritten to `syncOnly`                 |
| `optimizedUnfused` / `optimizedUnfusedSyncOnly` | the same proofs without host fusion                                         |

### Methods and noise

- **Instruction counts.** Each cell runs twice under cachegrind, with the same warmup and
  `ops` or `2*ops` operations. Per-op cost is `(Ir(2·ops) − Ir(ops)) / ops`. Node runs with
  `--predictable --single-threaded`. This is the primary CPU signal.
  - Two full-runtime runs at the same commit agreed within 0.2% on every cell that both
    measured cleanly (for example `flags/mount/handwritten` 1,229,113 and 1,229,186).
  - Runs against different runtime builds are less comparable. `flags/mount/transformed`
    measured 3,079,598 Ir/op in the Stage 1 unfused run and about 1,476,000 in three other
    runs. Treat mount deltas under about 5% as noise, and compare cells from the same run or
    the same runtime build.
  - A disturbed cell can come out absurd (one cell read −4,113,411 Ir/op in the discarded
    run). Such cells are rerun, not averaged.
- **Wall time.** Fresh process per cell, 5 reps × 20 samples, warmups of 30 (mount) and 300
  (update). Rep-to-rep spread was 4.2% minimum, 15.1% median and 41.1% maximum. Only large
  wall-time differences are meaningful.
- **Allocations.** `v8.GCProfiler` plus `heapUsed` deltas per op. These are deterministic for
  update cells.
- **Compiler time.** Median of 200 transforms after 20 warmups, measured on an otherwise
  idle machine. p10 to p90 spread is 20 to 45%, so differences under about 10% are noise.

## Stage 1: synchronous status-free fast paths

### What was built

- **Compiler proofs** (`packages/compiler/src/block_proofs.rs`), decided separately per `$` block:
  - `BLOCK_SYNC`: every returned value is proven plain. Plain means a primitive, an array, an
    object literal without a `then` key, a function, or an intrinsic JSX element.
  - `BLOCK_NOTHROW`: no step can throw and no read can see a pending or errored source.
    Allowed: `===`, `!`, `typeof`, logical or conditional selection, literals, and arithmetic
    or comparison over proven non-symbol, non-bigint primitives. Reads must come from plain
    `createSignal(value)` accessors or memos over SYNC+NOTHROW blocks. Any call, member access,
    `new`, assignment, loop, `try`, `switch`, destructuring, import binding or unknown read refuses.
  - Typed primitive domains (`createSignal(0)`, `createSignal<number>()`) apply only in `.ts`
    and `.tsx` modules. The strict contract has `solid-tsc` check them.
  - TDZ soundness: a read binding must be a parameter, an earlier body-local, a function
    declaration, or a binding declared before the `$` call in the same function scope. Imports
    are refused because cyclic modules can observe them uninitialized.
- **Emission** (`generators.rs`, option `blockProofs`): `$(fn, flags)`, plus host options
  `_$statusFree` (SYNC+NOTHROW) or `_$syncOnly` (SYNC only).
- **Runtime** (`@solidjs/signals`):
  - `$(body, flags)` skips the Promise/AsyncIterable result probes under `BLOCK_SYNC`.
  - `syncOnly = { sync: true }` and `statusFree = { sync: true, noThrow: true }` are exported
    from signals and solid-js (client and server).
  - The status-free recompute lives in `core/status-free.ts`, installed as a hook, so apps
    without it pay nothing.
  - Hydration strips the fast path from any node with serialized data
    (`withoutFastPathIfSerialized`).
- **Dev verification and deoptimization:**
  - `[BLOCK_SYNC_VIOLATED]`: a SYNC block returned a Promise, thenable or iterator.
  - `[SYNC_NODE_RECEIVED_ASYNC]`: a sync host node received an async value.
  - `[NOTHROW_NODE_THREW]`: a NOTHROW node threw.
  - In production, a throw inside a status-free node still goes through `notifyStatus` and
    clears `CONFIG_NOTHROW` for that node. A wrong NOTHROW proof costs speed, never behavior.

### Correctness tests

| File                                                       | Covers                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/signals/tests/status-free.test.ts`               | fast path eligibility, thrown errors reach boundaries, deopt on throw, transitions, loading, ownership, dev diagnostics                     |
| `packages/signals/tests/track-a-equivalence.test.ts`       | handwritten, runtime `$`, transformed, optimized and optimized-unfused produce identical values, effect orders and errors (native compiler) |
| `packages/compiler/src/block_proofs.rs` (Rust tests)       | each proof and each refusal: calls, member access, imports, TDZ, `then` keys, typed vs untyped domains                                      |
| `packages/compiler/__tests__/generators/fixtures/proofs-*` | emitted output for status-free and fused forms                                                                                              |

### Sizes (bytes)

Micro bundle: each scenario bundled with the full production runtime.

| Scenario    | handwritten gzip | fused gzip | optimized gzip | optimizedSyncOnly gzip | transformed gzip |
| ----------- | ---------------: | ---------: | -------------: | ---------------------: | ---------------: |
| flags       |            9,563 |      9,568 |          9,942 |                  9,572 |           11,613 |
| typed-arith |            9,569 |      9,577 |          9,953 |                  9,580 |           11,622 |
| objects     |            9,567 |      9,572 |          9,947 |                  9,573 |           11,618 |
| unprovable  |            9,566 |      9,570 |          9,570 |                  9,570 |           11,612 |

The status-free hook module costs **+374 B gzip / +340 B brotli**. `syncOnly` costs 1 to 4 B.

App: `examples/todos-blocks`, a Vite production build.

| Build                          |    raw |   gzip | brotli |
| ------------------------------ | -----: | -----: | -----: |
| `examples/todos` (handwritten) | 84,550 | 30,578 | 27,466 |
| todos-blocks transformed       | 87,926 | 31,786 | 28,475 |
| todos-blocks fused             | 87,853 | 31,765 | 28,488 |
| todos-blocks optimized         | 87,904 | 31,797 | 28,570 |
| todos-blocks optimized unfused | 87,979 | 31,812 | 28,530 |

Proof coverage in todos-blocks: **8 of 14 blocks SYNC, 0 NOTHROW**. Every real block calls
something (`filter`, `trim`, a store read), so the NOTHROW rule never fires.

### CPU: instruction counts (Ir/op, from `stage1-icount.json`)

| Cell               | handwritten | transformed |     fused | optimized (statusFree) | optimizedSyncOnly |
| ------------------ | ----------: | ----------: | --------: | ---------------------: | ----------------: |
| flags/mount        |   1,286,064 |   1,476,353 | 1,214,763 |              1,450,140 |         1,240,947 |
| flags/update       |     445,401 |     522,299 |   445,423 |                494,193 |           434,994 |
| typed-arith/mount  |   1,998,038 |   2,168,994 | 1,966,867 |              2,262,908 |         2,003,661 |
| typed-arith/update |   1,738,693 |   1,971,549 | 1,738,074 |              1,842,599 |         1,705,149 |
| objects/mount      |   1,495,415 |   1,926,780 | 1,429,647 |              1,567,551 |         1,424,505 |
| objects/update     |   1,296,429 |   1,771,504 | 1,296,450 |              1,299,687 |         1,211,033 |
| unprovable/mount   |   1,238,559 |   1,436,775 | 1,279,152 |              1,279,238 |         1,279,221 |
| unprovable/update  |   1,306,452 |   1,373,842 | 1,308,987 |              1,308,890 |         1,308,754 |

Deltas against the fused baseline:

| Cell                       | optimized (statusFree) |         optimizedSyncOnly |
| -------------------------- | ---------------------: | ------------------------: |
| flags mount / update       |        +19.4% / +10.9% | +2.2% (noise) / **−2.3%** |
| typed-arith mount / update |         +15.1% / +6.0% | +1.9% (noise) / **−1.9%** |
| objects mount / update     |          +9.6% / +0.2% |         −0.4% / **−6.6%** |
| unprovable (control)       |          +0.0% / −0.0% |             +0.0% / −0.0% |

Unfused (`stage1-icount-unfused.json`, one run, against `transformed`):

| Cell               | transformed |   optimizedUnfused | optimizedUnfusedSyncOnly |
| ------------------ | ----------: | -----------------: | -----------------------: |
| flags/update       |     532,194 |    563,334 (+5.9%) |          504,674 (−5.2%) |
| typed-arith/update |   1,962,952 |  2,036,902 (+3.8%) |        2,005,269 (+2.2%) |
| objects/update     |   1,771,687 | 1,468,437 (−17.1%) |       1,362,886 (−23.1%) |
| unprovable/update  |   1,365,160 |          1,365,121 |                1,365,148 |

**Negative result.** The separate status-free recompute is slower than the general recompute
it replaces. The general path is already monomorphic and well inlined; a second, hook-installed
recompute adds a dispatch test on every recompute and a polymorphic call site. Erasing the
pending/error channels removed less work than that added.

### Wall time and allocations (`stage1-bench.json`, median µs per op, n = 1000)

| Cell               | handwritten | transformed | fused | optimized | optimizedUnfused |
| ------------------ | ----------: | ----------: | ----: | --------: | ---------------: |
| flags/mount        |         597 |         909 |   589 |       646 |              860 |
| flags/update       |         107 |         160 |   112 |       101 |              123 |
| objects/mount      |         629 |       1,147 |   670 |       641 |            1,006 |
| objects/update     |         451 |         846 |   441 |       398 |              486 |
| typed-arith/mount  |         879 |       1,504 |   841 |       884 |            1,489 |
| typed-arith/update |         613 |         969 |   624 |       614 |              851 |
| unprovable/mount   |         575 |         954 |   547 |       594 |              941 |
| unprovable/update  |         423 |         549 |   410 |       414 |              562 |

With 15% median rep spread, only the transformed vs everything gap (+50 to +90%) and the
unfused gaps are real. Fused, optimized and handwritten are indistinguishable by wall time.

| Cell (bytes/op)    | handwritten | transformed |     fused | optimized | optimizedUnfused |
| ------------------ | ----------: | ----------: | --------: | --------: | ---------------: |
| flags/update       |         760 |     112,984 |       760 |       760 |           32,824 |
| objects/update     |     129,920 |     963,608 |   129,920 |   129,920 |          193,920 |
| typed-arith/update |     121,136 |     457,168 |   121,136 |   121,136 |          217,136 |
| unprovable/update  |      81,944 |     305,952 |    81,944 |    81,944 |          305,952 |
| flags/mount        |   1,060,808 |   1,942,224 | 1,076,952 | 1,075,784 |        1,781,856 |
| objects/mount      |   1,228,840 |   2,719,184 | 1,243,152 | 1,243,120 |        1,949,256 |

When fusion is off, the proofs cut update allocation by 71% (flags), 80% (objects) and 53%
(typed-arith), because skipping probes avoids the per-run result wrappers. Fused code already
matches handwritten allocation, so the proofs add nothing there.

### Stage 1 verdict: ITERATE

- **KEEP:** `BLOCK_SYNC` and `syncOnly`. Update CPU is 1.9 to 6.6% lower than fused and 5 to
  23% lower than unfused. Allocation is lower unfused. Size is flat. The control is unchanged.
- **REJECT (as built):** the status-free recompute and NOTHROW erasure. They are +6 to +11%
  slower on update, +374 B gzip, and fire on 0 of 14 real blocks.
- **Next iteration:** fold channel erasure into the general recompute as a branch on an
  existing flag, rather than a separate function. Widen NOTHROW only with typed method
  summaries (for example `string.trim` on a proven string). Re-measure before re-enabling
  `statusFree` emission.

## Stage 2: async-free reactive core

### What was built

1. **Async-free runtime tree.** A new `__ASYNC__` build constant (`true` in every existing
   build) gates the async machinery in the core:
   - `core.ts`: `recompute`, `read`, `readNodeFast`, `setSignal`, `updateIfNecessary`.
   - `async.ts`: `notifyStatus`, `clearStatus`.
   - `scheduler.ts`: transitions (`initTransition`), pending registration, lane assignment,
     lane cleanup, the flush transition arm.
   - `effect.ts` (`runEffect`) and `store/next/projection.ts`.

   `rollup.config.js` builds a third tree, `dist/sync`, with `__ASYNC__ = false`, plus
   `dist/sync.dev.js`. The entry is `src/index.sync.ts`, exported as `@solidjs/signals/sync`:
   - Every export of the full entry is present.
   - The async capabilities are stubs that throw `[ASYNC_CAPABILITY_EXCLUDED]`: `action`,
     `isPending`, `latest`, `resolve`, `until`, `refresh`, `affects`, `createOptimistic`,
     `createOptimisticStore`, `createLoadingBoundary`, `createRevealOrder`, `wait`, `loading`.
   - `enforceLoadingBoundary` becomes a no-op.

   The sync tree is built with `treeshake.tryCatchDeoptimization: false`. Otherwise Rollup
   keeps everything referenced inside a `try` block (rollup#2883).

2. **Dev verification.** In `sync.dev.js`, a compute that produces a Promise or AsyncIterable
   raises `[ASYNC_IN_SYNC_GRAPH]` instead of silently treating it as a value.
3. **Capability manifests.** `capabilities.json` ships in `@solidjs/signals`, `solid-js` and
   `@solidjs/web`:
   - `asyncExports`: the async capability exports.
   - `hosts`: the reactive hosts.
   - `componentComputeProps`: the component props that feed an internal computation
     (`Show.when`, `Match.when`, `For.each`, `Repeat.count`/`from`, `Dynamic.component`).
4. **Compiler summaries.** `summarizeCapabilities(source, { filename })`
   (`packages/compiler/src/capabilities.rs`) reports per module:
   - import, re-export and dynamic-import edges;
   - every host compute with its local proof (`sync`, `async` or `unproven`);
   - every prop passed to a library component, with its local proof.

   Positions are UTF-16 offsets.

5. **Typed summaries.** `solid-tsc --capabilities <file>` asks TypeScript whether each compute's
   result type and each checked prop's type can be a Promise or AsyncIterable. It writes
   verdicts only for an error-free program.
6. **Capability linker** (`@solidjs/compiler/capabilities`, a Vite plugin):
   - In `buildStart`, before any module loads, it walks the graph from the build input through
     the bundler's own resolver.
   - It joins compiler summaries, typed summaries and manifests. Only a graph with zero reasons
     aliases `@solidjs/signals` to `@solidjs/signals/sync`.
   - Client and SSR builds are proven independently.
   - It writes a report with every reason.

### Proven: when the linker selects the async-free entry

A graph is async-free only when all of these hold:

| Requirement                                                                                   | Else (full runtime kept, reason recorded)                                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Every module is an app module the compiler summarized, a library with a manifest, or an asset | `` `pkg` has no capability manifest ``, `unresolved import`                           |
| No module imports an async capability by name                                                 | `imports async capability X from pkg`                                                 |
| No namespace import of a library that has async exports                                       | `namespace import of pkg`                                                             |
| Every host compute is proven sync locally, or has a typed `sync` verdict at its position      | `compute is async (…)`, `not proven synchronous … no typed summary`, `typed: unknown` |
| Every manifest-listed component prop is proven sync the same way                              | `<For each> not proven synchronous`                                                   |
| Every dynamic import has a literal specifier (which is then followed)                         | `unclassified dynamic import (non-literal)`                                           |

Local compute proofs are: a `$` block proven `BLOCK_SYNC`, a plain function whose every
returned expression is proven plain, or an identifier bound to one of those. `async` functions
and blocks that `wait` are `async`. Everything else is `unproven` and needs the typed summary.

### Retained fallbacks

- Any reason keeps the full runtime for that graph. The decision is per graph, never per module.
- No linker (`SOLID_CAPABILITIES=0`, a non-Vite bundler, or dev server) keeps the full runtime.
- In the sync tree, `handleAsync`'s synchronous path, `NotReadyError` (thrown by user code),
  error boundaries, ownership, cleanup and effect ordering are unchanged.
- `generator.js` keeps its result-shape probes (4,300 B in both trees). `$` blocks that are
  not proven SYNC still probe.
- The solid-js server `processResult` and all `@solidjs/web` SSR, streaming and hydration code
  are unchanged. Only the signals runtime is swapped.

### Correctness tests

| Test                                                                                                                                                     | Result                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Differential (`stage2-differential.json`): the whole signals suite under the async census, then the synchronous subset compiled with `__ASYNC__ = false` | **881 / 881** sync tests pass. Full suite under sync: 820 sync passed, 61 sync failed only by cascade from async tests in the same file, 869 async tests failed as expected, 78 async tests passed anyway. 0 regressions, 0 unmatched. |
| `packages/signals/tests/sync-entry.test.ts`                                                                                                              | same exports as the full entry; stubs match the manifest exactly; every other export is identical                                                                                                                                      |
| `packages/signals/tests/treeshake.test.ts`                                                                                                               | async-free floor ceiling 14,700 B (measured 13,928) with no async markers; full floor unchanged                                                                                                                                        |
| `packages/compiler/__tests__/capabilities.test.js` (11)                                                                                                  | summary edges and positions; each refusal reason; typed verdict join; dynamic imports; namespace imports; missing manifests                                                                                                            |
| `packages/typecheck/tests/solid-tsc.test.js` (2 new)                                                                                                     | typed verdicts for computes and props; no summary for a program with errors                                                                                                                                                            |
| `examples/sync-blocks/tests/app.test.tsx`                                                                                                                | the same user flows pass on the linked runtime (default) and the full runtime (`SOLID_CAPABILITIES=0`); the first test pins which runtime was selected                                                                                 |

### Sizes (`stage2.json`)

Runtime floor: the core primitives (`createSignal`, `createMemo`, `createEffect`,
`createRenderEffect`, `createRoot`, `flush`, `createStore`, `createErrorBoundary`) bundled with
esbuild and minified.

| Runtime                  |             raw |            gzip |          brotli | modules |
| ------------------------ | --------------: | --------------: | --------------: | ------: |
| full (`dist/prod`)       |          54,482 |          19,886 |          17,975 |      20 |
| async-free (`dist/sync`) | 45,212 (−17.0%) | 16,527 (−16.9%) | 14,958 (−16.8%) |      20 |

The smallest floor (signal, memo, effect, root, flush), measured by `treeshake.test.ts`:
22,945 → 13,928 B minified (−39%).

Largest per-module reductions: `core/async.js` 4,404 → 724, `core/scheduler.js` 6,775 → 4,399,
`core/core.js` 7,175 → 5,290, `core/lanes.js` 772 → 42. The same modules are retained. They
shrink but do not disappear, because the stubs, boundaries and store keep references into them.

`examples/sync-blocks`: Vite production build with `hostFusion` and `blockProofs`.

| Build                       |             raw |            gzip |          brotli | modules | signals modules |
| --------------------------- | --------------: | --------------: | --------------: | ------: | --------------: |
| client, full runtime        |          71,931 |          26,260 |          23,679 |      25 |              21 |
| client, linker (async-free) | 62,976 (−12.4%) | 23,033 (−12.3%) | 20,756 (−12.3%) |      25 |              21 |
| server, full runtime        |          96,711 |          23,417 |          20,733 |      14 |              11 |
| server, linker (async-free) | 76,664 (−20.7%) | 19,171 (−18.1%) | 16,967 (−18.2%) |      14 |              11 |

Server bundles are not minified. The retained module graph is identical by module (21 client
and 11 server signals modules); every module is smaller.

### Linker decisions and cost

| App                            | async-free | modules | computes (local / typed) | proof ms (median of 7) | first reason                                     |
| ------------------------------ | ---------- | ------: | ------------------------ | ---------------------: | ------------------------------------------------ |
| `examples/todos` (handwritten) | no         |       5 | 1 (0 / 0)                |                   1.96 | imports async capability `Loading` from solid-js |
| `examples/todos-blocks`        | no         |       5 | 5 (1 / 0)                |                   1.69 | imports async capability `Loading` from solid-js |
| `examples/sync-blocks`         | **yes**    |       2 | 5 (3 / 2)                |                   0.56 | none                                             |

Both negative controls are correct refusals: the todos apps use `Loading`. Two of the five
sync-blocks computes (both `readStore(state, s => s.items.filter(…))`) needed the typed summary. Linker time
is under 2 ms. Vite build time moved from 1,169 to 1,347 ms (client), inside the run-to-run
noise of a single build.

### CPU: instruction counts

Same four scenarios, run against the full runtime (`stage2-icount-full.json`) and the
async-free runtime (`stage2-icount-sync.json`) at the same commit. Δ is sync vs full for the
same variant.

| Cell               | handwritten full | handwritten sync |          Δ | fused full | fused sync |          Δ | syncOnly full | syncOnly sync |      Δ |
| ------------------ | ---------------: | ---------------: | ---------: | ---------: | ---------: | ---------: | ------------: | ------------: | -----: |
| flags/mount        |        1,229,186 |        1,193,898 |      −2.9% |  1,214,747 |  1,179,365 |      −2.9% |     1,240,963 |     1,223,389 |  −1.4% |
| flags/update       |          445,348 |          390,866 | **−12.2%** |    445,445 |    390,886 | **−12.2%** |       434,970 |       390,704 | −10.2% |
| typed-arith/mount  |        1,918,987 |        1,785,173 |      −7.0% |  1,903,750 |  1,818,421 |      −4.5% |     1,940,486 |     1,882,381 |  −3.0% |
| typed-arith/update |        1,738,028 |        1,523,871 | **−12.3%** |  1,738,076 |  1,523,515 | **−12.3%** |     1,705,098 |     1,523,595 | −10.6% |
| objects/mount      |        1,476,378 |        1,285,236 |     −12.9% |  1,447,008 |  1,271,710 |     −12.1% |     1,395,505 |     1,315,756 |  −5.7% |
| objects/update     |        1,296,499 |        1,101,149 | **−15.1%** |  1,296,419 |  1,101,215 | **−15.1%** |     1,210,607 |     1,100,919 |  −9.1% |
| unprovable/mount   |        1,238,603 |        1,205,672 |      −2.7% |  1,279,219 |  1,220,370 |      −4.6% |     1,279,237 |     1,220,337 |  −4.6% |
| unprovable/update  |        1,309,000 |        1,063,427 | **−18.8%** |  1,309,510 |  1,063,493 | **−18.8%** |     1,309,575 |     1,063,501 | −18.8% |

- The async-free core removes 12 to 19% of update instructions and 3 to 13% of mount
  instructions. Handwritten Solid gets the same gain as fused `$` code: the saving is in the
  core, not in block code.
- The full runtime did not regress from the `__ASYNC__` gates. Stage 1 measured
  `unprovable/update/handwritten` at 1,306,452; Stage 2 full measured 1,309,000 (+0.2%). The
  full floor still passes the Stage 1 treeshake ceiling.
- **Negative result: `syncOnly` and the async-free core do not compound.**

  | Cell                       | syncOnly vs fused (full) | syncOnly vs fused (sync) | unfused syncOnly vs transformed (full) | unfused syncOnly vs transformed (sync) |
  | -------------------------- | -----------------------: | -----------------------: | -------------------------------------: | -------------------------------------: |
  | flags mount / update       |            +2.2% / −2.4% |            +3.7% / −0.0% |                          −4.3% / −3.4% |                          −0.1% / −2.2% |
  | typed-arith mount / update |            +1.9% / −1.9% |            +3.5% / +0.0% |                          +0.1% / −2.9% |                          +5.7% / −4.1% |
  | objects mount / update     |            −3.6% / −6.6% |            +3.5% / −0.0% |                        −19.0% / −23.1% |                         −8.3% / −20.7% |
  | unprovable mount / update  |            +0.0% / +0.0% |            −0.0% / +0.0% |                          −0.0% / +0.0% |                          −0.0% / −0.0% |

  On the sync runtime, the work `syncOnly` skips (async result handling in `recompute`) is
  already gone, so fused `syncOnly` gains nothing on update and costs +3.5 to +3.7% on mount
  (the extra options object per host). Unfused `syncOnly` still helps, because it also skips
  the `$` wrapper's result probes, which the sync runtime keeps (`generator.js` is unchanged).
  The compiler should emit `syncOnly` only when the graph keeps the full runtime; that
  requires the linker decision to reach the compiler (remaining work 7).

- The contaminated first full run is discarded. It shared a module directory with the
  concurrent sync run, so late cells loaded the sync runtime. `icount.mjs` and `bench.mjs` now
  use one module directory per runtime.

### Wall time and allocations

`stage2-bench-full.json` and `stage2-bench-sync.json`: median µs per op (n = 1000) and bytes
per op. The two runtimes ran as two separate invocations, one after the other, so Δ is not
paired. Rep spread was 2.6% minimum, 22.0% median and 66.2% maximum.

| Cell               | handwritten full | handwritten sync |      Δ | fused full | fused sync |      Δ |
| ------------------ | ---------------: | ---------------: | -----: | ---------: | ---------: | -----: |
| flags/mount        |              639 |              531 | −16.8% |        723 |        604 | −16.4% |
| flags/update       |              108 |               91 | −16.2% |        108 |         89 | −17.5% |
| typed-arith/mount  |            1,021 |              831 | −18.6% |        963 |        785 | −18.5% |
| typed-arith/update |              666 |              617 |  −7.3% |        664 |        596 | −10.2% |
| objects/mount      |              713 |              610 | −14.4% |        743 |        607 | −18.3% |
| objects/update     |              448 |              361 | −19.4% |        465 |        354 | −23.8% |
| unprovable/mount   |              582 |              582 |  −0.1% |        587 |        538 |  −8.3% |
| unprovable/update  |              419 |              333 | −20.5% |        430 |        342 | −20.4% |

Wall time agrees in direction with the instruction counts, but the magnitudes carry the noise
above. Use the instruction counts for size of effect.

**Allocation is unchanged.** Every update cell allocates the same bytes/op on both runtimes
(760, 121,136, 129,920 and 81,944), and mount cells differ by under 0.2%. The async-free
core removes branches and code, not per-node objects: pending and error state already
lives in the lazily allocated `_x` extension, which synchronous graphs never create.

### Stage 2 verdict: KEEP (experimental)

The whole-graph proof works end to end on a real app, on both graphs, with TypeScript summaries
and a bundler hook rather than a flag. It cuts 12 to 18% of app gzip and 12 to 19% of update
instructions, and it refuses every graph that touches async. The full runtime is unchanged in
size and CPU. Keep it behind the linker. It should not ship until the remaining work below
is done.

### Remaining slice-4 work

1. **Coverage.** Any use of `Loading` refuses today, and most real apps use it. The next step
   is per-boundary proof: a `Loading` whose children are proven sync never shows a fallback.
2. **Generated library summaries.** Manifests are hand-written and trusted. They should be
   generated from the library's own compiler summaries at publish time and checked in CI
   against its exports.
3. **Deeper erasure.** `generator.js` result probes, `boundaries.js` loading paths, store
   optimistic and projection async paths, and `@solidjs/web` SSR, streaming and hydration
   adapters are still full in the sync graph. Slice 7 (capability-selected hydration runtime)
   owns the web side.
4. **Other bundlers.** The linker is a Vite plugin. Rollup works through the same hooks but is
   untested; webpack and esbuild need adapters.
5. **Typed precision.** Unannotated helpers imported from other app modules stay `unproven`
   unless `solid-tsc` runs. Cross-module local proofs (following an imported function's summary)
   are not implemented.
6. **Dev server.** The linker only runs for builds and Vitest. `vite dev` always uses the full
   runtime, so dev and prod select different runtimes. The dev-verifier build (`sync.dev.js`)
   exists but is not selected in dev.
7. **Compiler feedback.** The linker decides after the compiler has emitted `syncOnly`. In a
   graph that gets the sync runtime, fused `syncOnly` only adds mount cost. The decision
   should flow back so the compiler drops it there.

## Compiler overhead (`compiler-cost.json`)

Median µs per transform. Emitted bytes are shown for the full example files.

| File                                 | unfused |  fused | fused + proofs | unfused + proofs | summarizeCapabilities |
| ------------------------------------ | ------: | -----: | -------------: | ---------------: | --------------------: |
| todos-blocks/src/app.tsx (µs)        |     698 |    803 |            784 |              623 |                   142 |
| todos-blocks/src/app.tsx (emitted B) |  10,461 | 10,376 |         10,433 |           10,521 |                       |
| sync-blocks/src/app.tsx (µs)         |     294 |    374 |            395 |              291 |                    62 |
| sync-blocks/src/app.tsx (emitted B)  |   5,038 |  4,938 |          5,051 |            5,160 |                       |

The block proofs add no transform time that exceeds noise (−11% to +6%; the p10 to p90 range
of each cell is wider than that). They add 57 to 122 B
of emitted source per file for flags and host options. The capability summary is a separate
parse costing about 20% of one transform per module.

## Limitations

- One shared cloud VM. Wall-time numbers carry 15% median rep spread. Instruction counts
  exclude cache and branch effects.
- Micro scenarios are synthetic. They are sized to isolate the recompute path, not app
  behavior.
- Stage 1 unfused counts used a stage-1 runtime snapshot
  (`node_modules/.cache/track-a/runtime-stage1`), so they compare within that file only.
- The linker trusts library manifests. A wrong manifest is unsound; that is why they must be
  generated (remaining work 2).
- Typed verdicts are only as sound as the program's types. A cast such as `as any` gives
  `unknown`, which is refused. A cast to a wrong non-`any` type is trusted. In the sync dev
  build, `[ASYNC_IN_SYNC_GRAPH]` catches such a value at runtime.
