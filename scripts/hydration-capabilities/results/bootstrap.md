## Runtime bytes (emitted / minified / gzip / brotli)

| fixture | installers | selected runtime | general runtime | Δ runtime minified | Δ runtime gzip |
|---|---|---|---|---|---|
| read-only | (none) | 98059 / 40002 / 15507 / 14141 | 138296 / 56424 / 21209 / 19299 | -16422 | -5702 |
| event-only | eventReplayHydration | 82038 / 32748 / 12769 / 11684 | 129369 / 51823 / 19420 / 17724 | -19075 | -6651 |
| synchronous-only | eventReplayHydration | 100317 / 40825 / 15809 / 14461 | 138556 / 56478 / 21245 / 19310 | -15653 | -5436 |
| store-using | installSnapshotHydration, installStoreHydration, eventReplayHydration | 176281 / 73016 / 26840 / 24272 | 205110 / 84827 / 30814 / 27831 | -11811 | -3974 |
| streamed | installSnapshotHydration, installAsyncResultHydration, loadingMarkerHydration, streamLedgerHydration, eventReplayHydration | 125479 / 48221 / 18366 / 16738 | 138228 / 52970 / 19966 / 18121 | -4749 | -1600 |
| full-feature | installSnapshotHydration, installAsyncResultHydration, installSsrClientHydration, installSsrHybridHydration, installStoreHydration, installErrorMarkerHydration, loadingMarkerHydration, streamLedgerHydration, lazyAssetHydration, eventReplayHydration | 205017 / 84724 / 30766 / 27759 | 205561 / 85086 / 30897 / 27847 | -362 | -131 |

## Whole client (emitted / minified / gzip / brotli)

| fixture | selected | general | Δ gzip | generated entry bytes (selected / general) |
|---|---|---|---|---|
| read-only | 100206 / 40980 / 16006 / 14569 | 140381 / 57380 / 21690 / 19712 | -5684 | 283 / 257 |
| event-only | 83424 / 33409 / 13147 / 11996 | 130644 / 52428 / 19769 / 18006 | -6622 | 350 / 257 |
| synchronous-only | 103037 / 42085 / 16419 / 14993 | 141164 / 57682 / 21825 / 19805 | -5406 | 338 / 257 |
| store-using | 180603 / 75033 / 27735 / 25058 | 209195 / 86702 / 31661 / 28566 | -3926 | 489 / 257 |
| streamed | 129904 / 50289 / 19248 / 17507 | 142311 / 54834 / 20767 / 18852 | -1519 | 630 / 257 |
| full-feature | 212496 / 88229 / 32191 / 29018 | 212437 / 88201 / 32183 / 28974 | +8 | 950 / 257 |

## Compiler cost (median µs per call)

| fixture | resolveHydrationBootstrap | + inline source map | unknown summary (general) | JSX compile of the app module (reference) |
|---|---|---|---|---|
