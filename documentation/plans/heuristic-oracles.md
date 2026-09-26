# Heuristic Oracles: Price the Shortcut Before Building the Proof

Status as of 2026-09-26 (rounds 2 and 3 added the same day). This is a measurement study, not a feature. Runtime arms exist only behind `__ORACLE__` and are folded out of every shipped build. The `prod`, `sync`, `observe` and `dev` outputs were verified byte-identical to the pre-change build.

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
| H8b | A compute owns nothing and its sources die with it | Never link it into the owner tree | Mount −5% to −8%; −18% with hydration ids; with H1, −47% | – | **Build with H1** (round 2) |
| C2 | Fusion across a component boundary (component inlined) | H1 applied to memos passed as props | replace −19%, update −7%; select +34% when the memo reads a shared source | Most of the 35 "escaped" memos in the census escape only as props | **Build, local sources only** (round 2) |
| L1 | Each list row renders one element | Skip flatten/normalize before the DOM reconciler | swap −15%, remove/insert −23% | – | **Build** (round 2) |
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

## Round 2: Owners, Component Boundaries and Lists

Oracles added after the first verdicts. The keyed-selector rewrite and type-driven static props were considered and not tested. The selection pattern belongs in a projection rather than being compiled away. Static props would lean on types that a runtime value can violate, forcing a throw or a deopt.

| # | Fact the compiler proves | Shortcut | Result | Verdict |
| --- | --- | --- | --- | --- |
| H8a | The compute creates no primitives, registers no cleanup and reads no context | Take no child id from the parent | Client-only mount +4% to +6% (the check costs more than an id that is nearly free); id-carrying trees −6% to −8% | Only as part of H8b |
| H8b | H8a, plus every source dies with the node and there is no effect cleanup | Never link the node into its parent (no owner-tree insert, no disposal visit, no id) | Mount −5% to −8% client-only, **−18% to −19% with ids** (SSR/hydration trees); updates unchanged | **Build**, alongside H1 |
| H1+H8b | Both | Both | rows mount −40% client-only, **−47% with ids** | The two compose |
| C1 | A component is known, pure and called from one site | Inline it (no props object, no getter indirection) | replace −7%, other ops within noise | Enabler only |
| C2 | C1, plus the per-row memo's only reader is now local | Fuse the memo across the former component boundary | replace −19%, create −18%, update10th −7%; **select +34%** | **Build, but not for memos over a shared source** (see below) |
| L1 | Every row renders exactly one element | Mapped nodes go straight to the DOM reconciler (no flatten/normalize/dispatch) | swap −15%, remove/insert −23%; create, replace and updates within noise | **Build** for structural list updates |

Unsafety tests for H8 are in `tests/heuristic-oracles.test.ts`:
- a memo marked ownerless that does create children loses its hydration id scope;
- a detached effect's compute-phase cleanup never runs;
- a detached node reading a surviving source keeps running after disposal.

**Cross-component fusion and shared sources.** Fusing `isSel = createMemo(() => selected() === row.id)` into the row's class binding removes a node per row (mount −19%). But every selection now recomputes 1,000 binding effects instead of 1,000 cheap memos plus 2 effects. An effect recompute costs more than a memo recompute, so select is +34%, reproducible across two runs. The rows suite without components measured the opposite (−22%), and the signal-level select cell is bimodal. So the select direction is not settled, but the risk is. Rule: fuse when the memo reads only row-local sources; keep the memo, or move to a projection, when it reads a source shared across many rows. That fact (where the source was created) is local to the compiler.

### Round 2 data

H8 instruction counts (two runs each; `*-ids` roots carry an id, as SSR and hydration trees do):

##### rows (instructions per op, n = 200)

| Cell | update10th | Δ | mount | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline@prod | 106,705 |  | 1,950,223 |  | 428,289 |  |
| control@oracle | 105,629 | −1.0% | 1,992,806 | +2.2% | 430,917 | +0.6% |
| H1-fuse@oracle | 101,972 | −4.4% | 1,207,416 | −38.1% | 429,749 | +0.3% |
| H8a-ownerless@oracle | 101,180 | −5.2% | 2,061,711 | +5.7% | 430,303 | +0.5% |
| H8b-detached@oracle | 101,299 | −5.1% | 1,798,511 | −7.8% | 430,329 | +0.5% |
| H1+H8b@oracle | 102,130 | −4.3% | 1,171,535 | −39.9% | 429,443 | +0.3% |

Run-to-run spread: update10th max 0.4%, mount max 0.1%, select max 0.0%.

##### chain (instructions per op, n = 200)

| Cell | mount | Δ | update | Δ |
| --- | ---: | ---: | ---: | ---: |
| baseline@prod | 1,878,319 |  | 1,752,779 |  |
| control@oracle | 1,902,576 | +1.3% | 1,763,665 | +0.6% |
| H1-fuse@oracle | 1,313,278 | −30.1% | 1,219,166 | −30.4% |
| H8a-ownerless@oracle | 1,954,925 | +4.1% | 1,755,252 | +0.1% |
| H8b-detached@oracle | 1,793,041 | −4.5% | 1,755,273 | +0.1% |

Run-to-run spread: mount max 0.1%, update max 0.0%.

##### todos (instructions per op, n = 200)

| Cell | mount | Δ | toggle | Δ | filter | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline@prod | 2,729,133 |  | 106,956 |  | 1,020,856 |  |
| control@oracle | 2,716,658 | −0.5% | 106,975 | +0.0% (noise) | 1,025,149 | +0.4% |
| H1-fuse@oracle | 2,306,156 | −15.5% | 107,057 | +0.1% | 631,819 | −38.1% |
| H8a-ownerless@oracle | 2,844,536 | +4.2% | 107,028 | +0.1% | 1,021,875 | +0.1% |
| H8b-detached@oracle | 2,506,302 | −8.2% | 106,999 | +0.0% | 1,021,839 | +0.1% |

Run-to-run spread: mount max 0.0%, toggle max 0.0%, filter max 0.2%.

##### rows-ids (instructions per op, n = 200)

| Cell | update10th | Δ | mount | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline@prod | 99,085 |  | 2,206,538 |  | 428,307 |  |
| control@oracle | 98,890 | −0.2% (noise) | 2,291,170 | +3.8% | 430,938 | +0.6% |
| H1-fuse@oracle | 102,915 | +3.9% | 1,401,242 | −36.5% | 329,410 | −23.1% |
| H8a-ownerless@oracle | 101,444 | +2.4% | 2,064,331 | −6.4% | 430,245 | +0.5% |
| H8b-detached@oracle | 101,329 | +2.3% | 1,801,070 | −18.4% | 430,270 | +0.5% |
| H1+H8b@oracle | 102,204 | +3.1% | 1,171,918 | −46.9% | 429,512 | +0.3% |

Run-to-run spread: update10th max 0.6%, mount max 0.0%, select max 0.1%.

##### todos-ids (instructions per op, n = 200)

| Cell | toggle | Δ | mount | Δ | filter | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline@prod | 106,994 |  | 3,123,869 |  | 1,020,896 |  |
| control@oracle | 106,950 | −0.0% (noise) | 3,146,559 | +0.7% | 1,025,173 | +0.4% |
| H1-fuse@oracle | 107,037 | +0.0% (noise) | 2,563,700 | −17.9% | 636,539 | −37.6% |
| H8a-ownerless@oracle | 107,019 | +0.0% (noise) | 2,884,121 | −7.7% | 1,021,913 | +0.1% |
| H8b-detached@oracle | 106,976 | −0.0% (noise) | 2,543,359 | −18.6% | 1,021,809 | +0.1% |

Run-to-run spread: toggle max 0.1%, mount max 0.0%, filter max 0.0%.

##### <For> + Row component in Chromium 141.0.7390.37 (µs per op, n = 1000, mean of two runs × median of 5 pages)

| Variant | create | Δ | replace | Δ | update10th | Δ | select | Δ | swap | Δ | removeAdd | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 5220.8 |  | 5787.5 |  | 76.9 |  | 148.5 |  | 105.1 |  | 118.6 |  |
| C1-inline | 4672.5 | −11% (noise) | 5358.3 | −7% (noise) | 76.2 | −1% (noise) | 156.3 | +5% (noise) | 107.3 | +2% (noise) | 112.8 | −5% (noise) |
| C2-fuse | 4294.6 | −18% (noise) | 4675.0 | −19% | 71.5 | −7% | 199.6 | +34% | 105.3 | +0% (noise) | 112.6 | −5% (noise) |
| L1-nodes | 5216.7 | −0% (noise) | 5660.0 | −2% (noise) | 75.5 | −2% (noise) | 146.6 | −1% (noise) | 89.6 | −15% | 91.5 | −23% |
| C2+L1 | 4120.8 | −21% (noise) | 4673.3 | −19% (noise) | 70.1 | −9% (noise) | 197.9 | +33% | 90.1 | −14% | 84.8 | −28% |
| control | 5929.2 | +14% (noise) | 5995.0 | +4% (noise) | 78.2 | +2% (noise) | 151.3 | +2% (noise) | 102.8 | −2% (noise) | 118.1 | −0% (noise) |

`create` has a wide spread in both runs (±31% baseline); read `replace` for the create-path effect.

## Round 3: Async Status, Stores, Actions and the Runtime's Answer

Rounds 1–2 priced heuristics on the memo/effect graph and the DOM. Round 3 covers the rest of the stack: the async status channel, stores and actions. It adds one column the earlier rounds lacked. For every heuristic the **runtime-only alternative** was tried as well, to check the claim that a compiler is needed. Where the runtime can close the gap, that is recorded as the answer.

Method as before: hand-written oracle variants (`scripts/heuristics/r3/scenarios.mjs`), an equivalence gate (`r3/check.mjs`), instruction counts (`r3/icount.mjs`, two runs), and unsafety tests in `tests/heuristic-oracles.test.ts`. Runtime-only alternatives are either shipped API (a projection, the path helpers) or runtime patches judged by the full `@solidjs/signals` suite.

| # | Fact the compiler proves | Shortcut | Compiler result | Runtime-only alternative | Runtime result | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| H9 | Nobody inspects a memo's pending status (no untracked or event read, no `isPending`/`latest`); only its readers' status reaches a boundary | Pass pending notifications through the memo without marking it | Refetch −13% to −15%; mount unchanged. With H1 (the memo fused away): **mount −43%, refetch −44%** | (a) Make every memo transparent. (b) A single-slot pending source instead of a `Set` | (a) **44 of 1,885 tests fail** (optimistic, `isPending`, equality, `on`, reveal order, transitions). (b) Tried upstream and reverted over a stranded-pending bug (#2893). A pull-based status redesign would be needed; not prototyped | **Build with H1**; alone it is modest |
| H13 | Every read site in a block is a `yield*` | Suspend by returning a sentinel instead of throwing `NotReadyError` | Bound: a throw costs about 1,300 instructions more than a sentinel return (micro-benchmark), about 8% of async mount here | None. A plain function compute can only be unwound by throwing | – | Low priority; priced, not built |
| S1 | A store never escapes compiled reads; paths are exact | Handle reads (`readHandle*`, no proxy) | mount +6%, update10th −2%, select −10% | Path helpers on proxies (`readPath1`) | ±4% | **Reject as measured**: the proxy is not where store mount goes |
| S2 | A store has a literal shape, never escapes, is never reconciled, has no dynamic keys, and its setter is local | Scalar replacement: one signal per field | **mount −76%, update10th −67%, select −29%** | Cut store constant factors: `createTarget`'s WeakMap registration costs about 5,000 instructions per object (about 12% of store mount); a non-enumerable stamp costs about 2,400 | About 6% of store mount recoverable; the rest is structural (target, proxy and node per field) | **Build**, but coverage is 2 of 15 stores (13%) in the corpus |
| S4 | No writer (path setter, draft assignment, reconcile, replacement) reaches a store path | Read the field once, untracked; static output | mount −20%, update10th −7% | None. A setter anywhere can write the path later | – | Per-site win; coverage 0 of 33 keys file-local (the target, `row.id` in list rows, crosses component boundaries) |
| A1 | An action body has no `yield` and no `await` | Run it as a plain batch that returns a settled promise | **−15% per call** (two writes, 400 readers) | R5: run the first slice in the ambient batch and create the transaction only at the first yield | **9 tests fail**: first-slice store, optimistic and `until()` state is not adopted by the late transaction | **Build**: the proof is syntactic and cheap |
| Sel | (H1 on a per-row selection memo) | Fuse `selected() === id` into the row effect | mount −56%, select −25% | A selection projection (shipped API) | **select −85%**, mount +28% | **Runtime wins on select**; the compiler wins on mount. Use both: fuse row-local memos, project shared selections |

### What the runtime already does lazily

The compiler adds nothing where the runtime already maintains a channel on demand. Code reading confirmed these:

- optimistic lanes, via the sticky `CONFIG_HAS_LANE` mark;
- the cold extension `_x`, which holds error, pending sources and snapshots;
- `isPending`/`latest` companions and snapshots, allocated on first use;
- context lookup, an O(1) inherited object;
- in-order dependency reuse in `link`, O(1) per read, so a "static deps" heuristic has little left to take;
- `NotReadyError` stack capture, already disabled in prod.

On the DOM side, today's compiler already splits static style keys and groups attribute bindings into one effect (checked by compiling a probe component). The eagerly maintained channel with real cost is **status propagation**: settling, `notifyStatus`, and adding and removing pending sources account for about 38% of refetch self time in a CPU profile.

### Unsafety and equivalence tests (round 3)

- **H9.** Equivalent when only the boundary and effects observe status, including a refetch that lands on an equal value. `isPending(row)` mid-flight reads `true` in ordinary Solid and `false` under the oracle.
- **A1.** Equivalent with an optimistic write in the body, and when the body writes a node an in-flight async action holds (both entangle the same way). The runtime cannot choose this form, because it learns the body was synchronous only after running it. R5 shows that adopting the first slice afterwards is not equivalent.
- **S4.** Equivalent when nothing writes the field; one write anywhere makes the static read stale.
- **S2** needs no test: an escaping store (spread, `JSON.stringify`, passing it to a helper, `reconcile`) observes the object graph that scalar replacement removes.

### Round 3 data

Two runs per cell. async-rows pairs runs 2 and 3, because the H9 oracle gained its settle-walk pass-through after run 1 (run 1 measured refetch −23% without it, which is the incomplete oracle). `sync-source` is not an equivalent program. It is the floor, the same update with no async machinery. It shows that async status costs 2.3× (refetch) to 3.6× (mount) a sync update of the same graph.

##### async-rows (instructions per op, n = 200)

| Cell | mount | Δ | refetch | Δ |
| --- | ---: | ---: | ---: | ---: |
| baseline@prod | 6,241,026 |  | 3,208,167 |  |
| control@oracle | 6,281,720 | +0.7% | 3,274,134 | +2.1% |
| sync-source@prod | 1,736,144 | −72.2% | 1,365,044 | −57.5% |
| H9-statusless@oracle | 6,224,340 | −0.3% | 2,788,862 | −13.1% |
| H9-direct@prod | 3,552,823 | −43.1% | 1,804,369 | −43.8% |

Run-to-run spread: max 0.02%.

##### store-rows (instructions per op, n = 200)

| Cell | mount | Δ | update10th | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline@prod | 8,331,738 |  | 315,219 |  | 604,942 |  |
| R-path@prod | 8,299,382 | −0.4% | 316,481 | +0.4% | 628,648 | +3.9% |
| S1-handle@prod | 8,815,425 | +5.8% | 310,162 | −1.6% | 547,198 | −9.5% |
| S2-scalar@prod | 2,022,909 | −75.7% | 104,239 | −66.9% | 429,398 | −29.0% |

Run-to-run spread: max 0.45%.

##### store-static (instructions per op, n = 200)

| Cell | mount | Δ | update10th | Δ |
| --- | ---: | ---: | ---: | ---: |
| baseline@prod | 7,280,134 |  | 304,983 |  |
| S4-static@prod | 5,807,206 | −20.2% | 285,020 | −6.5% |

Run-to-run spread: max 0.06%.

##### select (instructions per op, n = 200)

| Cell | mount | Δ | select | Δ |
| --- | ---: | ---: | ---: | ---: |
| baseline@prod | 1,233,521 |  | 429,345 |  |
| H1-fuse@oracle | 546,245 | −55.7% | 320,759 | −25.3% |
| R-projection@prod | 1,578,289 | +27.9% | 64,140 | −85.1% |

Run-to-run spread: max 0.06%.

##### action (instructions per op, n = 200)

| Cell | write | Δ |
| --- | ---: | ---: |
| baseline@prod | 923,539 |  |
| A1-batch@prod | 786,679 | −14.8% |

Run-to-run spread: max 0.02%.

Store census (`scripts/heuristics/r3/store-census.mjs`, same 206-file corpus, `r3/store-census.json`):
- 15 stores; 12 with a literal initializer; none with dynamic keys or `reconcile`.
- 12 escape. The escapes are function arguments (helpers, API calls with keys missing from the initializer) and props, and inlining the child component (C2) recovers none of them.
- S2 qualifies for 1 store in full, 2 at row level.

The corpus is small and mostly 1.x-era, so these coverage numbers are weak.

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
node scripts/heuristics/icount.mjs --scenarios rows,chain,todos,rows-ids,todos-ids \
  --cells baseline@prod,H1-fuse@oracle,H8a-ownerless@oracle,H8b-detached@oracle,H1+H8b@oracle,control@oracle \
  --out documentation/plans/heuristic-oracles/icount-h8.json          # and -repeat
node scripts/heuristics/dom/bench.mjs --suite list --n 1000 --reps 5 \
  --out documentation/plans/heuristic-oracles/dom-list-1.json          # and -2
node scripts/heuristics/census.mjs <dir>... --out census.json
node scripts/heuristics/report.mjs
# Round 3 (async status, stores, actions)
node scripts/heuristics/r3/check.mjs
node scripts/heuristics/r3/icount.mjs --out documentation/plans/heuristic-oracles/r3/icount-1.json   # and -2
node scripts/heuristics/r3/icount.mjs --scenarios async-rows --out documentation/plans/heuristic-oracles/r3/icount-async-3.json
node scripts/heuristics/r3/icount.mjs --scenarios store-static,select --out documentation/plans/heuristic-oracles/r3/icount-3.json
node scripts/heuristics/r3/report.mjs
node scripts/heuristics/r3/store-census.mjs examples <corpus>... --out documentation/plans/heuristic-oracles/r3/store-census.json
cd packages/signals && npx vitest run tests/heuristic-oracles.test.ts
```

Environment: Node v22.22.2, Valgrind 3.22 (`cachegrind --cache-sim=no`), Chromium 141.0.7390.37 headless via Playwright 1.56.1, a shared 4-core cloud VM.

## Limits

- Three signal-level scenarios and one DOM scenario are chosen to exercise each fact where it holds. They show what a heuristic is worth *per site*. Application-level wins scale with coverage, which is why the census exists.
- The signal-level scenarios exclude DOM cost. The DOM bench excludes layout and paint, and covers one list shape.
- Hydration and SSR are not exercised. H7 during hydration needs the claim path, which the oracle variants skip. Stores, async and actions are covered at signal level only (round 3).
- The census is syntactic, file-local and small (206 files).
