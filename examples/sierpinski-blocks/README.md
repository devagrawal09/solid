# sierpinski-blocks

`examples/sierpinski` rewritten with generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
Same markup, styles and behavior; `pnpm test` runs the behavior tests and a
differential parity test that drives the original and this twin with one
script (`tests/script.ts`) and compares the DOM after every step.

```sh
pnpm test        # vitest + jsdom: behavior + parity with examples/sierpinski
pnpm typecheck   # solid-tsc (the v2 type layer)
pnpm build       # vite build
node ../../scripts/example-blocks/browser.mjs sierpinski   # Chromium, both builds
```

## Porting notes

| Original | v2 | Why |
| --- | --- | --- |
| `Triangle`: `let { x, y, s } = props; if (s <= TARGET) return <Dot/>; const slowChildren = createMemo(…)` | the view reads `yield* props.s` and returns `<Dot/>` or `yield* Branch(props)`; `Branch` owns the memo | a setup may not read props, and a memo can only be created in a setup, so a structural choice made from a prop needs a second component |
| `onCleanup(() => cancelIdleCallback(t))` inside the memo | plain `onCleanup` inside the `attempt` thunk | a memo block has no `$cleanup`; the thunk runs synchronously under the memo owner, so the plain call still registers there |
| `<Loading fallback>` around `<div class="container"><Triangle/></div>` | `Loading({ fallback, children: Container(props) })` with the markup moved to `Container` | the JSX tag `<Loading>` does not admit a pending child (`View<true>` is not a `JSX.Element`); the call form does, but only for a component call, so the markup between the boundary and the pending child becomes a component |
| `<Triangle …>{slowChildren()}</Triangle>` (x3) | `{yield* Triangle({ …, children: slowChildren })}` | a pending child is rendered with `yield*` (propagates); the JSX tag requires a settled child |
| `const Triangle = (props) => …` (recursive) | `const Triangle: BlockComponent<TriangleProps, true, never> = $component(…)` | TypeScript cannot infer a `const` referenced by its own initializer |
| `render(TriangleDemo, document.body)` | `render(() => <TriangleDemo />, document.body)` | a `$component` is typed `(props) => View`; `render` wants `() => JSX.Element` |
| style `left: x + "px"` with `x` destructured | `const x = yield* props.x` at the top of the view | reading inside the style object makes `left` / `top` dynamic, applied after the static properties, which reorders the `style` attribute |
| timer / frame callbacks calling setters | `$event` handlers with `yield* set(…)` | the idiomatic v2 write site |

Compiled output: every view that renders a child with `yield* Child(…)` keeps
`perform` and so the generator driver (`$`), which is most of the bundle
growth (+10.5 kB min).
