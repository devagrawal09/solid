# Attribution Lab

Four reactivity defects a compiler cannot see, each shown **broken** and **fixed**, with Solid
2.0's own diagnostics and attribution channels rendered beside them as the evidence.

Every one of these programs type-checks. Three of them produce visibly wrong or needlessly slow
behaviour that no static tool can flag; the fourth produces the _right_ answer and is still wrong,
and only the runtime record shows it. That is the argument of this example: the reactive graph
knows things about your program that the source text does not.

```bash
pnpm install
pnpm --filter attribution-lab-example dev     # http://localhost:3008
pnpm --filter attribution-lab-example test    # the same four stories, asserted
```

---

## The four cards

### 1. The effect that corrects its own input — `EFFECT_WRITES_OWN_SOURCE`

57 items, 10 per page, and you are on page 6 of 6. Switch to 25 per page and there are only 3
pages: page 6 no longer exists.

|            |                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| **broken** | `createEffect(() => ({ page: page(), max: pageCount() }), v => { if (v.page > v.max) setPage(v.max) })` |
| **fixed**  | `const page = createMemo(() => Math.min(rawPage(), pageCount()))`                                       |

The clamp is a _second_ write, so it needs a _second_ flush — and the frame in between paints
**“Page 6 of 3”**, a state the app considers impossible. The card lists every frame `pageLabel`
painted, so you can see the torn one rather than take our word for it.

The runtime proves the feedback edge from the cause chain — the write that re-ran the effect was
the effect's own — and reports it with `flushes: 2` and the exact transition (`"page" (6 → 3)`).
The fix makes the invalid state unrepresentable, so nothing has to correct it afterwards: one
flush, one reader run, no effect at all.

> The same defect also tears every reader of both `page` and `pageCount`, so the broken card
> reports `EFFECT_RELAY_TEAR` alongside the cycle. One defect, two detectors — the test pins both.

### 2. Derived state kept in sync by an effect — `EFFECT_RELAY_TEAR`

Pick Ada Lovelace, then filter the list to “li”. Ada is gone, so the selection has to move.

|            |                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------- |
| **broken** | `createEffect(visibleIds, ids => { if (!ids.includes(selectedId())) setSelectedId(ids[0]) })`       |
| **fixed**  | `const selectedId = createMemo(() => visibleIds().includes(chosen()) ? chosen() : visibleIds()[0])` |

One keystroke, two runs of the detail pane: first `li → ada` — a detail pane showing a row that
is no longer in the list — then `li → linus`.

This one is deliberately _not_ the shape the engine can convict on sight. The write is conditional
and transformed (`ids[0]`, not the effect's compute output), and `selectedId` has another writer
(you, clicking a row), so neither the identity-copy nor the sole-writer heuristic applies. The
verdict is earned purely from the cause chain: the victim's re-run had only effect-origin root
writes, and the effect that made one of them shares a root write with the victim's previous run.
Because the claim rests on causality rather than intent, it opens at `info` — a DOM-measurement
effect tears for good reason — and escalates to `warn` on the third tear of the same relay.

### 3. The accidental request chain — `ASYNC_WATERFALL`

Show an organisation, its team, and that team's lead.

|            |                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------- |
| **broken** | `const team = createMemo(() => fetchTeam(org().teamId))` — cannot start until `org` lands |
| **fixed**  | `Promise.all([fetchOrg(id), fetchTeamByOrg(id), fetchLeadByOrg(id)])`                     |

Nothing is wrong with any single memo. Together they are three round trips where one would do —
~450ms to paint instead of ~150ms.

The engine does not guess: a chain link exists only when the dependent flight's recompute was
_caused_ by the upstream's landing **and** its origin post-dates that landing, so work that was
already in the air (a preloader, a cache hit, anything stamped with `attribution.markFlight`) is
parallel and breaks the chain. Depth 2 is advisory; depth 3 that survives the origin test earns
`warn`. The card renders `attribution.waterfalls()` — the fact table behind the verdict — beside
the measured click-to-paint time. The fixed variant's table is empty.

### 4. The action that lost its click — provenance only, no diagnostic

Publish three drafts; the server rejects the second.

|            |                                                                 |
| ---------- | --------------------------------------------------------------- |
| **broken** | `const r = await upload(d);` … `setProgress(p => p + 1)`        |
| **fixed**  | `const r = await upload(d); yield;` … `setProgress(p => p + 1)` |

Both variants end in **exactly** the same state — `done · 3/3 · Draft B skipped` — and neither
emits a single diagnostic. Nothing is broken in the value sense. This card exists because that is
the interesting case.

`await` resumes on a bare microtask with no reactive frame on the stack, so every write after it
escapes the action's transaction: the engine stamps those writes `{ kind: "external" }` and the
trail back to the click is gone (the report highlights those lines in red). Add the `yield` and
control returns to the action runner, which re-enters the transaction — now every reader's run
reads `— action "publish" (under click on button#publish "Publish 3 drafts")`, all the way from a
real delegated DOM click.

That target string comes from the web runtime describing `e.target` at dispatch
(`packages/web/src/client.ts`), which is why `#publish` is a text-only button: a `<span>` inside
it would make the span the recorded target.

---

## How the lab is wired

`src/lab/engine.ts` is the only file that touches a dev channel, and it is worth reading before
building anything like it:

- **`OBSERVE.diagnostics.subscribe`** is subscribed once at module scope. It survives
  `attribution.disable()`.
- **`attribution.subscribe`** is re-subscribed by every `arm()`, because `disable()` drops all
  subscriptions.
- **Neither listener writes reactive state.** Both are invoked _synchronously from inside the
  flush that produced the record_ — the contract on `Attribution.subscribe` says so in as many
  words. A listener that wrote a signal would be the observer changing what it observes. They
  append to a plain array and schedule one microtask that commits the batch after the flush has
  unwound.
- The panel's own state lives in a root handed to **`OBSERVE.exclude`**, so the report does not
  appear in the tables it is rendering. Writing under an excluded owner means writing with an
  owner on the stack, which `setSignal`'s dev guard rejects (`REACTIVE_WRITE_IN_OWNED_SCOPE`)
  unless the signal opts in — hence `ownedWrite: true` on that one signal, and nowhere else.
- **`arm()` disables before it enables.** Cycle and tear verdicts report once per key, so without
  the `disable()` a second visit to a Broken card would be silent. The card is keyed on
  `scenario:variant:nonce` so every demonstration also gets fresh nodes — some of the engine's
  once-only flags live on the nodes themselves.
- Rendered evidence is passed through `stripVolatile`, which removes run counters, wall times and
  write sequence numbers. What you read on screen is byte-identical to what `tests/` assert; real
  timings sit in a muted column beside the text rather than inside it.

## Build tiers

The diagnostics and attribution channels are a **development/observe** tier feature, and this
example is configured to be honest about that:

| command                                                 | tier                                          | `OBSERVE`                  |
| ------------------------------------------------------- | --------------------------------------------- | -------------------------- |
| `pnpm --filter attribution-lab-example dev`             | development                                   | defined — everything works |
| `pnpm --filter attribution-lab-example test`            | development + browser (vitest `mode: "test"`) | defined                    |
| `pnpm --filter attribution-lab-example build` / `start` | **production**                                | `undefined`                |

`@solidjs/vite-plugin` adds the `development` export condition when `command === "serve"`, which
covers both `vite` and `vitest`; vitest additionally runs with `mode: "test"`, which adds the
`browser` condition so the jsdom tests exercise the DOM build. A production build resolves the
inert `solid-js/attribution` engine and has no diagnostics channel at all, so `src/main.tsx`
renders an explicit banner instead of panels that could never fill. Do not "fix" this by passing
`dev: true` to the plugin — a diagnostics demo that lies about the production tier teaches the
wrong thing.

`solid({ diagnostics: true })` additionally serves `/__solid/diagnostics` on the dev server and
installs the in-page bridge from this package's `@solidjs/diagnostics` dev dependency, so an agent
can drive the same channels this UI renders:

```bash
curl -s localhost:3008/__solid/diagnostics
```

## Tests

```bash
pnpm --filter attribution-lab-example test
```

`tests/` mounts the app's real components into jsdom and drives them with real events — real
delegated clicks and `input` events, no stubs of the reactive system, and no fake timers (the
async cards deadline-poll via `tests/helpers.ts`, the recipe the signals suite settled on after
three CI flakes on fixed sleeps).

- `clamp` / `relay` / `waterfall` / `publish` assert each card's story through
  `captureArtifact` from `@solidjs/diagnostics`: the exact diagnostic codes, severities and
  `data` payloads for the broken variant, and `toHaveNoDiagnostics()` for the fixed one.
- `lab.test.tsx` asserts the shell: that the rendered evidence is the verbatim, volatile-free
  record; that re-arming clears and re-reports; and — the arithmetic guard on the listener
  contract — that driving a story with the whole app mounted produces the _same_ re-run counts as
  driving the bare component does. If the channel listeners ever started writing reactive state,
  that number would move.
