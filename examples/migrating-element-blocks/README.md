# migrating-element-blocks

`examples/migrating-element` rewritten with generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
Same markup, styles and behavior; `src/logoCanvas.ts` is copied unchanged.
`pnpm test` runs the behavior tests and a differential parity test
(`tests/script.ts`) that drives the original and the twin with one script and
compares, after every step, the DOM, which canvas elements are the same nodes
as before, and what each canvas painted (a recording 2D context stub).

```sh
pnpm test        # vitest + jsdom: behavior + parity with examples/migrating-element
pnpm typecheck   # solid-tsc (the v2 type layer)
pnpm build       # vite build
node ../../scripts/example-blocks/browser.mjs migrating-element   # Chromium, both builds
```

## Porting notes

| Original | v2 | Why |
| --- | --- | --- |
| `const hoistedCanvas = <Canvas />;` … `{hoistedCanvas}` in three slots | `const hoistedCanvas = children(() => <Canvas />);` … `{hoistedCanvas()}` | **Semantics differ.** A plain component call returns DOM, so the hoisted value is one node the runtime migrates. A `$component` call returns its *view*, which renders anew at every insertion point: the naive port renders a new canvas per slot (the parity test catches it: new node, no reset, no click listener). `children()` resolves the view to its DOM once. |
| — | `{hoistedCanvas()}`, not `{yield* hoistedCanvas}` | `ChildrenReturn` is typed as a plain `Accessor`, which is not iterable, so the v2 read form does not typecheck (and an untyped read turns the whole view into `View<boolean, unknown>`, which `render` then rejects) |
| `{slots.map(s => <button class={{ active: slot() === s }} onClick={() => setSlot(s)}>…)}` | a `SlotButton` component per button | a `.map` callback is a plain arrow and cannot `yield*`; a render-callback block would keep the row inline |
| `onSettled(() => { …; return cleanup })` | `yield* $settled(function* () { …; yield* $cleanup(cleanup) })` | the v2 run-once effect |
| `App` and `render` in `main.tsx` | `App` in `app.tsx`, `render(() => <App />)` in `main.tsx` | so tests can mount it; a `$component` is not a `() => JSX.Element` for `render` |

The canvas `ref` callback, the frame loop and the native click listener are
kept as plain functions: they do no reactive reads or writes.
