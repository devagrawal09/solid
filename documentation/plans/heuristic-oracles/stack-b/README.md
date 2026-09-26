# Heuristic Oracles, Stack B: More Realistic Shapes

Status: 2026-09-26. This is a measurement study that extends `../../heuristic-oracles.md`. Nothing under `packages/` was changed. All code is in `scripts/heuristics/stack-b/`, and all raw data is next to this file.

It answers four questions:

1. Does modelling selection as a projection make the shared-source fusion question moot?
2. Which fusion policy should a compiler use?
3. How do fusion and detached nodes behave under hydration-style ids?
4. What do the licensed heuristics buy a real app (TodoMVC)?

## Answers

1. **Yes, the projection makes the question moot.** One `createProjection` keyed by id flips only the old and new row.
   - Select drops **−85%** at signal level (428K → 63K instructions per op, n = 200) and **−91%** in Chromium (157 → 13 µs, n = 1000).
   - Fusing the per-row memo gives −23% at signal level but +36% in the DOM.
   - With a projection there is no per-row memo left to fuse, so the fusion question disappears.
   - The price is mount: **+20%** at signal level (+12% once H8b is added to the label binding). DOM `replace` was −8% and DOM `create` was within noise.
   - The projection's gain holds on every runtime tested: prod, oracle and statusFree.
2. **Policy (b), fuse local-source single-reader memos, is the right default.** It never lost more than 5% on any op and won large where the local chains are:
   - chain: mount −29%, update −31%;
   - dashboard: mount −21%, tick −58%.

   On these signal-level graphs, policy (c) (fuse every single-reader memo) was at least as good as (b) on every op. Examples: todos filter −50% vs +1%; dashboard unit −45% vs +2%; rows select −23% vs +0.6%. The only measured evidence against (c) is the DOM selection result (+36%, reproduced here). So (b) stays the safe rule, and (c) is unproven headroom for shared sources that update every reader, such as a filter or a unit. It needs a DOM check before it is adopted.
3. **Ids amplify both wins; H8b roughly doubles.** Compare (b)+H8b against the same program without and with a root id:

   | Scenario | Mount Δ, no id | Mount Δ, with ids |
   | --- | ---: | ---: |
   | rows | −11% | −16% |
   | todos | −8% | −18% |
   | chain | −37% | −42% |
   | dashboard | −29% | −31% |

   Fusion alone gains a little under ids (for example chain −29% → −32%). Updates are unchanged by ids or H8b.
4. **The licensed heuristics buy almost nothing measurable across the whole app** (DOM, real compiler, Chromium).
   - Only three facts hold in `examples/todos`:
     - C1: inline `TodoItem`;
     - L1: rows are single elements;
     - H7: typed text, which needs `solid-tsc` types.
   - None of the oracle-runtime facts hold:
     - there are no memos (H1);
     - every row reads a shared store (H8b);
     - the real store is async (H5).
   - With all three applied: add −7%. Mount, toggle, filter and clear-completed were all within noise.
   - The app's cost is its unmemoized O(n) store scans. Memoizing them by hand (not a compiler heuristic) cut toggle −58%, add −30% and clear-completed −23%.

## Variant definitions

**Cells** are named `program@runtime`.

**Runtimes** are snapshots of `packages/signals/dist/{prod,oracle}` taken per process:
- `prod` is the shipped runtime.
- `oracle` is prod plus the `__ORACLE__` arms.
- `control` / `a@oracle` run an unmodified program on the oracle runtime. They price the arms themselves: +1% to +2% on mount.

**Oracles:**

| Tag | What the program does | Licensed when |
| --- | --- | --- |
| fuse (H1) | Memo removed; its only tracked reader computes the expression with `equals: same`, which sets FUSED | The memo has exactly one tracked reader and does not escape |
| DET (H8b) | `oracle: OWNERLESS \| DETACHED` | Creates nothing, has no cleanup, reads no context, and every source dies with the node |
| OWN (H8a) | `oracle: OWNERLESS` | Creates nothing, has no cleanup, reads no context |
| SF | Track A's `statusFree` option (sync and non-throwing) | Proven synchronous and non-throwing |
| ids | `createRoot(fn, { id: "r" })`, so every node formats an id (SSR/hydration trees) | – |

**Q1 (`sel`, rows with selection, n = 200).** Each row has a label signal with a text binding, and a class binding for "is selected".
- Selection models:
  - `memo`: a per-row `isSel = createMemo(() => selected() === id)` (today's shape);
  - `fused`: H1 applied to that memo, a shared source;
  - `proj`: `createProjection(draft => { const s = selected(); if (prev !== undefined && prev !== s) delete draft[prev]; if (s >= 0) draft[s] = true; prev = s; }, {})`, with rows reading `isSelected[id]`. This is the idiom of the "selection" test in `packages/signals/tests/store/createProjection.test.ts`.
- Stacks:
  - `+SF`: statusFree on every compute, including render effects.
  - `+SFmemo`: statusFree on the memo only, which is Track A's placement.
  - `+stack` (planned): DET on the label binding and on the memo's reader, OWN on nodes that read a shared source, and SF on everything.
  - `+stack2` (refined after run 1 showed SF on effects and OWN are losses): DET where it qualifies, and SF on memos only.

**Q2/Q3 policies.**
- (a): no fusion.
- (b): fuse single-reader memos whose sources are all local, meaning created under the same scope and dying with it.
- (c): fuse every single-reader memo.
- `+H8b`: DET on every node that qualifies. Nodes reading a shared source never get it.

Scenarios:
- **rows**: the `isSel` memo reads the shared `selected`, so (b) fuses nothing and (b) ≡ (a).
- **chain**: `count` (shared) → `scaled` → `label` → binding. (b) fuses `label`; (c) also fuses `scaled`.
- **todos**: `visible` reads the shared filter, so it is fused under (c) only. The root `remaining` aggregate reads only item signals from the same root and has one reader, so it is fused under (b) and (c).
- **dash** (new): a monitoring dashboard. It has three shared sources (range, unit, threshold), and each widget has two local signals and five memos:

  | Memo | Sources | Readers | (b) | (c) |
  | --- | --- | --- | --- | --- |
  | `scaled` | raw, range* | display, alert, total (3) | – | – |
  | `title` | name | 1 | fuse | fuse |
  | `bar` | raw | 1 | fuse | fuse |
  | `display` | scaled, unit* | 1 | – | fuse |
  | `alert` | scaled, threshold* | class, note binding, overCount (3) | – | – |
  | `note` | raw | 1, read only when `alert()` (the conditional read) | fuse | fuse |
  | root `total` | every `scaled` | 1 | fuse | fuse |
  | root `overCount` | every `alert` | 2 | – | – |

  `*` marks a shared source. The ops are: tick (10% of raw values), range, threshold, unit and rename. All state is bounded and deterministic. `b[widget-only]` and `b[total-only]` are attribution cells.

**Q4 (DOM, `examples/todos`).** `dom/todos-app.jsx` ports `src/app.tsx` verbatim: the component tree, every binding, `Errored`/`Loading`/`Show`/`For`, the per-item error `<Show>`, and the plain-function derivations. Only the data layer changed: the async optimistic store and actions became a synchronous `createStore`, and each action applies just its optimistic write. The hash listener became a setter, and ids come from a counter. The seed is n = 1000 todos, with every third one completed.

It is compiled by the real native compiler (`transform(src, {generate: "dom"})`) and run in Chromium 141 over a cross-origin-isolated local server, which gives fine timers. Each op has an untimed setup and restore, so the state stays bounded:
- `add` adds a todo, then an untimed restore removes it.
- `clearCompleted` clears, then an untimed restore puts the original list back.

The heuristic audit (details in `dom/todos-variants.mjs`):

| Heuristic | Holds? | Why |
| --- | --- | --- |
| H1 fuse | no | The app has zero `createMemo`. `todos-blocks` has four memos, but each has several readers or escapes (`For each`, `Show when`, an event handler). |
| H8b | no | Every row binding reads the shared todos store; a row's store node outlives the row (filtering). |
| H5 SF | no | The real store is an async optimistic projection; reads can be pending. |
| H8a | no | Client render has no ids; H8a alone is a loss there (round 2). |
| C1 inline `TodoItem` | yes | One call site, same file. |
| L1 single-element rows | yes | `TodoItem` renders one `<li>`. |
| H7 typed text | yes, by types | `title: string`, `remaining(): number`, `"item" \| "items"`. This is typed text writes, not the type-derived static props the lead rejected. |

`author-memo` is **not a heuristic**. It is an author change (three `createMemo`s around the app's scans), measured only to size what is left on the table.

**Q1 in the DOM** (`dom/sel-variants.mjs`) reuses round 2's `<For>` + `Row` suite read-only:
- `baseline` (per-row memo via props) and `C2-fuse` (inline plus shared-source fusion) come from round 2;
- `proj` (one projection) and `proj+C1` (projection with `Row` inlined) are new.

## Verification that each oracle fired

- **Runtime probe** (`probe.mjs` → `probe.json`). On the oracle snapshot:
  - a DET effect survives its root's disposal and re-runs;
  - an OWN memo leaves the root's next child id unchanged (`p0`/`p0`);
  - a fused `equals` effect skips an equal value.

  On prod, none of the three happens (`p0`/`p1`).
- **Module check** (`equivalence.json`, `markers`). Each generated module is grepped for its edit, and a missing marker fails the cell. For example:
  - dash b: 4 fused effects and 3 memos, versus 8 memos in (a);
  - dash b+H8b: 9 DET nodes;
  - sel memo+stack: 2 DET, 1 OWN, 3 statusFree.
- **DOM variants.** `bench.mjs` refuses to run a variant whose edit string is missing: `__forNodes(`, `_t$.data = v`, `createProjection(`, `equals: (a, b) => a === b`, and so on. It prints each one as `fired …` in the log.
- **Negative control.** The same cell with `equals` removed diverges from the baseline wherever the fused value can repeat (sel, rows c, todos c). That shows the gate catches a plain syntactic inline.

## Equivalence gate

- **Signal level** (`equivalence.mjs`): 48 cells. Each trace covers mount twice, then 7 rounds of every op, recording sink values plus effect-phase run counts, compared against the scenario's first cell. **All 48 pass.** The projection cells pass against the memo baseline, so the projection is observably identical, run counts included.
- **DOM:** `innerHTML` after mount, after every op and after every restore, over 3 rounds. **All variants pass** in every run (`gate` in each `dom-*.json`).

## Method

- **Instruction counts:** the `icount.mjs` method.
  - cachegrind with `--cache-sim=no`; node with `--predictable --single-threaded`;
  - warmups of 300 mount and 2000 update;
  - (40, 80)-op differencing, n = 200.
- **Pinning and runs:** every process was pinned with `taskset -c 2,3` and ran at most 2 valgrind jobs. Every cell ran twice in independent processes (`icount-run1/2.json`; supplementary cells in `icount-extra`, `-attr` and `-stack2`, `-1/-2`).
- **Stability:** 142 of 142 main cells agreed within 0.3%, except the tiny dash `rename` op (about 2.4K instructions).
- **Reruns:** three cells differed by more than 1%. Each got 3 more runs (`icount-rerun-*.json`) and is reported as a distribution.
- **Noise flag:** "(noise)" means |Δ of means| ≤ the sum of the two cells' run-to-run spreads.
- **DOM:** the median of 5 fresh pages per run, two runs, with the same noise rule on the two medians.

## Results

### Q1: selection as a projection

Signal level, instructions per op, n = 200. The reference is memo@prod, and each value is the mean of two runs.

| Cell | mount | Δ | update10th | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| memo@prod | 1,950,253 | | 99,817 | | 428,413 | |
| memo+SFmemo@prod | 1,827,941 | −6.3% | 91,074 | −8.8% | 338,034 | −21.1% |
| memo+SF@prod (SF on effects too) | 2,330,493 | **+19.5%** | 99,730 | −0.1% | 410,472 | −4.2% |
| memo(control)@oracle | 1,992,809 | +2.2% | 99,240 | −0.6% | 430,968 | +0.6% |
| memo+stack@oracle | 2,162,112 | +10.9% | 99,753 | −0.1% | 410,581 | −4.2% |
| memo+stack2@oracle | 1,603,685 | −17.8% | 89,828 | −10.0% | 334,764 | −21.9% |
| fused@oracle | 1,206,962 | −38.1% | 103,275 | +3.5% | 329,422 | −23.1% |
| fused+stack@oracle | 1,392,086 | −28.6% | 93,295 | −6.5% | 330,167 | −22.9% |
| fused+stack2@oracle | 1,144,550 | −41.3% | 103,365 (n=5, 102.9K–104.0K) | +3.6% | 329,348 | −23.1% |
| **proj@prod** | 2,342,805 | +20.1% | 104,156 | +4.3% | **63,079** | **−85.3%** |
| proj+SF@prod | 2,525,017 | +29.5% | 94,374 | −5.5% | 68,761 | −83.9% |
| proj(control)@oracle | 2,336,902 | +19.8% | 103,854 | +4.0% | 62,914 | −85.3% |
| proj+stack@oracle | 2,403,876 | +23.3% | 94,378 | −5.4% | 69,798 | −83.7% |
| proj+stack2@oracle | 2,181,337 | +11.8% | 98,687 | −1.1% | 62,930 | −85.3% |

Run-to-run spread was ≤ 0.3% in every cell except fused+stack2 update10th, which is bimodal at 102.9K–104.0K over 5 runs.

DOM, `<For>` + `Row`, n = 1000, µs per op. The means of two runs are shown; per-run values are in the appendix.

| Variant | create | Δ | replace | Δ | update10th | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline (memo) | 8436.7 | | 7181.8 | | 80.1 | | 156.7 | |
| C2-fuse (shared-source fusion) | 4720.8 | −44% (noise) | 6089.3 | −15% | 73.7 | −8% (noise) | 213.0 | **+36%** |
| proj | 7048.8 | −17% (noise) | 6636.9 | −8% | 76.9 | −4% (noise) | **13.4** | **−91%** |
| proj+C1 | 5858.5 | −31% (noise) | 7052.1 | −2% (noise) | 77.5 | −3% (noise) | 13.7 | −91% |
| control (oracle runtime) | 8917.5 | +6% (noise) | 7679.4 | +7% (noise) | 82.2 | +3% (noise) | 163.1 | +4% |

`create` has a ±25–40% spread in both runs, as in round 2.

**Answer to Q1.** The projection turns select from n recomputes into 2. On the fastest runtime cell for each model, select is:
- memo: 334K (stack2);
- fused: 329K;
- projection: 63K.

The projection wins by 5× regardless of runtime, which makes "should we fuse a memo over a shared source?" irrelevant for selection. It also removes the only case where fusion measured a DOM regression.

The cost is mount at signal level: +20% (proj@prod), cut to +12% with H8b on the label binding. In the DOM this cost does not show (replace −8%, create within noise). A plausible cause, not proven here, is that each row's `isSelected[id]` read of an absent key creates a per-key tracked node in the projection store.

On the statusFree runtime, statusFree only helps when it sits on memos. Put on render effects, it costs about +19–30% mount and gives back most of the memo's select gain (memo+SF select −4% vs memo+SFmemo −21%).

### Q2: fusion policy

Instructions per op, n = 200, Δ vs a@prod, means of two runs. Run-to-run spread is ≤ 0.3% except where noted.

| Scenario | Op | a@prod | a@oracle | b@oracle | c@oracle |
| --- | --- | ---: | ---: | ---: | ---: |
| rows | mount | 1,950,234 | +2.2% | +2.2% (b ≡ a) | −38.1% |
| rows | update10th | 99,824 | −0.8% | −0.8% | +3.5% |
| rows | select | 428,404 | +0.6% | +0.6% | −23.1% |
| chain | mount | 1,854,066 | +1.3% | −29.1% | −70.5% |
| chain | update | 1,752,708 | +0.6% | −30.5% | −56.0% |
| todos | mount | 2,729,111 | −0.5% | +1.5% | −29.7% |
| todos | toggle | 106,946 | +0.1% (noise) | −3.4% | −15.0% |
| todos | filter | 1,020,864 | +0.4% | +1.0% | −49.7% |
| dash | mount | 8,165,930 | +1.2% | −21.4% | −28.6% |
| dash | tick | 1,666,713 | +0.1% | −57.9% | −60.1% |
| dash | threshold | 478,403 | +0.4% | +5.3% | +5.3% |
| dash | unit | 1,351,343 | +0.4% | +2.0% | −45.2% |
| dash | range | 3,807,092 | +0.3% | −7.0% | −21.8% |
| dash | rename | 2,334 (n=5) | −0.7% (noise) | +4.6% | +3.7% |

Dash attribution (both runs agree):
- `b[widget-only]` (title, bar and note fused): tick −58.0%, mount −21.4%, range +0.7%.
- `b[total-only]`: tick +0.5%, mount +1.8%, range −6.6%.

So the tick and mount wins come from the three per-widget local memos, each worth a comparable share (an indicative wall-time split gave about 20% each for note and bar). The range win comes from the root aggregate.

**Answer to Q2.** Policy (b) is safe and profitable:
- It never costs more than +5% on any op. The losses are +5.3% on dash threshold (the fused conditional binding now computes `raw*7%13` itself when `alert` flips) and +4.6% on the ~2.4K-instruction rename.
- It wins wherever local chains exist.
- It correctly does nothing on rows, whose only memo is selection. With selection modelled as a projection, that memo does not exist anyway.

Policy (c) dominated (b) on every signal-level op measured here, including rows select (−23%, stable in both runs; the round-1 bimodality did not recur). The risk that justifies (b) is DOM-only: shared-source fusion made DOM select +36% (round 2, reproduced above).

The shared-source memos that (c) additionally fuses here (todos `visible`, dash `display`) are of the "every reader changes" kind: filter and unit flip all rows. Fusing them does not multiply work. So (c) looks like safe extra headroom *for shared sources whose change touches every reader*. That is not a fact a compiler can see locally, so it needs a DOM measurement before it is adopted. Selection-like fan-out should go to a projection instead.

### Q3: hydration-style ids

Mount instructions per op. The non-id cells are compared with a@prod and the id cells with a-ids@prod. Updates are in the appendix; ids and H8b change them by ≤ 1.2%.

| Scenario | a@prod | b | b+H8b | a-ids@prod (vs a@prod) | b-ids | b+H8b-ids |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| rows | 1,950,234 | +2.2% | −11.2% | 2,206,557 (+13.1%) | +3.8% | **−15.8%** |
| chain | 1,854,066 | −29.1% | −36.8% | 2,193,291 (+18.3%) | −31.9% | **−41.9%** |
| todos | 2,729,111 | +1.5% | −7.9% | 3,123,806 (+14.5%) | −0.6% | **−17.8%** |
| dash | 8,165,930 | −21.4% | −28.9% | 9,252,143 (+13.3%) | −23.6% | **−31.2%** |

**Answer to Q3.**
- Ids cost 13–18% of mount.
- Fusion alone recovers slightly more under ids, since fewer nodes format an id: chain −29% → −32%, dash −21% → −24%.
- H8b's increment over (b) grows under ids:
  - rows: −13 points → −20 points;
  - todos: −9 → −17;
  - chain: −8 → −10;
  - dash: −7.5 → −7.6.
- With ids, (b)+H8b recovers more than the whole cost of the ids in three of four scenarios.
- One regression: `b-ids@oracle` on rows is +3.8%. That is the oracle arms' own mount cost (+2.2% client) with nothing fused. It does not come from the ids.

### Q4: the todos app (DOM)

Chromium 141, n = 1000, µs per op. Means of two runs; the Δ is vs baseline.

| Variant | mount | add | toggle | filter | clear-completed |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 21,484 | 4,400 | 1,625 | 9,248 | 7,023 |
| C1-inline | +9.3% (noise) | −6.8% | −2.8% (noise) | −3.6% (noise) | +1.9% (noise) |
| L1-nodes | +0.1% (noise) | −5.8% | −3.7% (noise) | +7.2% (noise) | −2.8% (noise) |
| H7-text (types) | +2.3% (noise) | −2.3% (noise) | +2.0% (noise) | −0.1% (noise) | −12.5% |
| C1+L1 (no types) | +3.4% (noise) | +1.9% (noise) | −3.4% (noise) | −14.0% (noise) | −6.5% (noise) |
| **C1+L1+H7 (everything licensed)** | +6.3% (noise) | **−6.6%** | +0.1% (noise) | −2.2% (noise) | −6.0% (noise) |
| *author-memo (not a heuristic; separate runs, own baseline)* | *+26.5%* | *−30.0%* | *−57.9%* | *−4.5% (noise)* | *−23.4%* |

**Answer to Q4.** This was measured in the DOM, compiled by the real compiler. Every heuristic whose fact holds (C1, L1, H7) was applied, and the whole-app gain is add −7%; mount, toggle, filter and clear-completed are within noise.
- The single-heuristic columns are inconsistent with the stacked ones (for example C1+L1 add +1.9% while C1 and L1 alone are each −6%). That is the signature of noise at the 5–10% level, not composition.
- The heuristics that measured big per-site wins (H1, H8b, H5) do not apply at all: the app has no memos, every row reads a shared store, and the store is async.
- Time goes to the app's own derivations. `remaining()` is read three times, and `allCompleted`, `completed` and `filtered` each rescan the 1000-item store on every change. For example, one toggle is about 1.6 ms.
- Memoizing them by hand cuts toggle −58%, add −30% and clear-completed −23%. It costs +27% mount; the reason is not investigated, and it is plausibly the memos' own subscription sets. No licensed heuristic reaches that.

## Surprising or broken, stated plainly

- **statusFree on render effects is a net loss.** On effects it costs about +950 instructions per effect at mount (+19.5% in `sel`, +29.5% with the projection). It also cancels most of the memo's select win: −4.2% select with SF on memo and effects, vs −21% with SF on the memo alone. Track A's placement (memos only) reproduces its published numbers exactly: mount −6.3%, select −21.1%, update −8.8%. The "stacked" cells that followed the plan literally (`+stack`) were therefore worse than `+stack2`. The report keeps both.
- **H8a (OWN) is still a client-side loss** when stacked. It is part of why `+stack` lost to `+stack2`.
- **The projection's mount cost** is real at signal level (+20%) but invisible in the DOM. The cause was not isolated.
- **Signal level and DOM disagree about shared-source fusion.** Signal level shows −23% select, stable in both runs; the DOM shows +36%, reproduced in both runs. The signal harness omits whatever makes a fused DOM class-binding recompute expensive. Signal-level wins for policy (c) should not be trusted until they are checked in the DOM.
- **A fused conditional binding moves work when its condition flips.** This shows as dash threshold +5.3%. It is the cost side of the conditional-read case: a fused memo read under `alert() ?` stops being computed while hidden (part of the tick win) but is computed inline when shown.
- **The todos port is not the real app's data layer.** The async optimistic store, actions and error side channel were replaced by a synchronous store. The render graph and every binding are verbatim.
- **Wall-time noise in the DOM** (±5–37% per run) hides anything under about 10% at the whole-app level. Instruction counts for the DOM app were not attempted.
- **Nothing was broken:** every gate passed, the probe confirmed every bit, and nothing under `packages/` was touched. The shared `documentation/plans/heuristic-oracles.md` changed on disk during this run; that was the other agent, not this study.

## Reproduce

```sh
S=scripts/heuristics/stack-b
taskset -c 2,3 node $S/probe.mjs
taskset -c 2,3 node $S/equivalence.mjs --out equivalence.json
taskset -c 2,3 node $S/icount.mjs --out icount-run1.json      # then icount-run2.json
taskset -c 2,3 node $S/icount.mjs --scenarios sel --cells memo+SFmemo@prod --out icount-extra-1.json   # and -2
taskset -c 2,3 node $S/icount.mjs --scenarios dash --cells "b[widget-only]@oracle,b[total-only]@oracle" --out icount-attr-1.json  # and -2
taskset -c 2,3 node $S/icount.mjs --scenarios sel --cells memo+stack2@oracle,fused+stack2@oracle,proj+stack2@oracle --out icount-stack2-1.json  # and -2
taskset -c 2,3 node $S/dom/bench.mjs --suite sel --out dom-sel-1.json        # and -2
taskset -c 2,3 node $S/dom/bench.mjs --suite todos --out dom-todos-1.json    # and -2
taskset -c 2,3 node $S/dom/bench.mjs --suite todos --variants baseline,author-memo --out dom-todos-memo-1.json  # and -2
node $S/report.mjs      # appendix tables
```

Environment: Node v22.22.2, Valgrind 3.22, Chromium 141.0.7390.37 (Playwright), 4-core VM with all work on CPUs 2–3.

## Appendix: full tables (generated by `report.mjs`)


#### sel (Q1) — instructions per op, n = 200, ref = memo@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| memo@prod | update10th | 99,830 | 99,804 | 99,817 |  | ref |
| memo+SF@prod | update10th | 99,710 | 99,749 | 99,730 | −0.1% |  |
| memo+SFmemo@prod | update10th | 91,070 | 91,078 | 91,074 | −8.8% |  |
| memo(control)@oracle | update10th | 99,243 | 99,236 | 99,240 | −0.6% |  |
| memo+stack@oracle | update10th | 99,753 | 99,752 | 99,753 | −0.1% |  |
| fused@oracle | update10th | 103,294 | 103,255 | 103,275 | +3.5% |  |
| fused+stack@oracle | update10th | 93,300 | 93,289 | 93,295 | −6.5% |  |
| memo+stack2@oracle | update10th | 89,798 | 89,857 | 89,828 | −10.0% |  |
| fused+stack2@oracle | update10th | 104,008 | 102,936 | 103,365 (n=5) | +3.6% | bimodal: 104,008 / 102,936 / 103,009 / 103,048 / 103,824 |
| proj+stack2@oracle | update10th | 98,759 | 98,614 | 98,687 | −1.1% |  |
| proj@prod | update10th | 104,310 | 104,001 | 104,156 | +4.3% |  |
| proj+SF@prod | update10th | 94,369 | 94,379 | 94,374 | −5.5% |  |
| proj(control)@oracle | update10th | 103,835 | 103,872 | 103,854 | +4.0% |  |
| proj+stack@oracle | update10th | 94,379 | 94,377 | 94,378 | −5.4% |  |
| memo@prod | mount | 1,950,241 | 1,950,265 | 1,950,253 |  | ref |
| memo+SF@prod | mount | 2,330,473 | 2,330,512 | 2,330,493 | +19.5% |  |
| memo+SFmemo@prod | mount | 1,827,939 | 1,827,943 | 1,827,941 | −6.3% |  |
| memo(control)@oracle | mount | 1,992,813 | 1,992,804 | 1,992,809 | +2.2% |  |
| memo+stack@oracle | mount | 2,162,111 | 2,162,112 | 2,162,112 | +10.9% |  |
| fused@oracle | mount | 1,206,961 | 1,206,963 | 1,206,962 | −38.1% |  |
| fused+stack@oracle | mount | 1,392,089 | 1,392,082 | 1,392,086 | −28.6% |  |
| memo+stack2@oracle | mount | 1,603,645 | 1,603,724 | 1,603,685 | −17.8% |  |
| fused+stack2@oracle | mount | 1,145,025 | 1,144,074 | 1,144,550 | −41.3% |  |
| proj+stack2@oracle | mount | 2,181,337 | 2,181,337 | 2,181,337 | +11.8% |  |
| proj@prod | mount | 2,342,817 | 2,342,792 | 2,342,805 | +20.1% |  |
| proj+SF@prod | mount | 2,525,032 | 2,525,001 | 2,525,017 | +29.5% |  |
| proj(control)@oracle | mount | 2,336,895 | 2,336,908 | 2,336,902 | +19.8% |  |
| proj+stack@oracle | mount | 2,403,889 | 2,403,863 | 2,403,876 | +23.3% |  |
| memo@prod | select | 428,469 | 428,357 | 428,413 |  | ref |
| memo+SF@prod | select | 410,478 | 410,466 | 410,472 | −4.2% |  |
| memo+SFmemo@prod | select | 338,038 | 338,029 | 338,034 | −21.1% |  |
| memo(control)@oracle | select | 430,968 | 430,967 | 430,968 | +0.6% |  |
| memo+stack@oracle | select | 410,572 | 410,589 | 410,581 | −4.2% |  |
| fused@oracle | select | 329,418 | 329,425 | 329,422 | −23.1% |  |
| fused+stack@oracle | select | 330,174 | 330,159 | 330,167 | −22.9% |  |
| memo+stack2@oracle | select | 334,712 | 334,815 | 334,764 | −21.9% |  |
| fused+stack2@oracle | select | 329,363 | 329,332 | 329,348 | −23.1% |  |
| proj+stack2@oracle | select | 62,929 | 62,931 | 62,930 | −85.3% |  |
| proj@prod | select | 63,134 | 63,023 | 63,079 | −85.3% |  |
| proj+SF@prod | select | 68,728 | 68,793 | 68,761 | −83.9% |  |
| proj(control)@oracle | select | 62,925 | 62,903 | 62,914 | −85.3% |  |
| proj+stack@oracle | select | 69,831 | 69,764 | 69,798 | −83.7% |  |

#### rows (Q2) — ref = a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 1,950,248 | 1,950,220 | 1,950,234 |  | ref |
| a@oracle | mount | 1,992,772 | 1,992,780 | 1,992,776 | +2.2% |  |
| b@oracle | mount | 1,992,806 | 1,992,788 | 1,992,797 | +2.2% |  |
| c@oracle | mount | 1,206,959 | 1,206,983 | 1,206,971 | −38.1% |  |
| a@prod | update10th | 99,835 | 99,812 | 99,824 |  | ref |
| a@oracle | update10th | 99,062 | 99,057 | 99,060 | −0.8% |  |
| b@oracle | update10th | 99,068 | 99,059 | 99,064 | −0.8% |  |
| c@oracle | update10th | 103,350 | 103,344 | 103,347 | +3.5% |  |
| a@prod | select | 428,493 | 428,314 | 428,404 |  | ref |
| a@oracle | select | 430,921 | 430,927 | 430,924 | +0.6% |  |
| b@oracle | select | 430,922 | 430,913 | 430,918 | +0.6% |  |
| c@oracle | select | 329,402 | 329,400 | 329,401 | −23.1% |  |

#### rows (Q3) — ids cells vs a-ids@prod, others vs a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 1,950,248 | 1,950,220 | 1,950,234 |  | ref |
| b@oracle | mount | 1,992,806 | 1,992,788 | 1,992,797 | +2.2% |  |
| b+H8b@oracle | mount | 1,731,519 | 1,731,567 | 1,731,543 | −11.2% |  |
| a-ids@prod | mount | 2,206,544 | 2,206,570 | 2,206,557 |  | ref |
| b-ids@oracle | mount | 2,291,125 | 2,291,094 | 2,291,110 | +3.8% |  |
| b+H8b-ids@oracle | mount | 1,858,179 | 1,858,191 | 1,858,185 | −15.8% |  |
| a@prod | update10th | 99,835 | 99,812 | 99,824 |  | ref |
| b@oracle | update10th | 99,068 | 99,059 | 99,064 | −0.8% |  |
| b+H8b@oracle | update10th | 97,809 | 97,779 | 97,794 | −2.0% |  |
| a-ids@prod | update10th | 96,712 | 96,622 | 96,667 |  | ref |
| b-ids@oracle | update10th | 96,729 | 96,694 | 96,712 | +0.0% | (noise) |
| b+H8b-ids@oracle | update10th | 97,788 | 97,821 | 97,805 | +1.2% |  |
| a@prod | select | 428,493 | 428,314 | 428,404 |  | ref |
| b@oracle | select | 430,922 | 430,913 | 430,918 | +0.6% |  |
| b+H8b@oracle | select | 426,213 | 426,202 | 426,208 | −0.5% |  |
| a-ids@prod | select | 428,292 | 428,315 | 428,304 |  | ref |
| b-ids@oracle | select | 430,926 | 430,907 | 430,917 | +0.6% |  |
| b+H8b-ids@oracle | select | 427,302 | 427,279 | 427,291 | −0.2% |  |

#### chain (Q2) — ref = a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 1,854,071 | 1,854,061 | 1,854,066 |  | ref |
| a@oracle | mount | 1,877,819 | 1,877,766 | 1,877,793 | +1.3% |  |
| b@oracle | mount | 1,313,703 | 1,313,688 | 1,313,696 | −29.1% |  |
| c@oracle | mount | 546,981 | 546,948 | 546,965 | −70.5% |  |
| a@prod | update | 1,752,692 | 1,752,724 | 1,752,708 |  | ref |
| a@oracle | update | 1,763,939 | 1,763,974 | 1,763,957 | +0.6% |  |
| b@oracle | update | 1,217,647 | 1,217,600 | 1,217,624 | −30.5% |  |
| c@oracle | update | 770,343 | 770,350 | 770,347 | −56.0% |  |

#### chain (Q3) — ids cells vs a-ids@prod, others vs a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 1,854,071 | 1,854,061 | 1,854,066 |  | ref |
| b@oracle | mount | 1,313,703 | 1,313,688 | 1,313,696 | −29.1% |  |
| b+H8b@oracle | mount | 1,172,087 | 1,172,116 | 1,172,102 | −36.8% |  |
| a-ids@prod | mount | 2,193,284 | 2,193,297 | 2,193,291 |  | ref |
| b-ids@oracle | mount | 1,493,551 | 1,493,473 | 1,493,512 | −31.9% |  |
| b+H8b-ids@oracle | mount | 1,274,131 | 1,274,114 | 1,274,123 | −41.9% |  |
| a@prod | update | 1,752,692 | 1,752,724 | 1,752,708 |  | ref |
| b@oracle | update | 1,217,647 | 1,217,600 | 1,217,624 | −30.5% |  |
| b+H8b@oracle | update | 1,217,645 | 1,217,619 | 1,217,632 | −30.5% |  |
| a-ids@prod | update | 1,751,793 | 1,751,512 | 1,751,653 |  | ref |
| b-ids@oracle | update | 1,217,547 | 1,217,572 | 1,217,560 | −30.5% |  |
| b+H8b-ids@oracle | update | 1,217,503 | 1,217,473 | 1,217,488 | −30.5% |  |

#### todos (Q2) — ref = a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 2,729,094 | 2,729,128 | 2,729,111 |  | ref |
| a@oracle | mount | 2,716,668 | 2,716,699 | 2,716,684 | −0.5% |  |
| b@oracle | mount | 2,769,928 | 2,769,980 | 2,769,954 | +1.5% |  |
| c@oracle | mount | 1,919,391 | 1,919,396 | 1,919,394 | −29.7% |  |
| a@prod | toggle | 106,989 | 106,902 | 106,946 |  | ref |
| a@oracle | toggle | 107,019 | 107,040 | 107,030 | +0.1% | (noise) |
| b@oracle | toggle | 103,325 | 103,312 | 103,319 | −3.4% |  |
| c@oracle | toggle | 90,928 | 90,961 | 90,945 | −15.0% |  |
| a@prod | filter | 1,020,910 | 1,020,818 | 1,020,864 |  | ref |
| a@oracle | filter | 1,025,239 | 1,025,271 | 1,025,255 | +0.4% |  |
| b@oracle | filter | 1,031,515 | 1,031,544 | 1,031,530 | +1.0% |  |
| c@oracle | filter | 513,972 | 513,953 | 513,963 | −49.7% |  |

#### todos (Q3) — ids cells vs a-ids@prod, others vs a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 2,729,094 | 2,729,128 | 2,729,111 |  | ref |
| b@oracle | mount | 2,769,928 | 2,769,980 | 2,769,954 | +1.5% |  |
| b+H8b@oracle | mount | 2,514,091 | 2,514,110 | 2,514,101 | −7.9% |  |
| a-ids@prod | mount | 3,123,819 | 3,123,792 | 3,123,806 |  | ref |
| b-ids@oracle | mount | 3,105,924 | 3,105,968 | 3,105,946 | −0.6% |  |
| b+H8b-ids@oracle | mount | 2,566,812 | 2,566,792 | 2,566,802 | −17.8% |  |
| a@prod | toggle | 106,989 | 106,902 | 106,946 |  | ref |
| b@oracle | toggle | 103,325 | 103,312 | 103,319 | −3.4% |  |
| b+H8b@oracle | toggle | 103,245 | 103,273 | 103,259 | −3.4% |  |
| a-ids@prod | toggle | 106,960 | 106,954 | 106,957 |  | ref |
| b-ids@oracle | toggle | 103,271 | 103,248 | 103,260 | −3.5% |  |
| b+H8b-ids@oracle | toggle | 103,143 | 103,125 | 103,134 | −3.6% |  |
| a@prod | filter | 1,020,910 | 1,020,818 | 1,020,864 |  | ref |
| b@oracle | filter | 1,031,515 | 1,031,544 | 1,031,530 | +1.0% |  |
| b+H8b@oracle | filter | 1,031,266 | 1,031,280 | 1,031,273 | +1.0% |  |
| a-ids@prod | filter | 1,020,820 | 1,020,937 | 1,020,879 |  | ref |
| b-ids@oracle | filter | 1,031,252 | 1,031,258 | 1,031,255 | +1.0% |  |
| b+H8b-ids@oracle | filter | 1,031,338 | 1,031,289 | 1,031,314 | +1.0% |  |

#### dash (Q2) — ref = a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 8,165,920 | 8,165,940 | 8,165,930 |  | ref |
| a@oracle | mount | 8,263,899 | 8,263,888 | 8,263,894 | +1.2% |  |
| b@oracle | mount | 6,415,740 | 6,415,732 | 6,415,736 | −21.4% |  |
| b[widget-only]@oracle | mount | 6,419,397 | 6,419,384 | 6,419,391 | −21.4% |  |
| b[total-only]@oracle | mount | 8,309,984 | 8,310,034 | 8,310,009 | +1.8% |  |
| c@oracle | mount | 5,834,179 | 5,834,201 | 5,834,190 | −28.6% |  |
| a@prod | tick | 1,666,689 | 1,666,737 | 1,666,713 |  | ref |
| a@oracle | tick | 1,668,458 | 1,668,471 | 1,668,465 | +0.1% |  |
| b@oracle | tick | 701,617 | 701,628 | 701,623 | −57.9% |  |
| b[widget-only]@oracle | tick | 700,919 | 700,768 | 700,844 | −58.0% |  |
| b[total-only]@oracle | tick | 1,675,822 | 1,675,671 | 1,675,747 | +0.5% |  |
| c@oracle | tick | 665,538 | 665,553 | 665,546 | −60.1% |  |
| a@prod | threshold | 478,360 | 478,445 | 478,403 |  | ref |
| a@oracle | threshold | 480,517 | 480,519 | 480,518 | +0.4% |  |
| b@oracle | threshold | 503,697 | 503,684 | 503,691 | +5.3% |  |
| b[widget-only]@oracle | threshold | 503,766 | 503,570 | 503,668 | +5.3% |  |
| b[total-only]@oracle | threshold | 494,638 | 494,656 | 494,647 | +3.4% |  |
| c@oracle | threshold | 503,691 | 503,709 | 503,700 | +5.3% |  |
| a@prod | unit | 1,351,442 | 1,351,244 | 1,351,343 |  | ref |
| a@oracle | unit | 1,356,715 | 1,356,735 | 1,356,725 | +0.4% |  |
| b@oracle | unit | 1,378,652 | 1,378,705 | 1,378,679 | +2.0% |  |
| b[widget-only]@oracle | unit | 1,379,784 | 1,378,845 | 1,379,315 | +2.1% |  |
| b[total-only]@oracle | unit | 1,378,455 | 1,378,438 | 1,378,447 | +2.0% |  |
| c@oracle | unit | 740,693 | 740,688 | 740,691 | −45.2% |  |
| a@prod | range | 3,807,047 | 3,807,137 | 3,807,092 |  | ref |
| a@oracle | range | 3,817,986 | 3,817,986 | 3,817,986 | +0.3% |  |
| b@oracle | range | 3,542,207 | 3,542,200 | 3,542,204 | −7.0% |  |
| b[widget-only]@oracle | range | 3,834,456 | 3,834,474 | 3,834,465 | +0.7% |  |
| b[total-only]@oracle | range | 3,554,511 | 3,555,338 | 3,554,925 | −6.6% |  |
| c@oracle | range | 2,975,272 | 2,975,298 | 2,975,285 | −21.8% |  |
| a@prod | rename | 2,337 | 2,324 | 2,334 (n=5) |  | ref |
| a@oracle | rename | 2,311 | 2,325 | 2,318 | −0.7% | (noise) |
| b@oracle | rename | 2,439 | 2,443 | 2,441 | +4.6% |  |
| b[widget-only]@oracle | rename | 2,443 | 2,437 | 2,440 | +4.6% |  |
| b[total-only]@oracle | rename | 2,344 | 2,311 | 2,322 (n=5) | −0.5% | (noise), bimodal: 2,344 / 2,311 / 2,310 / 2,331 / 2,316 |
| c@oracle | rename | 2,419 | 2,423 | 2,421 | +3.7% |  |

#### dash (Q3) — ids cells vs a-ids@prod, others vs a@prod

| Cell | Op | run 1 | run 2 | mean | Δ vs ref | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| a@prod | mount | 8,165,920 | 8,165,940 | 8,165,930 |  | ref |
| b@oracle | mount | 6,415,740 | 6,415,732 | 6,415,736 | −21.4% |  |
| b+H8b@oracle | mount | 5,803,393 | 5,803,479 | 5,803,436 | −28.9% |  |
| a-ids@prod | mount | 9,252,133 | 9,252,153 | 9,252,143 |  | ref |
| b-ids@oracle | mount | 7,066,938 | 7,066,878 | 7,066,908 | −23.6% |  |
| b+H8b-ids@oracle | mount | 6,368,723 | 6,368,714 | 6,368,719 | −31.2% |  |
| a@prod | tick | 1,666,689 | 1,666,737 | 1,666,713 |  | ref |
| b@oracle | tick | 701,617 | 701,628 | 701,623 | −57.9% |  |
| b+H8b@oracle | tick | 695,751 | 695,758 | 695,755 | −58.3% |  |
| a-ids@prod | tick | 1,667,027 | 1,667,089 | 1,667,058 |  | ref |
| b-ids@oracle | tick | 701,512 | 701,529 | 701,521 | −57.9% |  |
| b+H8b-ids@oracle | tick | 695,631 | 695,639 | 695,635 | −58.3% |  |
| a@prod | threshold | 478,360 | 478,445 | 478,403 |  | ref |
| b@oracle | threshold | 503,697 | 503,684 | 503,691 | +5.3% |  |
| b+H8b@oracle | threshold | 499,844 | 499,846 | 499,845 | +4.5% |  |
| a-ids@prod | threshold | 478,521 | 478,474 | 478,498 |  | ref |
| b-ids@oracle | threshold | 503,731 | 503,697 | 503,714 | +5.3% |  |
| b+H8b-ids@oracle | threshold | 499,825 | 499,844 | 499,835 | +4.5% |  |
| a@prod | unit | 1,351,442 | 1,351,244 | 1,351,343 |  | ref |
| b@oracle | unit | 1,378,652 | 1,378,705 | 1,378,679 | +2.0% |  |
| b+H8b@oracle | unit | 1,363,503 | 1,363,523 | 1,363,513 | +0.9% |  |
| a-ids@prod | unit | 1,351,197 | 1,351,247 | 1,351,222 |  | ref |
| b-ids@oracle | unit | 1,377,201 | 1,377,192 | 1,377,197 | +1.9% |  |
| b+H8b-ids@oracle | unit | 1,363,607 | 1,363,584 | 1,363,596 | +0.9% |  |
| a@prod | range | 3,807,047 | 3,807,137 | 3,807,092 |  | ref |
| b@oracle | range | 3,542,207 | 3,542,200 | 3,542,204 | −7.0% |  |
| b+H8b@oracle | range | 3,517,545 | 3,517,539 | 3,517,542 | −7.6% |  |
| a-ids@prod | range | 3,807,698 | 3,807,453 | 3,807,576 |  | ref |
| b-ids@oracle | range | 3,555,247 | 3,555,241 | 3,555,244 | −6.6% |  |
| b+H8b-ids@oracle | range | 3,517,316 | 3,517,316 | 3,517,316 | −7.6% |  |
| a@prod | rename | 2,337 | 2,324 | 2,334 (n=5) |  | ref |
| b@oracle | rename | 2,439 | 2,443 | 2,441 | +4.6% |  |
| b+H8b@oracle | rename | 2,426 | 2,400 | 2,430 (n=5) | +4.1% | bimodal: 2,426 / 2,400 / 2,443 / 2,434 / 2,448 |
| a-ids@prod | rename | 2,322 | 2,300 | 2,311 |  | ref |
| b-ids@oracle | rename | 2,434 | 2,447 | 2,441 | +5.6% |  |
| b+H8b-ids@oracle | rename | 2,436 | 2,429 | 2,433 | +5.3% |  |

#### DOM sel — µs per op, n = 1000, median of 5 pages per run (141.0.7390.37, isolated=true)

| Variant | Op | run 1 | run 2 | mean | Δ vs baseline | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| baseline | create | 10553.3 | 6320.0 | 8436.7 |  | ref |
| C2-fuse | create | 5129.0 | 4312.5 | 4720.8 | −44.0% | (noise) |
| proj | create | 7118.7 | 6978.8 | 7048.8 | −16.5% | (noise) |
| proj+C1 | create | 5901.0 | 5816.0 | 5858.5 | −30.6% | (noise) |
| control | create | 8521.7 | 9313.3 | 8917.5 | +5.7% | (noise) |
| baseline | replace | 7282.5 | 7081.0 | 7181.8 |  | ref |
| C2-fuse | replace | 6456.7 | 5722.0 | 6089.3 | −15.2% |  |
| proj | replace | 6503.7 | 6770.0 | 6636.9 | −7.6% |  |
| proj+C1 | replace | 8036.2 | 6068.0 | 7052.1 | −1.8% | (noise) |
| control | replace | 8535.0 | 6823.7 | 7679.4 | +6.9% | (noise) |
| baseline | update10th | 82.3 | 77.9 | 80.1 |  | ref |
| C2-fuse | update10th | 75.6 | 71.7 | 73.7 | −8.0% | (noise) |
| proj | update10th | 75.4 | 78.4 | 76.9 | −4.0% | (noise) |
| proj+C1 | update10th | 78.9 | 76.2 | 77.5 | −3.2% | (noise) |
| control | update10th | 80.3 | 84.2 | 82.2 | +2.7% | (noise) |
| baseline | select | 157.4 | 156.1 | 156.7 |  | ref |
| C2-fuse | select | 208.6 | 217.4 | 213.0 | +35.9% |  |
| proj | select | 16.0 | 10.7 | 13.4 | −91.5% |  |
| proj+C1 | select | 16.3 | 11.1 | 13.7 | −91.3% |  |
| control | select | 164.6 | 161.5 | 163.1 | +4.1% |  |

#### DOM todos — µs per op, n = 1000, median of 5 pages per run (141.0.7390.37, isolated=true)

| Variant | Op | run 1 | run 2 | mean | Δ vs baseline | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| baseline | mount | 21285.0 | 21682.5 | 21483.8 |  | ref |
| C1-inline | mount | 24700.0 | 22245.0 | 23472.5 | +9.3% | (noise) |
| L1-nodes | mount | 21682.5 | 21347.5 | 21515.0 | +0.1% | (noise) |
| H7-text | mount | 20737.5 | 23235.0 | 21986.3 | +2.3% | (noise) |
| C1+L1 | mount | 23312.5 | 21095.0 | 22203.7 | +3.4% | (noise) |
| C1+L1+H7 | mount | 20827.5 | 24862.5 | 22845.0 | +6.3% | (noise) |
| baseline | add | 4422.5 | 4377.5 | 4400.0 |  | ref |
| C1-inline | add | 4171.7 | 4031.4 | 4101.5 | −6.8% |  |
| L1-nodes | add | 4115.0 | 4173.6 | 4144.3 | −5.8% |  |
| H7-text | add | 4350.0 | 4250.8 | 4300.4 | −2.3% | (noise) |
| C1+L1 | add | 4527.5 | 4441.7 | 4484.6 | +1.9% | (noise) |
| C1+L1+H7 | add | 4153.6 | 4068.6 | 4111.1 | −6.6% |  |
| baseline | toggle | 1671.3 | 1578.4 | 1624.8 |  | ref |
| C1-inline | toggle | 1615.3 | 1543.8 | 1579.6 | −2.8% | (noise) |
| L1-nodes | toggle | 1603.8 | 1525.3 | 1564.5 | −3.7% | (noise) |
| H7-text | toggle | 1682.7 | 1632.2 | 1657.4 | +2.0% | (noise) |
| C1+L1 | toggle | 1567.5 | 1571.6 | 1569.5 | −3.4% | (noise) |
| C1+L1+H7 | toggle | 1616.6 | 1636.3 | 1626.4 | +0.1% | (noise) |
| baseline | filter | 8356.7 | 10140.0 | 9248.3 |  | ref |
| C1-inline | filter | 7677.5 | 10151.7 | 8914.6 | −3.6% | (noise) |
| L1-nodes | filter | 8381.7 | 11448.3 | 9915.0 | +7.2% | (noise) |
| H7-text | filter | 7751.3 | 10731.7 | 9241.5 | −0.1% | (noise) |
| C1+L1 | filter | 7485.0 | 8418.3 | 7951.7 | −14.0% | (noise) |
| C1+L1+H7 | filter | 8633.8 | 9452.5 | 9043.1 | −2.2% | (noise) |
| baseline | clearCompleted | 6860.0 | 7185.0 | 7022.5 |  | ref |
| C1-inline | clearCompleted | 6768.8 | 7545.0 | 7156.9 | +1.9% | (noise) |
| L1-nodes | clearCompleted | 6330.0 | 7328.7 | 6829.4 | −2.8% | (noise) |
| H7-text | clearCompleted | 6019.0 | 6269.0 | 6144.0 | −12.5% |  |
| C1+L1 | clearCompleted | 6292.5 | 6843.8 | 6568.1 | −6.5% | (noise) |
| C1+L1+H7 | clearCompleted | 6251.2 | 6955.0 | 6603.1 | −6.0% | (noise) |

#### DOM todos-memo — µs per op, n = 1000, median of 5 pages per run (141.0.7390.37, isolated=true)

| Variant | Op | run 1 | run 2 | mean | Δ vs baseline | flag |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| baseline | mount | 23702.5 | 22942.5 | 23322.5 |  | ref |
| author-memo | mount | 31617.5 | 27387.5 | 29502.5 | +26.5% |  |
| baseline | add | 4248.3 | 4206.7 | 4227.5 |  | ref |
| author-memo | add | 2960.0 | 2957.8 | 2958.9 | −30.0% |  |
| baseline | toggle | 1616.6 | 1595.3 | 1605.9 |  | ref |
| author-memo | toggle | 662.6 | 688.4 | 675.5 | −57.9% |  |
| baseline | filter | 8396.7 | 8676.7 | 8536.7 |  | ref |
| author-memo | filter | 7962.5 | 8341.3 | 8151.9 | −4.5% | (noise) |
| baseline | clearCompleted | 6491.2 | 7468.8 | 6980.0 |  | ref |
| author-memo | clearCompleted | 5118.0 | 5572.0 | 5345.0 | −23.4% |  |
