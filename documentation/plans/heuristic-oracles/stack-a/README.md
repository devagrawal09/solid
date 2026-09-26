# Stack A: What the "Build" Heuristics Are Worth Together (Chromium)

Status: measured 2026-09-26 on branch `experiment/iterable-signals`. This is a follow-up to [`../../heuristic-oracles.md`](../../heuristic-oracles.md). All heuristics that earned a "build" verdict there are applied at once to both DOM suites, and each one is then removed in turn (leave-one-out). Nothing under `packages/` was changed. The one new runtime, oracle + async-free, was built into `node_modules/.cache/heuristics/stack-a/oracle-sync`.

## Headline

| Suite / op | baseline µs | STACK µs | STACK Δ | largest single contributor inside the stack (Δ when removed) |
| --- | ---: | ---: | ---: | --- |
| list create | 6218 | 4797 | −23% (noise) | none resolvable |
| list replace | 7100 | 5570 | −22% (noise; † trimmed-real) | none resolvable |
| list update10th | 79.3 | 60.4 | **−24%** ★ | H7 typed text (+22% ★) |
| list select | 154 | 106 | **−31%** † (★ in the pilot run) | statusFree on isSel (+45% †) |
| list swap | 114 | 93.0 | **−18%** ★ | L1 single-element rows (+19% †) |
| list removeAdd | 129 | 90.9 | **−29%** ★ | L1 (+46% ★) |
| rows mount | 4979 | 4342 | **−13%** ★ | H7 (+13% †) |
| rows update10th | 71.3 | 59.7 | **−16%** ★ | H7 (+19% ★) |
| rows select | 146 | 102 | **−30%** ★ | statusFree (+46% ★) |

★ means the delta exceeds the strict noise band: run-to-run difference plus the full within-run spread over 5 pages (see Method). † means it exceeds only the trimmed band, which drops one outlier page at each end. See "Noise" for why list `select` needs the trimmed band.

## Variant Definitions

Every variant is an edit of the real compiler's output (`packages/compiler`, `transform(src, {generate: "dom"})`). The edits are composed by `listVariant(flags)` in [`scripts/heuristics/stack-a/list-variants.mjs`](../../../../scripts/heuristics/stack-a/list-variants.mjs) and by `rowsVariant(flags)` in [`rows-variants.mjs`](../../../../scripts/heuristics/stack-a/rows-variants.mjs). A leave-one-out cell is therefore exactly STACK with one edit not applied.

### List suite (`dom/list/baseline.jsx`: keyed `<For>` + `Row` component, n = 1000)

| Component | Edit of the compiled output |
| --- | --- |
| **C1** inline | The `Row` body is inlined at its only call site (a source rewrite, then compiled). There is no props object and no getter. The dead `Row` function is removed. |
| **C2 local fusion** | Fuse memos whose sources are all row-local. **This is a no-op in this benchmark.** The only memo, `isSel`, reads the shared `selected` signal, so the policy keeps it. |
| **H7** typed text | The template carries the text nodes (`<td class=col-md-1> </td>`). `insert(el, () => X)` becomes `var t = el.firstChild; effect(() => X, v => { t.data = v; })` for both `{row.id}` and `{row.label()}`. The class binding drops `readShallow` and writes `v !== p && el.setAttribute("class", v)`. `{row.id}` stays a reactive read, because a type of `number` does not prove the property is constant. |
| **L1** single-element rows | `render(() => <For …>)` becomes `__forNodes(tbody, () => rows(), cb)`: a `mapArray` plus one effect that hands the node array straight to `reconcile` (copied verbatim from `dom/list/variants.mjs`). |
| **H8b** detached | `{ oracle: OWNERLESS \| DETACHED }` (= 201326592) is set on the id text effect (no sources), the label text effect (reads `row.label`), and the class effect when it reads `isSel`. It is never set on `isSel` or on anything that reads `selected`. H8b needs H7: `insert` takes no node options and can own inner effects. |
| **SF** statusFree | `createMemo(() => selected() === row.id, statusFree)`, with `statusFree` imported from `solid-js`. |

| Variant | Runtime | Contents |
| --- | --- | --- |
| baseline | prod | compiler output, verbatim |
| control | oracle | baseline on the oracle runtime (prices the oracle arms) |
| baseline@sync | sync | baseline on the async-free core |
| **STACK** | oracle | C1 + H7 + L1 + H8b (3 sites) + SF |
| STACK+fuseShared | oracle | STACK, plus `isSel` fused into the class effect with `equals` anyway. The class effect then reads `selected`, so it is not detached, and SF has no memo left to apply to. |
| STACK-C1 / -H7 / -L1 / -H8b / -SF | oracle | STACK minus that component. STACK-H7 still detaches the class effect (1 site). |
| STACK-H8bLabel | oracle | STACK with the label effect left attached. This is the *sound* H8b set; see Surprises. |
| STACK@oracle-sync | oracle-sync | STACK on the oracle + async-free runtime |

### Rows suite (`dom/variants.mjs`: no `<For>`, rows appended by hand, n = 1000)

These are edits of `DOM_VARIANTS.baseline` and `DOM_VARIANTS["H7-text"]`.

| Variant | Runtime | Contents |
| --- | --- | --- |
| baseline / control / baseline@sync | prod / oracle / sync | as above |
| **STACK** | oracle | H7 text (the `id` is a static `.data` write, as in `H7-text`) + H8b on the label effect + SF on `isSel` |
| STACK-H7 | oracle | Text goes back to `insert`. H8b has no site left, so this cell is SF alone. |
| STACK-H8b / STACK-SF | oracle | STACK minus that component |
| STACK+H8b-class | oracle | Extra: STACK plus the class effect detached (it reads only the row-local `isSel`) |
| STACK@oracle-sync | oracle-sync | STACK on the oracle + async-free runtime |

## Verification That Each Oracle Landed

`bench.mjs` refuses to time anything until every check below passes. The results are stored under `verification`, `gate` and `probe` in each run's JSON.

1. **Source markers** in each generated entry module (`listMarkers` / `rowsMarkers`). Each marker must be present (+) or absent (−) according to the variant's flags:
   - `_$createComponent(Row` is absent under C1.
   - `__forNodes(tbody` is present and `_$createComponent(For` absent under L1.
   - `.data = v` is present, and `_$insert(_el$` and `_$readShallow(` are absent, under H7.
   - `__statusFree);` is present under SF.
   - `equals: (a, b) => a === b` is present only under fuseShared, and the `isSel` memo is absent there.
   - The count of `oracle: 201326592` sites must equal the expected number: STACK 3, STACK-H7 1, STACK-H8bLabel 2, STACK+fuseShared 2, rows STACK 1, rows STACK+H8b-class 2.

   All checks passed for every variant in all four runs.
2. **Runtime identity in the bundle.** Oracle bundles contain the `?.oracle` option read and prod bundles do not. Async-free bundles contain the `ASYNC_CAPABILITY_EXCLUDED` stubs and the others do not. All checks passed. (A `statusFree` import that does not resolve fails the esbuild build. The frozen `statusFree` object is in every bundle because `solid-js` re-exports it, so the bundle bytes cannot show SF.)
3. **Behavioural H8b probe.** This shows the detached effects really are outside the owner tree.
   - List: remove and re-add the row at index 4 twenty times, then write that item's label. Every variant whose label effect is detached updated **20 of 20** disposed rows' `<td>`s. Baseline, control, STACK-H7, STACK-H8b and STACK-H8bLabel updated 0.
   - Rows: unmount, then run `update10th`. In STACK, STACK-SF, STACK+H8b-class and STACK@oracle-sync the old row 0 still changed (`row 0 !1`). In the others it did not.
4. **Equivalence gate.** `tbody.innerHTML` must be identical to the baseline after prepare and after each op, over 3 rounds of all ops (19 snapshots for list, 7 for rows, n = 50). Every variant passed in every run.

Bundle sizes (list): baseline 69.1 KB, STACK 61.2 KB, STACK@oracle-sync 52.9 KB. Removing L1 or H7 puts back about 6.7 KB (the `insert`/`For` machinery).

## Method

- `taskset -c 0,1` on every process. Node, the shell and the Chromium processes were checked with `taskset -p` (mask `3`).
- Chromium 141.0.7390.37 headless (Playwright 1.56.1), `file://` pages, script time only (no layout or paint).
- Each cell is 5 fresh pages. Reps are interleaved across variants (op → rep → variant), so a transient slowdown hits every variant in the same slot rather than one cell.
- Per page: up to 1000 warm-up runs or 1.5 s, then 20 samples. **Every sample runs until at least 25 ms has elapsed** (the smallest sample was 25.0 ms). The page value is the median sample, and the cell value is the median over the 5 pages.
- The whole suite (both suites, every variant) was run **twice**, as independent processes: `list-1/rows-1` and `list-2/rows-2`. The tables report run 1, run 2 and their mean.
- **Noise rule (strict, ★).** For each cell, band = |run1 − run2| / mean + max(within-run spread) / 2, where within-run spread = (max − min) / median over the 5 pages. A delta is real only if it exceeds the larger band of the two cells compared. This is the same rule `scripts/heuristics/report.mjs` uses for DOM runs.
- **Trimmed rule (†, secondary).** The same formula with the within-run spread taken as (4th − 2nd) / median of the sorted 5 pages. It is shown next to the strict flag, never instead of it.
- **Pilot runs (kept as `pilot-*.json`).** A first pair of full runs used `dom/bench.mjs`'s batch sizing. When the sizing pass hit a GC, a batch could collapse to a single run of about 5 ms (`create`, `replace`), which breaks the ≥ 25 ms rule. Those runs were discarded and everything was re-run with time-bounded samples. The pilot numbers for ops whose batches were well over 25 ms (update10th, select, swap, removeAdd) agree with the final runs. They are cited only as corroboration.
- Ops keep state bounded: labels are set to a fresh value per round, and lists are replaced rather than grown.

Reproduce:

```sh
taskset -c 0,1 node scripts/heuristics/stack-a/build-oracle-sync.mjs   # oracle+sync tree into node_modules/.cache
taskset -c 0,1 node scripts/heuristics/stack-a/bench.mjs --suite list --check   # landing + gate + probe only
taskset -c 0,1 sh scripts/heuristics/stack-a/run-all.sh                 # 2 runs x 2 suites
node scripts/heuristics/stack-a/report.mjs                              # the tables below
```

## Leave-One-Out: What Each Heuristic Contributes Inside the Stack

Positive means that removing X made the stack slower, so X was helping.

| Removed X | list update10th | list select | list swap | list removeAdd | list replace | rows mount | rows update10th | rows select |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C1 | +3.4% † | −2.1% | −0.4% | +7.2% † | +9.8% | n/a | n/a | n/a |
| H7 | **+21.9% ★** | +1.9% | +2.8% | −2.6% | +9.4% | +13.2% † | **+19.0% ★** | +2.7% |
| L1 | +0.9% | −1.5% | +18.6% † | **+45.8% ★** | +3.9% | n/a | n/a | n/a |
| H8b | +0.7% | −1.9% | −3.6% | −1.3% | +9.0% | +4.6% | +0.7% | +4.5% |
| statusFree | +5.7% ★ | **+45.2% †** | −3.1% | +5.5% | +9.7% | +2.0% | +1.2% | **+45.7% ★** |
| (add) fuseShared | −2.4% | **+21.8% †** | +0.5% | +2.5% | −1.8% | n/a | n/a | n/a |
| (swap runtime) oracle-sync | −4.2% † | +9.0% | −1.1% | +2.7% | −0.2% | +2.1% | −2.5% | +5.2% |

Reading it:

- **statusFree** carries select in both suites: removing it gives back the whole select win (−31% → −0%). The pilot runs agree (+45.6% ★ on list, +43.9% ★ on rows). No other component moves select.
- **H7** carries update10th in both suites (+22% and +19% when removed). It is also the only resolvable component of rows mount (+13% †, and STACK-H7 lands at −1% vs baseline).
- **L1** carries the structural ops: without it, swap and removeAdd fall back to the baseline level.
- **C1** gives small positive contributions everywhere (+3% to +10%), but only update10th and removeAdd clear even the trimmed band. `create`/`replace` are too noisy to resolve the +10% to +33% it shows there. This agrees with round 2 ("enabler only").
- **H8b** is **not resolvable on any op in either suite** (all within ±5%, none past either band). This is true with 3 sites (list) or 1 (rows), and with the extra class-effect site (rows STACK+H8b-class: −2% to +1% vs STACK). The instruction-count win in `heuristic-oracles.md` (mount −5% to −8%, client-only) is below what this Chromium harness can resolve on mount/create, where bands are ±7% to ±58%.
- **fuseShared** inside the stack reproduces the shared-source penalty. Select goes from −31% to −16% vs baseline (+22% vs STACK †; +24.6% ★ in the pilot) and nothing else improves. Policy-correct fusion (row-local sources only) had nothing to fuse in this benchmark.

## What the Stack Achieves

- **List suite (`<For>` + component):** update10th −24% ★, select −31% (★ in the pilot, † here), swap −18% ★, removeAdd −29% ★. create and replace are −22% to −23% on the mean, but within their ±16% to ±34% strict bands (replace is † real). Both runs put STACK below baseline on create and replace, so the direction is consistent but the size is not resolved.
- **Rows suite:** mount −13% ★, update10th −16% ★, select −30% ★. That beats every single heuristic measured in round 1 (H7-text alone was update10th −28% with no select win; H1+H7 was select −26%).
- The pieces are close to **additive and orthogonal**. Each op has one owning heuristic (select → statusFree, updates → H7, structural → L1), and removing any component leaves the others' wins intact.
- **The async-free runtime adds little on top.** STACK@oracle-sync vs STACK is −4% † on list update10th, and within noise everywhere else. On select it is +9% (list) and +5% (rows) slower, both within noise, but the pilot list select showed +13.3% ★. baseline@sync alone gives update10th −9% (list, †), and the stack's per-node shortcuts already cover most of that.
- **control** (baseline on the oracle runtime) is within noise everywhere (−4% to +5%), so the oracle arms do not bias the comparison.

## Surprises and Failures

1. **The label effect is not a sound H8b site in the list suite, and the gate cannot see it.** The brief names it as the example of a detachable node, but `row.label` is created in `build()`, outside the row, and the item survives its row. `removeAdd` disposes the row and re-creates it for the *same* item. With the label effect detached, the disposed row's effect stays subscribed to the item's label and keeps writing to a disconnected `<td>`. The probe counted **20 zombie effects after 20 removeAdd rounds**: one leaked row (effect + `<tr>` subtree) per round, without bound.
   - The equivalence gate passes anyway, because the zombies write only to detached DOM.
   - A sound proof must refuse this site: the source was not created under the row's owner.
   - The sound variant **STACK-H8bLabel** measured the same as STACK on every op (all differences within noise), so dropping the unsound site costs nothing measurable.
   - In the rows suite, the label signal *is* created inside `Row`, so that site is sound. (The rows probe writes after unmount through the escaped setter. That shows the node is detached; it is not a real-app leak.)
2. **H8b has no measurable DOM benefit** in either suite, alone or stacked. It also needs H7 to have any site at all, since `insert`'s effect takes no node options and may own children.
3. **List select needs the trimmed band.** In run 1, the third interleaved page slot was slow for every variant at once: baseline 375 µs, STACK 225 µs, STACK@oracle-sync 210 µs, against about 105 to 155 µs everywhere else. That inflates the strict band to ±59% to ±75%. The effect itself is steady: STACK is 106/105 µs against baseline 157/151 µs across the two runs, and ★ in the pilot. Because reps were interleaved, one shared disturbance could not masquerade as a variant effect.
4. **Pilot batch sizing failure.** This was caught and the runs were redone (see Method). `dom/bench.mjs` has the same weakness for ops that take milliseconds (`mount`, `create`, `replace`), since a GC in its single sizing pass can make one sample a single short run.
5. **oracle-sync on select.** The stack is not faster on the async-free core, and select trends slower there (+5% to +13%). This was not investigated further; a follow-up should compare statusFree on `dist/sync` vs `dist/prod` with instruction counts.

## Raw Data

- `list-1.json`, `list-2.json`, `rows-1.json`, `rows-2.json`: the two final runs. Each file holds per-page values, batches, the landing checks, the gate and the probe.
- `pilot-*.json`: the discarded first pair of runs (batch-sizing flaw; see Method).

## Full Tables (generated by `report.mjs`)

### list suite (µs/op, n = 1000; Chromium 141.0.7390.37; run 1 2026-09-26T11:07:50.817Z, run 2 2026-09-26T11:17:29.479Z)


#### create

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 5760 | 6675 | 6218 | ±34% | ±21% |  |  |  |
| control | 7075 | 5860 | 6467 | ±40% | ±37% | +4.0% | noise | noise |
| baseline@sync | 5400 | 5500 | 5450 | ±31% | ±9% | −12.3% | noise | noise |
| STACK | 4533 | 5060 | 4797 | ±21% | ±15% | −22.9% | noise | real |
| STACK+fuseShared | 5140 | 5440 | 5290 | ±14% | ±10% | −14.9% | noise | noise |
| STACK-C1 | 5440 | 7325 | 6382 | ±58% | ±47% | +2.7% | noise | noise |
| STACK-H7 | 5000 | 5060 | 5030 | ±15% | ±4% | −19.1% | noise | noise |
| STACK-L1 | 4700 | 4867 | 4783 | ±40% | ±10% | −23.1% | noise | real |
| STACK-H8b | 4783 | 4471 | 4627 | ±20% | ±11% | −25.6% | noise | real |
| STACK-SF | 4883 | 4783 | 4833 | ±11% | ±8% | −22.3% | noise | real |
| STACK-H8bLabel | 5380 | 5440 | 5410 | ±8% | ±6% | −13.0% | noise | noise |
| STACK@oracle-sync | 4567 | 4450 | 4508 | ±17% | ±11% | −27.5% | noise | real |

#### replace

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 7475 | 6725 | 7100 | ±23% | ±14% |  |  |  |
| control | 6450 | 7425 | 6937 | ±43% | ±28% | −2.3% | noise | noise |
| baseline@sync | 7400 | 6375 | 6887 | ±36% | ±19% | −3.0% | noise | noise |
| STACK | 5440 | 5700 | 5570 | ±16% | ±12% | −21.5% | noise | real |
| STACK+fuseShared | 5380 | 5560 | 5470 | ±13% | ±6% | −23.0% | noise | real |
| STACK-C1 | 6275 | 5960 | 6117 | ±14% | ±10% | −13.8% | noise | noise |
| STACK-H7 | 5540 | 6650 | 6095 | ±33% | ±23% | −14.2% | noise | noise |
| STACK-L1 | 5660 | 5920 | 5790 | ±32% | ±20% | −18.5% | noise | noise |
| STACK-H8b | 6280 | 5860 | 6070 | ±22% | ±14% | −14.5% | noise | real |
| STACK-SF | 5760 | 6460 | 6110 | ±30% | ±17% | −13.9% | noise | noise |
| STACK-H8bLabel | 6475 | 5680 | 6078 | ±37% | ±21% | −14.4% | noise | noise |
| STACK@oracle-sync | 5380 | 5740 | 5560 | ±42% | ±10% | −21.7% | noise | real |

#### update10th

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 80.4 | 78.1 | 79.3 | ±10% | ±4% |  |  |  |
| control | 79.9 | 79.4 | 79.7 | ±4% | ±2% | +0.5% | noise | noise |
| baseline@sync | 72.3 | 72.3 | 72.3 | ±4% | ±2% | −8.8% | noise | real |
| STACK | 60.5 | 60.2 | 60.4 | ±4% | ±2% | −23.8% | **real** | real |
| STACK+fuseShared | 58.8 | 59.1 | 59.0 | ±4% | ±3% | −25.6% | **real** | real |
| STACK-C1 | 62.7 | 62.2 | 62.4 | ±5% | ±3% | −21.2% | **real** | real |
| STACK-H7 | 73.3 | 74.0 | 73.6 | ±8% | ±3% | −7.1% | noise | real |
| STACK-L1 | 60.7 | 61.1 | 60.9 | ±3% | ±2% | −23.2% | **real** | real |
| STACK-H8b | 60.8 | 60.8 | 60.8 | ±3% | ±2% | −23.3% | **real** | real |
| STACK-SF | 63.9 | 63.7 | 63.8 | ±5% | ±1% | −19.5% | **real** | real |
| STACK-H8bLabel | 65.6 | 61.0 | 63.3 | ±20% | ±11% | −20.1% | **real** | real |
| STACK@oracle-sync | 57.7 | 58.0 | 57.9 | ±6% | ±3% | −27.0% | **real** | real |

#### select

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 157 | 151 | 154 | ±75% | ±6% |  |  |  |
| control | 160 | 155 | 157 | ±13% | ±4% | +2.2% | noise | noise |
| baseline@sync | 149 | 146 | 148 | ±7% | ±4% | −4.0% | noise | noise |
| STACK | 106 | 105 | 106 | ±59% | ±6% | −31.2% | noise | real |
| STACK+fuseShared | 130 | 128 | 129 | ±7% | ±5% | −16.2% | noise | real |
| STACK-C1 | 102 | 105 | 104 | ±9% | ±4% | −32.6% | noise | real |
| STACK-H7 | 109 | 107 | 108 | ±11% | ±5% | −29.9% | noise | real |
| STACK-L1 | 105 | 104 | 104 | ±9% | ±3% | −32.2% | noise | real |
| STACK-H8b | 103 | 105 | 104 | ±46% | ±4% | −32.5% | noise | real |
| STACK-SF | 154 | 153 | 154 | ±9% | ±4% | −0.1% | noise | noise |
| STACK-H8bLabel | 104 | 106 | 105 | ±6% | ±3% | −31.8% | noise | real |
| STACK@oracle-sync | 115 | 116 | 115 | ±43% | ±12% | −25.1% | noise | real |

#### swap

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 117 | 110 | 114 | ±13% | ±8% |  |  |  |
| control | 110 | 110 | 110 | ±10% | ±2% | −3.6% | noise | noise |
| baseline@sync | 110 | 108 | 109 | ±14% | ±6% | −4.3% | noise | noise |
| STACK | 91.9 | 94.1 | 93.0 | ±7% | ±5% | −18.2% | **real** | real |
| STACK+fuseShared | 95.4 | 91.6 | 93.5 | ±12% | ±12% | −17.8% | **real** | real |
| STACK-C1 | 92.3 | 92.9 | 92.6 | ±12% | ±2% | −18.6% | **real** | real |
| STACK-H7 | 94.7 | 96.5 | 95.6 | ±9% | ±7% | −15.9% | **real** | real |
| STACK-L1 | 106 | 114 | 110 | ±33% | ±17% | −3.1% | noise | noise |
| STACK-H8b | 90.3 | 89.0 | 89.6 | ±20% | ±7% | −21.2% | **real** | real |
| STACK-SF | 88.7 | 91.6 | 90.1 | ±8% | ±6% | −20.8% | **real** | real |
| STACK-H8bLabel | 91.9 | 95.1 | 93.5 | ±8% | ±5% | −17.8% | **real** | real |
| STACK@oracle-sync | 90.3 | 93.6 | 91.9 | ±9% | ±5% | −19.2% | **real** | real |

#### removeAdd

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 127 | 130 | 129 | ±22% | ±9% |  |  |  |
| control | 132 | 131 | 131 | ±14% | ±10% | +2.0% | noise | noise |
| baseline@sync | 121 | 120 | 120 | ±8% | ±4% | −6.3% | noise | noise |
| STACK | 89.3 | 92.6 | 90.9 | ±20% | ±6% | −29.3% | **real** | real |
| STACK+fuseShared | 88.0 | 98.4 | 93.2 | ±21% | ±16% | −27.5% | **real** | real |
| STACK-C1 | 97.7 | 97.3 | 97.5 | ±9% | ±5% | −24.2% | **real** | real |
| STACK-H7 | 88.7 | 88.5 | 88.6 | ±19% | ±2% | −31.1% | **real** | real |
| STACK-L1 | 139 | 126 | 133 | ±21% | ±15% | +3.1% | noise | noise |
| STACK-H8b | 88.3 | 91.2 | 89.8 | ±14% | ±8% | −30.2% | **real** | real |
| STACK-SF | 92.3 | 99.6 | 95.9 | ±14% | ±10% | −25.4% | **real** | real |
| STACK-H8bLabel | 87.4 | 86.5 | 87.0 | ±5% | ±3% | −32.4% | **real** | real |
| STACK@oracle-sync | 90.6 | 96.2 | 93.4 | ±44% | ±7% | −27.4% | noise | real |

#### list: summary, mean Δ vs baseline (★ exceeds the strict band; † exceeds only the trimmed band)

| Variant | create | replace | update10th | select | swap | removeAdd |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline (µs) | 6218 | 7100 | 79.3 | 154 | 114 | 129 |
| control | +4.0% | −2.3% | +0.5% | +2.2% | −3.6% | +2.0% |
| baseline@sync | −12.3% | −3.0% | −8.8% † | −4.0% | −4.3% | −6.3% |
| STACK | −22.9% † | −21.5% † | −23.8% ★ | −31.2% † | −18.2% ★ | −29.3% ★ |
| STACK+fuseShared | −14.9% | −23.0% † | −25.6% ★ | −16.2% † | −17.8% ★ | −27.5% ★ |
| STACK-C1 | +2.7% | −13.8% | −21.2% ★ | −32.6% † | −18.6% ★ | −24.2% ★ |
| STACK-H7 | −19.1% | −14.2% | −7.1% † | −29.9% † | −15.9% ★ | −31.1% ★ |
| STACK-L1 | −23.1% † | −18.5% | −23.2% ★ | −32.2% † | −3.1% | +3.1% |
| STACK-H8b | −25.6% † | −14.5% † | −23.3% ★ | −32.5% † | −21.2% ★ | −30.2% ★ |
| STACK-SF | −22.3% † | −13.9% | −19.5% ★ | −0.1% | −20.8% ★ | −25.4% ★ |
| STACK-H8bLabel | −13.0% | −14.4% | −20.1% ★ | −31.8% † | −17.8% ★ | −32.4% ★ |
| STACK@oracle-sync | −27.5% † | −21.7% † | −27.0% ★ | −25.1% † | −19.2% ★ | −27.4% † |

#### list: leave-one-out (STACK−X vs STACK; + means X was helping) (★ strict, † trimmed only)

| Removed | create | replace | update10th | select | swap | removeAdd |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| STACK+fuseShared | +10.3% | −1.8% | −2.4% | +21.8% † | +0.5% | +2.5% |
| STACK-C1 | +33.1% | +9.8% | +3.4% † | −2.1% | −0.4% | +7.2% † |
| STACK-H7 | +4.9% | +9.4% | +21.9% ★ | +1.9% | +2.8% | −2.6% |
| STACK-L1 | −0.3% | +3.9% | +0.9% | −1.5% | +18.6% † | +45.8% ★ |
| STACK-H8b | −3.5% | +9.0% | +0.7% | −1.9% | −3.6% | −1.3% |
| STACK-SF | +0.8% | +9.7% | +5.7% ★ | +45.2% † | −3.1% | +5.5% |
| STACK-H8bLabel | +12.8% | +9.1% | +4.8% | −0.8% | +0.5% | −4.4% |
| STACK@oracle-sync | −6.0% | −0.2% | −4.2% † | +9.0% | −1.1% | +2.7% |

Smallest timed batch in any sample: 25.0 ms.

### rows suite (µs/op, n = 1000; Chromium 141.0.7390.37; run 1 2026-09-26T11:09:45.266Z, run 2 2026-09-26T11:19:22.689Z)


#### mount

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 5043 | 4914 | 4979 | ±10% | ±8% |  |  |  |
| control | 5160 | 5000 | 5080 | ±10% | ±7% | +2.0% | noise | noise |
| baseline@sync | 4817 | 4833 | 4825 | ±9% | ±6% | −3.1% | noise | noise |
| STACK | 4367 | 4317 | 4342 | ±7% | ±5% | −12.8% | **real** | real |
| STACK-H7 | 5060 | 4767 | 4913 | ±16% | ±11% | −1.3% | noise | noise |
| STACK-H8b | 4417 | 4667 | 4542 | ±19% | ±9% | −8.8% | noise | noise |
| STACK-SF | 4483 | 4371 | 4427 | ±7% | ±5% | −11.1% | **real** | real |
| STACK+H8b-class | 4286 | 4243 | 4264 | ±6% | ±4% | −14.3% | **real** | real |
| STACK@oracle-sync | 4483 | 4386 | 4435 | ±8% | ±4% | −10.9% | **real** | real |

#### update10th

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 71.3 | 71.2 | 71.3 | ±5% | ±4% |  |  |  |
| control | 73.1 | 76.7 | 74.9 | ±11% | ±8% | +5.1% | noise | noise |
| baseline@sync | 70.2 | 67.7 | 68.9 | ±40% | ±6% | −3.3% | noise | noise |
| STACK | 58.2 | 61.1 | 59.7 | ±12% | ±9% | −16.3% | **real** | real |
| STACK-H7 | 71.2 | 70.8 | 71.0 | ±14% | ±10% | −0.3% | noise | noise |
| STACK-H8b | 60.4 | 59.9 | 60.1 | ±5% | ±4% | −15.6% | **real** | real |
| STACK-SF | 59.4 | 61.4 | 60.4 | ±8% | ±5% | −15.2% | **real** | real |
| STACK+H8b-class | 58.7 | 57.9 | 58.3 | ±13% | ±4% | −18.2% | **real** | real |
| STACK@oracle-sync | 58.3 | 58.1 | 58.2 | ±42% | ±5% | −18.4% | noise | real |

#### select

| Variant | run 1 | run 2 | mean | band | trimmed band | Δ vs baseline | strict | trimmed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| baseline | 143 | 149 | 146 | ±8% | ±7% |  |  |  |
| control | 138 | 142 | 140 | ±5% | ±4% | −4.1% | noise | noise |
| baseline@sync | 146 | 137 | 141 | ±13% | ±10% | −3.1% | noise | noise |
| STACK | 103 | 102 | 102 | ±17% | ±4% | −29.8% | **real** | real |
| STACK-H7 | 105 | 106 | 105 | ±14% | ±11% | −27.9% | **real** | real |
| STACK-H8b | 108 | 106 | 107 | ±9% | ±6% | −26.7% | **real** | real |
| STACK-SF | 151 | 148 | 149 | ±5% | ±4% | +2.2% | noise | noise |
| STACK+H8b-class | 105 | 102 | 104 | ±13% | ±5% | −29.1% | **real** | real |
| STACK@oracle-sync | 110 | 106 | 108 | ±10% | ±8% | −26.2% | **real** | real |

#### rows: summary, mean Δ vs baseline (★ exceeds the strict band; † exceeds only the trimmed band)

| Variant | mount | update10th | select |
| --- | ---: | ---: | ---: |
| baseline (µs) | 4979 | 71.3 | 146 |
| control | +2.0% | +5.1% | −4.1% |
| baseline@sync | −3.1% | −3.3% | −3.1% |
| STACK | −12.8% ★ | −16.3% ★ | −29.8% ★ |
| STACK-H7 | −1.3% | −0.3% | −27.9% ★ |
| STACK-H8b | −8.8% | −15.6% ★ | −26.7% ★ |
| STACK-SF | −11.1% ★ | −15.2% ★ | +2.2% |
| STACK+H8b-class | −14.3% ★ | −18.2% ★ | −29.1% ★ |
| STACK@oracle-sync | −10.9% ★ | −18.4% † | −26.2% ★ |

#### rows: leave-one-out (STACK−X vs STACK; + means X was helping) (★ strict, † trimmed only)

| Removed | mount | update10th | select |
| --- | ---: | ---: | ---: |
| STACK-H7 | +13.2% † | +19.0% ★ | +2.7% |
| STACK-H8b | +4.6% | +0.7% | +4.5% |
| STACK-SF | +2.0% | +1.2% | +45.7% ★ |
| STACK+H8b-class | −1.8% | −2.4% | +1.0% |
| STACK@oracle-sync | +2.1% | −2.5% | +5.2% |

Smallest timed batch in any sample: 25.0 ms.
