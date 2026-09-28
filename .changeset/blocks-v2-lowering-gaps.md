---
"@solidjs/compiler": patch
"@solidjs/signals": patch
"solid-js": patch
---

Generator blocks v2: a fully compiled app no longer ships the generator driver, and its hot paths no longer go through `perform`:

- A `$memo` / `$event` body that waits (`yield* attempt(() => promise)`) compiles on the client to an `async function` run by `asyncBody` (new internal entry), with the driver's semantics: a plain `attempt` result continues synchronously, a synchronous failure is reported synchronously, a superseded memo run never resumes, and the continuation runs in the same microtask as the driver's. Bodies whose other operations cannot be erased keep their generator, unchanged.
- Setup context reads (`yield* Ctx` of a `createContext` binding) compile to `readContext(Ctx)`, and a module-local helper generator that only reads contexts (`function* useTodos() { return yield* Ctx; }`) compiles to a plain function its setups call directly, so those setups lose their block.
- View reads the fusion could not erase (attribute holes, component prop getters) compile to `readAccessor(acc)` / `readSelected(store, selector)`, and to plain calls inside the effect or insert computation the JSX transform creates.
- `onSettled(function* …)` / `$settled` bodies fuse like effect halves (`onSettled(fn)` returning the cleanup).
- A view returning `<Show>`, `<For>`, `<Switch>`, `<Repeat>`, `<Loading>` or `<Errored>` from `solid-js` is proven `BLOCK_SYNC`.
- The path readers no longer reference `perform` (a path token and a readable found at a path are read without the generic dispatch), so a bundle with no `perform` call drops it.
- `storeForms` reuses an existing `createPlainStore` specifier from the same module instead of adding a second one.
