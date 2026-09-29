# diagnostics-blocks

`examples/diagnostics` (four reactive defects a compiler cannot see, each
reported by Solid 2's runtime diagnostics and attribution channels) with its
components rewritten in generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
The defect code itself — `inventory.ts`, `cart.ts`, `story-chain.ts`,
`story-page.ts`, the steppers, `channel.ts`, `paint-log.ts` — is the original's,
with the type changes listed below.

```sh
pnpm dev                  # the dev tier (port 3010)
pnpm build                # production: the page says it has no diagnostics channel
pnpm build:observe        # the observe tier: live panels in a production bundle
pnpm test                 # the original's five suites against the twin + a parity test
pnpm typecheck            # solid-tsc (the v2 type layer)
node ../../scripts/example-blocks/browser.mjs diagnostics                  # dev servers
node ../../scripts/example-blocks/browser.mjs diagnostics --mode static    # after build / build:observe
```

`tests/parity.test.tsx` drives the whole demo — all four cards in both modes,
the focus select — against the original's App and this one, each on a fresh
module graph (the attribution engine is process-wide), and compares the DOM,
evidence panels included, after every step. Timings and owner paths are
normalized (see below).

## What is v2 and what is not

| Module | v2? | Notes |
| --- | --- | --- |
| `App`, the scenario card | yes | the card's view is rendered with `renderBlock` in the `<For>` row (see "Bugs") |
| `ResultsPanel`, `CheckoutSummary`, `StoryCard` (+ `Story`), `QuantityStepper` | yes | built per mode (`per-value.ts`) |
| `EvidencePanel`, `EvidenceBody`, the three row components | yes | |
| `Excluded` | **no** | a root boundary: it calls `props.children()` inside `createRoot` |
| the named effects (`tear:summary`, `overrun:shipping`, `waterfall:page-complete`) | **no** | plain `createEffect(…, { name })`: an effect block takes no options, and every diagnostic is routed to its card by these names |
| data layer (`inventory`, `cart`, story chain/page, steppers, channel, paint log) | **no** | module-level factories, not components: `$signal`/`$memo` exist only in a setup |

## Porting notes

| Where | Original | v2 | Why |
| --- | --- | --- | --- |
| the four scenarios | `const inventory = props.broken ? createRelayedInventory() : createDerivedInventory()` in the body | `perValue(broken => $component(…))` + a dispatcher `$component` whose view picks the built one | a setup cannot read props; the mode decides which graph exists |
| `App` | `<Show when={broken()} fallback={<scenario.view broken={false} />}><scenario.view broken={true} /></Show>` | `<View broken={yield* props.broken} />` | the dispatcher's view re-runs on the mode and builds the other graph — same rebuild |
| `inventory.ts`, `cart.ts`, `story-chain.ts`, `paint-log.ts`, `channel.ts` | `Accessor<T>` fields | `SourceAccessor<T>` | a view reads with `yield*`; `Accessor<T>` is not iterable at the type level |
| `cart.ts` (wide summary) | `gift: () => summary().gift` | `gift: createMemo(() => summary().gift)` | a view cannot read a plain derived function (no `yield*` on it, and a direct call throws `DIRECT_READ_IN_BLOCK`); one extra unnamed node in the broken graph, which changes no diagnostic |
| `story-page.ts` | `story: () => page().story` (×3) | three unnamed memos | same |
| `CheckoutSummary` | `model.cart.lines` | `(model.cart as unknown as TypedStore<Cart>).lines` | a plain `createStore` store reads with `yield*` at runtime, but only `$store` is typed that way |
| `CheckoutSummary`, `StoryCard` | `rerunsOfEffect()` / `chains()`: read `paint.frames()` to refresh, then query the engine | `((yield* paint.frames), scenarioReruns(…))` inline in the hole | the same dependency, written as a read |
| `StoryCard` | the story `<article>` inline under `<Loading>` | a `Story` component | the `<Loading>` tag does not take a pending child written inline |
| `StoryCard`, `App` row callbacks | `class={selected() === id …}`, `broken={broken()}` | unchanged: direct calls in plain render callbacks | render callbacks cannot `yield*` (render-callback blocks would help) |
| `StoryCard`, `QuantityStepper` | `isPending(() => view.story().id)`, `isPending(quantity)` | unchanged, in the view | no block form of `isPending` |
| `EvidencePanel` | `<Excluded>{() => { const feed = scenarioFeed(props.feed); return <div>{props.children}…</div> }}</Excluded>` | the view reads `feed`/`show*` and returns `<Excluded>{() => <EvidenceBody …>{props.children}</EvidenceBody>}</Excluded>` | `Excluded` takes a render callback (no `yield*`). `props.children` is forwarded **unread** (a path read the renderer resolves): read with `yield*` in the panel's view, the scenario's measurement list was created outside the excluded root and the engine counted its `<For>` as an app re-run (`re-runs caused: 3` instead of `1` for "Reset") |
| `Excluded` | `return props.children()` inside `createRoot` | `renderBlock(props.children())` inside `createRoot` | the child is a `$component` — its call returns a view (from inside a view, a deferred view thunk) that would render where it is *inserted*, outside the excluded root, so nothing in it would be excluded |
| handlers | `onClick={() => setMode(true)}`, … | `$event`s (`setMode(true)` is an `$event` factory) | |

## Bugs and differences found

- **A `$component` view returned from a `<For>` row (or as the direct child
  of `<Show>`, …) is re-rendered whenever the flow's output is re-read** —
  `flatten` in `@solidjs/signals` runs `renderBlock` on every block it walks,
  each time it walks it. The row's setup does not re-run, but its DOM and
  every component under it are rebuilt, so their state is lost. Here: changing
  the focus select reset the surviving card (the waterfall card forgot the
  loaded story). Minimal repro: a `<For>` of `$component` rows each holding a
  `$component` counter; click a counter, remove the other row: the counter
  reads `0` again (a plain row component, or wrapping the row in an element,
  keeps `1`). Workaround: `renderBlock(ScenarioCard({ … }))` in the row
  callback.
- **Owner paths lose component names.** The diagnostics show
  `in <For> › <Show> › value › <ResultsPanel> › tear:summary` for the original
  and `in effect › effect › effect › effect › tear:summary` for the twin: a
  `$component` rendered from a view is a deferred call (`lazyView`) whose setup
  runs under an owner created at render time, not inside the `<Name>`-labelled
  root that dev/observe `createComponent` opens. Parity and the browser check
  normalize the `event-owner` line.
- Timing: the original's `StoryCard` says "nothing loads until a story is
  picked", but both apps start the story → author → avatar chain for story 1
  at mount. The parity script waits for it before the first step.
- Under `vite` dev in Chromium, neither app's evidence panels receive a
  diagnostic (the same as `attribution-lab`); the jsdom suites and the observe
  build show them, identically for both apps.
