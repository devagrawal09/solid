# hackernews-spa-blocks

`examples/hackernews-spa` (the SSR + hydration HackerNews baseline) rewritten
with generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
Same routes, markup, data layer (`src/lib`), server and styles; the 600 KB
thread capture is imported from the original rather than copied.

```sh
pnpm build && pnpm start   # SSR + hydration, as the original
pnpm test                  # vitest + jsdom (client-only, production runtime): behavior + parity
pnpm typecheck             # solid-tsc (the v2 type layer)
node ../../scripts/example-blocks/browser.mjs hackernews-spa   # Chromium, both production servers
```

The sandbox has no network, so both the tests and the browser check answer
the HN API from fixtures (`tests/fixtures/hn-data.mjs`; the browser check
starts both servers with `tests/fixtures/hn-fetch.mjs` as a `node --import`
`fetch` stub). The parity test drives the original's App and the twin's
through the same client navigation script and compares URL and DOM after
every step; the browser check does the same against both SSR builds,
including document loads of every route and the 1,406-comment thread.

## v2 coverage

`$component`: the three route components (`Stories`, `Story`, `User` — passed
to `@solidjs/router`), `Nav`, the story row, the recursive `Comment`, and
`Toggle` (`$signal` + `$event`). Plain: `App` (see below) and the router's
root-layout render callback.

## Porting notes and findings

| Where | Original | v2 | Why |
| --- | --- | --- | --- |
| `app.tsx` | `export default function App() { return <Router>{props => …}</Router> }` | **unchanged (plain)** | As a `$component` the app SSR-renders and hydrates, but the first client navigation to a route whose data is not cached (a story page) re-creates the route component endlessly — ≈17 000 setups in 30 s, the page freezes. Every other component can be v2; only the component rendering `<Router>` has to stay plain. |
| `app.tsx` | `component: Stories` | `component: routeComponent(Stories)` (a cast) | a route component that reads async data has a pending view (`View<true, …>`), and the router's component type wants a settled `JSX.Element`; the router renders routes under App's `<Loading>`, which the types cannot see through it |
| `routes/*` | `createMemo(() => getStory(props.params.id))` | `$memo(function* () { const id = (yield* props.params.id)!; return getStory(id) as unknown as StoryDefinition })` | The idiomatic v2 form, `return yield* attempt(() => getStory(id))`, breaks under hydration: hydration re-runs memo bodies inside `subFetch`, which swaps the global `Promise` for a `MockPromise` whose executor never runs; the compiled body's `AsyncRun.level()` then never gets its `ok`/`fail`, and the run throws `TypeError: this.ok is not a function` (or `this.fail`) when it is superseded — a page error on every SSR load. Returning the promise as the memo's value (as the original does) avoids the async body, at the price of a cast. |
| `routes/story.tsx`, `user.tsx` | `props.params.id` (`string`) | `(yield* props.params.id)!` | `TypedProps` maps the router's `Params` index signature (`Record<string, string \| undefined>`), so the path read is typed `string \| undefined` |
| `components/comment.tsx` | `const Comment: Component<…> = props => …` (recursive) | `const Comment: BlockComponent<…, false, never> = $component(…)` | TypeScript cannot infer a `const` its initializer references |
| the whole app, **dev runtime** | — | — | Every `<a href>` a `$component` view creates throws `DIRECT_READ_IN_BLOCK` under the dev runtime: `@solidjs/router`'s link claims (`registerElementClaim` → `linkState`) read `router.location.pathname` synchronously while the anchor is created, i.e. inside the view block with the strict read guard up (`untrack` does not lower it). The app is unusable under `vite` dev; the jsdom tests therefore run against the production builds of `solid-js` / `@solidjs/web` / `@solidjs/signals` (`vitest.config.ts`; `DEV_RUNTIME=1` shows the failure). |

Islands (`compileIslands`): every module compiles; `Toggle` is a tier-0 lazy
island, everything else is inert.
