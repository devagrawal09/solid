# Is Resumability Worth It? (Challenge 2)

Status: 2026-09-27. A measurement study; nothing here changes shipped code. Harness in `scripts/heuristics/resume/`, raw data in `documentation/plans/resumability/`.

## Question

Resumability avoids re-running components on the client, but it must ship the reactive graph. Is it worth it, and how much does pruning the serialized graph matter?

## The correctness rule (why naive lazy hydration is wrong)

Lazy hydration is not safe by default. Suppose an event in island X writes a signal that island Y reads, and Y is not hydrated yet:
- Y's DOM goes stale, because it has no binding.
- Hydrating Y later renders from client state over server HTML, which is a mismatch.
- The runtime cannot know Y reads the signal until Y's code has run.

The rule every correct strategy obeys: **before a handler writes, every island (or binding) that reads what it writes must be live.** It is hydrated while the state still equals the server snapshot, or its serialized subscriptions are woken. The write then updates it normally.

Without a compiler, the only way to follow the rule is to hydrate everything on the first event. The dependents of a write are known only from a static handler → island map (compiler) or from serialized subscriptions (resumability).

## Strategies

The app has four islands over shared state:
- **table:** n = 1,000 rows; id, label, and the selected class.
- **detail:** the selected row.
- **header:** a rename count and the rename button.
- **footer:** m static server-data items.

There are two handlers: `select(id)` writes `selected`, and `rename()` writes the selected row's label and the count. Labels and footer items are server data, serialized for any strategy that re-runs components.

| | Strategy | At load | Before a handler |
| --- | --- | --- | --- |
| A | Full hydration | hydrate every island | – |
| D | Pruned hydration | hydrate the islands a handler can reach; the footer never runs and its data is not shipped | – |
| E-lazy | Runtime-only lazy | nothing | hydrate **every** island on the first event |
| E-naive | Unsafe control | nothing | hydrate only the event's island |
| F | Compiler-scoped lazy | nothing | hydrate the islands in the handler's static map (select → table, detail; rename → + header) |
| F-csr | Cost bound | as F | as F, but islands are client-rendered from scratch (a hydration runtime with zero overhead). Not a correct strategy: node identity is lost |
| B | Naive resumability | nothing | wake the subscribers of the written signals from a serialized table of **every** binding and value |
| C | Pruned resumability | nothing | as B, serializing only the **live closure**: values a handler can reach, the bindings that read them, and each signal's subscribers |
| C-broken | Unsafe control | nothing | C with one subscriber missing (over-pruned) |

The implementations:
- **Hydration strategies:** the real compiler's hydratable output and `@solidjs/web` `hydrate(…, { renderId })` per island.
- **B and C:** a hand-written resumable client, standing in for a resumable compiler. It ships no component code and no web runtime, only signals, per-site expressions, and a binder that finds elements by `data-q`.

## Gate

The gate checks HTML equality with A after load and after every step of a 7-step session, plus node identity: the server-rendered row, detail and count nodes must be the same DOM nodes at the end.
- A, D, E-lazy, F, B and C pass.
- **E-naive fails at step 1**: the detail island is stale. This is the problem above, reproduced.
- **C-broken fails at step 1**: an over-pruned closure is caught.
- The identity check caught a real runtime limit (next section) that HTML equality alone missed.

## Runtime finding: Solid 2 cannot hydrate islands at different times

When the first hydration pass drains, Solid 2:
- clears snapshots and the serialization registry;
- sets `_$HY.done`;
- makes every later `hydrate()` fall back to a client render (`packages/solid/src/client/hydration.ts` ~246–260, `packages/web/src/client.ts:1795`).

So F, or any progressive or lazy hydration, silently re-creates the late island's DOM. The measurements use an oracle that reopens hydration for a late island; this app keeps nothing in the registry. Real support needs a per-island hydration lifetime, where the registry and snapshots are kept until each island hydrates.

## Results

Chromium 141; each load in a fresh browser context (no code cache); the medians of 7 loads, mean of two runs.
- **load:** bundle compile and eval (an isolated probe), plus the work before the page responds.
- **first click:** a select, including any lazy hydration or resume.
- **rest:** the other six interactions.

### CPU 1x (ms; n = 1000 rows, mean of two runs)

| footer m (live bindings) | Strategy | load | first click | rest of session | total | HTML gz | JS gz |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 (67%) | A | 37.8 | 3.3 | 4.3 | 45.3 | 14.3 KB | 29.9 KB |
| 0 (67%) | D | 35.3 | 3.5 | 4.5 | 43.3 | 14.3 KB | 29.9 KB |
| 0 (67%) | E-lazy | 3.8 | 34.5 | 4.4 | 42.6 | 14.3 KB | 29.9 KB |
| 0 (67%) | F | 3.8 | 35.6 | 4.9 | 44.3 | 14.3 KB | 29.9 KB |
| 0 (67%) | F-csr | 3.1 | 27.3 | 4.0 | 34.4 | 14.3 KB | 24.2 KB |
| 0 (67%) | B | 2.4 | 13.8 | 4.5 | 20.8 | 40.9 KB | 19.5 KB |
| 0 (67%) | C | 2.6 | 10.4 | 5.2 | 18.1 | 33.0 KB | 19.5 KB |
| 1000 (40%) | A | 47.7 | 3.4 | 4.2 | 55.3 | 32.2 KB | 29.9 KB |
| 1000 (40%) | D | 38.1 | 3.3 | 4.3 | 45.8 | 24.9 KB | 29.9 KB |
| 1000 (40%) | E-lazy | 3.8 | 45.6 | 4.1 | 53.5 | 32.2 KB | 29.9 KB |
| 1000 (40%) | F | 3.9 | 34.5 | 4.9 | 43.3 | 24.9 KB | 29.9 KB |
| 1000 (40%) | F-csr | 3.2 | 27.7 | 4.5 | 35.4 | 24.9 KB | 24.2 KB |
| 1000 (40%) | B | 2.4 | 13.6 | 5.4 | 21.5 | 63.8 KB | 19.5 KB |
| 1000 (40%) | C | 2.5 | 10.3 | 4.8 | 17.6 | 40.6 KB | 19.5 KB |
| 5000 (15%) | A | 77.1 | 3.9 | 4.6 | 85.6 | 99.2 KB | 29.9 KB |
| 5000 (15%) | D | 37.2 | 3.4 | 4.8 | 45.3 | 63.4 KB | 29.9 KB |
| 5000 (15%) | E-lazy | 3.8 | 78.0 | 4.4 | 86.2 | 99.2 KB | 29.9 KB |
| 5000 (15%) | F | 3.8 | 37.1 | 4.7 | 45.6 | 63.4 KB | 29.9 KB |
| 5000 (15%) | F-csr | 3.2 | 28.6 | 4.6 | 36.3 | 63.4 KB | 24.2 KB |
| 5000 (15%) | B | 2.5 | 17.6 | 4.7 | 24.8 | 147.5 KB | 19.5 KB |
| 5000 (15%) | C | 2.5 | 10.6 | 5.1 | 18.2 | 68.6 KB | 19.5 KB |

### CPU 4x (ms; n = 1000 rows, mean of two runs)

| footer m (live bindings) | Strategy | load | first click | rest of session | total | HTML gz | JS gz |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 (67%) | A | 138.6 | 15.5 | 20.8 | 174.9 | 14.3 KB | 29.9 KB |
| 0 (67%) | D | 136.2 | 13.9 | 21.0 | 171.2 | 14.3 KB | 29.9 KB |
| 0 (67%) | E-lazy | 18.1 | 131.3 | 21.5 | 170.9 | 14.3 KB | 29.9 KB |
| 0 (67%) | F | 18.3 | 132.3 | 22.7 | 173.3 | 14.3 KB | 29.9 KB |
| 0 (67%) | F-csr | 15.8 | 92.4 | 21.5 | 129.6 | 14.3 KB | 24.2 KB |
| 0 (67%) | B | 12.0 | 44.0 | 22.3 | 78.2 | 40.9 KB | 19.5 KB |
| 0 (67%) | C | 12.0 | 39.6 | 22.5 | 74.1 | 33.0 KB | 19.5 KB |
| 1000 (40%) | A | 172.8 | 15.5 | 20.8 | 209.0 | 32.2 KB | 29.9 KB |
| 1000 (40%) | D | 144.2 | 14.5 | 21.4 | 180.1 | 24.9 KB | 29.9 KB |
| 1000 (40%) | E-lazy | 18.1 | 181.2 | 22.9 | 222.1 | 32.2 KB | 29.9 KB |
| 1000 (40%) | F | 18.1 | 138.1 | 23.7 | 179.9 | 24.9 KB | 29.9 KB |
| 1000 (40%) | F-csr | 15.4 | 93.7 | 19.3 | 128.3 | 24.9 KB | 24.2 KB |
| 1000 (40%) | B | 12.0 | 49.4 | 25.8 | 87.3 | 63.8 KB | 19.5 KB |
| 1000 (40%) | C | 11.9 | 41.1 | 26.1 | 79.2 | 40.6 KB | 19.5 KB |
| 5000 (15%) | A | 312.2 | 16.6 | 22.9 | 351.6 | 99.2 KB | 29.9 KB |
| 5000 (15%) | D | 146.3 | 14.7 | 23.5 | 184.5 | 63.4 KB | 29.9 KB |
| 5000 (15%) | E-lazy | 18.4 | 320.7 | 22.1 | 361.2 | 99.2 KB | 29.9 KB |
| 5000 (15%) | F | 18.1 | 145.9 | 24.4 | 188.5 | 63.4 KB | 29.9 KB |
| 5000 (15%) | F-csr | 15.9 | 95.9 | 20.9 | 132.7 | 63.4 KB | 24.2 KB |
| 5000 (15%) | B | 12.1 | 58.4 | 21.3 | 91.8 | 147.5 KB | 19.5 KB |
| 5000 (15%) | C | 12.0 | 42.2 | 24.6 | 78.7 | 68.6 KB | 19.5 KB |

Run-to-run spread (first click, and init where > 5 ms): max 22%.

### Model: slow 3G, 4x CPU (0.4 Mbps, RTT 400 ms)

| footer m | Strategy | ready (JS eager) | first click | ready (JS deferred) | first click (JS deferred) |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 | A | 1445 | 15 | – | – |
| 0 | D | 1442 | 14 | – | – |
| 0 | E-lazy | 1324 | 131 | 694 | 1162 |
| 0 | F | 1325 | 132 | 694 | 1164 |
| 0 | F-csr | 1204 | 92 | 694 | 1003 |
| 0 | B | 1649 | 44 | 1238 | 856 |
| 0 | C | 1487 | 40 | 1077 | 851 |
| 1000 | A | 1846 | 15 | – | – |
| 1000 | D | 1668 | 15 | – | – |
| 1000 | E-lazy | 1691 | 181 | 1061 | 1212 |
| 1000 | F | 1542 | 138 | 912 | 1169 |
| 1000 | F-csr | 1421 | 94 | 912 | 1004 |
| 1000 | B | 2118 | 49 | 1707 | 861 |
| 1000 | C | 1642 | 41 | 1232 | 853 |
| 5000 | A | 3356 | 17 | – | – |
| 5000 | D | 2457 | 15 | – | – |
| 5000 | E-lazy | 3063 | 321 | 2432 | 1352 |
| 5000 | F | 2329 | 146 | 1699 | 1177 |
| 5000 | F-csr | 2209 | 96 | 1699 | 1007 |
| 5000 | B | 3832 | 58 | 3421 | 870 |
| 5000 | C | 2217 | 42 | 1807 | 854 |

### Model: 4G, 4x CPU (9.0 Mbps, RTT 85 ms)

| footer m | Strategy | ready (JS eager) | first click | ready (JS deferred) | first click (JS deferred) |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 | A | 264 | 15 | – | – |
| 0 | D | 261 | 14 | – | – |
| 0 | E-lazy | 143 | 131 | 99 | 262 |
| 0 | F | 144 | 132 | 99 | 263 |
| 0 | F-csr | 136 | 92 | 99 | 215 |
| 0 | B | 152 | 44 | 123 | 159 |
| 0 | C | 145 | 40 | 116 | 154 |
| 1000 | A | 314 | 15 | – | – |
| 1000 | D | 279 | 15 | – | – |
| 1000 | E-lazy | 160 | 181 | 115 | 311 |
| 1000 | F | 153 | 138 | 109 | 269 |
| 1000 | F-csr | 145 | 94 | 109 | 216 |
| 1000 | B | 173 | 49 | 144 | 164 |
| 1000 | C | 152 | 41 | 123 | 156 |
| 5000 | A | 515 | 17 | – | – |
| 5000 | D | 316 | 15 | – | – |
| 5000 | E-lazy | 221 | 321 | 176 | 451 |
| 5000 | F | 188 | 146 | 144 | 276 |
| 5000 | F-csr | 181 | 96 | 144 | 219 |
| 5000 | B | 249 | 58 | 220 | 173 |
| 5000 | C | 177 | 42 | 148 | 157 |

### Model: cable, 1x CPU (50.0 Mbps, RTT 20 ms)

| footer m | Strategy | ready (JS eager) | first click | ready (JS deferred) | first click (JS deferred) |
| --- | --- | ---: | ---: | ---: | ---: |
| 0 | A | 65 | 3 | – | – |
| 0 | D | 63 | 4 | – | – |
| 0 | E-lazy | 31 | 34 | 23 | 63 |
| 0 | F | 31 | 36 | 23 | 64 |
| 0 | F-csr | 29 | 27 | 23 | 54 |
| 0 | B | 32 | 14 | 28 | 39 |
| 0 | C | 31 | 10 | 26 | 36 |
| 1000 | A | 78 | 3 | – | – |
| 1000 | D | 67 | 3 | – | – |
| 1000 | E-lazy | 34 | 46 | 26 | 74 |
| 1000 | F | 33 | 35 | 25 | 63 |
| 1000 | F-csr | 31 | 28 | 25 | 55 |
| 1000 | B | 36 | 14 | 31 | 39 |
| 1000 | C | 32 | 10 | 28 | 36 |
| 5000 | A | 118 | 4 | – | – |
| 5000 | D | 72 | 3 | – | – |
| 5000 | E-lazy | 45 | 78 | 37 | 107 |
| 5000 | F | 39 | 37 | 31 | 66 |
| 5000 | F-csr | 38 | 29 | 31 | 56 |
| 5000 | B | 50 | 18 | 45 | 43 |
| 5000 | C | 37 | 11 | 32 | 36 |

### Break-even bandwidth for C (pruned resumability)

C ships more bytes than hydration strategies and spends less CPU. Break-even: extra bytes / CPU saved; above it C wins, below it C loses.

| footer m | CPU | vs | extra bytes (gz, HTML+JS) | CPU saved (load + first click) | break-even |
| --- | --- | --- | ---: | ---: | ---: |
| 0 | 1x | F | 8.3 KB | 26 ms | 2.56 Mbps |
| 0 | 1x | D | 8.3 KB | 26 ms | 2.62 Mbps |
| 0 | 1x | F-csr | 14.0 KB | 17 ms | 6.58 Mbps |
| 0 | 4x | F | 8.3 KB | 99 ms | 0.68 Mbps |
| 0 | 4x | D | 8.3 KB | 99 ms | 0.69 Mbps |
| 0 | 4x | F-csr | 14.0 KB | 57 ms | 2.03 Mbps |
| 1000 | 1x | F | 5.2 KB | 26 ms | 1.67 Mbps |
| 1000 | 1x | D | 5.2 KB | 29 ms | 1.50 Mbps |
| 1000 | 1x | F-csr | 11.0 KB | 18 ms | 5.00 Mbps |
| 1000 | 4x | F | 5.2 KB | 103 ms | 0.41 Mbps |
| 1000 | 4x | D | 5.2 KB | 106 ms | 0.40 Mbps |
| 1000 | 4x | F-csr | 11.0 KB | 56 ms | 1.61 Mbps |
| 5000 | 1x | F | -5.2 KB | 28 ms | C wins at any bandwidth |
| 5000 | 1x | D | -5.2 KB | 27 ms | C wins at any bandwidth |
| 5000 | 1x | F-csr | 0.6 KB | 19 ms | 0.26 Mbps |
| 5000 | 4x | F | -5.2 KB | 110 ms | C wins at any bandwidth |
| 5000 | 4x | D | -5.2 KB | 107 ms | C wins at any bandwidth |
| 5000 | 4x | F-csr | 0.6 KB | 58 ms | 0.09 Mbps |

## Verdict

1. **Runtime-only lazy hydration only moves the cost.** E-lazy's total CPU equals A's (171 vs 175 ms at 4× and m = 0; 361 vs 352 ms at m = 5,000). It pays at the first click instead of at load, with 131–321 ms first-click latency on 4× CPU. That confirms the correctness argument: without a map, the first write must hydrate everything.
2. **Pruning is essential: naive resumability loses on slow networks.** B ships 2.2× C's HTML when the page is mostly static (147 vs 69 KB gzipped at 15% live). On slow 3G it is ready at 3.8 s, against 2.2 s for C and 2.3–2.5 s for D and F.
3. **Pruned resumability (C) wins on CPU at every live fraction.**
   - Load plus first click: **52–54 ms against 150–164 ms** for the best hydration strategies (D, F) at 4× CPU, and against 108–112 ms even for the zero-overhead hydration bound (F-csr).
   - The rest of the session costs the same (21–27 ms): once woken, it is the same reactive graph.
4. **Bytes decide the rest, through the live fraction.**
   - C's live closure costs about 19 KB gzipped of serialized bindings and subscribers for 1,000 live rows. Its JS is 10 KB smaller (no component code, no web runtime).
   - Net against D/F: **+8.3 KB at 67% live, +5.2 KB at 40%, −5.2 KB at 15%.**
   - Break-even bandwidth against today's hydration: **0.4–0.7 Mbps on a 4× CPU device, 1.5–2.6 Mbps at 1× CPU.** Against a zero-overhead hydration runtime: 1.6–2.0 Mbps (4×) and 5–6.6 Mbps (1×) when most of the page is live, and 0.1–0.3 Mbps at 15% live.
5. **So resumability is worth it when the graph is aggressively pruned to the live closure**, and either the page is mostly static or the connection is faster than roughly 0.5–2 Mbps. It loses when most of the page is live, the device is fast and the network is slow; a faster hydration runtime widens that losing region. That is the challenge's hypothesis, now with numbers.

## What a compiler must prove, and where it gets hard

- **The live closure** comes from handler and action write sets ("writes only in events and actions") joined with binding read sets. Writes through a dynamic index (`labels[selected]`) make the whole family live; here, every row label.
- **Subscribers**: C-broken shows that under-approximating them is a silent staleness bug, so the proof must over-approximate.
- **Shared-source reads wake everything.** Every row's class reads `selected`, so the first select wakes 1,000 bindings, which is most of C's 40 ms. A projection-shaped selection would wake 2.
- **Server data that can be refetched** (`refresh()`, action revalidation) is live, not static.

## Limits

- One app shape.
- B and C are hand-written stand-ins for a resumable compiler. Their JS excludes component code, and real handlers can pull in more.
- The serialization format is plain JSON and could be denser.
- The network model has no TCP slow start or streaming; it computes `RTT + bytes / bandwidth`.
- F relies on the staggered-hydration oracle above.
- No async data or Suspense boundaries.

## Reproduce

```sh
node scripts/heuristics/resume/bench.mjs --check                   # gate (E-naive and C-broken must fail)
node scripts/heuristics/resume/bench.mjs --out documentation/plans/resumability/results-1.json   # and -2
node scripts/heuristics/resume/bench.mjs --only F-csr --out documentation/plans/resumability/results-1-fcsr.json  # and -2
node scripts/heuristics/resume/report.mjs
```
