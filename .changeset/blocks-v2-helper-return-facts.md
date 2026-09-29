---
"@solidjs/compiler": patch
---

Generator blocks v2: lowered helper generators carry return facts. When a helper returns an accessor, a store, or a fresh object / array literal on every path, reads of its result lower to direct calls (`const d = useThing()`: `yield* d` → `d()`; `const k = useCounter()`: `yield* k.d` → `k.d()` when `k` is never written or passed on). Exported helpers list the fact in `helperSummary` (`returns`), so importers compiled with `helperSummaries` benefit too.
