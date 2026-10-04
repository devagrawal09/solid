# Blocks gate — reference run (baseline)

The gate is `scripts/blocks-gate.mjs` (`pnpm blocks:gate`). This file records the
reference run used as the baseline; the machine-readable copy is
[`blocks-gate-baseline.json`](./blocks-gate-baseline.json).

**Reference summary: `30 pass / 0 fail / 0 skip in 48s`** (30 steps, `--jobs 3`,
HEAD `45cdfdf9` with Phase 1B commit 4's `summarizeBlocks` removal applied and
`compiler.node` rebuilt from it, every step run with `TZ=UTC`).

**No red step remains.** Phase 1B removed the type linker and its compiler half
(D-023):

- **Commit 3** dropped each twin's `link:check` step and `pkg:blocks-linker:test`,
  taking the gate from 39 to 30 steps: 3 per twin for the 8 twins, plus 6
  package / repo steps. The `pkg:blocks-linker:test` red went with its package.
- **Commit 4** removed `summarizeBlocks` from `@solidjs/compiler` and the test
  behind the `pkg:compiler:test` red, so that step now passes: 5,986 tests, the
  former 5,990 less the 4 in `blocks-summary.test.js`.

`repo:oxlint` passes.

## What "green" means

A commit is **green** iff no step that is `PASS` in this reference run is `FAIL`
on it:

```sh
pnpm exec turbo run build --filter=@solidjs/blocks --force   # the gate never builds
node scripts/blocks-gate.mjs --baseline documentation/plans/blocks-gate-baseline.json
```

With `--baseline` the gate prints `new reds` (PASS → FAIL; any of these makes it
red), `fixed` (FAIL → PASS) and `unchanged`, and exits 0 iff there are no new reds.
A step that is `SKIP` on a later
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
| `twin:effect-blocks:test` | PASS | 1.6 s |
| `twin:effect-blocks:typecheck` | PASS | 1.3 s |
| `twin:effect-blocks:lint` | PASS | 1.7 s |
| `twin:hackernews-spa-blocks:test` | PASS | 2.0 s |
| `twin:hackernews-spa-blocks:typecheck` | PASS | 1.4 s |
| `twin:hackernews-spa-blocks:lint` | PASS | 1.7 s |
| `twin:rendering-blocks:test` | PASS | 3.3 s |
| `twin:rendering-blocks:typecheck` | PASS | 1.4 s |
| `twin:rendering-blocks:lint` | PASS | 1.6 s |
| `twin:room-blocks:test` | PASS | 1.4 s |
| `twin:room-blocks:typecheck` | PASS | 1.4 s |
| `twin:room-blocks:lint` | PASS | 1.7 s |
| `twin:sierpinski-blocks:test` | PASS | 10.9 s |
| `twin:sierpinski-blocks:typecheck` | PASS | 1.0 s |
| `twin:sierpinski-blocks:lint` | PASS | 1.2 s |
| `twin:sierpinski-blocks-h:test` | PASS | 10.9 s |
| `twin:sierpinski-blocks-h:typecheck` | PASS | 1.7 s |
| `twin:sierpinski-blocks-h:lint` | PASS | 1.8 s |
| `twin:todos-blocks:test` | PASS | 1.3 s |
| `twin:todos-blocks:typecheck` | PASS | 1.0 s |
| `twin:todos-blocks:lint` | PASS | 1.3 s |
| `twin:todos-blocks-h:test` | PASS | 1.3 s |
| `twin:todos-blocks-h:typecheck` | PASS | 1.8 s |
| `twin:todos-blocks-h:lint` | PASS | 2.0 s |
| `pkg:blocks:test` | PASS | 7.4 s |
| `pkg:eslint-plugin-blocks:test` | PASS | 1.4 s |
| `pkg:babel-plugin:test` | PASS | 4.5 s |
| `pkg:compiler:test` | PASS | 27.5 s |
| `repo:prettier` | PASS | 1.5 s |
| `repo:oxlint` | PASS | 0.1 s |

Durations are per step, measured with 3 steps running at once, so they add up to
more than the wall time.

## `repo:oxlint` (D-037)

- **What it runs**:
  ```sh
  node_modules/.bin/oxlint packages/blocks packages/eslint-plugin-blocks \
    examples/<8 twins> \
    --ignore-pattern '**/dist/**' --ignore-pattern '**/node_modules/**'
  ```
  It runs from the repo root, and the binary is resolved there only, never from
  `PATH`. The config is the root `.oxlintrc.json`, picked up automatically. It
  turns `require-yield` off for `examples/*-blocks/**`, `examples/*-blocks-h/**`,
  `examples/blocks-harness/**` and `packages/blocks/**`. With the linker's
  fixtures gone, no `require-yield` warning remains.
- **Result: PASS** (exit 0). It reports **17 warnings and 0 errors**. oxlint fails
  only on errors (the gate doesn't pass `--deny-warnings`). Warnings by rule:
  - 13 × `eslint(no-unused-vars)`:
    - `packages/blocks/src/runtime.ts` (5)
    - `examples/room-blocks/tests/app.test.tsx` (2)
    - `examples/room-blocks/tests/browser.steps.mjs` (2)
    - `examples/todos-blocks/src/app.tsx` (2)
    - `packages/blocks/test/nojsx.type-tests.ts` (1)
  - 1 × each of:
    - `unicorn(no-thenable)` (`packages/blocks/src/runtime.ts`)
    - `unicorn(no-new-array)` (`packages/blocks/src/h.ts`)
    - `unicorn(prefer-string-starts-ends-with)` (`packages/eslint-plugin-blocks/src/index.js`)
    - `unicorn(no-empty-file)` (`packages/eslint-plugin-blocks/test/fixtures/file.tsx`, an intentional fixture)
    - `oxc(only-used-in-recursion)` (`packages/blocks/test/exports.spec.ts`)

  The warnings aren't printed on PASS. Run the command above to see them. If the
  config later promotes any of these to errors, the step turns red and counts as a
  new red against this baseline.

## Failures

None. The last two pre-existing reds are gone (see "Earlier runs").

## Skips

None in this run. `pkg:babel-plugin:test` and `pkg:compiler:test` SKIP only when
their built artifact is missing (see below).

## Step selection notes

- **Twins**: `examples/*-blocks` and `examples/*-blocks-h` directories whose
  `package.json` has `test`, `typecheck` and `lint` scripts. There are exactly 8
  (12 before D-058 removed chat, hackernews and notes; 9 before D-061 removed
  migrating-element), and the gate fails if the count is anything else: effect,
  hackernews-spa, rendering, room, sierpinski, sierpinski-h, todos, todos-h.
  `examples/blocks-harness` (the shared helper) doesn't match the glob and has
  none of those scripts. Each twin has three steps: `test`, `typecheck`, `lint`
  (`link:check` went with the linker, D-023), each run as
  `pnpm -C <dir> run <script>`.
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
  `.gitignore` (dist/, node_modules/) is honoured. (`.prettierignore`, which kept
  the linker's `*.gen.d.ts` byte-for-byte, went with the linker.)
- **`--fast`**: twin `typecheck` + `lint` (16 steps), `pkg:blocks:test` and
  `repo:prettier`, 18 steps in total. It drops twin `test`, the other package
  suites and oxlint.

## Earlier runs

- **Phase 1B commit 3** (HEAD `45fdd477` + the linker removal): `29 pass / 1 fail /
  0 skip in 51s` over 30 steps. The red was `pkg:compiler:test`:
  `__tests__/blocks-summary.test.js > summarizeBlocks > gives each render site's
  props a value fact` (expected `fails: ["NotFound", "Oops"]`, received
  `["*", "Oops"]`). Commit `dfe692cf` had made `blocks_summary.rs` record a handler
  passed by name as `*` without updating the test. It went away with
  `summarizeBlocks` in commit 4.
- **Previous reference, after D-061, before Phase 1B commit 3** (HEAD `f38f95de` +
  the twin removal): `37 pass / 2 fail / 0 skip in 62s` over 39 steps (4 per twin,
  `link:check` included). The reds were `pkg:blocks-linker:test` (3 staleness
  tests: a fixture rewritten by prettier no longer matched the tests' search
  string) and `pkg:compiler:test` (above).
- **After D-058, before D-061** (HEAD `9b358663` + the twin removal):
  `41 pass / 2 fail / 0 skip in 76s` over 43 steps (9 twins). Same two reds.
- **After D-037, before D-058** (HEAD `aeb2a1a6` + oxlint):
  `53 pass / 2 fail / 0 skip in 63s` over 55 steps (12 twins). Same two reds.
- **Before D-037** (HEAD `09fa9de5`, TZ pinned):
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
  `compiler.node` built before `dfe692cf`'s `blocks_summary.rs` change.

## Environment

| | |
| --- | --- |
| HEAD | `45cdfdf95802169b39f896965a81666957d8ebb6` (branch `bl/colors`), plus the uncommitted `summarizeBlocks` removal, committed together with this baseline |
| node | v24.18.0 |
| pnpm | 11.1.1 |
| oxlint | 1.86.0 (root devDependency, `node_modules/.bin/oxlint`) |
| OS | macOS 26.5.2 (darwin arm64) |
| timezone | host `Asia/Calcutta` (IST, UTC+5:30); every step pinned to `TZ=UTC` |
| jobs | `--jobs 3` (default) |
| wall time | 48s (2026-10-04T17:29:32.531Z → 2026-10-04T17:30:20.184Z) |
| build before gate | `@solidjs/blocks` dist prebuilt by the caller; `babel-plugin/index.js` used as found; `compiler/compiler.node` rebuilt from commit 4's source (release cargo build, 2026-10-04 22:58 IST) |
