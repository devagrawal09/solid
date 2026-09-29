# effect-blocks

`examples/effect` (Solid 2.0 × Effect) rewritten with generator blocks v2
([documentation/plans/generator-blocks-v2.md](../../documentation/plans/generator-blocks-v2.md)).
The integration (`src/solid-effect.ts`), the Effect backends (`src/api.ts`)
and the log store (`src/log.ts`) are copied unchanged; the components
(`app.tsx`, `typeahead.tsx`, `checkout.tsx`) are blocks.

```sh
pnpm test        # vitest + jsdom: behavior + parity with examples/effect
pnpm typecheck   # solid-tsc (the v2 type layer)
pnpm build       # vite build
node ../../scripts/example-blocks/browser.mjs effect   # Chromium, both builds, fake clock
```

`tests/script.ts` is one interaction script (typeahead: supersede, stale
results, no matches, retries giving up, reset, log clear; checkout: quantity
edits, a full saga, a typed decline, a mid-charge cancel, tab switches) run
against the original and the twin under the same fake clock and scripted
`Math.random`; the parity test compares the DOM after all 36 steps.

## Porting notes

| Where | Original | v2 | Why |
| --- | --- | --- | --- |
| `typeahead.tsx` | `createMemo<Package[]>(() => … runEffect(searchPackages(q)))` | `$memo(function* () { … return runEffect(…) as unknown as Package[] })` | The read path's whole point is interruption: Solid closes a superseded flight's iterator and `runEffect` interrupts the fiber. `yield* attempt(…)` only awaits a promise and a superseded run is closed without telling the producer, so the fiber and its retries would run on (the parity test's log would differ). Returning the AsyncIterable from the memo block keeps the behavior, but `$memo` types its value as the generator's return, so a cast is needed, and the cast hides the memo's pending state from the type layer. |
| `typeahead.tsx` `Results` | `latest(props.results)`, `isPending(props.results)` | a plain-function prop (`results={() => results()}`) passed to `latest` / `isPending` in the view | there is no block form of `latest` / `isPending`; they take a function, and a prop holding an accessor is read *through* (`yield* props.results` is the list), so the accessor has to be wrapped in a plain function |
| `app.tsx` | `<RuntimeContext value={createRuntime(SearchConfigLive)}>` in App's JSX | a `RuntimeProvider` component whose setup calls `createRuntime` | a view may not create or clean up (`createRuntime` registers an `onCleanup`); a provider component keeps the runtime under the `<Errored>` boundary, as in the original |
| `checkout.tsx` | `createOptimisticStore`, `createOptimistic` | the same plain primitives, called in the setup | no block constructor for optimistic state (`$store` / `$signal` are the plain forms) |
| `checkout.tsx` | `<For each={cart}>{(item, i) => …onClick={() => setCart(c => { c[i()].quantity-- })}…}` | `CartRow` component, `index={i()}` | a render callback cannot hold `$event`s or `yield*`; `For`'s index accessor is typed `Accessor<number>`, not a `SourceAccessor`, so it cannot be forwarded as a prop read |
| `checkout.tsx` | `stepState(step.phase)` read in a `For` callback | `StepItem` component with a `$memo` | same (render callback) |
| `app.tsx` `LogPanel`, orders list, `<Show when={notice()}>{n => …}` | plain render callbacks | kept as plain render callbacks | they only read; a render-callback block would make those reads `yield*` |
| `checkout.tsx` | `effectAction(function* (…) { … yield* reserveInventory(items) … throw e })` | unchanged | the saga generator is the integration's own dialect (it yields Effects to `effectAction`'s driver), not a block; the compiler leaves it alone |
| `app.tsx` | `import { JSX } from "solid-js"` (as in `hn-blocks`) | `import type { JSX } from "@solidjs/web"` | `solid-js` does not export `JSX` |

Observed in both apps (so not a porting difference): log entries written by
the saga's `Effect.sync(() => log(…))` while the checkout action is in flight
do not show until the action settles, although `log.ts`'s header says they
commit immediately.
