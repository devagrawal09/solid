---
"@solidjs/compiler": patch
"@solidjs/signals": patch
"solid-js": patch
---

Generator blocks v2: compiled async `$event` handlers are leaner. The compiler emits `$eventAsync(async function …)` (new internal export) instead of `$eventCompiled(asyncBody(…))`: a handler returns nothing, so its dispatch skips the result promise chain `asyncBody` rebuilds for memos and routes a failure after a wait to the nearest boundary (or rejects unhandled) in the job the body fails in. Event bodies drop the identity resume call and inline `attempt(() => expr)` outside a user `try` without allocating a closure. Attempts in compiled async bodies skip the strict-guard and untrack brackets when they would change nothing, and event dispatch no longer allocates a closure context when it already runs without an owner.
