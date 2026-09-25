# Optimization Slice 7: Capability-Selected Hydration Runtime (Track E)

Status: implemented and measured on branch `track-e/slice-7-capability-hydration`
(base `experiment/iterable-signals` @ `1fc0b873`). Decision: **ITERATE**. Keep the
runtime split, the manifest consumer, and the matrix; the universal path's size
regression needs another pass before this ships as the default. See
[Decision](#decision).

This slice specializes only the **browser SSR hydration/bootstrap layer**. It
does not remove the reactive core's async, pending, error, loading, or store
implementations. That is slice 4, the async-free core. Where a capability's cost
includes core code, the numbers below say so. Out of scope and not implemented:
the async-free core, inert regions, server replay elimination, cold event
chunking, and resumability.

## What Changed

### Runtime: hydration as independent capabilities

`packages/solid/src/client/hydration.ts` is now the public primitive wrappers plus
the capability switch. Each hydration protocol lives in its own module and is
reachable only through its installer:

| capability (manifest key) | solid-js installer / module | @solidjs/web DOM half | what it adopts |
|---|---|---|---|
| `snapshots` | `installSnapshotHydration`, `hydration/snapshots.ts` | none | Snapshot capture around hydration passes and boundary resumes (setup only; the core's snapshot read paths stay) |
| `asyncResults` | `installAsyncResultHydration`, `hydration/async-results.ts` | none | Serialized async results (promises, async-iterable replay, live takeover) for createMemo, computed createSignal/createOptimistic, and effects |
| `ssrSources` `["client"]` | `installSsrClientHydration`, `hydration/ssr-sources.ts` | none | `ssrSource: "client"` pre-hydration gate (signal, store, effect) |
| `ssrSources` `["hybrid"]` | `installSsrHybridHydration`, `hydration/ssr-sources.ts` | none | `ssrSource: "hybrid"` adopt-then-take-over |
| `storeAdapters` | `installStoreHydration`, `hydration/stores.ts` | none | Derived store/projection/optimistic-store snapshot and patch replay, sync adoption |
| `errorMarkers` | `installErrorMarkerHydration`, `hydration/boundaries.ts` | none | Serialized `<Errored>` error re-thrown on the first pass |
| `loadingMarkers` | `installLoadingMarkerHydration`, `hydration/boundaries.ts` | `loadingMarkerHydration` (per-root boundary scope capture, #2917) | `$$f`, settled/pending boundary refs, deferred resume |
| `streamLedger` | `installStreamLedgerHydration`, `hydration/stream-ledger.ts` | `streamLedgerHydration` (fragment cleanup, claim-runtime region reclaim) | `<id>_fr` fragments, `$df` reveal policy (`_$HY.f`/`_$HY.fr`), truncation |
| `lazyAssets` | `installLazyAssetHydration`, `hydration/lazy-assets.ts` | `lazyAssetHydration` (module loader, root `_assets` preload) | Boundary/root module maps, lazy()'s synchronous lookup |
| `delegatedEvents` | none | `eventReplayHydration` (replay loop, live-event dedupe) | Pre-hydration events captured by the bootstrap |
| `resumableEvents` | reserved (slice 8) | reserved | none yet |

Shared, installer-free modules: `state.ts` (sharedConfig, slots, hydration phase),
`dispatch.ts` (signal and effect dispatch), `serialized.ts` (serialized-value
helpers shared by asyncResults, storeAdapters, and hybrid), `drafts.ts` (store
drafts), and `guards.ts` (dev assertions).

- **Wrappers** keep their pre-refactor shape. For example
  `createMemo = (...a) => (slots.memo || coreMemo)(...a)`. An empty slot means the
  plain core path.
- **`enableHydration()`** is the universal switch and installs every capability.
- **`enableHydrationWith(installers)`** installs a subset.
- **`@solidjs/web` `hydrate()`** is now `hydrateRoot(ALL_HYDRATION_CAPABILITIES)`.
  Each DOM half runs at the exact prologue position the old `hydrate()` used.
- **`createHydrator(capabilities, delegatedEvents)`** is the manifest-composed
  entry point.
- **`runHydrationEvents`** is emitted unconditionally by compiled hydratable
  output, so its replay loop moved behind a slot.
- **Store adapters** are installed by the store capability, not unconditionally
  by the universal switch. The universal switch still installs them, because a
  manifest-less `hydrate()` cannot know whether the page carries store records.
  Plain `createStore(value)` never needs them.
- **Server graph separation:** the solid-js server entry exports inert installer
  stubs. The web server entry exports `createHydrator` (it constructs fine and
  throws only if called) plus `notSup` DOM capabilities. A generated client entry
  imported by an isomorphic module never throws at import and never pulls client
  hydration into the server bundle.

### Development assertions for violated manifests

In development builds, `enableHydrationWith` fills every omitted capability's slot
with a guard. The guard runs where the real adapter would have run and throws
`[HYDRATION_MANIFEST] The client hydration manifest omits "<capability>", but
<what the page delivered>`. The web half adds DOM-level checks:

- the bootstrap captured events but replay is omitted;
- the client registers a delegated event type the manifest does not list;
- `_fr` records exist without the stream ledger;
- `_assets` records exist without lazy assets.

`snapshots` is asserted at install time. Production builds contain none of this:
the rollup dist folds it out, and the retained-graph spec asserts that.

### Manifest: narrow, generated, consumer isolated from producer

`@solidjs/web/hydration-manifest` is a build-time, node-safe subpath and the
consumer side:

- **`schema.ts`:** schema v1. All ten capability keys are required: booleans plus
  the sorted, unique `delegatedEvents` and `ssrSources`. It also defines the
  `HydrationManifestProducer` contract.
- **`validate.ts`:** exact keys and types, sorted and unique lists. It enforces the
  dependency rules:
  - `streamLedger` requires `loadingMarkers`.
  - `snapshots` is required by any of `asyncResults`, `storeAdapters`,
    `loadingMarkers`, or `ssrSources`.
  - `resumableEvents` requires a registered consumer.
- **`compose.ts`:**
  - `composeHydrationEntry(manifest)` produces deterministic client entry source.
  - `composeServerHydrationOptions(manifest)` returns the `{ eventNames }` for
    `generateHydrationScript` / `<HydrationScript>`.
  - `resolveHydrationInstallers(manifest)` returns the consumption table, in the
    universal `hydrate()` order.
  - `serializeHydrationManifest(manifest)` produces canonical JSON.

Example output for the sync fixture:

```js
// @generated by @solidjs/web/hydration-manifest composeHydrationEntry. Do not edit.
// graph: "sync"  producer: "fixture:sync"  schema: 1
// capabilities: delegatedEvents[click]
import { createHydrator, eventReplayHydration } from "@solidjs/web";
export const hydrate = /* @__PURE__ */ createHydrator([eventReplayHydration], ["click"]);
```

Production is isolated. Manifests come from checked-in fixtures read by
`packages/web/test/hydration-capabilities/fixture-producer.ts`, a
`HydrationManifestProducer<string>`. The consumer and the runtime never import
it; `hydration-manifest.spec.ts` asserts both directions. Track C's linker replaces
the fixture producer by implementing the same contract; nothing on the consumer
side changes. There is no end-user feature-selection API: `createHydrator` and the
installers are `@internal`, and only generated entries call them.

## Capability Matrix

Six fixture graphs live in `packages/web/test/harness/capability-apps/`, one module
per graph so each registers exactly its own delegated events:

- **sync/no-store:** signals, memo, Show/For, click.
- **store:** plain store, projection, and an async derived store.
- **async:** a top-level async memo and a serialized `<Errored>` error.
- **streaming:** a `<Loading>` whose data streams after the shell; the streamed
  content stays reactive.
- **lazy:** a root `lazy()`.
- **full:** all of the above plus `input` events and ssrSource `client` and
  `hybrid`.

Each graph has a positive fixture manifest. The server harness checks every record
kind the server emitted against the manifest: `_fr` needs streamLedger, `_assets`
needs lazyAssets, and plain ids need an adopting capability.

| manifest | graph | dev (`vite.config.hydrate.mjs`) | prod artifacts (`vite.config.hydrate-prod.mjs`) |
|---|---|---|---|
| sync, store, async, streaming, lazy, full | their own graph | hydrates identically to universal | same |
| full | sync, store, async, lazy | hydrates identically | same |
| violation-sync-no-delegated-events | sync | asserts `delegatedEvents` | skipped (dev only) |
| violation-store-no-store-adapters | store | asserts `storeAdapters` | skipped |
| violation-async-no-async-results | async | asserts `asyncResults` | skipped |
| violation-async-no-error-markers | async | asserts `errorMarkers` | skipped |
| violation-streaming-no-stream-ledger | streaming | asserts `streamLedger` | skipped |
| violation-streaming-no-loading-markers | streaming | asserts `streamLedger` (DOM check fires first) | skipped |
| violation-lazy-no-lazy-assets | lazy | asserts `lazyAssets` | skipped |
| violation-full-no-ssr-sources | full | asserts `ssrSources` | skipped |
| sync | async | asserts `asyncResults` | diverges (asserted) |
| sync | store, streaming, lazy | not run in dev | diverges (asserted) |
| async | streaming | not run in dev | diverges (asserted) |
| streaming | full | not run in dev | diverges (asserted) |
| invalid-* (6) | none | rejected by the validator with a specific error | none |

"Hydrates identically" is checked against the universal runtime on the same
artifact. It covers:

- no errors or warnings;
- identical settled `innerHTML`;
- an identical set of server elements lost and client elements created;
- claimed-node identity;
- pre-hydration click replay (sync and full);
- identical markup after a live delegated click.

The **prod divergence** cases exist because production has no assertions. They
prove the comparison is sensitive. An earlier, weaker check (text plus `_hk`
identity only) let under-approximated manifests pass in prod, because an unclaimed
streamed region looks right but is inert. The fixtures now make streamed content
depend on the live counter.

`hydration-capability-graph.spec.ts` bundles each composed entry with rollup
against source, with production flags. It asserts exactly which
`client/hydration/*` modules and DOM capability functions are retained:

| manifest | retained hydration modules | DOM halves |
|---|---|---|
| sync | state | event replay |
| store | state, snapshots, stores, serialized, drafts | event replay |
| async | state, snapshots, async-results, dispatch, serialized, boundaries | event replay |
| streaming | async plus stream-ledger | stream ledger, loading scopes, event replay |
| lazy | state, lazy-assets | lazy assets, event replay |
| full / universal `hydrate()` | all 11 | all 4 |

Guards are never retained in prod, and are retained in dev. With no delegated
events, the replay loop is gone even though compiled output calls
`runHydrationEvents`.

## Commands

```sh
# toolchain (the container's rustc 1.94 is below the compiler's 1.95 floor)
rustup toolchain install 1.97.1 --profile minimal
(cd packages/compiler && RUSTUP_TOOLCHAIN=1.97.1 pnpm run build:debug)
(cd packages/signals && pnpm run build)
(cd packages/solid && pnpm run build && pnpm run types)
(cd packages/web && pnpm run build && pnpm run types)

# correctness
(cd packages/solid && npx vitest run && pnpm run test-types)
(cd packages/signals && npx vitest run tests/treeshake.test.ts)
(cd packages/web && npx vitest run --config vite.config.server.mjs)      # writes capability artifacts
(cd packages/web && npx vitest run)                                       # manifest + graph specs
(cd packages/web && npx vitest run --config vite.config.hydrate.mjs)      # dev matrix
(cd packages/web && npx vitest run --config vite.config.hydrate-prod.mjs) # prod matrix
(cd packages/web && pnpm run test-types)
SHOW_VIOLATIONS=1 npx vitest run --config vite.config.hydrate.mjs test/hydration/capability-matrix.spec.tsx
UPDATE_CAPABILITY_ENTRIES=1 npx vitest run test/hydration-manifest.spec.ts   # regenerate golden entries

# sizes (esbuild minify, gzip -9, brotli q11), against the built prod dists
node scripts/hydration-capabilities/measure-size.mjs --json scripts/hydration-capabilities/results/size.json
SLICE7_DIST_ROOT=<pre-change dists> node scripts/hydration-capabilities/measure-size.mjs --universal-only
(cd scripts/size && npm ci && npx size-limit --json)                      # the repo's size gate

# startup CPU (playwright-core outside the workspace)
npm i --prefix <dir> playwright-core@1.56.1
BASELINE_DIST=<pre-change dists> PLAYWRIGHT_CORE=<dir>/node_modules/playwright-core \
  node scripts/hydration-capabilities/measure-startup.mjs --runs 40 --json scripts/hydration-capabilities/results/startup.json
```

Pre-change dists are `packages/{solid,web,signals}/dist` built from `1fc0b873`
with the same working tree. Each copy needs a `package.json` with
`"sideEffects": false`. Without it the bundler keeps modules the packages let it
drop. The first baseline attempt made that mistake and was about 9 KB too large.

## Results

Environment: Linux container, 4 vCPU Intel Xeon @ 2.10 GHz, Node 22.22.2,
esbuild 0.27.7, Chromium 141.0.7390.37 (headless), native compiler debug build.
Raw outputs are in `scripts/hydration-capabilities/results/`.

### Correctness

| suite | before | after |
|---|---|---|
| solid (vitest) | 595 passed | 595 passed |
| solid test-types | pass | pass |
| signals treeshake | 6 passed | 6 passed |
| web client (vitest) | 748 passed | 816 passed (+58 manifest, +10 graph) |
| web hydrate (dev) | 168 passed | 193 passed, 6 skipped (prod-only) |
| web hydrate (prod, new) | none | 22 passed, 9 skipped (dev-only) |
| web server | 790 passed, 1 failed | 796 passed, 1 failed (+6 capability harness) |
| web test-types | pass | pass |

The one server failure, in `server-functions-adapter-request.spec.tsx`, fails
identically with every change of this slice stashed. It predates the slice and
has nothing to do with hydration.

### Retained graph sizes (bytes, minified raw / gzip / brotli)

The real client graph is the compiled app plus its hydrate entry, bundled against
the prod dists.

| graph | CSR `render()` | pre-change universal `hydrate()` | universal `hydrate()` | manifest entry | entry vs pre-change (brotli) | entry vs universal (brotli) |
|---|---|---|---|---|---|---|
| sync/no-store | 37965 / 14898 / 13534 | 56198 / 21268 / 19323 | 57682 / 21830 / 19786 | 42085 / 16419 / 14993 | −4330 (−22.4%) | −4793 (−24.2%) |
| store | 66718 / 24672 / 22268 | 84859 / 31070 / 27999 | 86702 / 31676 / 28528 | 75033 / 27735 / 25058 | −2941 (−10.5%) | −3470 (−12.2%) |
| async | 37209 / 14627 / 13281 | 52969 / 20189 / 18321 | 54705 / 20761 / 18851 | 45013 / 17474 / 15906 | −2415 (−13.2%) | −2945 (−15.6%) |
| streaming | 37205 / 14616 / 13264 | 53096 / 20215 / 18351 | 54834 / 20762 / 18884 | 50289 / 19248 / 17507 | −844 (−4.6%) | −1377 (−7.3%) |
| lazy | 34401 / 13521 / 12305 | 52512 / 19971 / 18118 | 54240 / 20547 / 18666 | 40065 / 15604 / 14219 | −3899 (−21.5%) | −4447 (−23.8%) |
| full | 70350 / 26019 / 23482 | 86350 / 31594 / 28468 | 88201 / 32179 / 28988 | 88229 / 32191 / 29018 | +550 (+1.9%) | +30 (+0.1%) |

The sync manifest entry is 1,459 B brotli above CSR. The universal runtime is
6,252 B above CSR.

The repo's size gate (`scripts/size`, esbuild brotli; before is the pre-change
dists, after is this branch):

| scenario | before | after | Δ |
|---|---|---|---|
| signals core floor / +createStore / +isPending | 8526 / 16820 / 10787 | same | 0 |
| app: render + one signal | 11512 | 11525 | +13 |
| app: hydrating (no stores) | 18925 | 19631 | **+706 (+3.7%)** |
| app: hydrating + every store family | 29943 | 30520 | **+577 (+1.9%)** |
| app: CSR / CSR observe / CSR observe + attribution | 14282 / 15696 / 27195 | 14300 / 15726 / 27236 | +18 / +30 / +41 |
| frames: eager client consumer | 11401 | 11372 | −29 |

The gate already fails every scenario except frames on the base branch, before
this slice, because of the typed-block work. Its limits were not bumped here.

### Overlap

The per-capability cost is not additive. The table below gives each capability's
cost measured two ways, in bytes. "Added alone" puts it on the sync graph's
minimal runtime, which is 42,085 / 16,419 / 14,993. "Removed" takes it out of the
full runtime on the same graph, which is 57,704 / 21,837 / 19,847.

| capability | added alone: raw / gzip / brotli | removed from full: raw / gzip / brotli |
|---|---|---|
| snapshots | 614 / 264 / 259 | cannot be removed while others need it |
| asyncResults (+snapshots) | 3653 / 1262 / 1093 | 942 / 300 / 271 |
| storeAdapters (+snapshots) | 3987 / 1463 / 1263 | 1555 / 535 / 447 |
| errorMarkers | 2282 / 895 / 776 | 323 / 119 / 131 |
| loadingMarkers (+snapshots) | 4838 / 1812 / 1638 | with streamLedger: 5382 / 1805 / 1666 |
| streamLedger (+loading, +snapshots) | 8000 / 2861 / 2550 | alone: 3162 / 1038 / 914 |
| lazyAssets | 1465 / 530 / 449 | 1432 / 448 / 440 |
| ssrSources client / hybrid / both (+snapshots) | 1716 / 3720 / 3965 raw; 582 / 1221 / 1288 brotli | both: 847 / 304 / 303 |
| delegatedEvents (replay) | 795 / 290 / 315 | none |

Reading this honestly:

- **Much of an "added alone" number is reactive core, not hydration.** errorMarkers
  alone costs 776 B brotli because it pulls the core error-boundary engine into a
  graph with no `<Errored>`. Its own adoption code is the 131 B removed from full.
  loadingMarkers and streamLedger likewise pull `createLoadingBoundary`. A graph
  that uses those components already pays that core, and this slice does not
  claim it; slice 4 does.
- **The helpers are shared.** Full over minimal costs 4,854 B brotli. The removals
  sum to 3,258 B. The remaining ~1.6 KB (serialized helpers, dispatch, snapshots)
  goes away only when every capability needing it goes. The store-only graph
  still pays `serialized.ts` without `asyncResults`.
- **Some savings are not this slice's.** On the sync graph, most of the
  hydration-specific savings came from the event replay loop, lazy/stream ledger
  code, and store adapters no longer riding the universal switch. The reactive
  core is unchanged: the signals share of each bundle is identical across columns.

### Hydration startup CPU

Method:

- 40 interleaved page loads per variant, in a seeded shuffled order, after one
  warm-up load each.
- Each load is a fresh page with the bundle inlined, so there is no HTTP or V8
  code cache.
- Documents are fully loaded (every chunk applied).
- Metrics:
  - `evalMs` runs from script start to just before `hydrate()`.
  - `hydrateMs` is the synchronous `hydrate()` call.
  - `settleMs` runs from `hydrate()` start to `onHydrationEnd`.
- Four variants: universal, a second identical copy of universal (A/A, the noise
  floor), the manifest entry, and the pre-change universal runtime.
- Full per-sample data is in `results/startup.json`, and every metric and
  quartile is in `results/startup.md`.

1× CPU, medians in ms:

| graph | universal eval / hydrate / settle | selected eval / hydrate / settle | Δ selected−universal | A/A Δ | Δ universal−pre-change |
|---|---|---|---|---|---|
| sync | 2.9 / 4.4 / 8.6 | 2.2 / 3.6 / 8.1 | −0.7 / −0.8 / −0.5 | +0.1 / −0.2 / −0.2 | +0.2 / +0.2 / 0.0 |
| store | 4.9 / 7.5 / 10.8 | 4.1 / 6.8 / 10.2 | −0.8 / −0.7 / −0.6 | −0.1 / −0.4 / +0.2 | +0.4 / +0.6 / +0.4 |
| async | 3.4 / 9.6 / 13.5 | 2.8 / 8.2 / 12.1 | −0.6 / −1.4 / −1.4 | −0.1 / −0.1 / −0.3 | +0.3 / +0.6 / +0.7 |
| streaming | 3.1 / 4.1 / 7.1 | 3.0 / 4.0 / 6.9 | −0.1 / −0.1 / −0.2 | +0.1 / 0.0 / −0.2 | 0.0 / +0.1 / 0.0 |
| lazy | 3.2 / 3.1 / 6.8 | 2.5 / 2.7 / 6.3 | −0.7 / −0.4 / −0.5 | 0.0 / +0.1 / 0.0 | +0.1 / +0.1 / +0.2 |
| full | 4.8 / 16.4 / 21.9 | 4.8 / 16.6 / 22.0 | 0.0 / +0.2 / +0.1 | 0.0 / +0.1 / −0.1 | +0.2 / +0.6 / +0.7 |

4× CPU throttling, medians in ms:

| graph | Δ selected−universal eval / hydrate / settle | A/A Δ | Δ universal−pre-change |
|---|---|---|---|
| sync | −3.7 / −2.7 / −3.7 | −0.6 / −0.7 / −1.6 | +1.6 / +1.3 / +1.8 |
| store | −3.3 / −0.7 / −2.1 | −0.2 / −1.7 / −1.1 | +1.8 / +1.6 / +2.1 |
| async | −2.0 / −3.6 / −4.3 | +0.1 / +1.3 / +1.8 | +0.4 / +0.5 / +0.9 |
| streaming | −0.7 / −0.7 / −0.5 | +0.2 / +1.0 / +1.7 | +0.6 / +1.3 / +1.0 |
| lazy | −4.0 / −2.9 / −3.1 | −0.6 / −0.6 / −0.7 | +1.0 / +1.2 / +0.1 |
| full | −1.0 / +0.7 / −0.4 | −0.8 / +1.6 / +3.3 | +0.6 / −2.6 / −3.0 |

What the numbers support:

- **Noise floor.** At 1×, the A/A differences are 0.0–0.4 ms. At 4× they are
  0.1–3.3 ms. Timer resolution is 0.1 ms.
- **Selected entries are faster on the four biggest-saving graphs.** For sync,
  store, async, and lazy, the selected entry cuts 0.4–1.4 ms at 1× and
  2.0–4.3 ms at 4× on evaluation and hydrate, above the A/A noise. Most of the
  gain is in `evalMs`, meaning less code to parse and initialize. The async
  graph's hydrate gain (−1.4 ms at 1×) is also real: under the async manifest
  the synchronous memos skip the adapter dispatch.
- **Streaming and full show no measurable difference.** Streaming keeps nearly
  everything. Full keeps everything, by construction.
- **The universal path is slightly slower than before.** At 1× the change is
  0.0–0.7 ms, most values at or just above the A/A floor. At 4× it is mixed
  (+2.1 to −3.0 ms) and inside noise. That matches the byte growth. It is not
  claimed as significant beyond "≤ ~0.7 ms at 1×".

## Limitations

- **The universal path regressed.** Apps still on `@solidjs/web`'s `hydrate()`
  pay +706 B brotli on the size gate's hydrating scenario (+3.7%) and +577 B with
  stores, plus up to ~0.7 ms of startup at 1× (near the noise floor). That is the cost of making each protocol a separately reachable module:
  slot property accesses that minifiers do not rename, small phase accessors,
  installer functions, and the snapshot hooks object. Wrapper golfing already
  brought the CSR cost down to +13..+41 B. Until a linker produces manifests for
  real apps, most users pay this and get nothing back.
- **Fixture manifests are hand-authored.** The server harness checks that each
  covers the records its graph emits. Minimality is shown only by the violation
  and divergence cases, not proven. A real app needs the Track C producer.
- **Record-based guards cannot see everything.** A synchronous ssrSource-less
  derived store and an unused capability are both invisible. Over-approximation is
  always safe; under-approximation is caught only where the page actually delivers
  something.
- **Delegated-event checks happen at hydrate time.** Types registered later by
  lazily loaded modules are not checked.
- **Startup benchmark limits:**
  - Lazy modules are pre-seeded into `_$HY.modules` identically for every variant,
    so no network is involved.
  - Pages are fully loaded, with no live streaming.
  - `performance.now()` is coarsened to 0.1 ms without cross-origin isolation.
- **The size gate is not reconciled.** It was already failing on the base branch.
- **resumableEvents is only reserved.** It has a schema slot and a consumer hook,
  but no runtime.

## Decision

**ITERATE.**

- **KEEP** the runtime split into capability installers, the manifest schema,
  validator, and composer, producer/consumer isolation, the dev assertions, the
  store-adapter move, and the dev plus prod capability matrix. Selected entries
  hydrate identically to the universal runtime on every fixture graph and cut
  retained client JavaScript by 4.6–22.4% brotli against the pre-change runtime,
  and 7–24% against the new universal runtime, for every graph except full.
  Hydration startup also drops by 0.4–1.4 ms at 1× and 2–4 ms at 4× on the sync,
  store, async, and lazy graphs.
- **ITERATE** on the universal path's +577..+706 B brotli before this becomes the
  default. Options:
  1. Have Track C produce a manifest for every app, so nobody runs the universal
     path.
  2. Make slot keys minifier-mangleable (`_`-prefixed plus the size gate's
     `mangleProps`), or turn slots back into module-level bindings with setters.
  3. Fold the phase accessors into the state module's call sites.
- **REJECT** nothing in this slice. The async-free core (slice 4) remains the lever
  for the reactive code these capabilities keep reaching.

## Blockers

- **No real manifest producer yet.** The Track C linker does not exist, so real
  apps cannot get manifests; only fixtures do.
- **Toolchain gap.** The container's rustc (1.94) is below the compiler's floor
  (1.95), so `pnpm build` at the root fails on `@solidjs/compiler`. Worked around
  with a 1.97.1 toolchain and a debug build.
- **Pre-existing failures.** One server-functions test failure and the failing size
  gate on the base branch (see above).

## Changed Files

Runtime commit:

- `packages/solid/src/client/hydration.ts` (wrappers and switch)
- `packages/solid/src/client/hydration/` (new capability modules)
- `packages/solid/src/client/component.ts` (lazy() slot)
- `packages/solid/src/index.ts` (installer exports)
- `packages/solid/src/server/component.ts` (server stubs)
- `packages/web/src/client.ts` (hydrateRoot, DOM capabilities, createHydrator,
  claim runtime, replay slot)
- `packages/web/src/server.ts` (server stubs)

Selection commit:

- `packages/web/hydration-manifest/` (schema, validate, compose, package plumbing)
- `packages/web/package.json`, `packages/web/rollup.config.js`
- `packages/web/vite.config.hydrate-prod.mjs`
- `packages/web/test/harness/capability-apps*` plus `__capability_artifacts__/`
- `packages/web/test/hydration-capabilities/` (fixture producer, matrix, manifests,
  golden entries)
- `packages/web/test/{hydration-manifest,hydration-capability-graph}.spec.ts`
- `packages/web/test/hydration/capability-matrix.spec.tsx`
- `packages/web/test/server/capability-harness.spec.tsx`
- `.prettierignore` (golden entries and canonical manifests stay byte-exact)

Measurement commit:

- the wrapper-shape size pass in `packages/solid/src/client/hydration*`
- `scripts/hydration-capabilities/{bundle,measure-size,measure-startup}.mjs`
- `scripts/hydration-capabilities/results/*`
- this document

Unrelated uncommitted work that was present on the base branch is untouched and
not committed: the typed-generator plan edits, host fusion, compiler fixtures,
signals `readValue`, and the todos-blocks config.
