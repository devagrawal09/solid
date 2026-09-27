---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/compiler": patch
---

Add the experimental `syncActions` compiler option (off by default, DOM output only): an `action(function* …)` whose body has no `yield` compiles to the new internal `syncAction(function …)`, which runs the body in the ambient batch without opening a transaction (−19% per call), keeping the owned-scope guard, provenance, flush guard, attribution brackets and the returned promise.
