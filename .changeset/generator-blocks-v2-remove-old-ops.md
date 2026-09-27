---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/compiler": patch
---

Generator blocks v2: remove the `wait`, `write` and `call` block operations. Async is `yield* attempt(() => promise)`, typed writes are `yield* set(value)` with `$signal` / `$store` setters (plain setters are called directly), and composition is `yield* Child(props)`. The compiler keeps a block that attempts on the runtime driver (an attempt may suspend), and the capability linker treats such a block as possibly async.
