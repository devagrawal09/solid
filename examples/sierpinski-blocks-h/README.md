# Sierpinski — `@solidjs/blocks` twin, no-JSX flavor (`h`)

[`examples/sierpinski`](../sierpinski) written with `@solidjs/blocks` and `@solidjs/blocks/h`: no JSX in the app (`src/app.ts`), no JSX transform involved in the views. The JSX-flavor twin is [`sierpinski-blocks`](../sierpinski-blocks); the setups are the same (position props taken with `$snapshot`, timer / frame callbacks as `$event`s).

What changes in the no-JSX flavor:

- Every dynamic value is a hole: the container's `style` and the dot's `style` and label are `$(function* () { … })` blocks. The view generators never read, so each runs once.
- Components are given to `h` (`h(Triangle, { x, y, s, children: slowChildren })`) and created where the output is materialized; a branch returns the fragment `h([a, b, c])`.
- The pending coloring flows through `h`: a triangle's output is pending (its branches read an async memo), so `TriangleDemo` must wrap the container in `h(Loading, …)` — without it `render(TriangleDemo, …)` is a type error.

The generated `src/solid-props.gen.d.ts` is identical to the JSX twin's: the linker reads `h(Component, { … })` render sites like JSX tags.

```bash
pnpm test         # behavior (6) + parity against examples/sierpinski (1)
pnpm typecheck && pnpm lint && pnpm link:check && pnpm build
node ../../scripts/example-blocks/browser.mjs sierpinski --twin -blocks-h   # after building both
```

Client bundle (min / gz): original 40,576 / 15,761 B; JSX twin 46,382 / 17,911 B; this twin 60,685 / 22,803 B (it ships `@solidjs/h` and builds its DOM at runtime instead of from compiled templates).
