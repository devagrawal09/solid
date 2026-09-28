---
"@solidjs/compiler": patch
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/web": patch
---

Generator blocks v2: static views. The compiler flags a view `BLOCK_STATIC` (new block flag `4`) when it is a single `return` of JSX whose every `yield*` sits in a position the JSX transform defers (a child hole, a dynamic intrinsic attribute, a component prop). Outside hydration, `insert` renders such a view once, untracked, instead of in a render effect that has no sources and could never re-run: a compiled component then costs what a plain component returning DOM costs.
