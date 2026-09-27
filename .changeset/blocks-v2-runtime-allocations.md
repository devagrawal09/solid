---
"@solidjs/signals": patch
---

Generator blocks v2 runtime: cut the per-operation allocations. `$signal` / `$store` setter receipts are instances of one class (no generator function per write; `perform` reads the value directly), v2 operations share one prototype iterator, `perform` keeps its closures out of the accessor path, a block run allocates no token list, no rest-argument array and runs one result-shape probe (none for a non-object result), blocks and views share one iterator function, a split effect's cleanups are collected without a closure or an empty list, and an event dispatched with no current owner skips the `runWithOwner` bracket. `$component` event dispatch is ~7× cheaper, component creation ~20% and effect runs ~40% (instruction counts, `documentation/plans/blocks-v2-performance.md`).
