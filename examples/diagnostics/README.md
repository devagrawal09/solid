# Four defects a compiler cannot see

A small demo of Solid 2.0's **runtime** diagnostics: four reactive bugs that type-check, review
clean, and produce the right final values — each one caught, named and explained by the two dev
channels the runtime already ships.

```bash
pnpm install
pnpm --filter diagnostics-example dev   # http://localhost:3009
```

Every code, message, hold and number the page renders arrives on one of these:

- `OBSERVE.diagnostics.subscribe()` — the structured channel behind the console reports (stable
  codes, severity, owner path).
- `solid-js/attribution` — the attribution engine: per-re-run causality, transition holds, and the
  interaction frames the web runtime stamps onto every delegated event.

Nothing in `src/` hardcodes a finding. Delete the scenario's bug and its card goes quiet, because
the card is rendering the channel, not a script.

## Presenting it

Open the page, leave the toolbar on **Broken**, and walk the four cards top to bottom. Each takes
one interaction. Then hit **Fixed** — every graph is rebuilt from scratch, the feeds clear, and the
same interactions produce silence.

| #   | Do this                                        | What breaks                                                              | What the runtime says                                                          |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | Type `b` in **Search parts**                   | For one frame the new query is shown beside the old results              | `EFFECT_RELAY_TEAR`, naming victim, root, relay and the signal it wrote        |
| 2   | Type a **gift note**                           | An effect that re-prices the cart runs on every keystroke                | `UNSTABLE_MEMO_OUTPUT` + the per-run causes from `attribution.history()`       |
| 3   | Click **Story 1** (nothing loads until you do) | 3 requests, ~660ms, one after another                                    | `ASYNC_WATERFALL` at `warn`, with the proven chain and its serialized cost     |
| 4   | Click **Add one** twice, fast                  | The cart ends up with 1 item, and the screen was dead for the whole wait | `SILENT_HOLD` + the hold record: the click, the action, and every staged write |

Card 3 deliberately loads nothing on mount: the chain the runtime reports is the one **your click**
started. The verdict is emitted once per node, so a second story adds timing and chain evidence to
the card rather than a second warning.

The `select` in the toolbar isolates one card if you want to project a single scenario.

The browser console is worth having open: `warn`-level diagnostics print there with the owner
chain and a link to the repair skill. The page shows the same events as structured records.

## The four scenarios

### 1 · The frame nobody looks at (`EFFECT_RELAY_TEAR`)

`scenarios/tear/inventory.ts` keeps the filtered list in a signal and re-syncs it with an effect.
`scenarios/tear/ResultsPanel.tsx` reads _both_ the query and the list. Neither file is wrong on its
own — the defect is in the schedule between them, which is why no compiler can find it: the effect
runs in the flush _after_ the one where `query` changed, so one frame pairs the new query with the
previous matches. Watch the "frames painted" list: one keystroke, two frames, the first one wrong.

The repair is a `createMemo`. It is more correct (the two values can never disagree, because there
is only one value), more idiomatic (derived state is a derivation), and cheaper (one flush, one
node fewer, and lazy while nothing reads it).

### 2 · The effect that runs on every keystroke (`UNSTABLE_MEMO_OUTPUT`)

`scenarios/overrun/cart.ts` summarises the whole cart record — including the gift note being typed
— and returns a fresh `{ count, total, gift }` each run. Nothing the summary reports can change
while you type, but the object identity does, so the memo's equality gate never closes and the
shipping effect in `scenarios/overrun/CheckoutSummary.tsx` re-runs for every character.

The runtime reports the memo after four consecutive equivalent outputs, and `attribution.history()`
names the cause of each effect run. The repair splits the memo by what each half depends on: the
summary over `cart.lines`, the gift flag over `cart.note`. The feature survives — the badge still
appears as you type — but the note no longer reaches the checkout total, so typing costs zero
re-runs of the summary or the shipping effect, asserted as
`expectRerunBudget(artifact, 0, { scope: "overrun:shipping" })`.

### 3 · Three requests standing in line (`ASYNC_WATERFALL`)

`scenarios/waterfall/story-chain.ts` asks for a story, then the author the story named, then the
avatar the author named. Each memo is reasonable; together they are three serial round trips.

The engine asserts a chain link only on double proof — the dependent flight's recompute was
_caused_ by the upstream's landing, and its origin post-dates that landing — so a preload already
in the air is never blamed. Depth 3 escalates to a console `warn`.

The repair (`scenarios/waterfall/story-page.ts`) keys every request by the story id the caller
already has and composes them in one memo, colocated with the screen that renders it:
`Promise.all` of three requests that leave together. Same data, same request count, one round trip
of waiting — the card measures it.

Loading a _second_ story holds the id write behind the new page's async, so the card reads
`isPending` and shows an `updating…` badge in **both** modes. That affordance belongs to the screen,
not to the data layer, which is why the fixed variant is clean on the whole channel (its test
asserts `expectNoDiagnostics`) rather than merely free of waterfalls.

### 4 · The click that lost an update (`SILENT_HOLD` + interaction attribution)

`scenarios/action/QuantityStepper.tsx` runs an `action` that reads the quantity, awaits the save,
then writes the number it computed _before_ the await. Two clicks inside one round trip both read
`0`, both write `1`. The buyer gets one item.

Because the write lands on pending async, Solid holds it — correct, and invisible: the screen kept
the old value and nothing said a wait was happening. The attribution record ties the whole story
together without a breakpoint:

```
interaction : click on button#action-inc "Add one"
action      : true
held writes : action:quantity  0 → 1      ← two clicks, one staged write
waiting     : 153ms, acknowledgements: none, effects painted: 0
```

The second click is the dead one: it recomputes the same `1`, so it writes no state at all and the
interaction table says exactly that (`nothing to wait for — this click wrote no state`) beside the
hold that shows the real 153ms wait.

The repair writes optimistically (`createOptimistic`) so the expected result shows immediately —
which is also what acknowledges the hold — and lets the server apply a **delta**, so overlapping
clicks compose. Two clicks, two items, no silent hold.

## Tests

```bash
pnpm --filter diagnostics-example test        # vitest + jsdom
pnpm --filter diagnostics-example typecheck
```

The suites mount the real components, drive real DOM events (so the web runtime's interaction
stamping is exercised), and assert on captured artifacts from `@solidjs/diagnostics`:

- `tests/tear.test.tsx` — the tear is reported, the reader runs twice, the first painted frame is
  the stale one; the fixed variant is silent and runs once.
- `tests/overrun.test.tsx` — one effect run per keystroke and the `UNSTABLE_MEMO_OUTPUT` verdict;
  the fixed variant holds a zero re-run budget while still reacting to real cart changes.
- `tests/waterfall.test.tsx` — nothing is requested before the click, the click's own chain is the
  exact three links at `warn`, and the parallel repair completes in under two round trips with
  `expectNoDiagnostics` (including an acknowledged hold on a second load).
- `tests/action.test.tsx` — the lost update, the `SILENT_HOLD`, and the hold record's interaction /
  action / staged writes; the fixed variant composes both clicks and is acknowledged.
- `tests/bridge.test.tsx` — the same page captured from _outside_ through
  `installDiagnosticsBridge()` and `captureBrowserArtifact`, with an in-process stand-in for a
  Playwright `page`. Swap in a real `page` and this is the agent/CI recipe.
- `tests/app.test.tsx` — the shell mounts, live records route to the card that caused them, and the
  demo's own UI stays out of the evidence (it renders under `OBSERVE.exclude`).

## Notes for reuse

- **The observer must exclude itself.** `src/diagnostics/channel.ts` mounts its store under
  `OBSERVE.exclude(getOwner())` and writes through `runWithOwner`, so the panels never report on
  themselves. The "everything else the channel saw" card at the bottom is the proof: it stays
  empty.
- **Channel listeners may not write signals.** Records are buffered and drained in a microtask.
- **HMR is off** (`solid({ refresh: { disabled: true } })`): the demo prints owner paths, and the
  refresh transform renames components to `<[solid-refresh]StoryCard>`. The toolbar rebuilds each
  graph anyway.
- **Naming is routing.** Every node is named `<scenario>:<what>` and every control carries
  `id="<scenario>-<what>"`, which is enough to route a record to the card that produced it using
  only the names the engine reports.
- **`pnpm build` strips all of it.** A plain production build resolves Vite's default conditions,
  so the channels (and the code feeding them) are gone and the page says so. `pnpm build:observe`
  is the only build that overrides resolution — it produces the `observe` tier, a shippable build
  that keeps both channels, which is the posture an app uses to watch production. `vite dev` and
  the vitest suites use the `development` condition.
- **Evidence is scoped to the mounted graph.** The engine's chain log is global, so card 3 takes a
  cursor when it mounts and only renders chains recorded after it; the fake services reset their
  counters on mount too. Switching modes never shows the other mode's numbers.
