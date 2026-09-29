# Sierpinski — `@solidjs/blocks` twin

[`examples/sierpinski`](../sierpinski) written with `@solidjs/blocks` (JSX flavor) on stock Solid 2: same markup, timing and behavior. The original stays as the baseline.

What the library's rules change in the source:

- **Setup creates, view reads.** A triangle chooses its structure from its position props. The original destructures `props` in the component body; here the setup takes those values with `$snapshot` (the value at creation, untracked — what the destructuring did) and returns the leaf view or the branch view.
- **Pending travels with the view.** The branch memos wait for an idle callback, so a triangle may be pending (`Component<TriangleProps, true, never>`, spelled out because the component is recursive). A view that reads a pending child is pending too, so the container markup moved into `Container` and the boundary receives it as a pending view: `<Loading fallback="Loading...">{Container({ scale, seconds })}</Loading>`.
- **Events are `$event`s**, the timer and frame callbacks included.
- The idle-callback cleanup stays a plain `onCleanup` inside the `attempt` thunk (it runs under the memo).

The type linker's output, `src/solid-props.gen.d.ts`, is committed: the seconds passed down the recursion are pending (`Triangle.children`, `Dot.children`), which is why the leaf renders its dot with `{yield* Dot(…)}`.

```bash
pnpm test         # behavior (6) + differential parity against examples/sierpinski (1)
pnpm typecheck    # stock tsc
pnpm lint         # @solidjs/eslint-plugin-blocks + no explicit any
pnpm link:check   # the committed linker output is current
pnpm build
node ../../scripts/example-blocks/browser.mjs sierpinski   # Chromium, original vs twin
```
