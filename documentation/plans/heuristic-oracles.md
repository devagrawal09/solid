# Heuristic Oracles: Price the Shortcut Before Building the Proof

Status as of 2026-09-26. This is a measurement study, not a feature. Runtime arms exist only behind `__ORACLE__` and are folded out of every shipped build. The `prod`, `sync`, `observe` and `dev` outputs were verified byte-identical to the pre-change build.

## Question

Which runtime shortcuts would be **unsafe in Solid today** but become **safe once a strict compiler proves a fact**? And what is each shortcut worth, measured before any compiler work is done?

Track A built things in the opposite order. It built the compiler proofs (`BLOCK_SYNC`, `BLOCK_NOTHROW`), the code generation and a runtime path, measured afterwards, and found that the proof fired on 0 of 14 real blocks. This study inverts the order:

1. **Oracle.** For each fact, give the runtime a way to *assume* it per node, and hand-write the program with the assumption applied. This uses an `oracle` node option, an effect `equals`, or a source rewrite a compiler would perform. Nothing is proven.
2. **Equivalence gate.** Every oracle variant must produce the same observable trace as the baseline on graphs where the fact holds. The trace covers sink values and effect-phase run counts, or the DOM HTML. A deliberately broken variant is confirmed to fail the gate.
3. **Unsafety.** A test shows ordinary Solid code where the fact is false and the shortcut changes behaviour. This is why the runtime cannot take the shortcut on its own.
4. **Benefit.** Instruction counts (cachegrind, two independent runs) and Chromium wall time for the DOM variants.
5. **Coverage.** A syntactic census of real Solid code: how often could a compiler prove the fact?

Only a heuristic that wins on both benefit and coverage earns a compiler proof.

## Verdicts

| # | Fact the compiler proves | Shortcut it licenses | Benefit (best measured) | Coverage | Verdict |
| --- | --- | --- | --- | --- | --- |
| H1 | A memo's only reader is one tracked computation, and the memo does not escape | Inline the memo into that reader, keeping its equality cut-off | Mount −17% to −39%; chain updates −31% (−56% when both memos fold); todos filter −38%; DOM mount −17% | 29% of memos (24/84) | **Build first** |
| H7 | A JSX child or attribute value is `string \| number` (types) | Text-node `.data` write instead of generic `insert`; no `readShallow` | DOM label update −28%; with H1, select −26% and update −20% | Up to 51% of dynamic parts are children (353/696); the typed share is unmeasured | **Build second** |
| H5 | A computation is synchronous **and** non-throwing | Track A's shipped `statusFree` path | Select −22%, chain update −19%, mount −6% to −8% (stable to 0.03%) | Track A's proof: 0/14 real blocks | **Reopen: the win is real; widen the proof** |
| H2 | No untracked reader observes the memo mid-batch | Commit the memo directly, skipping the staging round-trip | ±2%; chain update −8% | – | Reject |
| H3 | Every source of a node dies with it | Skip unlinking at disposal | Within noise | – | Reject |
| H4 | A signal's setter is never used | Treat the signal as a constant | Mount −2% alone; −24% when its binding also becomes static | 1.5% of signals (2/133) | Reject: no coverage |
| H6 | An element's bindings are pure reads | One effect per element | Mount −24%, but updates +6%; with H1, select +97% | Attributes already grouped by today's compiler | Already done for attributes; do not group fused selections |

The whole-graph async-free runtime (Track A stage 2) is included as a reference point. In the same scenarios it measured mount −8% to −9%, updates −4% to −20% and filter/select −10% to −16%. Per-node H1 beats it on mount; the two compose.

## How Each Shortcut Breaks Ordinary Code

`packages/signals/tests/heuristic-oracles.test.ts` pins these. Each test runs one program with and without the oracle, and asserts the documented divergence.

- **H1.** With two readers, fusing duplicates the compute: a side-effecting or expensive compute runs twice per change. Without the memo's `equals`, the effect phase also fires on unchanged values. The oracle needed a real runtime addition: an effect `equals` (`CONFIG_ORACLE_FUSED`), because effect nodes today never cut off. A syntactic rewrite alone is not equivalent; the equivalence gate caught 200 effect runs instead of 103.
- **H2.** `latest(memo)` in an event handler pulls a recompute. With direct commit, a following plain read returns the fresh derivation while its source still reads the committed value: `a = 1, doubled = 4`. Ordinary Solid never shows that torn frame.
- **H3.** When a source outlives the node, the disposed node stays subscribed. The source retains it (a leak) and its compute re-runs on the next write.

H7 needs no runtime test to show the hazard. An untyped `{x()}` may produce a node, an array or a function, which a text write cannot render. H5's hazard (a throw or pending read on the status-free path) is already covered by Track A's deoptimization tests.

## Results

Raw data is in `documentation/plans/heuristic-oracles/`. The tables were generated by `node scripts/heuristics/report.mjs`.

### Instruction counts (instructions per op, n = 200)

Each cell is the mean of two independent runs. "(noise)" marks a delta within the two cells' combined run-to-run spread. `control@oracle` is the baseline program on the oracle runtime; it prices the oracle arms themselves (≤ 1.7%).

**rows** (js-framework-benchmark shape without the DOM: a label signal, an `isSelected` memo over a shared `selected` signal, text and class render effects):

| Cell | update10th | Δ | mount | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline@prod | 109,502 |  | 1,950,240 |  | 428,299 |  |
| control@oracle | 107,677 | −1.7% (noise) | 1,982,207 | +1.6% | 430,851 | +0.6% |
| baseline@sync | 88,037 | −19.6% | 1,785,645 | −8.4% | 383,643 | −10.4% |
| H1-fuse | 101,680 | −7.1% | 1,197,508 | −38.6% | 380,118 | −11.2% (noise, bimodal) |
| H2-direct | 107,547 | −1.8% (noise) | 1,978,521 | +1.5% | 421,426 | −1.6% |
| H3-local | 106,554 | −2.7% (noise) | 1,934,496 | −0.8% | 426,190 | −0.5% |
| H1+H3 | 101,508 | −7.3% | 1,241,820 | −36.3% | 379,626 | −11.4% (noise, bimodal) |
| H6-group | 115,768 | +5.7% | 1,483,290 | −23.9% | 439,931 | +2.7% |
| H1+H6 | 98,132 | −10.4% | 742,528 | −61.9% | 841,855 | +96.6% |

H1's select cell is bimodal within one build: 329K in one run, then 430K in three further runs. Treat it as "no reliable signal-level select change". Structurally the select work is unchanged: 200 memo recomputes become 200 fused-effect recomputes. The mount win is stable (1.197M and 1.198M across runs and builds).

**chain** (per item `count → scaled → label` memos, one render effect):

| Cell | mount | Δ | update | Δ |
| --- | ---: | ---: | ---: | ---: |
| baseline@prod | 1,878,367 |  | 1,753,433 |  |
| control@oracle | 1,890,979 | +0.7% | 1,764,385 | +0.6% |
| baseline@sync | 1,707,669 | −9.1% | 1,501,558 | −14.4% |
| H1-fuse (label memo) | 1,304,277 | −30.6% | 1,219,009 | −30.5% |
| H1-fuse-all (both memos) | 541,747 | −71.2% | 772,054 | −56.0% |
| H2-direct | 1,915,073 | +2.0% | 1,607,369 | −8.3% |

**todos** (signals per item, a `visible` memo over a shared filter, three render effects, one `remaining` aggregate):

| Cell | toggle | Δ | mount | Δ | filter | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline@prod | 106,984 |  | 2,754,229 |  | 1,021,304 |  |
| control@oracle | 107,010 | +0.0% (noise) | 2,727,872 | −1.0% (noise) | 1,025,258 | +0.4% |
| baseline@sync | 102,345 | −4.3% | 2,541,386 | −7.7% | 860,519 | −15.7% |
| H1-fuse | 106,956 | −0.0% (noise) | 2,297,160 | −16.6% | 628,958 | −38.4% |
| H2-direct | 106,302 | −0.6% | 2,748,896 | −0.2% (noise) | 988,955 | −3.2% |
| H3-local | 107,040 | +0.1% (noise) | 2,771,090 | +0.6% (noise) | 1,023,161 | +0.2% |
| H4-const | 106,969 | −0.0% (noise) | 2,710,379 | −1.6% (noise) | 1,025,866 | +0.4% |
| H4+H5-static | 106,958 | −0.0% (noise) | 2,092,264 | −24.0% | 1,025,252 | +0.4% |
| H1+H4+H5 | 106,927 | −0.1% (noise) | 1,577,758 | −42.7% | 616,812 | −39.6% |

(`H4+H5-static` in this table is the constant-signal binding becoming a one-shot write, not Track A's H5 below.)

**Track A's shipped options, re-measured on the prod runtime** (two runs, spread ≤ 0.03%):

| Scenario | Cell | mount | Δ | update / select | Δ |
| --- | --- | ---: | ---: | ---: | ---: |
| rows | `statusFree` on `isSelected` | 1,827,920 | −6.3% | select 335,687 / update10th 97,342 | −21.6% / −9.3% |
| rows | `syncOnly` | 1,950,980 | +0.0% | select 415,005 / update10th 106,012 | −3.1% / −1.2% |
| chain | `statusFree` on both memos | 1,732,467 | −7.8% | update 1,428,690 | −18.5% |
| chain | `syncOnly` | 1,891,297 | +0.7% | update 1,736,790 | −0.9% |

### DOM rows in Chromium 141 (µs per op, n = 1000, median of 5 fresh pages)

The variants are hand edits of the real compiler's output for `scripts/heuristics/dom/rows.jsx`. Only script time is measured (no layout or paint); wall time is ±5–15%.

| Variant | mount | Δ | update10th | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline (compiler output) | 2535.0 |  | 36.4 |  | 72.8 |  |
| H7-text | 2410.0 | −5% (noise) | 26.1 | −28% | 71.3 | −2% (noise) |
| H7-group (text grouped into the element effect) | 2295.0 | −9% (noise) | 35.9 | −1% (noise) | 63.1 | −13% (noise) |
| H1-fuse | 2100.0 | −17% (noise) | 33.9 | −7% (noise) | 56.8 | −22% |
| H1+H7 | 2145.0 | −15% (noise) | 29.3 | −20% | 54.0 | −26% |
| control (oracle runtime) | 2510.0 | −1% (noise) | 35.6 | −2% (noise) | 69.5 | −5% (noise) |

### Coverage census

`scripts/heuristics/census.mjs` covers 206 files with Solid code: this repo's `examples/`, `solid-realworld`, `solid-hackernews`, `solid-devtools` and `solid-docs`. Per-corpus data is in `census-*.json`. The census is syntactic and file-local. It over-approximates what a sound proof accepts in one way (it assumes no aliasing through helpers) and under-approximates in another (cross-file readers count as escapes).

| Fact | Count |
| --- | --- |
| Memos with exactly one tracked reader (H1) | 24 / 84 (29%); 12 shared, 35 escaped (returned from hooks or passed to components), 12 read inside unknown callbacks |
| Signals whose setter is never used (H4) | 2 / 133 (1.5%) |
| Dynamic DOM parts that are children (H7 upper bound) | 353 / 696 (51%); the rest are attributes, which the compiler already groups per element |
| Dynamic parts sitting on an element with ≥ 2 parts (H6) | 271 / 696 (39%), in 120 elements |

## What Each Heuristic Needs From the Compiler

- **H1 memo fusion** needs the local reader graph of a `const m = createMemo(...)`:
  - exactly one read;
  - inside a tracked host (a JSX binding or the compute of an effect or memo);
  - no escape (passed, returned, stored, or read in an unknown callback).

  The strict summaries already record reads per host and capability escapes. The runtime part is one bit: an effect that keeps its fused memo's `equals`.

  Two rules come from the data:
  - Do not fuse into a grouped attribute effect. Once grouped, the memo's cut-off no longer shields the other parts, and H1+H6 select doubled (+97%).
  - Fusion of memos into memos (`H1-fuse-all`) is the largest single win measured, at −71% mount.
- **H7 typed text** needs `solid-tsc` types at JSX children and attributes: `string | number` means text. This is a typed-summary fact, not a syntactic one, and it is exactly the class the strict plan reserves for `solid-tsc`. It also removes `readShallow` for typed string attributes. The census cannot yet measure the typed share of the 353 children; that is the next measurement.
- **H5 status-free** needs a wider NOTHROW proof. The benefit is real; Track A's rule refused every call, member access and store read. Typed domains (`string.trim()`, array `length`, plain-object property reads) are the obvious extension, and they come from the same `solid-tsc` types as H7.

## Measurement Findings

- **Warmups too short for steady state.** Track A's instruction-count harness used 20 mount and 100 update warmups. Under `--predictable --single-threaded`, per-op time still swung 10–100× between windows after 100 update warmups; it is flat by 2000 (mount by about 300). This harness uses 300/2000 with 40/80-op windows. Re-measured this way, Track A's `statusFree` flips from "slower (+6% to +19%)" to faster (−6% to −22%). Track A's stage-1 verdict should be revisited with its own scenarios under these warmups.
- **Instruction counts depend on machine load.** Even under `--predictable`, V8's GC heuristics are time-based. `update10th` baselines ranged 96.7K–111.7K when other work shared the machine, but held to ≤ 0.03% on an idle machine. Run the harness alone.
- **JIT outcomes can be bimodal.** H1's rows/select produced two stable values from one build (see the rows table). Any cell whose runs disagree is flagged "(noise)", not reported as a win.
- **A workspace `turbo` build cleans `packages/signals/dist` mid-run.** The harness now measures from a per-process snapshot of the runtime trees.

## Reproduce

```sh
pnpm --filter @solidjs/signals build          # dist/prod, dist/sync
node scripts/heuristics/build.mjs             # dist/oracle (never published)
node scripts/heuristics/equivalence.mjs       # oracle variants == baseline
node scripts/heuristics/icount.mjs --out documentation/plans/heuristic-oracles/icount.json
node scripts/heuristics/icount.mjs --out documentation/plans/heuristic-oracles/icount-repeat.json
node scripts/heuristics/icount.mjs --scenarios rows,chain \
  --cells baseline@prod,H5-statusFree@prod,H5-syncOnly@prod --out documentation/plans/heuristic-oracles/icount-h5.json
# DOM: needs `rollup -c` in packages/solid and the @solidjs/web build
node scripts/heuristics/dom/bench.mjs --n 1000 --reps 5
node scripts/heuristics/census.mjs <dir>... --out census.json
node scripts/heuristics/report.mjs
cd packages/signals && npx vitest run tests/heuristic-oracles.test.ts
```

Environment: Node v22.22.2, Valgrind 3.22 (`cachegrind --cache-sim=no`), Chromium 141.0.7390.37 headless via Playwright 1.56.1, a shared 4-core cloud VM.

## Limits

- Three signal-level scenarios and one DOM scenario are chosen to exercise each fact where it holds. They show what a heuristic is worth *per site*. Application-level wins scale with coverage, which is why the census exists.
- The signal-level scenarios exclude DOM cost. The DOM bench excludes layout and paint, and covers one list shape.
- Hydration, SSR, stores and async are not exercised. H7 during hydration needs the claim path, which the oracle variants skip.
- The census is syntactic, file-local and small (206 files).
