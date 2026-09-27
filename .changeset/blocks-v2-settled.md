---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/compiler": patch
---

Generator blocks v2: a run-once effect kind. `yield* $settled(function* …)` in a component setup, or `onSettled(function* …)`, runs an effect block once after the graph settles and never re-runs it (reads are current values, writes and `$cleanup` allowed, no async). The compiler lowers it as an effect body with no split.
