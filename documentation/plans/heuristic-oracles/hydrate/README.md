# Cold-Scope Hydration: Pricing Inert Bindings

Status as of 2026-09-26. This is a measurement study in the style of [`../../heuristic-oracles.md`](../../heuristic-oracles.md): hand-written oracle variants, an equivalence gate, an unsafety demonstration, then measurement. Nothing under `packages/` was changed or rebuilt. Everything ran from the existing `dist/` outputs, pinned with `taskset -c 2,3`.

## Question

Suppose a strict compiler knows that writes happen only in event handlers and actions ("cold scopes"). It can then name the signals that are never written on the client. For a binding that reads only such signals, hydration could skip creating the render effect or memo. It would claim the server-rendered node, whose value is already in the HTML. What is that worth, and could the runtime get it without a proof?

## Setup

- **App:** `scripts/heuristics/hydrate/app.jsx`, a rows page with n = 1000. Each `Row` component has a `label` signal, an `isSel` memo over a shared `selected` signal, a `<tr class>` binding, an id cell (`{id}`, a constant) and a label cell (`{label()}`).
- **Server:** the real compiler (`transform(src, { generate: "ssr", hydratable: true })`), rendered in Node with `renderToString` from `packages/web/dist/server.js` and `packages/solid/dist/server.js`. The result is 89 KB of HTML with `_hk` keys.
- **Client:** `transform(src, { generate: "dom", hydratable: true })`, bundled with esbuild against `packages/web/dist/web.js`, `packages/solid/dist/solid.js` and a snapshot of `packages/signals/dist/prod`. It is hydrated with `hydrate()` in Chromium 141.0.7390.37 (Playwright).
- **Timing:** each sample pre-fills K containers with the SSR HTML. Parsing is not timed. The sample then times K back-to-back `hydrate()` calls; render's own `flush` is included. K adapts so that each sample is at least 25 ms. A page's result is the median of 20 samples, a run's result is the median of 5 fresh pages, and there were two independent runs. `dispose()` is timed separately. Heap is `usedJSHeapSize` retained by one hydrated app after `gc()`, as the median of 5.
- **Noise:** the noise band is the run-to-run difference plus half the larger within-run page spread, the same rule as the `<For>` list suite. A delta inside the band is marked "(noise)".

Run it with:

```
taskset -c 2,3 node scripts/heuristics/hydrate/bench.mjs --out documentation/plans/heuristic-oracles/hydrate/hydrate-1.json
taskset -c 2,3 node scripts/heuristics/hydrate/bench.mjs --check          # gate + unsafety only
node scripts/heuristics/hydrate/bench.mjs --print-baseline                # compiler's hydratable client output
taskset -c 2,3 node scripts/heuristics/hydrate/bench.mjs --profile baseline   # CDP self-time profile of hydrate() only
```

## Variants

All variants are hand edits of the compiler's hydratable client output (`variants.mjs`). Each edit must match exactly once, so a change in compiler output fails loudly.

| Variant | What the "compiler" emitted |
| --- | --- |
| baseline | Compiler output, verbatim. |
| inert-labels | The label cell's `insert(_el$3, scope(() => label()))` is not created, and the text node stays as the server wrote it. The label signal is still created. The id insert, `isSel` and the class effect stay. |
| inert-all | Only the selection binding is created (`isSel` memo and class effect). The constant id insert is also dropped. |
| inert-all+H4 | `inert-all`, and the never-written label signal is not created at all. The same fact makes it a constant, which is H4 in the main study. |
| floor | Each row only claims its `<tr>` (`getNextElement`). It has no signal, memo, effect or insert. This is the lower bound: it cannot select. |
| gather-only | Probe, not a candidate. App claims `<table>` but not the rows. It prices `hydrate()` setup, the `_hk` scan (`querySelectorAll` plus `closest` per key) and the root render. |
| csr | Reference. The same app compiled non-hydratable and `render()`ed from scratch into an empty container. |
| broken-noid | Gate self-test, never timed. It is `inert-labels` without the hydration-id bump described below. |

**Hydration-id parity is part of the proof.** Every owned node, here the `isSel` memo and the label's `scope` insert effect, consumes one child id, and SSR allocated the same ids for its holes. A dropped binding that owned a node must still consume its id. The inert variants emit `getNextChildId(getOwner())` in its place. Alternatively, the compiler could apply the fact to both the SSR and client outputs.

If the bump is missing, every later row's `getNextElement` key misses and falls back to cloning the template. The class effect then binds to a detached copy. The server DOM looks correct after hydration, but selection silently stops working. The gate catches this: `broken-noid` clones the template 33 times out of 50 rows and fails at `select(3)`.

## Equivalence gate and unsafety (n = 50, both runs)

| Variant | Hydrated DOM = baseline = SSR | Template clones during hydrate | `select(3, 7, 7, −1, 0, 49)` DOM = baseline | `setters[5]("written after hydration")` from outside |
| --- | --- | ---: | --- | --- |
| baseline | yes | 0 | yes | label becomes "written after hydration" |
| inert-labels | yes | 0 | yes | **label stays "row 5"** |
| inert-all | yes | 0 | yes | **label stays "row 5"** |
| inert-all+H4 | yes | 0 | yes | no setter exists (the signal was removed) |
| floor | yes | 0 | no (expected: not a program variant) | stays |
| gather-only | yes | 0 | no (expected) | stays |
| broken-noid | yes | **33** | **no → gate rejects it** | stays |
| csr | yes, ignoring `_hk` | n/a | yes | updates |

The unsafety probe is a setter call that the program never makes: a devtools or console write, or an event handler the compiler did not see. The baseline updates the DOM. The inert variants silently keep showing the server value. Selecting row 5 afterwards still works in every inert variant. The full records are in `gate` in the JSON files.

## Results: µs per `hydrate()`, n = 1000

| Variant | run 1 | run 2 | mean | Δ vs baseline | band | dispose µs | retained heap KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 14033 | 14000 | 14017 |  | ±8% | 2117 | 2920 |
| inert-labels | 10625 | 9820 | 10222 | −27% | ±14% | 1703 | 2398 |
| inert-all | 7517 | 8120 | 7818 | −44% | ±16% | 1340 | 2354 |
| inert-all+H4 | 5783 | 6220 | 6002 | −57% | ±13% | 1109 | 1438 |
| floor | 2012 | 2063 | 2037 | −85% | ±5% | 151 | 64 |
| gather-only | 885 | 866 | 876 | −94% | ±7% | 146 | 22 |
| csr (reference: client render from scratch) | 5350 | 5063 | 5206 | −63% | ±13% | 1019 | 1075 |

Every delta is well outside its noise band. An earlier pair of runs of the same harness, before the final variant set was fixed, gave the same picture (baseline 15.2k/15.5k, inert-labels 10.8k/10.5k, inert-all 8.3k/8.3k, floor 2.0k/2.1k, csr 5.1k/5.0k).

### Where hydration time goes

This is the baseline, split by successive differences of the variant means. Each component inherits roughly ±1.5 ms of noise.

| Component | µs | Share |
| --- | ---: | ---: |
| `hydrate()` setup, `_hk` scan, table claim (gather-only) | 876 | 6% |
| Row claiming: 1000 × `getNextElement`, `createComponent`, list insert (floor − gather-only) | 1161 | 8% |
| **Node claiming subtotal (floor)** | **2037** | **15%** |
| Label insert, a `scope` effect (baseline − inert-labels) | 3795 | 27% |
| Constant id insert, which has no effect (inert-labels − inert-all) | 2404 | 17% |
| Label signal creation (inert-all − inert-all+H4) | 1816 | 13% |
| `isSel` memo and class effect (inert-all+H4 − floor) | 3965 | 28% |
| **Binding and reactive creation subtotal** | **11980** | **85%** |

A CDP profile of `hydrate()` alone (`--profile baseline`) agrees. Garbage collection is about 37% of self time. `claimInitial` is about 16%: it spreads `[...parent.childNodes]` on every insert, including the constant id insert. `clearSnapshots` is about 8%: the snapshot capture that hydration turns on is cleared with a `delete` per captured source. After those come `getNextElement`, `sharedConfig.has`, `isHydrating`, `readSerializedOrCompute` and `formatId`, which does the id string for every owner. In `inert-all` the `claimInitial` share drops to about 2%. In `floor` it is almost all `getNextElement`, `gatherHydratable` and `closest`.

## Findings

1. **The oracle's benefit is large per binding.**
   - Dropping one of three row bindings (the label) cuts hydration by 27%.
   - Dropping everything but the selection cuts 44%, and 57% when the dead signal also goes (H4).
   - Dispose drops by 20–48%, and retained heap by up to 51%.
   - Claiming is cheap: the floor is 15% of baseline. Binding creation is the cost.
2. **Hydration is 2.7× a from-scratch client render** of the same page, in both time (14.0 ms vs 5.2 ms) and retained heap (2.9 MB vs 1.1 MB). The best cold-scope variant (`inert-all+H4`, 6.0 ms) is still slower than not hydrating at all and client-rendering over the page. The hydration runtime's per-binding tax is a bigger pot than the proof.
3. **The constant id insert costs 17% of hydration and needs no proof.** `{id}` is already compiled as a non-reactive `insert(_el$2, id)`. At hydration that still runs `claimInitial` (an array spread), `normalize` and `insertExpression`: about 2.4 µs per call. Skipping constant inserts at hydration needs only the syntactic fact the compiler already has. There is one caveat. Today a client/server value mismatch is repaired by that insert; skipped, the server text would stay.
4. **The proof must also keep hydration-id parity,** as shown by the `broken-noid` failure above. That is one more thing a compiler must get right on both outputs, and the failure mode is silent.

## Could the runtime do this without a proof?

The runtime cannot know which bindings read a signal until each binding's compute has run once and subscribed. That is exactly the work being skipped. The candidates:

- **Defer every binding until the first write anywhere after hydration.** This is safe: when a deferred binding is finally created, its compute reads the current value and fixes the DOM. It removes nothing, though. The whole ~12 ms moves onto the first write, which is typically the first click (`select`), so it lands directly on input latency. Any write during startup (an `onSettled` or effect write, a hydrated async value resolving) triggers it at once. It also needs a check on every signal write for the "materialize everything" barrier.
- **Defer until idle (progressive hydration) with the same write barrier.** This is safe and improves time-to-interactive: roughly the 2 ms claim floor blocks. Total work is unchanged, and an early interaction still pays the full cost. This is a scheduling technique, not a saving.
- **Finer granularity** (materialize only the bindings a written signal feeds) needs the dependency edges. They exist only after compute runs. They could be serialized from the server, but client signals are new objects: each edge would need a stable id and payload for every binding, which likely costs more than the effect it replaces.
- **Owner-local guesses** (a signal created in a component feeds only that component's bindings) are unsound. Props, context and module-level signals cross owners.

So the runtime can shift the cost but not remove it. Only the compiler fact removes work. That work is proportional to the number of inert bindings.

## Verdict

**Do not build the cold-scope hydration proof yet.** The payoff per inert binding is real (about 4 µs per binding here, 27–57% of this page's hydration), but four things weigh against building it now:

- **Coverage is likely small where the proof is sound.** Constant expressions are already non-reactive, so the new population is reactive sources that are never written on the client. For plain signals the main study's census found 2 of 133 (1.5%) never-written setters (H4). The larger population is server data that is never refetched. Proving "never refetched" means ruling out `refresh()` and action revalidation, which are dynamic and cross-module and are often reachable by design. This study did not measure coverage.
- **It is unsafe to anything outside the proof:** devtools writes, HMR and late handlers all get silently stale DOM. It also needs SSR/client id parity.
- **The proof-free pots are the same size.**
  - Skipping constant inserts at hydration is worth 17% here.
  - The runtime's per-binding hydration tax covers `claimInitial` spreads, per-owner id formatting and serialized-value lookups, snapshot capture and clearing, and about 2.9 KB retained per row against 1.1 KB for CSR. It makes hydration 2.7× CSR, applies to every binding, and needs no compiler fact.
- **Re-price after the runtime work.** If per-binding hydration cost falls toward CSR cost, the absolute win from an inert binding shrinks with it.

If it is built later, the cheapest sound slice is the H4 composition: a signal with no reachable setter and no `refresh` target. That gives the `inert-all+H4` shape, the largest single step measured here.

## What was not measured

- Instruction counts (not required). Layout and paint: the host is `display:none`, and hydration writes no DOM in the baseline anyway.
- HTML parse time, which is equal across variants.
- Streaming or async-data hydration (`renderToStream`, serialized `_$HY.r` values). The page serializes nothing.
- Coverage of the fact in real code.
- A probe that switched the runtime's hydration wrappers off per row (by toggling `sharedConfig.hydrating`) was tried and discarded. The `hydrating` setter runs the hydration-end drain on every toggle, so it scheduled a `setTimeout` and a snapshot release per row, and its timings were not interpretable.

## Files

- `scripts/heuristics/hydrate/app.jsx`: the app source (both compiles).
- `scripts/heuristics/hydrate/variants.mjs`: the oracle edits of the hydratable client output.
- `scripts/heuristics/hydrate/bench.mjs`: SSR, bundling, gate and unsafety probe, timing, heap and `--profile`.
- `documentation/plans/heuristic-oracles/hydrate/hydrate-1.json` and `hydrate-2.json`: the two independent runs (per-page reps, dispose, heap, batch K, gate records).
