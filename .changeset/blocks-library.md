---
"@solidjs/blocks": minor
"@solidjs/blocks-linker": minor
"@solidjs/eslint-plugin-blocks": minor
---

New packages: generator blocks as a library on stock Solid 2. `@solidjs/blocks` is a runtime interpreter with strict types — `$component(function* (props) { setup; return function* () { view } })`, `$signal` / `$store` / `$memo` / `$effect` / `$settled` / `$event`, typed pending and failures (`attempt`, `raise`, `Loading` / `Errored`), row blocks in `For` / `Show` / `Match` / `Repeat`, `adopt()` for plain components, `render` / `hydrate`, a settled-only JSX namespace (`jsxImportSource: "@solidjs/blocks"`) and a no-JSX flavor (`@solidjs/blocks/h`, `@solidjs/blocks/html`). `@solidjs/blocks-linker` joins what every render site passes into each component's props and writes declaration-merged prop colors that `TypedProps<P, "Key">` reads (Vite plugin and `solid-link` CLI; reads the project's tsconfig path aliases). `@solidjs/eslint-plugin-blocks` covers what TypeScript cannot express: `no-throw`, `no-read-outside-hole`, `yield-in-jsx-hole`, `read-before-attempt`, `no-write-in-reactive`, `typed-props-key`. See documentation/plans/blocks-library.md.
