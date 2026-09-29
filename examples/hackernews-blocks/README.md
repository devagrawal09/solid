# hackernews-blocks

`examples/hackernews` (HackerNews as Solid Server Components over frame
streams) rewritten with generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
Same frames wiring (`serverFunctions.components`), routes, data layer, server
and styles; the 600 KB thread capture is imported from the original.

```sh
pnpm build && pnpm start   # SSR + frames, as the original
pnpm test                  # vitest + jsdom (client-only): behavior + parity with examples/hackernews
pnpm typecheck             # solid-tsc (the v2 type layer)
node ../../scripts/example-blocks/browser.mjs hackernews   # Chromium, both production servers
```

Fixtures (`tests/fixtures`) stand in for the HN API (no network here), as in
`hackernews-spa-blocks`. The parity test runs both apps client-only (the
server components render in-process); the browser check compares both SSR
builds through document loads and client navigation of every route.

## What is v2 and what is not

| Module | v2? | Notes |
| --- | --- | --- |
| `src/routes/*` (route components passed to the router) | yes | each is `$component` whose setup reads its params through a `$memo` and creates the `dynamic()` server-component instance; the view returns that instance |
| `src/app.tsx` `App` (renders `<Router>`) | yes | a `$component` whose **setup** creates `dynamic(() => navView())` and `<Router>…</Router>`; the view returns the router. With the router created in the view (`return function* () { return <Router>…</Router> }`) the SSR document arrives but the page never finishes loading in Chromium (the hydrating client hangs); see also `hackernews-spa-blocks`. |
| `src/components/toggle.tsx` (client component filling the `toggle` slot) | **no** | as a `$component` it works (collapse, client navigation), but in a document-rendered thread its fills are rendered anew on the client instead of adopting the server markup: the DOM differs from the original's (`style="display: block;"` re-serialized from a property write, vs the server's `style="display:block"`) |
| `src/lib/views.tsx` (`"use server"` views returning components) | **no** | as `$component`s they render and stream, but the SSR markup loses the `data-lha` attribute-hole addresses the frames runtime mints on the original's anchors (`<a data-lha="6" href=…>`), and after client navigation the attribute order differs (`href` before `data-lha`) |

## Porting notes and findings

| Where | Original | v2 | Why |
| --- | --- | --- | --- |
| `routes/*` | `const View = dynamic(() => getStory(props.params.id)); return <View toggle={…} />` | `const id = yield* $memo(function* () { return (yield* props.params.id)! }); const View = dynamic(() => getStory(id())); const rendered = <View toggle={…} />; return function* () { return rendered }` | (1) `dynamic`'s source is a plain thunk, which cannot `yield*` a prop, so the prop goes through a memo block the thunk calls. (2) **The instance must be created in the setup.** Written in the view (`return <View … />`), a route mounted by client navigation never appears: the navigation stays pending and the old route stays on screen (hydrated routes work). Creating `<View />` in the setup — where a plain component body creates it — fixes it. |
| `routes/*` | `component: Story` | unchanged | these route components are settled (their views read nothing async), so the router accepts them without the cast `hackernews-spa-blocks` needs |
| `(yield* props.params.id)!` | `props.params.id` | — | `TypedProps` maps the router's `Params` index signature: the read is typed `string \| undefined` |

Islands (`compileIslands`): the three route modules compile, all inert.
