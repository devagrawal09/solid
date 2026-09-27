# Proxy-Free Stores on Tier 2: js-framework-benchmark

Status as of 2026-09-27. This page checks, at application level on Tier 2, what the compiler's experimental `storeHandles` option (Track B slice 2 stage 2, [`../../track-b-slice-2-proxy-free-stores.md`](../../track-b-slice-2-proxy-free-stores.md)) buys a list app. It also checks what a handle-aware `<For>` would add, and how both compare with rows built from per-field signals (S2). The setup is the same as [`../jfb/README.md`](../jfb/README.md): JFB `f2df01a8`, JFB's own runner (`webdriver-ts --runner playwright --headless`), Chromium 141.0.7390.37, and the frozen runtime snapshot of this repo's dists. This time `--count 40` was used (`04_select1k`: 50), with two independent runs, the second in reversed framework order.

## Short Answer

- **(a) `storeHandles` as it exists does nothing measurable for a list app.**
  - `store-handles` vs `store-strict` (the same source, with and without the option): every benchmark is noise, the largest being −7% to +7%.
  - The compiler makes the root store a handle, but the only lowered root read is `state.data`. Its result is materialized as a proxy, so `<For>` and every row still work on proxies.
- **(b) A handle-aware `<For>` moves some structural ops, but not in one direction.**
  - Against `store-handles`:
    - `01_run1k` is **−19% (real)**.
    - Swap, remove-one and create-after are −8% to −18% in both runs (p<0.001), but just inside the σ band.
    - `02_replace1k` is +9% / +12% and `07_create10k` +4% / +8% (p<0.001).
  - Against the plain proxy app, handles-for is still **+15% on `07_create10k` (real)**.
  - Proxy traps are not what a store list pays for.
- **(c) Proxy-free rows do not get close to per-row signals.**
  - S2 (the `keyed/solid` signals app) beats the best proxy-free variant on 8 of 9 benchmarks by **−14% to −55% (all real)**; select is noise.
  - It beats the plain proxy app by −17% to −62% on 6 benchmarks.
  - The gap is in the store's write and notification path: `storePath` drafts, store nodes and the array `$TRACK`. It is not in read traps, which handles remove, and they barely move.
- **Strict authoring itself costs mount time.** `store-strict` vs `store-proxy`: `07_create10k` **+10% (real)**; create-after +13% to +15%, remove-one +7% to +8% and clear +6% to +8% (p<0.001, inside the band).
- **Two strict-mode runtime findings came out of building the variants.** Both have standalone repros in `scripts/heuristics/jfb/`. See "Strict-Mode Findings" below:
  - a `<For>` over a store inside a `$` block crashes in **production** builds only;
  - `$`-block rows under `<For>` lose keyed identity, so every row is re-created on each list change.

## Apps and Variants

The Solid 2 port of `keyed/solid-store` is [`scripts/heuristics/jfb/store-main.jsx`](../../../../scripts/heuristics/jfb/store-main.jsx). It uses the minimal-rename rule: `createSelector` → `createProjection`, and every 1.x path setter is wrapped in the documented compat helper `storePath(...)`, so `setState("data", { by: 10 }, "label", l => l + " !!!")` becomes `setState(storePath("data", { by: 10 }, "label", l => l + " !!!"))`, and so on. The rows live in the store (`{ data: [{ id, label }], selected }`). Update10th, select, swap and remove all go through the store setter.

The build is [`build.mjs --suite store`](../../../../scripts/heuristics/jfb/build.mjs). It uses the same pipeline as before: the repo compiler, Rollup and terser, against the frozen snapshot. The compiled outputs are in [`compiled/`](compiled/), and bundle hashes are in [`variants.json`](variants.json).

| Variant | What it is |
| --- | --- |
| store-proxy | `store-main.jsx`, plain JSX, idiomatic proxy reads |
| store-proxy-aa | byte-identical copy of store-proxy (same sha256 `5b5a963a…`), the A/A noise floor |
| store-strict | [`store-strict-main.jsx`](../../../../scripts/heuristics/jfb/store-strict-main.jsx), the same app in the strict generator style, compiled **without** `storeHandles` (stage-1 `readPath` readers). Differences:<br>• The rows array is `createMemo($(function* () { return yield* state.data; }))`.<br>• Each row is a `$(function* () {…})` block run once per row, reading `yield* row.id`, `yield* row.label` and `yield* isSelected[rowId]`.<br>• Markup, ops and setters are unchanged.<br>• The two structural choices are forced by the findings below. |
| store-handles | the same source compiled **with** `storeHandles: true` (real compiler output) |
| store-handles-for | store-handles, hand-edited so the list is handle-aware:<br>• The rows memo returns an array of **child handles**: `readHandleChild(state, ["data"])`, the array's `$TRACK` (the same structural tracking `mapArray` does on a store array), then `readHandleChild(d, [i])` per row, untracked.<br>• Each row reads `readHandle1(row, "id" / "label")`.<br>• Verified in the page: rows reaching `<For>` are store targets with `px === null`, so no proxy is created, whereas in store-handles they are proxies. |
| S2-rows | the signals entry `keyed/solid-next` from [`../jfb/`](../jfb/README.md), **reused as is**. Its rows are `{ id, label, setLabel }` with a per-row label signal inside an array signal; this is the `keyed/solid` shape. Its ops and markup are identical to the store app except that the `<h1>` reads "Solid" rather than "Solid Store", so the gate compares the `<table>`. |
| S4-static-id | **not built: identical to store-proxy.** JFB's source already reads the id once, untracked (`const rowId = row.id; … textContent={rowId}`), and the compiler emits it as a static `textContent` write. There is no tracked id read left to remove. |

### What `storeHandles` Did

This is the store summary from [`store-summary.json`](store-summary.json):

```json
{ "binding": "state", "handle": true, "refused": null, "reads": 1, "setter": true, "proxyFree": false,
  "escapes": [{ "kind": "member", "loc": "51:16" }] }
```

- **Handle:** `state` is created with `_$createStoreHandle`.
- **Lowered read:** the rows memo reads `_$readHandle1(state, "data")`. This is the one lowered read, and it hands back the materialized **proxy** of the `data` array (a walk that ends on a child target returns its proxy).
- **Escape:** the projection's `state.selected` becomes `_$storeProxy(state).selected`.
- **Rows:** these are not the root store, so the option has nothing to act on. `<For>` receives the proxy array. Row reads stay `_$readPath1(row, "label")`, one proxy trap each, the same as in store-strict.
- **Setter:** the setter materializes the root draft proxy on first use in any case.
- **`<For each={state.data}>`:** written this way (as in `packages/web/test/store-handles/app.tsx`), it becomes `_$storeProxy(state).data`, which is the "For escape". The strict source here uses a lowered read instead; it ends in the same proxy array either way.

## Equivalence Gate

[`check.mjs --suite store`](../../../../scripts/heuristics/jfb/check.mjs) is the same driver as before: seeded labels, 28 steps covering every JFB operation, compared after each step.

It was strengthened for this suite with a **keyed-identity check**. Before every step it marks all `<tr>` nodes. After the step it records how many marked rows survive, and that count is part of the trace. A keyed list keeps 1000 rows on swap, 999 on remove, and all old rows on append. The earlier heuristic suite was re-gated with this check and still passes: [`../jfb/equivalence-keyed.json`](../jfb/equivalence-keyed.json).

Result ([`equivalence.json`](equivalence.json)):

- All five store variants and S2 match store-proxy at every step, both in HTML and in rows kept.
- The negative control `store-broken` **fails** at "03 update". It is handles-for with the label read made untracked.

## Results

The metric is JFB `script` time in ms. The median is of 40 iterations (50 for select) per run; run 1 and run 2 are shown. The "real" rule is the same as before: same sign in both runs, |Δ| greater than the pooled σ in both runs, and Mann–Whitney p below 0.01 over the pooled 80 samples.

The full tables, including every pair and `total` time, are in [`tables.md`](tables.md). The data is in [`results.json`](results.json), and raw JFB files are in `raw/run{1,2}/` (54 each). Run 1 was 2026-09-26T23:57Z–2026-09-27T01:16Z; run 2 was 01:16Z–02:36Z. No failures and no retries.

### Script medians (run 1 / run 2)

| Benchmark | store-proxy | store-proxy-aa | store-strict | store-handles | store-handles-for | S2-rows |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 01_run1k | 16.3 / 18.5 | 17.4 / 17.4 | 17.9 / 17.4 | 17.3 / 17.9 | 14.4 / 14.2 | 10.3 / 10.5 |
| 02_replace1k | 24.9 / 24.9 | 25.1 / 24.1 | 24.5 / 24.6 | 24.6 / 24.4 | 26.8 / 27.3 | 23.5 / 22.9 |
| 03_update10th1k_x16 | 10.6 / 10.1 | 10.3 / 10.4 | 10.1 / 10.6 | 10.8 / 10.9 | 11.1 / 11.2 | 7.3 / 7.1 |
| 04_select1k | 4.0 / 4.5 | 4.2 / 4.4 | 4.4 / 4.2 | 4.3 / 4.5 | 4.2 / 4.3 | 4.5 / 4.8 |
| 05_swap1k | 15.3 / 16.1 | 15.8 / 15.9 | 15.8 / 16.0 | 15.2 / 14.9 | 13.4 / 13.6 | 6.3 / 6.5 |
| 06_remove-one-1k | 6.0 / 6.3 | 6.1 / 6.4 | 6.5 / 6.7 | 6.2 / 6.4 | 5.0 / 5.3 | 2.3 / 2.3 |
| 07_create10k | 138.1 / 141.9 | 140.7 / 140.1 | 151.8 / 156.8 | 152.6 / 151.1 | 158.8 / 163.4 | 114.8 / 117.8 |
| 08_create1k-after1k_x2 | 19.5 / 20.2 | 20.1 / 20.2 | 22.4 / 22.9 | 22.2 / 21.8 | 18.8 / 19.6 | 13.6 / 13.8 |
| 09_clear1k_x8 | 47.5 / 46.5 | 48.3 / 46.1 | 51.3 / 49.5 | 51.0 / 51.2 | 53.9 / 53.4 | 42.4 / 42.2 |

Stddevs are 1–4 ms on the small benchmarks and 6–13 ms on 07/09; they are listed per cell in `tables.md`.

### Deltas in script time (%, run 1 / run 2; bold = real)

| Benchmark | A/A | strict vs proxy | handles vs strict | handles vs proxy | handles-for vs handles | handles-for vs proxy | S2 vs proxy | S2 vs handles-for |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01_run1k | +7 / −6 | +10 / −6 | −3 / +3 | +6 / −3 | **−17 / −21** | −12 / −23 ‡ | **−37 / −43** | **−29 / −26** |
| 02_replace1k | +1 / −4 | −1 / −1 | 0 / −1 | −1 / −2 | +9 / +12 ‡ | +8 / +9 ‡ | −5 / −8 ‡ | **−12 / −16** |
| 03_update10th1k_x16 | −3 / +3 | −6 / +5 | +7 / +3 | +1 / +8 | +3 / +2 | +4 / +11 ‡ | **−32 / −30** | **−34 / −37** |
| 04_select1k | +5 / −2 | +10 / −7 | −1 / +7 | +9 / 0 | −5 / −4 | +4 / −4 | +11 / +6 | +7 / +11 |
| 05_swap1k | +4 / −1 | +3 / 0 | −4 / −7 | 0 / −7 | −12 / −8 ‡ | −12 / −15 ‡ | **−58 / −59** | **−53 / −52** |
| 06_remove-one-1k | +2 / +2 | +8 / +7 ‡ | −5 / −5 | +3 / +2 | −19 / −17 ‡ | −16 / −15 ‡ | **−62 / −62** | **−55 / −56** |
| 07_create10k | +2 / −1 | **+10 / +11** | +1 / −4 | +11 / +6 ‡ | +4 / +8 ‡ | **+15 / +15** | **−17 / −17** | **−28 / −28** |
| 08_create1k-after1k_x2 | +3 / 0 | +15 / +13 ‡ | −1 / −5 | +14 / +8 ‡ | −15 / −10 ‡ | −4 / −3 | **−31 / −32** | **−28 / −30** |
| 09_clear1k_x8 | +2 / −1 | +8 / +6 ‡ | −1 / +4 | +7 / +10 ‡ | +6 / +4 | +13 / +15 ‡ | −11 / −10 ‡ | **−21 / −21** |

‡ marks a delta with the same sign in both runs and Mann–Whitney p<0.01 that stays inside the σ band in at least one run: a probable effect below this setup's per-cell resolution.

**A/A floor:** store-proxy vs its byte-identical copy. With 40 iterations, no benchmark has a consistent sign beyond the band. The medians differ by at most 7% in a run, and the lowest Mann–Whitney p is 0.063. That is about half the ±15% floor seen at 15 iterations in `../jfb/`.

`total` time (script plus layout and paint) is reported in `tables.md` and is not used for the verdicts; paint dominates it.

## Strict-Mode Findings

Both findings are in the runtime as currently built (`packages/*/dist` in the frozen snapshot, which matches the sources at `3d536fcb`). Neither is fixed here; `packages/` was not touched.

1. **A `<For>` over a store inside a `$` block crashes in production builds only.**
   - `recompute` in `packages/signals/src/core/core.ts` resets `blockGuard` for each computation's run, but only under `if (__DEV__)`, at lines ~331–339 and ~458–461.
   - The store `get` trap checks `blockGuard` in every build (`store/next/store.ts` ~1966).
   - So in production, a computation created and first run inside a block body inherits the raised guard. `<For>`'s `mapArray`, created by `insert` inside the block, then reads the store array's `length` and items as path **tokens** and throws `[DIRECT_READ_IN_BLOCK]`, and reactivity halts.
   - Repro: [`scripts/heuristics/jfb/repro-block-guard.jsx`](../../../../scripts/heuristics/jfb/repro-block-guard.jsx). Bundled against the prod dists it throws; against the dev dists it renders `<li>1</li><li>2</li>`.
   - `packages/web/test/store-handles/app.tsx` has exactly this shape (`<For each={store.todos}>` inside `App`'s block), but the web suites run the dev bundles.
   - The strict app therefore reads the rows through a memo-hosted block instead of wrapping the whole app in a block.
2. **`$`-block rows under `<For>` lose keyed identity (every build).**
   - When the row callback returns the block (`row => $(function* () {…})`, the natural strict spelling, which is also what a `Row` component returning a block produces), `<For>`'s result is an array of functions.
   - `insert` re-runs every row block on each list change, so all row nodes are re-created on swap, remove and append.
   - Repro: [`scripts/heuristics/jfb/repro-row-blocks.jsx`](../../../../scripts/heuristics/jfb/repro-row-blocks.jsx) keeps 0 of 3 nodes after a reverse, in both prod and dev.
   - JFB measured the cost before the keyed check caught it. That first timing session, archived in [`rowblocks/`](rowblocks/) and invalid as a keyed implementation, shows the strict variants against store-proxy at `05_swap1k` **+631%** (113 ms vs 15.6 ms), `06_remove-one-1k` **+760%**, and `08_create1k-after1k_x2` **+124%**.
   - The measured strict variants run the row block once in the callback (`$(function* () {…})()`) and hand `<For>` the `<tr>`. This is keyed and passes the gate.
   - The HTML-only gate passed the broken variants; only the keyed-identity check caught them. That check is now part of `check.mjs`.

## Verdicts

| Question | Answer |
| --- | --- |
| (a) Does `storeHandles` as it exists help a list app? | **No.** `store-handles` equals `store-strict` within noise on all nine benchmarks. The handle covers only the root store's one read, and the list and rows are still proxies. Authoring in strict style to enable it costs create10k **+10%** (real) and +6% to +15% on create-after, remove and clear (probable). This comes from per-row block and reader overhead. |
| (b) What would a handle-aware `<For>` add? | **Mixed, and small.** It is faster on the create-after-clear path (`01_run1k` **−19%**, real) and probably on swap, remove and append (−8% to −19%). It is slower on replace (+9% to +12%) and create10k (+4% to +8%): the handle-aware list rebuilds its array of child handles with one tracked hop per row on each change, and gets nothing back on those ops. Against the plain proxy app it nets create10k **+15% (real)**. Removing proxy traps from rows is not worth a compiler proof on this evidence. |
| (c) How close does proxy-free get to S2 per-row signals? | **Not close.** S2 is −14% to −55% faster than handles-for on 8 of 9 benchmarks (all real), and −17% to −62% faster than store-proxy on 6. The store app's cost sits in writes and notification: `storePath` walking a draft, per-key store nodes, and the array's structural `$TRACK` re-running `mapArray` on swap and remove. Per-row signals avoid all of it. This agrees with round 3's **S2 store scalar replacement** oracle (mount −76%, update −67% at signal level): on Tier 2 the win belongs to turning store rows into signals, not to reading the same store without proxies. |

## Deviations and Limits

- **Keyed-identity check and a second timing session.** The first timing session (21:06–23:52Z, [`rowblocks/`](rowblocks/)) measured strict variants that were not keyed (finding 2). The gate was then strengthened, the strict rows fixed, and both runs repeated. The numbers above come only from the repeat session.
- **Structural changes to the strict source.** The rows memo and the invoked row block are forced by findings 1 and 2, and are documented in the source. The markup, ops and setters are identical to store-proxy.
- **`store-handles-for` is a hand edit.** It is not something the compiler emits: it prices a hypothetical handle-aware list. Its `__handleRows` helper is in `build.mjs`.
- **S2 reuses the signals entry as is.** It differs from the store app only in the `<h1>` text.
- **Runner and machine.** JFB's playwright runner (as in `../jfb/`). The JFB checkout is unmodified apart from the added framework directories. I had the machine to myself for both runs (the coordinator was idle), and no stray runner or browser was alive; this was checked before each session.
- **Commits.** Interim files (`store-main.jsx`, `store-strict-main.jsx`, `build.mjs`, `check.mjs`) were committed by the coordinator during the work (`3d536fcb`, `91507381`); the later edits are uncommitted.

## Reproduce

```sh
node scripts/heuristics/jfb/build.mjs --jfb <jfb> --suite store
(cd <jfb>/server && npm start) &
node scripts/heuristics/jfb/check.mjs --suite store --out documentation/plans/heuristic-oracles/jfb-store/equivalence.json
FW_LIST="solid-next-store solid-next-store-aa solid-next-store-strict solid-next-store-handles solid-next-store-handles-for solid-next" \
  COUNT=40 JFB=<jfb> scripts/heuristics/jfb/run.sh <out1>
FW_LIST=... COUNT=40 JFB=<jfb> scripts/heuristics/jfb/run.sh <out2> reverse
node scripts/heuristics/jfb/report.mjs <out1> <out2> --suite store --out results.json --md tables.md
```
