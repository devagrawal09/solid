---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/web": patch
---

Generator blocks v2: `$component`, `$memo`, `$effect`, `$event` with `$signal`, `$store`, `$cleanup`, `$flush` and `yield* Ctx`. Setters from `$signal` / `$store` are yieldable and evaluate to the new value. A component's pending and failures travel with its view: JSX admits settled views only, and `Loading` / `Errored` remove what they handle. `attempt` without error classes declares no failures.
