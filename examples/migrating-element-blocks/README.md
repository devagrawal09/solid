# Migrating element — `@solidjs/blocks` twin

[`examples/migrating-element`](../migrating-element) written with `@solidjs/blocks` (JSX flavor): the same hoisted canvas migrates between three slots, the inline one is re-created; same markup and behavior.

What the library's rules change in the source:

- `App` and `Canvas` are `$component`s; `App` moved from `main.tsx` to `app.tsx` so tests can mount it (`main.tsx` only renders).
- The slot buttons were a `.map` with a plain arrow; a view cannot read the current slot there, so each button is a row block of a `<For>` (same DOM).
- `onSettled(() => { …; return cleanup })` is `$settled(function* () { …; yield* $cleanup(…) })`.
- The hoisted `<Canvas />` is still created once in the setup and referenced by the three `<Show>` slots.

```bash
pnpm test         # behavior (7) + parity against examples/migrating-element (1): DOM, canvas identity and paint log after 12 steps
pnpm typecheck && pnpm lint && pnpm link:check && pnpm build
node ../../scripts/example-blocks/browser.mjs migrating-element
```
