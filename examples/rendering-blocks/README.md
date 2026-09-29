# rendering-blocks

`examples/rendering` (one shared app under three render modes: client-only,
streaming SSR, string SSR) with the shared app rewritten in generator blocks
v2 ([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
The three variants (`csr/`, `stream/`, `string/`), their servers and entries
are copied unchanged.

```sh
pnpm build                 # csr:build + stream:build + string:build
pnpm stream:start          # or string:start / csr:start, as the original
pnpm test                  # vitest + jsdom (CSR): behavior + parity with examples/rendering
pnpm typecheck             # solid-tsc (the v2 type layer)
node ../../scripts/example-blocks/browser.mjs rendering --variant csr|stream|string
```

The browser check runs one script (every route by client navigation and by
document load, with the page clock paused) against both apps' builds of the
chosen variant; all three pass.

## What is v2 and what is not

| Module | v2? | Notes |
| --- | --- | --- |
| `router.tsx` (`RouteHOC`, `Link`, `useRouter`) | yes | see the notes on `location` below |
| `App.tsx` | yes | `RouteHOC($component(…))`; `matches(name)` becomes a helper generator `at(name)` the view `yield*`s |
| `Home`, `Settings`, `Stream`, `Skeleton`, `RevealPage`, `Profile` (index and lazy) | yes | lazily loaded ones export `eager(Component)` (see below) |
| `Shell.tsx` (the SSR document shell) | **no** | as a `$component` the streamed page fails to hydrate: `lazy() module "…/Home.tsx" (hydration id "011000c0") was not preloaded before hydration` + `REACTIVITY_HALTED` |
| `ErrorStream.tsx` (the page and its two boundary items) | **no** | as `$component`s the streamed page hydrates with an uncaught `Item bad-item not found` page error, and the DOM differs from the original's |
| `Reveal.tsx` `AsyncCard` | **no** | as a `$component` (setup: the delayed memo; view: `<Loading>` over the card) the streamed page hydrates into duplicated cards (`A, A, B, B loading…, C, …`) |

CSR and string SSR work with every component as a `$component`; the three
"no" rows fail only under streaming SSR + hydration.

## Porting notes

| Where | Original | v2 | Why |
| --- | --- | --- | --- |
| lazily loaded modules | `export default Settings` | `export default eager(Settings)` (`shared/src/eager.ts`: `props => renderBlock(Settings(props))`) | On the server, `lazy()` returns the component's value from its render memo. For a `$component` that value is a view, rendered later; when the module was not loaded yet (the first request that reaches it), the view is rendered while the SSR string is serialized, outside the hydration context, and throws `getNextContextId cannot be used under non-hydrating context` (the response ends after `<!DOCTYPE html>`). Rendering the view inside the memo fixes it. |
| `router.tsx` | `const [location, setLocation] = createSignal(initialPath(props.url))` | `const initial = yield* $memo(… yield* props.url …); const [location, setLocation] = createSignal(() => initial())` | A setup cannot read props and `$signal` takes a value, not a derivation, so the location is a plain writable derived signal over a memo block of the prop. A first version (a memo overridden by a separate `$signal`) rendered the same but `isPending(location)` never turned true, so the tab lost its `pending` class during navigation. |
| `ErrorStream.tsx` (tried) | `const [id, setId] = createSignal(props.id)` | a memo of the prop overridden by a `$signal` | same: a signal seeded from a prop |
| `Profile/index.tsx`, `Skeleton`, `AsyncCard`, `ErrorStream` | `createMemo(() => fetch…())` | `$memo(function* () { …; return fetch…() as unknown as T })` | `yield* attempt(() => …)` breaks under hydration (see `hackernews-spa-blocks`: hydration's mock `Promise` leaves the compiled body's result promise without settle functions); returning the promise needs a cast |
| `Stream.tsx` | `createMemo(async function* () { … })` | `$memo(function* () { return accumulate() as unknown as StreamItem[] })` | blocks are never `async function*` and `attempt` awaits one promise; the memo block returns the async iterable |
| `Stream.tsx`, `Skeleton.tsx` | `createProjection(async function* …)`, `createStore(async draft => …, seed, { seedLoadingValue })` | unchanged, in the setup | no block constructor for projections or derived stores |
| `App.tsx`, `Skeleton.tsx` | `isPending(location)`, `isPending(() => store.items)` | unchanged, in the view | no block form of `isPending` |
| `Settings.tsx` | `createUniqueId()` → `100j00` (streamed SSR) | → `12000c00` | the id comes from the owner tree, which views deepen; consistent between server and client (hydration is fine) but not the original's value — the checks normalize it |
| `Reveal.tsx` radios, `Settings.tsx` buttons | `onInput={() => setOrder("sequential")}` | `onInput={pick("sequential")}` (an `$event` factory) | handlers are `$event`s |
