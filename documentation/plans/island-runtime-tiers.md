# Island Runtime Tiers

Status: 2026-09-27. A measured prototype. The only production-adjacent code is an unexported kernel under `packages/signals/src/kernel/` (nothing imports it; the published build is unchanged). The harness is `scripts/ssr-redesign/` (extended) plus `scripts/island-tiers/`, and the raw data is in `documentation/plans/island-runtime-tiers/`.

This builds on [ssr-hydration-redesign.md](./ssr-hydration-redesign.md) (compiled islands over the v2 block graph, P1-static) and [generator-blocks-v2.md](./generator-blocks-v2.md) (the block facts). It does not study per-feature slicing of the core, which is a separate study.

## Summary

The redesign's compiled islands left one cost standing: **the runtime is the whole remaining JS.** HN's Toggle island shipped 9.6 KB gz of signals core to toggle one boolean (redesign doc, open question 4). This study gives each island the smallest runtime its graph allows, chosen by the compiler:

- **Tier 0: no reactive runtime.** Cells become slots; each view hole becomes a (compute, apply) pair on the cells it reads; a ~0.3 KB gz helper keeps the core's batching contract.
- **Tier 1: a 2.1 KB gz kernel** (signal, memo, render/user effect, cleanup, root, untrack, flush) that reproduces the core's scheduling event for event on the subset it supports.
- **Tier 2: the full core,** for async, transitions, optimistic writes, stores.

The linker picks the highest tier across each connected group of islands (islands that share a cell), and the group shares one runtime instance.

**Measured** (same harness and methodology as the redesign doc; tables in [Measurements](#measurements)):

| | HN today (hydrate) | HN tier 2 (P1, core) | HN tier 1 (kernel) | HN tier 0 |
| --- | ---: | ---: | ---: | ---: |
| JS gz at load, eager | 32.2 KB | 9.6 KB | 2.2 KB | **0.6 KB** |
| JS gz lazy: loader + first interaction | – | 0.3 + 9.6 KB | 0.3 + 2.1 KB | 0.3 + **0.5 KB** |
| script at load, eager, 1× · 4× | 121 · 325 ms | 17 · 40 ms | 8 · 23 ms | **5 · 18 ms** |
| heap after load, eager | 13.6 MB | 2.4 MB | 2.2 MB | 2.0 MB |
| first click, eager, 4× | 4.0 ms | 5.7 ms | 5.9 ms | 4.1 ms |

| | todos-local today (hydrate) | tier 2 (core) | tier 1 (kernel) | T0\* (hand-written floor) |
| --- | ---: | ---: | ---: | ---: |
| JS gz at load, eager | 32.5 KB | 11.1 KB | **3.7 KB** | 1.6 KB |
| script at load, eager, 1× · 4× | 14 · 51 ms | 6 · 22 ms | **4 · 15 ms** | 2 · 6 ms |
| first interaction, eager, 4× | 10.1 ms | 7.7 ms | 6.8 ms | 6.3 ms |

- **The runtime was the remaining JS, and the tiers remove most of it.** On HN, tier 0 ships 0.6 KB gz eager (0.5 KB on first click lazily) against 9.6 KB for tier 2: −94%. Eager script at load falls from 17 ms (tier 2) to 5 ms at 1×, and 96% against today.
- **Tier 1 is the right floor for list apps.** On todos-local the kernel takes JS from 11.1 to 3.7 KB gz (−67%) and load script by about a third against the core, with identical DOM. The hand-written T0\* floor is another 2.1 KB and ~2–9 ms below: what a list-aware tier 0 could still buy (open question 3).
- **Interaction latency does not change** between tiers once active (all within noise at 4–7 ms at 4×). Lazily, the first click is dominated by fetching the chunk; smaller chunks help (HN tier 0: 6 ms at 1× against 24 ms for tier 2), but 4× lazy numbers are noisy (see 4).
- **todos-blocks stays tier 2.** Its optimistic async store, actions and boundaries need the core; the tiers change nothing there, as they should.

**Equivalence.** Every tier is trace-equivalent to the core:
- the kernel matches the core on **20,000 random graphs** (every compute run, every read value, every effect run with its previous value, every cleanup, in order), plus 10 contract tests run against both;
- **real compiler output** of the DOM-free conformance scenarios runs on the kernel with a trace identical to the oracle's;
- tier-0 and tier-1 **activation code** for the conformance tier scenarios reproduces the oracle's trace after activation (and the tier-1 code, run on the core, is the tier-2 control); two planted tier-0 scheduling bugs are caught;
- in Chromium, every tier's page **equals today's hydrated page after load and after every step** of the HN and todos sessions, with server nodes kept.

**One core defect** came out of the differential suite: a pulled zombie node loses its `REACTIVE_ZOMBIE` flag while still linked into the zombie heap, and a later removal unlinks it from the dirty heap, corrupting a bucket (a `TypeError` in `deleteFromHeap` after a few thousand programs in one runtime). The kernel avoids it; the core is not changed here. See [Defects found](#defects-found).

## 1. Tier rules

The rules are joins over the block facts the redesign's linker already has (generator-blocks-v2 makes each one syntactic): what each setup creates, what each view hole reads and where, what each `$event` writes, which blocks are async, and which cells cross component boundaries (props, context, For/Show parameters). `scripts/ssr-redesign/analyze.mjs` (`assignTiers()`) implements them over the example apps and prints the facts that forced each tier.

**Groups first.** Two islands are connected when they touch a common cell: a cell one reads and another reads or writes, directly, through a memo (a memo stands for the live cells it reads), through props, or through context. Each connected group gets one tier, the highest any member needs, and one runtime instance. A cell created in a component's setup and touched by no other component is instance-local: 652 Toggle instances are 652 one-member groups, not one group.

**Tier 0: no reactive runtime.** A group is tier 0 when all of these hold:

| Condition | Fact it reads |
| --- | --- |
| one island, no cell shared with another island | the group has one member |
| every live cell it touches is written only by its own `$event` handlers | writes (no effect, action or other island writes it) |
| every live view hole reads its cells **unconditionally** | no read in a ternary branch, a `&&` / `\|\|` / `??` right operand, an `if` branch or a callback inside the hole (a ternary's *condition* is unconditional) |
| no dynamic structure over live inputs | no `Show` / `For` / `Index` / `Switch` / `Match` / `Dynamic` whose inputs are live |
| no memo, no effect (`$effect`, `createEffect`, `onSettled`, `onMount`), no `onCleanup` | creations and load-time effects |
| no async, optimistic or store cell, no `attempt` / `action` / `refresh` / transition, no `Loading` / `Errored` | the tier-2 list below |

Under these conditions the dependency graph is fixed at compile time: each hole's read set is exactly the cells it names, forever. So the compiler emits each cell as a slot and each hole as `(compute, apply)` registered on its cells, seeded with the server-rendered value (activation computes nothing). What is left of the runtime is the core's **batching contract**, which is observable and is kept by a 0.3 KB gz helper (`packages/signals/src/kernel/t0.ts`):
- a write stages the value; an updater sees the staged value; a handler's read sees the committed value until the flush; an equal write is a no-op;
- the flush runs on a microtask (or an explicit `flush()`); it commits, computes every hole of every changed cell once, **in the core's heap order** (cells in first-write order, each cell's holes in creation order, each hole once), then applies them in that order.

The order rule is not cosmetic: with holes `h1(b)`, `h2(a)`, `h3(a, b)`, a handler writing `a` then `b` runs `h2, h3, h1` on the core, and a naive "dirty set, creation order" scheduler runs `h1, h2, h3`. The conformance self-test plants exactly that bug and catches it.

**Tier 1: the kernel.** A group that fails a tier-0 condition but uses only the kernel's subset: memos, conditional (dynamic) reads, `Show` / `For` over live inputs, effects and load-time effects, `onCleanup`, cells shared across islands (props, context resolved statically by the linker), `untrack`.

**Tier 2: the full core.** Any of: an async or optimistic cell (`createOptimistic*`, `createProjection`, an async memo), a store (`$store` / `createStore`: the kernel has no stores), `attempt` / `action` / `refresh` / `startTransition`, a `Loading` / `Errored` boundary, or anything the linker cannot see (an unknown library, an escaping setter). Unknown is conservative: it raises the tier, never lowers it.

**What the classifier says** (`node scripts/ssr-redesign/analyze.mjs`; JSON in `island-runtime-tiers/analysis.json`):

| App | Group | Tier | Why |
| --- | --- | --- | --- |
| hn | Toggle (each instance) | **0** | `open` written only by its own `onClick`; 3 live holes (class, text, style), all unconditional; `props.children` is a pass-through slot |
| hn | Page, StoryPage, Comment | – | inert (no code) |
| todos (todos-blocks) | Header, TodoItem, MainSection, Footer, App | **2** | `todos` is an async optimistic store; handlers `attempt` actions; `Loading` and `Errored` |
| todos-local | Header, TodoItem, MainSection, Footer, App | **1** | memos (`filtered`, `allCompleted`, `remaining`, `completed`); `Show` / `For` over live inputs; App's load-time `hashchange` listener; `todos`, `filter` shared across five islands |
| sync | Converter | **1** | memos `fahrenheit`, `label` (a memo-folding candidate, see 7) |
| sync | App | **2** | `$store` |

`todos-local` (`scripts/ssr-redesign/apps/todos-local/`) is todos-blocks' UI and markup over a synchronous local store: one signal holding an immutable array, persisted to localStorage, plain handlers. It exists because todos-blocks is tier 2 by construction, so it cannot show what the lower tiers do for a list app. It is a different program, and is labelled as such in every table.

Todos has **no tier-0 group** under the rules (a keyed list, branches, memos, five islands sharing `todos`). To bound what the kernel costs over the best possible code, the todos tables add **T0\***: the same group written by hand as direct DOM updates with no reactive runtime, outside the rules. No compiler following the rules emits it.

## 2. The kernel (tier 1)

`packages/signals/src/kernel/index.ts`: 4.5 KB min, **2.1 KB gz** with every export (2.0 KB gz for Toggle's signal + render effect + root). Same names and call shapes as the core (`createSignal`, `createMemo`, `createRenderEffect`, `createEffect`, `createRoot`, `runWithOwner`, `getOwner`, `onCleanup`, `untrack`, `flush`), so the compiler emits one activation module and **the linker binds it to the kernel or to the core by an import alias**. Tier 1 and tier 2 of every island here run the same code.

| Runtime for the same API | min | gz |
| --- | ---: | ---: |
| kernel | 4.53 KB | **2.10 KB** |
| core (`@solidjs/signals`), the kernel's 8 exports | 23.92 KB | 9.54 KB |
| async-free core (`@solidjs/signals/sync`), the same exports | 15.38 KB | 6.43 KB |
| core, all exports | 100.84 KB | 35.84 KB |

(`scripts/island-tiers/sizes.mjs`, esbuild minify as in the harness.)

**Design: keep the core's mechanics, drop its features.** An equivalent-looking design (a textbook push-pull) differs from the core in observable order (which hole re-runs first, when a pulled memo runs, when a re-run owner's cleanups fire). The kernel instead ports the parts of the core that decide order, and nothing else:

| Mechanism | Core source | Kernel |
| --- | --- | --- |
| Write: stage `pendingValue`, notify subscribers into the heap, schedule a microtask flush; equal writes stop | `setSignal`, `insertSubs` | same |
| Read: committed value outside a computation, staged value inside; tracked reads link and pull a dirty computed at or above the heap cursor (`markNode` + `markHeap` + `updateIfNecessary`); the reader's height rises above the source's | `read` | same |
| Links: alien-signals style, reused in place, so subscriber order (and therefore heap order) matches | `graph.ts` `link` / `trimStaleDeps` | same |
| Height-ordered heap with a rewindable `_min` cursor and height-adjust entries | `heap.ts` | same, including the zombie heap (never drained without transitions, but marked and pulled through like the core's) |
| Recompute: re-run owners move children and cleanups to a zombie list, disposed at commit; memos stage and cut off on `equals` (default `===`); effects never cut off; missed-wake latch for a write landing on a validated link mid-run | `recompute` | same |
| Flush: heap, commit (values, then zombie disposals in recompute order), heap again if a commit dirtied something, render-effect queue, user-effect queue, loop while scheduled | `GlobalQueue.flush`, `flush` | same |
| Effects: render effects run their effect half synchronously on creation, user effects queue it; the previous effect cleanup runs right before the next run | `effect`, `runEffect` | same |
| Disposal: children newest first (depth first), then `onCleanup` in registration order, then the effect's returned cleanup | `disposeChildren` | same |

Dropped: status flags, errors and boundaries, async (`NotReadyError`, flights, loading windows), transitions and lanes, optimistic overrides, snapshots, stores and projections, context, companions (`isPending` / `latest`), refresh / re-ask, auto-disposal of unowned memos, all dev diagnostics. A throw simply escapes (the core halts reactivity).

**Deliberate differences, all outside the subset:** a throw is not routed or halted; an unowned memo is not auto-disposed when its last subscriber leaves; no dev diagnostics. And one bug the kernel does not share (next section).

**Tests.** `packages/signals/tests/kernel/`:
- `kernel.test.ts`: 10 contract cases (stale reads, microtask flush, diamond, cut-off, flush order, dynamic re-tracking, disposal order, `untrack`, `equals`, effect writes looping), each run against the kernel **and** the core;
- `differential.test.ts`: random synchronous programs (2–5 signals, memos, render and user effects, branching and untracked reads, custom and `false` equality, nested owners and child roots, compute cleanups and effect cleanups, batches of writes with explicit or microtask flushes, stale reads between write and flush, mid-run root disposal) run through both runtimes; the event logs must be identical. 400 programs by default (0.3 s); `KERNEL_DIFF_SEEDS=20000` passes (20,000 programs, 20 s).

## 3. Equivalence evidence

| Evidence | What runs | Result |
| --- | --- | --- |
| Kernel vs core, differential | 20,000 random programs; logs of every compute, read value, effect `(value, prev)`, cleanup, in order | identical |
| Kernel alone, one runtime instance | the same 20,000 programs without re-importing | no failure (the core fails here, see Defects) |
| Kernel contract | 10 cases × {kernel, core} | pass |
| Conformance: real compiler output on the kernel | `memo-effect-order`, `dynamic-subscriptions`, `owned-children`, `tier-diamond`: reference sources compiled as `client/reference` compiles them, `solid-js` bound to the kernel; whole trace including mount | identical to the oracle |
| Conformance: activation stand-ins | `tier-toggle` and `tier-two-cells` at tier 0 and tier 1, `tier-shared` at tier 1, and the tier-1 code on the core (tier-2 control): activate the oracle's initial DOM, drive the steps | identical to the oracle after activation; tier-0 activation records nothing |
| Conformance self-tests | tier 0 with holes in creation order; tier 0 without batching | both diverge; the real helper does not |
| Browser gate (`measure.mjs`) | HN: T0 / T1 eager and lazy. todos-local: T0\*, T1, T2, eager and lazy. Page equals today's hydrated page after load and after every session step (normalized for keys and markers); server nodes captured while parsing are the live nodes | all pass, nodes kept |

The new conformance scenarios (`packages/web/test/conformance/scenarios/tiers.ts`) are ordinary scenarios with goldens: they also run in the `blocks` modes (`tier-toggle` and `tier-two-cells` are equivalent through the compiler and uncompiled where applicable). The runner is `tiers.spec.ts`; the README section "Island runtime tiers" describes it. The activation stand-ins are hand-written (the compiler does not emit activation yet), so they live outside the mode registry, whose contract is "real compiler output only". The kernel check, by contrast, runs real compiler output.

The todos session was extended for todos-local to reach the dynamic paths: toggle a row, delete a row, toggle all, filter to Active (every row leaves), add a todo (a row is created from the template), toggle it (it leaves), filter to All (100 rows are created), clear completed (both `Show` regions close).

## 4. Measurements

Harness and methodology are the redesign doc's (`measure.mjs`): real Rust compiler, prod dists, esbuild minify, Chromium, in-memory serving, a fresh browser context per load, 7 loads per run and CPU rate (1× and 4× throttling), median per run, mean of two runs. Byte numbers are exact. "script at load" is CDP `ScriptDuration` from navigation to settled; "activation" is the island activation (or `hydrate()`) call; "first interaction" is from the scripted click to the DOM change; "script through first interaction" adds that interaction's script. HN's session is the redesign's (four toggle clicks); todos-local's is extended (see 3). Every variant passes the gate against today's page (`A`).

Tier 2 on HN is the redesign's own P1-static (`P1-eager` / `P1-lazy`, `toggle.island.ts` on the core). Tier 1 is the **same module** bound to the kernel. Tier 0 is `toggle.t0.ts`.

### hn: bytes

| Variant | | HTML gz | JS gz at load | + JS gz on first interaction | runtime min KB | gate |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A | today: hydrate | 405.6 | 32.2 | – | 61.5 | reference |
| P1-eager | tier 2 (core), eager | 189.7 | 9.6 | – | 23.5 | pass, nodes kept |
| P1-lazy | tier 2 (core), lazy | 189.7 | 0.3 | 9.6 | 23.5 | pass, nodes kept |
| T1-eager | tier 1 (kernel), eager | 189.7 | 2.2 | – | 4.1 | pass, nodes kept |
| T1-lazy | tier 1 (kernel), lazy | 189.7 | 0.3 | 2.1 | 4.1 | pass, nodes kept |
| T0-eager | tier 0 (no runtime), eager | 189.7 | 0.6 | – | 0.5 | pass, nodes kept |
| T0-lazy | tier 0 (no runtime), lazy | 189.7 | 0.3 | 0.5 | 0.5 | pass, nodes kept |

### hn: time (ms)

| Variant | script at load 1× | 4× | activation 4× | heap KB | first interaction 1× | 4× | script through first interaction 1× | 4× | ready 4× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 121.0 | 324.6 | 310.8 | 13624 | 1.8 | 4.0 | 123.6 | 326.1 | 1386.9 |
| P1-eager (tier 2) | 17.0 | 40.1 | 35.7 | 2394 | 1.6 | 5.7 | 18.2 | 44.9 | 901.9 |
| P1-lazy (tier 2) | 1.8 | 3.4 | 0.0 | 1485 | 24.0 | 36.2 | 3.8 | 11.3 | 746.0 |
| T1-eager | 8.2 | 23.1 | 19.5 | 2158 | 1.5 | 5.9 | 9.3 | 29.0 | 903.9 |
| T1-lazy | 2.1 | 6.2 | 0.0 | 1485 | 7.5 | 44.4 | 3.6 | 12.0 | 897.0 |
| T0-eager | 4.7 | 18.4 | 9.5 | 1968 | 0.8 | 4.1 | 5.2 | 20.7 | 891.2 |
| T0-lazy | 1.7 | 4.8 | 0.0 | 1485 | 6.1 | 17.9 | 3.0 | 8.6 | 830.1 |

### todos-local: bytes

| Variant | | HTML gz | JS gz at load | + JS gz on first interaction | runtime min KB | gate |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| A | today: hydrate | 1.4 | 32.5 | – | 61.3 | reference |
| T2-eager | tier 2 (core), eager | 0.9 | 11.1 | – | 23.7 | pass, nodes kept |
| T2-lazy | tier 2 (core), lazy | 0.9 | 0.4 | 11.0 | 23.7 | pass, nodes kept |
| T1-eager | tier 1 (kernel), eager | 0.9 | 3.7 | – | 4.4 | pass, nodes kept |
| T1-lazy | tier 1 (kernel), lazy | 0.9 | 0.4 | 3.6 | 4.4 | pass, nodes kept |
| T0\*-eager | hand-written, outside the rules | 0.9 | 1.6 | – | 0.0 | pass, nodes kept |

### todos-local: time (ms)

| Variant | script at load 1× | 4× | activation 4× | heap KB | first interaction 1× | 4× | script through first interaction 1× | 4× | ready 4× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 14.1 | 50.5 | 41.2 | 2202 | 2.4 | 10.1 | 16.1 | 57.4 | 196.0 |
| T2-eager | 5.9 | 21.7 | 15.4 | 1747 | 1.9 | 7.7 | 7.6 | 27.0 | 123.9 |
| T2-lazy | 0.7 | 2.8 | 0.0 | 1501 | 20.6 | 60.0 | 3.6 | 15.2 | 104.9 |
| T1-eager | 3.6 | 14.5 | 10.1 | 1625 | 1.6 | 6.8 | 4.7 | 20.0 | 122.1 |
| T1-lazy | 0.8 | 2.3 | 0.0 | 1501 | 16.8 | 50.8 | 3.0 | 13.0 | 127.4 |
| T0\*-eager | 1.7 | 6.3 | 2.7 | 1548 | 1.4 | 6.3 | 2.8 | 9.7 | 149.5 |

### todos (todos-blocks, tier 2 by the rules): reference

| Variant | JS gz at load | + on first interaction | script at load 1× · 4× | first interaction 1× · 4× | script through first 1× · 4× |
| --- | ---: | ---: | --- | --- | --- |
| A (hydrate) | 39.4 | – | 36.0 · 111.8 | 4.8 · 18.5 | 41.1 · 131.4 |
| A-lazy | 0.2 | 39.4 | 0.9 · 3.1 | 69.9 · 163.0 | 45.7 · 131.6 |

**Noise.** Run-to-run spread of script at load is at most 14% (HN) and 31% (todos-local) at 1×. At 4× numbers under 10 ms move by several ms between runs (the worst: T0-lazy on HN, 7.8 then 1.8 ms: 124% relative), and lazy first-interaction times swing most (T1-lazy on HN: 64.9 then 23.9 ms at 4×), since they are dominated by the chunk fetch and compile. Read sub-10 ms and lazy 4× differences as ties. HN's "ready" is bounded by parsing 1.4 MB of HTML (as in the redesign doc) and does not separate the tiers. Today's HN numbers reproduce the redesign doc's (script at load 121 / 325 ms against 111 / 369 there).

**What the numbers say.**
- **Bytes scale with the tier exactly as designed**: 9.6 → 2.2 → 0.6 KB gz for Toggle; 11.1 → 3.7 KB for todos-local. The kernel is 2.0–2.1 KB of that.
- **Load script at 1× roughly halves per tier on HN** (17 → 8 → 5 ms eager), because the core's per-node cost (owner, heap, status fields; 652 × three effects) is what the lower tiers drop. At 4× tier 0 and tier 1 are 18–23 ms against 40 ms for tier 2; the floor there is the DOM walk and 652 `addEventListener`s, which all tiers share.
- **Eager tier 0 costs about what lazy tier 2 does** in script through the first interaction (5.2 vs 3.8 ms at 1×, a few ms apart) but has no chunk-load latency on the first click (0.8 vs 24 ms at 1×). For a page like HN, eager tier 0 is a reasonable default: no loader, no replay, 0.6 KB.
- **todos-local**: the tiers cut load script 2.5× (tier 2) and 3.9× (tier 1) against hydrating the same program at 1×. T0\* shows the remaining headroom is small in absolute terms (≈2 ms at 1×).

## 5. Recommendations

1. **Adopt the tiers, with tier selection in the linker.** The facts are already in the block graph. Tier 0 is the common case for self-contained widgets (toggles, disclosure, tabs, counters) on content pages, and it removes the runtime from the page entirely.
2. **Make the kernel the core's API subset, not a new API.** The alias binding (one activation module, two runtimes) is what made tier-1 and tier-2 equivalence cheap to prove here: the tier-1 activation code run on the core is the tier-2 control. Keep it that way: the kernel must never grow a name the core lacks.
3. **Dedupe per page (route chunk), not only per group.** Two groups with different tiers on one page would load both the kernel and the core. When any group on a route needs tier 2, bind that route's tier-1 groups to the core too (their code already works on it, and the core is already paid for); tier-0 groups stay runtime-free. Only routes whose highest tier is 1 load the kernel.
4. **Guard the kernel with the differential suite in CI,** and run it against every core change that touches `core.ts`, `heap.ts`, `graph.ts`, `owner.ts` or `scheduler.ts`: the kernel's value is that it is the core's semantics, and the random programs are what found the one place they part (a core bug).
5. **Fix the zombie-flag defect in the core** (below) before relying on long-lived pages, in either runtime.
6. **Keep tier 0 strict for now.** Every relaxation below changes what "same order" means and needs its own proof.

## 6. Open questions

1. **Memo folding into tier 0.** A memo with unconditional reads, owned by one island (sync's Converter: `fahrenheit`, `label`), is a derived slot recomputed before the holes with its own cut-off. The classifier flags such groups ("memo folding candidate"). The order rule needs a height notion (a memo's holes run after the memo), which the t0 helper does not have yet.
2. **Over-approximated tier 0 for conditional reads.** A hole `c() ? x() : y()` can be recomputed whenever any of `c`, `x`, `y` changes; the DOM is the same (apply compares), but compute runs and reads differ from the core's, which is observable in traces. Is "same DOM, more computes" an acceptable contract for tier 0?
3. **Lists without a graph.** T0\* shows what a list-aware tier 0 would buy on todos (a keyed list, two branches, four derived values). Can the compiler emit that safely from blocks (immutable items, keyed rows, derived values folded), or is the kernel the right floor for lists?
4. **Cross-runtime ordering.** Tier-0 islands and a kernel flush on separate microtasks, where the core would update all of them in one flush. Groups share no state, so no reactive read can tell; a `MutationObserver` can see the record order change. A page-level `flush()` must also reach every runtime on the page (the compiler would route it).
5. **Stores at tier 1.** The kernel has no stores, so any `$store` island is tier 2 (sync's App). Lowering store paths to per-path signals when the compiler knows every path (the store-summary facts) would let many store islands drop to tier 1. How much of the store semantics (proxies, reconcile, projections) must come along?
6. **Context at tier 1.** The kernel has no context; the prototype resolves context values statically (the linker knows each provider). Dynamic context (a provider whose value is chosen at run time, or a component used under several providers) needs either a kernel context or tier 2.
7. **Lazy activation latency.** The first-interaction numbers for lazy variants are dominated by fetching and compiling the chunk, and vary between runs more than any other number here; the redesign's prefetch policy question applies unchanged.
8. **Dev builds.** A dev build should run every tier's island on the core (or both, comparing) so a misclassified island shows up; the kernel has no diagnostics.

## Defects found

| Defect | Status | Evidence |
| --- | --- | --- |
| **Core: a pulled zombie loses `REACTIVE_ZOMBIE` while still linked into the zombie heap.** `updateIfNecessary` ends with `el._flags &= (SNAPSHOT_STALE \| IN_HEAP \| IN_HEAP_HEIGHT)`, dropping `REACTIVE_ZOMBIE` from a node that `markDisposal` moved into `zombieQueue`. `queueFor` then names the dirty heap, so the next `deleteFromHeap` unlinks the node from the wrong heap: it can repoint the dirty bucket's tail at a zombie node, or throw when that bucket is empty | open (the core is not changed here) | `KERNEL_DIFF_BATCH=1000000 KERNEL_DIFF_FROM=1000 KERNEL_DIFF_SEEDS=5166 pnpm exec vitest run tests/kernel/differential.test.ts` in `packages/signals`: the core throws `TypeError: Cannot set properties of undefined (setting '_prevHeap')` in `deleteFromHeap` at seed 5166. A ported kernel with the same line fails the same way; keeping the flag changes which doomed nodes run (seed 84 diverges), so the kernel instead unlinks from the heap a node is physically in (`hq`) and keeps the core's observable behavior. Suggested core fix: the same (remember the heap on insert), or re-home the node when the flag drops |

## Reproduce

```sh
# builds: packages/signals, packages/solid, packages/web, packages/h (pnpm build), packages/compiler (pnpm build; rustc 1.95)
node scripts/ssr-redesign/analyze.mjs                                     # tiers per group (--json out)
node scripts/island-tiers/sizes.mjs                                       # runtime sizes
(cd packages/signals && pnpm exec vitest run tests/kernel)                # kernel contract + 400 random programs
(cd packages/signals && KERNEL_DIFF_SEEDS=20000 pnpm exec vitest run tests/kernel/differential.test.ts)
(cd packages/web && pnpm exec vitest run test/conformance/tiers.spec.ts)  # conformance: kernel + activation stand-ins
node scripts/ssr-redesign/measure.mjs --apps hn,todos-local,todos --only A,P1-eager,P1-lazy,T1-eager,T1-lazy,T0-eager,T0-lazy,T2-eager,T2-lazy,T0*-eager,A-lazy --check
node scripts/ssr-redesign/measure.mjs --apps hn,todos-local,todos --only A,P1-eager,P1-lazy,T1-eager,T1-lazy,T0-eager,T0-lazy,T2-eager,T2-lazy,T0*-eager,A-lazy --reps 7 --cpu 1,4 --out documentation/plans/island-runtime-tiers/results-1.json   # and -2
node scripts/island-tiers/report.mjs                                      # the tables above
```

Files:
- kernel and tier-0 helper: `packages/signals/src/kernel/{index,t0}.ts`; tests `packages/signals/tests/kernel/`;
- HN activation: `scripts/ssr-redesign/apps/hn/islands-static/` (`toggle.island.ts` is tiers 1 and 2 by alias, `toggle.t0.ts` tier 0, `client-{eager,lazy}{,-t0}.ts`);
- todos-local: `scripts/ssr-redesign/apps/todos-local/` (`app.tsx` the program, `islands.ts` tiers 1 and 2 by alias, `islands-t0.ts` T0\*, `client-lazy.ts` the loader with the group's handler map);
- conformance: `packages/web/test/conformance/{tiers.spec.ts,scenarios/tiers.ts,tiers/activations.ts}`.
