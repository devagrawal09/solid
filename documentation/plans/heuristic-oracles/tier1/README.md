# Tier-1 vitest benches (packages/signals/tests/heuristic-oracles.bench.ts)

Quiet machine, `SIGNALS_TIER=prod` twice and the dev tier once, 3 s samples after a 1 s warmup. Mean ms per iteration. A delta is marked noise when it falls within the larger of the two cells' band, where a band is max RME plus the run-to-run spread.

| Group | Variant | prod run 1 (ms) | prod run 2 (ms) | Δ (prod) | dev Δ |
| --- | --- | ---: | ---: | ---: | ---: |
| rows 1000: mount + dispose | baseline | 9.656 | 9.819 |  |  |
| rows 1000: mount + dispose | H1-fuse | 6.697 | 6.757 | −31% | −34% |
| rows 1000: mount + dispose | H1+H8b | 5.945 | 7.562 | −31% | −28% |
| rows 1000: mount + dispose | R-projection | 9.341 | 10.316 | +1% (noise) | +5% |
| rows 1000: select | baseline | 1.309 | 1.225 |  |  |
| rows 1000: select | H1-fuse | 1.315 | 1.273 | +2% (noise) | +18% |
| rows 1000: select | H1+H8b | 1.377 | 1.238 | +3% (noise) | +8% |
| rows 1000: select | R-projection | 0.027 | 0.026 | −98% | −98% |
| chain 100: update | baseline | 0.503 | 0.522 |  |  |
| chain 100: update | H1-fuse | 0.164 | 0.149 | −70% | −74% |
| async rows 1000: refetch | baseline | 8.911 | 8.221 |  |  |
| async rows 1000: refetch | H9-statusless | 7.230 | 8.447 | −8% (noise) | −12% |
| async rows 1000: refetch | H9-direct | 4.153 | 4.567 | −49% | −53% |
| store rows 1000: mount + dispose | store | 12.099 | 11.875 |  |  |
| store rows 1000: mount + dispose | S4-static-id | 8.548 | 7.867 | −32% | −28% |
| store rows 1000: mount + dispose | S2-scalar | 3.154 | 3.498 | −72% | −66% |
| store rows 1000: update10th | store | 0.553 | 0.518 |  |  |
| store rows 1000: update10th | S4-static-id | 0.507 | 0.540 | −2% (noise) | −3% |
| store rows 1000: update10th | S2-scalar | 0.207 | 0.224 | −60% | −58% |
| action: two writes, 400 readers | baseline (action) | 0.665 | 0.678 |  |  |
| action: two writes, 400 readers | A1-batch | 0.545 | 0.507 | −22% | −0% |
