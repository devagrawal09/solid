# Semantic conformance harness

A deterministic oracle for the iterable/compiled signals (`$` block) proposal.
It runs the same scenario through several implementations and checks that
their observable traces match a handwritten Solid reference. It compares
recorded events, not output snapshots or runtime internals.

- Coverage matrix, declared differences and pinned defects: [COVERAGE.md](./COVERAGE.md)
  (generated, so it cannot drift from what runs)
- Proposal: [documentation/plans/typed-generator-compiler.md](../../../../documentation/plans/typed-generator-compiler.md)

## Running

```sh
# from packages/web; all three are part of `pnpm test`
pnpm exec vitest run test/conformance                                   # client modes, self-tests, matrix
pnpm exec vitest run --config vite.config.server.mjs test/server/conformance.spec.tsx
pnpm exec vitest run --config vite.config.hydrate.mjs test/hydration/conformance.spec.tsx test/hydration/conformance-self-test.spec.tsx
```

You need a built workspace compiler (`packages/compiler`, `pnpm run build:debug`) and
built `solid-js`, the same prerequisites as the rest of this package's tests.
The server project writes `__artifacts__/`, which the hydrate project reads;
`pnpm test` runs the server project first.

After an intentional change, update goldens and the matrix with `vitest -u`,
then review the diff.

## Architecture

```
scenario (sources + steps + per-mode expectations)
   │  source adapter: mode.source picks sources.reference | sources.generator
   ▼
real native compiler  transform(source, mode.compile)      harness/module.ts
   │  emitted ESM, imports bound to the environment's solid-js / @solidjs/web
   ▼
runner  mount/render | stream SSR | hydrate + drive steps  harness/runner.ts
   │  instrumented through `import { h } from "conformance"` harness/trace.ts
   ▼
trace: ordered strings, one observable event each
   ▼
judge(expectation, oracle trace, candidate trace)          harness/compare.ts
```

- **Environments** are the package's three vitest projects: `client`
  (jsdom, fresh render), `server` (node, SSR) and `hydrate` (jsdom, hydrating
  the server environment's recorded output). Each resolves `solid-js` and
  `@solidjs/web` to a different build. Compiled scenario code is evaluated
  against exactly those modules, so no mode runs against the wrong build.
- **Oracles**: `client/reference`, `server/reference` and `hydrate/reference`
  run the handwritten source. Each is pinned to a committed golden trace in
  `golden/<scenario>.<env>.trace`, so a change in ordinary Solid semantics is
  reviewed as such rather than showing up as a mode regression.
- **Candidates**: every other mode is compared with the oracle of its own
  environment.
- **Real compiler output only.** Every mode runs `@solidjs/compiler`
  `transform()` output (`generators: false` for the runtime driver, default
  lowering, `hostFusion: true`). The evaluator rewrites only the compiler's
  import/export lines and rejects anything else. It never approximates output
  by hand.

### Trace events

`## step`, `read <signal> = v`, `read <signal> ! Err`, `write <signal> = v`,
`run <label>`, `cleanup <label>`, `owner <label> = <owner label>`,
`task <name#n> = input`, `settle|reject <name#n>`, `value <label> = v`,
`caught <boundary> = Err`, `html = …`, `console.warn|error = <first line>`,
`uncaught <step> = Err`. On the server the trace also records
`markup = …`, `hydration-keys = […]` and `serialized = […]`. On hydrate it also
records `hydration server-nodes k/n kept, m client-inserted`.

Traces never contain object addresses or timings:

- Owners get logical labels (`h.owner("memo")`, else `anon#n` in first-seen order).
- Errors print as `Class(message)`.
- Task flights are named `label#n` per label.
- Async progress is driven explicitly: `tasks.resolve("load#2", v)` settles a
  controlled deferred, and `settle()` drains microtasks with one zero-length
  macrotask turn, then flushes. There are no sleeps.

### Expectations

The default expectation is `equivalent`: the candidate trace must equal the
oracle's exactly, including order and multiplicity. Anything else is declared
per scenario and mode, with a reason:

| status           | meaning                                                                                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `differs`        | An intentional, reviewed difference. The exact expected trace is given in full, or as exact edits of the oracle trace: each `remove` line must occur exactly once, and each `insert` lands after a unique anchor. There is no normalization. |
| `known-defect`   | A baseline defect isolated by the scenario. The mode must still diverge, optionally pinned at `firstDivergence`. When it stops diverging, the test fails and asks for the entry to be flipped to `equivalent`.                               |
| `not-applicable` | The scenario cannot be expressed in the mode. The mode is not run, and the reason is listed in the matrix.                                                                                                                                   |

`harness/expect.ts#forModes` applies one declaration to several modes, for
example every generator mode, or only `*/runtime`.

`self-test.spec.ts` and `../hydration/conformance-self-test.spec.tsx` prove the
comparator catches real regressions. Each plants one bug in a real scenario
source, compiles it and runs it through the normal runner:

- missing cleanup
- a branch read made unconditional
- a duplicate event write
- a stale async commit
- an owner mismatch
- a hydration-ID mismatch

They also cover the judge's rules. `harness/mutate.ts` requires every edit to
match exactly once, so a self-test cannot pass vacuously.

## Adding a scenario

1. Add a `Scenario` to a file in `scenarios/` and list it in
   `scenarios/index.ts`.
2. Write `sources.reference` (ordinary Solid) and `sources.generator` (the
   same program with `$`). Import instrumentation with
   `import { h, NotFound } from "conformance"`:
   - `h.signal(label, init)` (traced reads and writes; the accessor keeps its
     iterator, so `yield*` works)
   - `h.run`, `h.cleanup`, `h.owner`/`h.where`, `h.task`, `h.value`, `h.caught`
     Export whatever the steps need, using live bindings (`export let setX;`).
3. Choose `entry`: `{ root: "setup" }` (no DOM) or `{ component: "App" }`. Add
   `ssr: {}` to also run the server and hydrate environments.
   `ssr.resolve` settles server-side flights in order.
4. Write `steps` using `flush`, `settle`, `tasks`, `click`, `html`, `observe`
   and `dispose`. Keep steps environment-neutral; use `environments` on a step
   when fresh render and hydration must start differently. Name flights by
   input when hydration may or may not repeat them.
5. Run with `-u` to write the golden traces, then read them. They are the
   specification, so check they say what the scenario claims.
6. If a candidate mode diverges, work out whether the divergence is intended
   (`differs`, with a precise reason) or a defect (`known-defect`, pinned). Do
   not change production semantics to make a scenario pass in this harness.

## Adding a mode (the adapter contract)

A mode is a `ModeAdapter` in `harness/modes.ts`:

```ts
{
  id: "client/strict",           // "<environment>/<name>"
  title: "non-generator strict frontend",
  environment: "client",         // which vitest project runs it
  source: "strict",              // which scenario source it consumes
  compile: { generate: "dom", mode: "strict" }, // exact transform() options
  reference: "client/reference", // the oracle it must reproduce
  pairedWith: undefined,         // hydrate modes: the server mode whose markup it hydrates
  available: () => reason | undefined // report, never fake, a missing capability
}
```

Planned modes and how they would plug in:

- **Non-generator strict frontend**: new `SourceKind` `"strict"`, with a
  `sources.strict` added to scenarios as the frontend lands. Scenarios without
  one are reported as not applicable for that mode.
- **Proxy-free stores or cold event extraction**: a new `compile` (or runtime)
  option on a client mode against the `generator` source. The existing
  scenarios apply unchanged.
- **Runtime-selected hydration**: a `hydrate/*` mode with its own `pairedWith`
  server mode. Its golden differences (for example no re-executed computations)
  are declared as `differs` against `hydrate/reference`.
- **Server components**: a `server/*` mode. If the renderer needs a different
  entry point, extend `observeServer` rather than the scenarios.

`plannedModes` lists these with their blockers, and they appear in the matrix.

## Current coverage and known gaps

See [COVERAGE.md](./COVERAGE.md) for the per-scenario matrix. In summary:

- **Running**: all six required modes, across 15 scenarios and 12 mode
  adapters:
  - handwritten reference
  - `$` runtime driver
  - compiler-lowered
  - host-fused (`hostFusion`)
  - SSR
  - hydration
- **Intentional differences (declared)**:
  - A superseded or disposed `$` run is closed at its pending `wait`, whereas an
    async function continues after `await`.
  - Uncompiled prop paths fail loudly.
  - JSX `yield*` is a compiler-only spelling.
- **Baseline defects (pinned, not fixed here)**:
  1. Host fusion lowers a dynamic-index store path (`yield* store.items[i].name`)
     to invalid JavaScript (`store.items[].name`).
  2. A component returning a `$` JSX block takes its hydration keys after its
     sibling components on the server, so keys diverge and hydration halts.
     This is the release blocker named in the proposal.
  3. The server runtime's accessor iterator yields the bare accessor instead of
     a read op, so any `$` block the server runs through the generator driver
     fails. That covers every block that `wait`s, and all of `server/runtime`.
     As a result, async `$` SSR cannot currently be compared.
- **Baseline behavior pinned in goldens**: hydrating an async memo re-runs its
  compute and re-starts the fetch, whose result is discarded because the
  serialized value renders. Hydration without duplicate authoritative work is
  therefore not currently supported, even for handwritten Solid, and is not
  claimed.
- **Not covered yet**:
  - streamed (shell-then-chunks) hydration; the harness applies the full
    output before hydrating
  - transitions and optimistic writes
  - `For`/keyed lists
  - event concurrency adapters (`latest`, `queue`, `exhaust`)
  - `call()` wrapper composition
  - projections and block-derived stores
  - Everything in `plannedModes`.

## Runtime and CI

The harness adds five spec files to the package's existing vitest projects:
client conformance, client self-tests, server, hydrate, and hydrate
self-test. It needs no new package, dependency, or workspace or turbo
registration.

Measured in a Linux cloud container with Node 22, two runs each, running only
the harness files:

| project | tests | vitest "tests" time | vitest duration | process wall time |
| ------- | ----: | ------------------: | --------------: | ----------------: |
| client  |    70 |         0.44–0.52 s |       1.7–1.9 s |         2.8–2.9 s |
| server  |    20 |         0.15–0.16 s |           1.2 s |         2.2–2.3 s |
| hydrate |    19 |         0.23–0.26 s |       1.5–1.8 s |         2.5–2.8 s |

Most of the time is vite transform and jsdom setup. Scenario execution,
including every native-compiler `transform()` call, stays well under a second
per project. Inside the full `pnpm test` run the harness adds roughly 1 s. It
is practical for normal CI.
