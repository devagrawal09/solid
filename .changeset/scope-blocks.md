---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/h": patch
"@solidjs/compiler": patch
---

Render callbacks as blocks, and an islands partition on scopes.

- A `For` / `Show` / `Match` / `Repeat` render callback may be a block with its own setup and view: a bare `function*`, `$(function* …)`, or a named (possibly recursive) row block declared in the setup and passed by name. The setup runs once per row or branch activation and receives the item and the index; its `$cleanup`s run when the row is disposed (the server's `onCleanup` too); the view is tracked like a component view. New `$scope` builds the callback explicitly (`$scopeCompiled` for compiled setups); `renderCallback` / `SCOPE_CALLBACK` in `@solidjs/signals`. Types accept row blocks (`RowBlock`), require settled row views (`[UNSETTLED_ROW]`) and reject creation outside the setup. `@solidjs/h` no longer wraps block callbacks.
- Compiler: row blocks lower to `$scopeCompiled`; `{child => yield* row(child)}` is a compile error (`[YIELD_IN_CALLBACK]`); `store[row.id]` reads lower to a path read.
- `compileIslands` partitions on scopes: row blocks, a `Show` branch holding an island's state and sites, and single-expression helper generators are normalized before the partitioner, so one component and several components compile to the same islands. Exported children of lifted state join the parent's island; lifted state read by a recursive child is one island over the thread (structural regions); a `$store` map read and written only at each row's own key is split into a cell per row. Rows created after activation are disposed with their island. Manifests of existing sources are unchanged.
