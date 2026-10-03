# Blocks gate — reference run (baseline)

The gate is `scripts/blocks-gate.mjs` (`pnpm blocks:gate`). This file records the
reference run used as the baseline; the machine-readable copy is
[`blocks-gate-baseline.json`](./blocks-gate-baseline.json).

**Reference summary: `53 pass / 2 fail / 0 skip in 63s`** (55 steps, `--jobs 3`,
HEAD `aeb2a1a6` plus the oxlint devDependency from D-037, every step run with
`TZ=UTC`).

This baseline was regenerated under **D-037** (which amends D-008). oxlint is now a
root devDependency (`oxlint@1.86.0`), so `repo:oxlint` really runs instead of being
SKIP. It passes (details below).

## What "green" means

A commit is **green** iff no step that is `PASS` in this reference run is `FAIL`
on it:

```sh
pnpm exec turbo run build --filter=@solidjs/blocks --force   # the gate never builds
node scripts/blocks-gate.mjs --baseline documentation/plans/blocks-gate-baseline.json
```

With `--baseline` the gate prints `new reds` (PASS → FAIL; any of these makes it
red), `fixed` (FAIL → PASS) and `unchanged`, and exits 0 iff there are no new reds.
The two reds below are known and do not block. A step that is `SKIP` on a later
run (e.g. a missing build artifact) and wasn't `SKIP` here doesn't count as a new
red under this rule, so look at it by hand. When a red is fixed (or its package is
removed), regenerate the baseline
(`--json documentation/plans/blocks-gate-baseline.json`).

## Timezone pin

The gate sets `TZ=UTC` in every step's environment, whatever the host timezone
(along with `FORCE_COLOR=0`, `NO_COLOR=1`, and `CI=1` unless `CI` is already set).
Results then depend on the commit, not on the machine's clock locale.
`examples/effect-blocks` makes this necessary: its saga test fixes the clock at
12:00 UTC and then formats the time in local time. The twin itself is unchanged.
The JSON records the host zone (`environment.hostTZ`) and the overrides
(`environment.childEnv`).

## Steps

| Step | Result | Duration |
| --- | --- | --- |
| `twin:chat-blocks:test` | PASS | 1.6 s |
| `twin:chat-blocks:typecheck` | PASS | 1.3 s |
| `twin:chat-blocks:lint` | PASS | 1.6 s |
| `twin:chat-blocks:link:check` | PASS | 0.6 s |
| `twin:effect-blocks:test` | PASS | 1.7 s |
| `twin:effect-blocks:typecheck` | PASS | 1.4 s |
| `twin:effect-blocks:lint` | PASS | 1.6 s |
| `twin:effect-blocks:link:check` | PASS | 0.6 s |
| `twin:hackernews-blocks:test` | PASS | 2.0 s |
| `twin:hackernews-blocks:typecheck` | PASS | 1.3 s |
| `twin:hackernews-blocks:lint` | PASS | 1.5 s |
| `twin:hackernews-blocks:link:check` | PASS | 0.6 s |
| `twin:hackernews-spa-blocks:test` | PASS | 2.0 s |
| `twin:hackernews-spa-blocks:typecheck` | PASS | 1.3 s |
| `twin:hackernews-spa-blocks:lint` | PASS | 1.5 s |
| `twin:hackernews-spa-blocks:link:check` | PASS | 0.6 s |
| `twin:migrating-element-blocks:test` | PASS | 1.4 s |
| `twin:migrating-element-blocks:typecheck` | PASS | 1.0 s |
| `twin:migrating-element-blocks:lint` | PASS | 1.3 s |
| `twin:migrating-element-blocks:link:check` | PASS | 0.6 s |
| `twin:notes-blocks:test` | PASS | 6.7 s |
| `twin:notes-blocks:typecheck` | PASS | 1.4 s |
| `twin:notes-blocks:lint` | PASS | 1.6 s |
| `twin:notes-blocks:link:check` | PASS | 0.6 s |
| `twin:rendering-blocks:test` | PASS | 3.2 s |
| `twin:rendering-blocks:typecheck` | PASS | 1.3 s |
| `twin:rendering-blocks:lint` | PASS | 1.4 s |
| `twin:rendering-blocks:link:check` | PASS | 0.6 s |
| `twin:room-blocks:test` | PASS | 1.5 s |
| `twin:room-blocks:typecheck` | PASS | 1.4 s |
| `twin:room-blocks:lint` | PASS | 1.6 s |
| `twin:room-blocks:link:check` | PASS | 0.6 s |
| `twin:sierpinski-blocks:test` | PASS | 10.9 s |
| `twin:sierpinski-blocks:typecheck` | PASS | 0.9 s |
| `twin:sierpinski-blocks:lint` | PASS | 1.2 s |
| `twin:sierpinski-blocks:link:check` | PASS | 0.6 s |
| `twin:sierpinski-blocks-h:test` | PASS | 10.9 s |
| `twin:sierpinski-blocks-h:typecheck` | PASS | 1.6 s |
| `twin:sierpinski-blocks-h:lint` | PASS | 1.9 s |
| `twin:sierpinski-blocks-h:link:check` | PASS | 0.6 s |
| `twin:todos-blocks:test` | PASS | 1.3 s |
| `twin:todos-blocks:typecheck` | PASS | 1.0 s |
| `twin:todos-blocks:lint` | PASS | 1.3 s |
| `twin:todos-blocks:link:check` | PASS | 0.6 s |
| `twin:todos-blocks-h:test` | PASS | 1.3 s |
| `twin:todos-blocks-h:typecheck` | PASS | 1.8 s |
| `twin:todos-blocks-h:lint` | PASS | 2.1 s |
| `twin:todos-blocks-h:link:check` | PASS | 0.6 s |
| `pkg:blocks:test` | PASS | 6.2 s |
| `pkg:blocks-linker:test` | **FAIL** (known, pre-existing, D-023) | 11.1 s |
| `pkg:eslint-plugin-blocks:test` | PASS | 1.3 s |
| `pkg:babel-plugin:test` | PASS | 4.3 s |
| `pkg:compiler:test` | **FAIL** (known, pre-existing, D-023) | 28.6 s |
| `repo:prettier` | PASS | 2.0 s |
| `repo:oxlint` | PASS (27 warnings, 0 errors) | 0.0 s |

Durations are per step, measured with 3 steps running at once, so they add up to
more than the wall time. `repo:oxlint` takes well under 0.1 s.

## `repo:oxlint` (D-037)

- **What it runs**:
  ```sh
  node_modules/.bin/oxlint packages/blocks packages/blocks-linker \
    packages/eslint-plugin-blocks examples/<12 twins> \
    --ignore-pattern '**/dist/**' --ignore-pattern '**/node_modules/**'
  ```
  It runs from the repo root, and the binary is resolved there only, never from
  `PATH`. The config is the root `.oxlintrc.json`, picked up automatically. It
  turns `require-yield` off for `examples/*-blocks/**`, `examples/*-blocks-h/**`,
  `examples/blocks-harness/**` and `packages/blocks/**`. The override is in
  effect: with an empty config, `packages/blocks` and the twins alone report 246
  `require-yield` warnings. With the repo config the whole run reports 12, all in
  `packages/blocks-linker`, which the override doesn't cover.
- **Result: PASS** (exit 0). It reports **27 warnings and 0 errors**. oxlint fails
  only on errors (the gate doesn't pass `--deny-warnings`), and neither the code
  nor the config was changed. Warnings by rule:
  - 12 × `eslint(require-yield)`: `packages/blocks-linker/test/fixtures/gap/src/` (chain.tsx 7, Parent.tsx 4, UserCard.tsx 1)
  - 10 × `eslint(no-unused-vars)`:
    - `packages/blocks/src/runtime.ts` (4)
    - `packages/blocks/test/nojsx.type-tests.ts` (2)
    - `examples/todos-blocks/src/app.tsx` (2)
    - `examples/room-blocks/tests/browser.steps.mjs` (1)
    - `examples/notes-blocks/tests/script.ts` (1)
  - 1 × each of:
    - `unicorn(no-thenable)` (`packages/blocks/src/runtime.ts:997`)
    - `unicorn(no-new-array)` (`packages/blocks/src/h.ts:110`)
    - `unicorn(no-useless-spread)` (`packages/blocks-linker/src/index.js:153`)
    - `unicorn(no-empty-file)` (`packages/eslint-plugin-blocks/test/fixtures/file.tsx`, an intentional fixture)
    - `oxc(only-used-in-recursion)` (`packages/blocks/test/exports.spec.ts:12`)

  The warnings aren't printed on PASS. Run the command above to see them. If the
  config later promotes any of these to errors, the step turns red and counts as a
  new red against this baseline.

## Failures

Both reds are pre-existing and both packages are slated for removal (decision
D-023). They stay recorded as reds and are not fixed.

### `pkg:blocks-linker:test` (3 of 8 tests)

- `test/linker.test.js > staleness and incremental updates > check() and `solid-link --check` fail when the committed file is stale`
  (`expected false to be true` at `fresh.check().stale`)
- `test/linker.test.js > staleness and incremental updates > updates incrementally on save (only the saved module is re-analyzed)`
  (`expected false to be true` at `linker.write().changed`)
- `test/vite.test.js > vite plugin > dev: writes at startup and updates the file when a save changes the facts`
  (`Error: timed out` in `waitFor`)

Cause: each test simulates "a caller stops passing a pending value" by running
`replaceAll` on the single-line string
`return yield* attempt(() => fetchUser(), () => new FetchError());` in
`test/fixtures/gap/src/Parent.tsx`. In HEAD the fixture's `attempt(...)` calls are
split across several lines (prettier style), so the search string no longer
matches. The file is rewritten unchanged, the linker correctly sees no change in
the facts, and every "now it's stale or changed" assertion fails. The cause is in
the test fixture, not the linker.

### `pkg:compiler:test` (1 of 5990 tests)

- `__tests__/blocks-summary.test.js > summarizeBlocks > gives each render site's props a value fact`:
  expected `fails: ["NotFound", "Oops"]`, received `fails: ["*", "Oops"]`.

The test source calls `attempt(() => load(id), NotFound)`, passing the error
class itself as the handler. Commit `dfe692cf` added `handler_fails` to
`packages/compiler/src/blocks_summary.rs`. It derives a handler's failure classes
from what an arrow/function handler returns, and any other handler expression,
including a bare identifier, falls through to `"*"` (unknown). The test was not
updated in that commit. `blocks_summary` exists only to feed the linker. The step
ran against the prebuilt `compiler.node`, whose output matches the source at HEAD,
and it has failed the same way on every run and rerun, so it is deterministic.

## Skips

None in this run. `repo:oxlint` was the only SKIP before D-037.
`pkg:babel-plugin:test` and `pkg:compiler:test` SKIP only when their built
artifact is missing (see below).

## Step selection notes

- **Twins**: `examples/*-blocks` and `examples/*-blocks-h` directories whose
  `package.json` has `test`, `typecheck` and `lint` scripts. There are exactly 12,
  and the gate fails if the count is anything else: chat, effect, hackernews,
  hackernews-spa, migrating-element, notes, rendering, room, sierpinski,
  sierpinski-h, todos, todos-h. `examples/blocks-harness` (the shared helper)
  doesn't match the glob and has none of those scripts. Each twin has four steps:
  `test`, `typecheck`, `lint`, `link:check`, each run as `pnpm -C <dir> run <script>`.
- **`pkg:babel-plugin:test`, `pkg:compiler:test`**: both run
  `vitest run --maxWorkers=2` in the package rather than the package's `test`
  script. The babel-plugin `test` script typechecks and then rollup-builds
  `index.js`. The compiler `test` script runs three `cargo test` passes plus a napi
  debug build, which takes minutes and builds. The gate must not build, so these
  steps test the artifacts that are already built (`packages/babel-plugin/index.js`,
  `packages/compiler/compiler.node`, both gitignored). A step SKIPs with a reason
  when its artifact is missing. **Caveat:** neither artifact is rebuilt by
  `turbo run build --filter=@solidjs/blocks`, so after compiler or babel-plugin
  source changes they can be stale. Rebuild them (`pnpm -C packages/babel-plugin
  run build`, `pnpm -C packages/compiler run build`) before trusting these two
  steps.
- **`repo:prettier`**: `prettier --check` with the root `format` glob
  `**/*.[tj]s?(x)` under each scoped directory, plus `scripts/blocks-gate.mjs`.
  `.gitignore` (dist/, node_modules/) and `.prettierignore` (`*.gen.d.ts`) are
  honoured.
- **`--fast`**: twin `typecheck` + `lint` (24 steps), `pkg:blocks:test` and
  `repo:prettier`, 26 steps in total. It drops twin `test`/`link:check`, the other
  package suites and oxlint.

## Earlier runs

- **Previous reference, before D-037** (HEAD `09fa9de5`, TZ pinned):
  `52 pass / 2 fail / 1 skip in 88s`. It had the same two reds. `repo:oxlint` was
  SKIP because there was no repo-local binary. The wall time was inflated by other
  load on the machine.
- **First run on this machine, before the TZ pin** (HEAD `dfe692cf`, IST host):
  `51 pass / 3 fail / 1 skip in 69s`. The third red was `twin:effect-blocks:test`:
  `expected '3 lines · placed 5:30:04 PM' to match /^3 lines · placed 12:00:0\d PM$/`.
  The saga test fixes the clock at 12:00 UTC but formats it in local time. The test
  failed again on rerun and passed with `TZ=UTC`. This is what led to the pin.
- **Lost run on another machine**: `53 pass / 1 fail / 1 skip in ~60 s`, also 55
  steps. That machine was on UTC, which is why effect-blocks passed there.
  `pkg:compiler:test` also passed there, so that run probably used a
  `compiler.node` built before `dfe692cf`'s `blocks_summary.rs` change (or an
  earlier commit). Every run since has had the same 55 steps.

## Environment

| | |
| --- | --- |
| HEAD | `aeb2a1a69bbeaf73eccba238be1cb53c4055b0a0` (branch `bl/bootstrap`), plus the uncommitted `oxlint@1.86.0` devDependency (`package.json` + `pnpm-lock.yaml`), committed together with this baseline |
| node | v24.18.0 |
| pnpm | 11.1.1 |
| oxlint | 1.86.0 (root devDependency, `node_modules/.bin/oxlint`) |
| OS | macOS 26.5.2 (darwin arm64) |
| timezone | host `Asia/Calcutta` (IST, UTC+5:30); every step pinned to `TZ=UTC` |
| jobs | `--jobs 3` (default) |
| wall time | 63 s (2026-10-03T23:33:03Z → 23:34:06Z) |
| build before gate | `@solidjs/blocks` dist prebuilt by the caller; prebuilt `babel-plugin/index.js` and `compiler/compiler.node` used as found |
