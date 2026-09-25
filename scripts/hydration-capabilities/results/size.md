## Retained client graph (minified bytes: raw / gzip / brotli)

| graph | csr render() | universal hydrate() | manifest entry | Δ selected vs universal (brotli) |
|---|---|---|---|---|
| sync | 37965 / 14898 / 13534 | 57682 / 21830 / 19786 | 42085 / 16419 / 14993 | -4793 (-24.2%) |
| store | 66718 / 24672 / 22268 | 86702 / 31676 / 28528 | 75033 / 27735 / 25058 | -3470 (-12.2%) |
| async | 37209 / 14627 / 13281 | 54705 / 20761 / 18851 | 45013 / 17474 / 15906 | -2945 (-15.6%) |
| streaming | 37205 / 14616 / 13264 | 54834 / 20762 / 18884 | 50289 / 19248 / 17507 | -1377 (-7.3%) |
| lazy | 34401 / 13521 / 12305 | 54240 / 20547 / 18666 | 40065 / 15604 / 14219 | -4447 (-23.8%) |
| full | 70350 / 26019 / 23482 | 88201 / 32179 / 28988 | 88229 / 32191 / 29018 | +30 (0.1%) |

## Capability marginal cost, added alone to the sync graph's minimal runtime (bytes)

| capability | raw | gzip | brotli |
|---|---|---|---|
| base |  42085 |  16419 |  14993 |
| snapshots |    614 |    264 |    259 |
| asyncResults |   3653 |   1262 |   1093 |
| storeAdapters |   3987 |   1463 |   1263 |
| errorMarkers |   2282 |    895 |    776 |
| loadingMarkers |   4838 |   1812 |   1638 |
| streamLedger |   8000 |   2861 |   2550 |
| lazyAssets |   1465 |    530 |    449 |
| ssrSources[client] |   1716 |    654 |    582 |
| ssrSources[hybrid] |   3720 |   1331 |   1221 |
| ssrSources[client,hybrid] |   3965 |   1412 |   1288 |
| delegatedEvents (replay) |    795 |    290 |    315 |

## Removed from the full runtime (bytes saved)

| capability | raw | gzip | brotli |
|---|---|---|---|
| full |  57704 |  21837 |  19847 |
| asyncResults |    942 |    300 |    271 |
| storeAdapters |   1555 |    535 |    447 |
| errorMarkers |    323 |    119 |    131 |
| streamLedger |   3162 |   1038 |    914 |
| loadingMarkers+streamLedger |   5382 |   1805 |   1666 |
| lazyAssets |   1432 |    448 |    440 |
| ssrSources |    847 |    304 |    303 |
| universal - full-manifest (same capabilities) |    -22 |     -7 |    -61 |
