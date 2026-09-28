---
"@solidjs/compiler": patch
"@solidjs/signals": patch
"solid-js": patch
---

Generator blocks v2: the lowering covers server output, helper generators and the remaining async cases, and compiled bundles shed the last pieces of the block machinery:

- Server (SSR) output gets the same lowering as the client (direct setup creations, erased setups and events, async bodies through `asyncBody`, context reads, `readAccessor` / `readSelected` view reads), so hydration ids stay aligned and server bundles of compiled v2 apps no longer use `perform` or the generator driver.
- Helper generators lower beyond context reads: a module-level `function*` whose every `yield*` is a context read, an accessor read, a creation (`$signal`, `$store`, `$memo`, `$effect`, `$settled`), a `$cleanup`, a `raise` statement or another lowered helper becomes a plain function where every call site's host admits its operations, or gains a lowered twin (`name$lowered`) next to the generator. Exported twins are listed in the module's `helperSummary` (new `transform()` output); the new `helperSummaries` option lowers call sites of imported helpers, and `@solidjs/compiler/helpers-build` (`summarizeHelperGraph`, `solidHelperSummaries`) produces the summaries for a build.
- An async `$event` body with `yield* $flush()` statements compiles to an async function too.
- A compiled async body's result promise now settles in the driver's microtask when the body suspends more than once (`AsyncRun` rebuilds the driver's promise chain; compiled bodies get a `finally { _$a.f(); }`).
- A view returning a fragment of intrinsic elements is proven `BLOCK_SYNC`.
- The operation switch (`performOp`) is installed by the constructors of the operations it runs, so a fully compiled bundle no longer retains it through the path readers.
- The path readers recognize an accessor found at a path by its refresh brand as well as its iterator: in the generator-free runtime slice (`ITERABLE` off) a prop holding a signal was returned unread.
- The capability linker installs the block driver (new internal `installBlockDriver`) in a module whose output still hands a generator body to `createMemo` / `createEffect` / `onSettled` — a module the Solid compiler did not transform — and warns, instead of letting a production bundle run the body as a plain callback.
