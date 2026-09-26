# Heuristic Oracles on Tier 2: js-framework-benchmark

Status as of 2026-09-26. This page checks the DOM-lane compiler heuristics (H1, H7, L1) and the runtime speculation R1b from [`../../heuristic-oracles.md`](../../heuristic-oracles.md) against the Tier-2 source of truth: js-framework-benchmark (JFB), run by JFB's own runner on its nine CPU benchmarks.

**Short answer:** none of the heuristics moves the idiomatic JFB app outside this setup's noise band. The three wins earlier measured in Chromium do not reach JFB, for structural reasons:

- JFB's Solid source already avoids the code H7 and H1 remove.
- R1b has no memos to promote.
- L1's swap gain falls inside the noise.

The one shape where H7 has something to remove is JSX-child text. There, H7 holds on Tier 2: create-after −21% (real), update10th −17% to −21% and replace −9% to −12% (consistent across both runs, just inside the band).

## Setup

| Item | Value |
| --- | --- |
| JFB | `krausest/js-framework-benchmark` master `f2df01a8679de05225c32714ca8cecbea3d78c5d` (2026-09-20), shallow clone |
| Solid entry | Upstream JFB has **no Solid 2 entry**: only `keyed/solid` and `keyed/solid-store`, both on `solid-js ^1.9.3`, and no `solid-next` in the history since 2025-06. `keyed/solid-next` was therefore **authored as a port** of `keyed/solid/src/main.jsx`, kept in [`scripts/heuristics/jfb/main.jsx`](../../../../scripts/heuristics/jfb/main.jsx). It changes only the Solid 2 API renames: `createSelector` → `createProjection` (the documented migration), `batch` removed, `solid-js/web` → `@solidjs/web`. Everything else is byte-for-byte the 1.x source, including `textContent={rowId}` / `textContent={row.label()}`, the delegated `onClick`s and the keyed `<For>`. |
| Solid packages | This repo at `5e4eedce` (working tree; no workspace build was run). The existing `packages/signals/dist/prod`, `packages/solid/dist/solid.js` and `packages/web/dist/web.js` were snapshotted once, and hashed in [`variants.json`](variants.json). Rspec runtimes were taken from `node_modules/.cache/heuristics/rspec/{signals-r0,signals-r16,web-r0.js}`. |
| Compiler | `packages/compiler` (native Oxc; its README says output is byte-identical to `@solidjs/babel-plugin`), `generate: "dom"`, `omitNestedClosingTags: true` as in the 1.x entry's babel config |
| Bundle | Rollup 4.59 (as the JFB entry uses), aliasing `solid-js` / `@solidjs/web` / `@solidjs/signals` to the snapshot, then terser 5.49 with the entry's options (`module`, `compress.passes: 3`, `mangle`). About 74.6 KB per variant. |
| Runner | JFB `webdriver-ts`, `--runner playwright --headless`, default iteration count (15; `04_select1k` 25), JFB's CPU throttling (4× on 03/04/05/09, 2× on 06). Two independent runs, variants interleaved per benchmark by JFB's loop; run 2 used reversed framework order. |
| Browser | Chromium 141.0.7390.37 (`/opt/pw-browsers/chromium-1194`, passed as `--chromeBinary`), driven by webdriver-ts's own Playwright 1.61.1 |
| Machine | Shared 4-core cloud VM, Node v22.22.2. Timing started after `jfb-go.flag` (17:24Z), not pinned. |
| Commands | `node scripts/heuristics/jfb/build.mjs --jfb <jfb>`; `node scripts/heuristics/jfb/check.mjs` (JFB server running); `JFB=<jfb> scripts/heuristics/jfb/run.sh <out> [reverse]`; `node scripts/heuristics/jfb/report.mjs run1 run2 --out results.json --md tables.md` |

### Deviations from stock JFB

- **Runner: playwright rather than JFB's default puppeteer.**
  - Puppeteer (puppeteer-core 25.3) was tried first, with a one-line `--no-sandbox` patch because the container runs as root.
  - With this Chromium, most traces also contained the warmup clicks. JFB's trace parser then rejected them ("at most one mousedown event is expected"), and 51 of 72 benchmark/variant cells failed in the first timing run.
  - The playwright runner is one of JFB's supported runners and needs no patch. It ran both timing runs with 0 failures and 0 retries.
  - The patch was reverted, so the JFB checkout is unmodified apart from the added framework directories.
- **Restart.** The aborted puppeteer runner survived its kill and was still running when the first playwright run started, so the two overlapped (about 30 s before it was caught). All processes were killed, every result was discarded, and both runs restarted from scratch at 17:57Z. Run 1 finished at 18:48Z and run 2 at 19:38Z. No result in this page comes from the overlapping period.
- **Framework metadata.** Each variant directory has a stub `package-lock.json` (JFB's server lists only directories that have one) and `frameworkVersion: "2.0.0-rc.8-local"`.

## Variants

Each variant is a separate framework directory, `frameworks/keyed/solid-next*`. The build, bundler, runtime snapshot and page are the same for all. Each variant makes one named edit to the compiled output, applied by [`build.mjs`](../../../../scripts/heuristics/jfb/build.mjs). The edit fails if its pattern is missing or not unique.

What the compiler emits for a JFB row (baseline):

```js
_el$18.textContent = rowId;                        // id: already a static text write
_$effect(() => ({ e: _$readShallow(isSelected[rowId] ? "danger" : ""), t: row.label() }),
  ({ e, t }, _p$) => { _$className(_el$17, e, _p$?.e); (!_p$ || t !== _p$.t) && (_el$21.data = t); });
```

| Variant | Edit | Notes |
| --- | --- | --- |
| baseline | none | |
| **H1** | **not built** | The app has **no memo**. Selection is a `createProjection` read directly in the row effect (`isSelected[rowId]`), the Solid 2 replacement for 1.x's `createSelector`. There is no single-reader memo to fuse, and forcing one would measure a different app. |
| H7 | Typed class in the grouped effect: drop `readShallow`, write `e !== prev && el.setAttribute("class", e)` instead of `className()` | The label and id are **already** text writes (`.data` / `textContent`) because JFB's source uses `textContent=`. Only H7's attribute half has anything to remove here. |
| L1 | `<For>` replaced by `mapArray` → `reconcileArrays` straight into `<tbody>` | Exactly `L1-nodes` from `dom/list/variants.mjs` |
| H7+L1 | both | |
| child | **source** change: `{rowId}` / `{row.label()}` as JSX children instead of `textContent=` | The shape H7 targets (generic `insert`); a reference for child-H7, not a heuristic |
| child-H7 | child + exactly `H7-text` from `dom/variants.mjs`: text nodes in the template, `.data` writes, a typed class effect | H7 as the Tier-1 bench measured it |
| rspec-r0 | baseline source on `web-r0.js` + `signals-r0` | The R control. **Its bundle is byte-identical to baseline** (same sha256), so it doubles as an **A/A noise-floor test**. |
| rspec-r1b | baseline source on `web-r0.js` + `signals-r16` (R1b) | Compared against rspec-r0 |

## Equivalence Gate

[`check.mjs`](../../../../scripts/heuristics/jfb/check.mjs) loads every built entry from the JFB server. It seeds `Math.random` identically, so labels match. It then drives 28 steps through the app's own buttons and row links, using JFB's selectors:

- run and replace, including a replace while a row is selected;
- update, also on 2k rows, 10k rows and an empty table;
- select and re-select, including after swap and at rows 999, 1500 and 10000;
- swap and swap back, and a swap on an empty table;
- remove the first, a middle and the last row;
- append, create 10k, and clear on 1k and 10k rows.

After every step it compares `#main.innerHTML` to the baseline. It also checks the baseline itself for the expected row counts and exactly one `danger` row after each select.

Result ([`equivalence.json`](equivalence.json)):

- All 8 variants match at every step, with no page errors.
- The negative control `broken` (an H7 edit that writes only truthy class values) **fails**, at step "01 run".

## Results

All values are ms, from JFB's `script` metric (V8 execution inside the click→idle window).

- **Median** is the median of the 15 iterations (25 for select) in each run.
- **Δ** is the variant median against the reference median, per run.
- **Real** requires three things together: the same sign in both runs, |Δ| greater than the pooled stddev `sqrt((σ_ref² + σ_var²)/2)` in both runs, and a Mann–Whitney p below 0.01 over both runs pooled. Everything else is marked (noise).

The full per-run tables, including `total` time, are in [`tables.md`](tables.md). Machine-readable data is in [`results.json`](results.json), and raw JFB result files are in `raw/run{1,2}/`.

### Script medians (run 1 / run 2)

| Benchmark | baseline | H7 | L1 | H7+L1 | child | child-H7 | rspec-r0 | rspec-r1b |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01_run1k | 13.9 / 13.1 | 13.4 / 14.0 | 12.8 / 13.2 | 12.4 / 12.6 | 16.7 / 15.1 | 15.3 / 15.2 | 12.8 / 12.9 | 13.0 / 12.7 |
| 02_replace1k | 32.8 / 31.4 | 30.5 / 31.0 | 33.7 / 30.6 | 30.2 / 30.5 | 34.3 / 34.7 | 30.2 / 31.5 | 29.6 / 29.1 | 29.8 / 34.5 |
| 03_update10th1k_x16 | 11.0 / 8.9 | 9.4 / 9.9 | 9.2 / 9.1 | 9.5 / 9.3 | 9.6 / 9.4 | 8.0 / 7.4 | 9.2 / 8.9 | 10.2 / 9.4 |
| 04_select1k | 6.1 / 6.1 | 5.8 / 5.5 | 5.5 / 5.3 | 6.2 / 5.0 | 5.7 / 5.8 | 5.4 / 5.6 | 5.7 / 5.4 | 5.7 / 5.6 |
| 05_swap1k | 8.1 / 8.6 | 7.2 / 7.3 | 7.4 / 7.8 | 7.5 / 6.7 | 8.2 / 7.8 | 7.5 / 7.4 | 7.2 / 7.7 | 7.7 / 8.0 |
| 06_remove-one-1k | 2.8 / 2.6 | 2.7 / 2.8 | 2.9 / 2.9 | 2.6 / 2.8 | 2.8 / 2.8 | 2.5 / 3.1 | 3.1 / 3.0 | 3.0 / 3.0 |
| 07_create10k | 141.0 / 138.9 | 144.4 / 147.7 | 143.2 / 143.6 | 139.7 / 145.4 | 166.8 / 162.9 | 170.1 / 168.0 | 150.2 / 141.4 | 142.6 / 138.3 |
| 08_create1k-after1k_x2 | 16.4 / 16.8 | 17.2 / 15.8 | 16.1 / 15.6 | 16.5 / 16.6 | 19.9 / 18.8 | 15.6 / 15.1 | 16.6 / 16.0 | 16.4 / 15.7 |
| 09_clear1k_x8 | 60.1 / 58.8 | 58.6 / 58.6 | 60.1 / 59.1 | 58.2 / 61.0 | 64.3 / 64.9 | 60.7 / 59.3 | 59.0 / 56.5 | 57.7 / 62.2 |

The stddevs are large relative to the effects: 1.3–3.8 ms on 01, 03, 04, 05 and 08; 0.5–1.4 ms on 06; 9–23 ms on 07. See [`tables.md`](tables.md) for each cell.

### Deltas in script time (Δ run 1 / Δ run 2; bold = real by the rule above)

| Benchmark | A/A: rspec-r0 vs baseline | H7 vs baseline | L1 vs baseline | H7+L1 vs baseline | child vs baseline | child-H7 vs child | R1b vs rspec-r0 | R1b vs baseline |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 01_run1k | −8 / −2 | −4 / +7 | −8 / +1 | −11 / −4 | +20 / +15 (p<.001) | −8 / +1 | +2 / −2 | −7 / −3 |
| 02_replace1k | −10 / −7 (p=.005) | −7 / −1 | +3 / −3 | −8 / −3 | +5 / +11 | −12 / −9 (p=.002) | +1 / +19 | −9 / +10 |
| 03_update10th1k_x16 | −16 / 0 | −15 / +11 | −16 / +2 | −14 / +5 | −13 / +6 | −17 / −21 (p<.001) | +11 / +6 | −7 / +6 |
| 04_select1k | −7 / −12 | −5 / −10 | −10 / −13 | +2 / −18 | −7 / −5 | −5 / −3 | 0 / +4 | −7 / −8 |
| 05_swap1k | −11 / −11 | −11 / −15 | −9 / −9 | −7 / −22 | +1 / −9 | −9 / −5 | +7 / +4 | −5 / −7 |
| 06_remove-one-1k | +11 / +15 (p=.003) | −4 / +8 | +4 / +12 | −7 / +8 | 0 / +8 | −11 / +11 | −3 / 0 | +7 / +15 |
| 07_create10k | +7 / +2 | +2 / +6 | +2 / +3 | −1 / +5 | **+18 / +17** | +2 / +3 | −5 / −2 | +1 / 0 |
| 08_create1k-after1k_x2 | +1 / −5 | +5 / −6 | −2 / −7 | +1 / −1 | +21 / +12 (p<.001) | **−22 / −20** | −1 / −2 | 0 / −7 |
| 09_clear1k_x8 | −2 / −4 | −3 / 0 | 0 / +1 | −3 / +4 | +7 / +10 | −6 / −9 | −2 / +10 | −4 / +6 |

(%; p is shown where the Mann–Whitney p is below 0.01 but the σ-band rule still calls the delta noise.)

**Read the A/A column first.** rspec-r0 and baseline are the *same bytes*, yet their medians differ by up to 16% on one run. The same sign appears in both runs at −7% to −11% (02, 05) and +11% to +15% (06), with MW p as low as 0.003. On this shared VM, JFB's resolution is therefore about ±10% per cell even with 15–25 iterations and two runs. A consistent same-sign delta below roughly 12% is not evidence. None of the heuristic deltas that fail the rule should be read as a direction.

The `total` metric (script, layout and paint) moves no cell outside the band for any pair. Paint dominates it: about 130 ms on 01 and 1.31 s on 07, with σ 5–30 ms.

## Verdicts: Does the Tier-1 / Custom-Harness Result Hold on Tier 2?

| Heuristic | Earlier claim (custom Chromium harness) | JFB result | Verdict |
| --- | --- | --- | --- |
| **H1** memo fusion | DOM mount −17%, select −22% (rows harness, per-row `isSel` memo) | Not applicable. JFB's Solid 2 app has no memo; selection is a projection (1.x: `createSelector`). | **Not testable on JFB without changing the app. No Tier-2 validation.** It is consistent with the ledger's own finding that a projection beats H1 on shared-source selection. H1's case rests on memos in real apps (census 29%), not on JFB. |
| **H7** typed text/class, on JFB's own source | update10th −13% to −28% | Only the class half applies, because the text is already `.data` via `textContent=`. Every benchmark is in noise (select −5/−10, swap −11/−15, 03 −15/+11). | **Does not hold for JFB-as-written.** Idiomatic hand-tuned source already gets H7's text win, and the typed class alone is below resolution. |
| **H7** on JSX-child text (child-H7 vs child) | update10th −13% to −28%, replace/mount small | update10th **−17% / −21%** (p<.001; just inside the band in run 1), replace −12% / −9% (p=.002), create-after **−22% / −20% (real)**, create10k +2% / +3% (noise) | **Holds, in direction and roughly in size, for update and incremental create.** This is the most solid Tier-2 confirmation in this study. It also shows *what* H7 buys: generic child `insert` costs +18% on create10k and +15% to +20% on run1k versus `textContent=`. |
| **L1** single-element rows | swap −12% to −15%, remove/insert −23% to −25% | swap −9% / −9% (p=.06), remove-one +4% / +12% (noise); everything else noise | **Not confirmed.** Swap has the right sign but is inside the A/A floor. Remove shows no gain. JFB's 06 removes one row by clicking, and its script time (≈2.8 ms) is dominated by event dispatch and DOM removal, not by the flatten step that L1 skips. |
| H7+L1 | – | swap −7% / −22%, run1k −11% / −4% (p=.002), all noise | **No additive effect visible.** |
| **R1b** (runtime speculation, vs the matching control) | select −32% to −33% (Chromium rows and list harnesses) | select 0% / +4%, every benchmark noise; also noise against baseline | **Does not reproduce: nothing to speculate on.** R1b promotes *memos*. JFB's rows have no memo, and the projection's single derive is not a per-row hot memo. The earlier −32% came from harnesses with a per-row `isSelected` memo over a shared signal, a shape Solid 2's idiomatic JFB source does not use. No regression either: mount (01/07) is within noise. |

Overall:

- **Tier 2 validates the H7-on-children mechanism and nothing else.**
- H1 and R1b target a per-row memo that idiomatic Solid 2 code (projections) does not write in JFB.
- L1's structural-update win is below JFB's ±10% resolution on this machine.

Whether these heuristics matter in production depends on coverage in real apps (the census), not on JFB. JFB's Solid source is hand-tuned (`textContent=`, a projection) and already avoids the costs these heuristics remove.

## Limits

- The Solid 2 entry is a port written for this study, because JFB upstream has none. The choice `createSelector` → `createProjection` follows the migration guide. The earlier `solid-next` journal entries in `performance-experiments.md` used a store (`selected[rowId]`) instead; that also has no memo.
- Measurements were taken on a shared 4-core VM with JFB's CPU throttling. The A/A test shows cell-level noise of about ±10–15%. A quiet dedicated machine would likely resolve smaller effects, especially L1 swap (−9% in both runs).
- The runner is playwright, not JFB's default puppeteer (see Deviations). Both runners compute script time from the same Chrome trace parser (`timeline.ts`).
- R1b was bundled from the rspec cache as found (`signals-r16`, built 2026-09-26). Which R1b cut it holds (end-of-first-run or entry-of-second-run) was not re-verified here. `web-r0.js` + `signals-r0` minify to exactly the shipped bundle.

## Files

- `scripts/heuristics/jfb/main.jsx`: the Solid 2 JFB entry source.
- `scripts/heuristics/jfb/build.mjs`: compiles, applies the variant edits, bundles and writes `frameworks/keyed/solid-next*` into a JFB checkout, plus `solid-variants.json`.
- `scripts/heuristics/jfb/check.mjs`: the equivalence gate.
- `scripts/heuristics/jfb/run.sh`: one JFB CPU run over all variants, with a retry of missing cells (none were needed).
- `scripts/heuristics/jfb/report.mjs`: aggregation, noise rule and tables.
- `documentation/plans/heuristic-oracles/jfb/`: `equivalence.json`, `variants.json` (runtime and bundle hashes), `results.json`, `tables.md`, and `raw/run1/`, `raw/run2/` (JFB result JSON, 72 files each).
