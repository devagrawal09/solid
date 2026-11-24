---
"@solidjs/signals": minor
---

Prototype: core feature switch `__SOLID_CORE_ASYNC__` in the `dist/select` tier. `false` treats every computation as `sync: true`: a returned object is its value and is never awaited, and the async result handling folds out of `recompute`.
