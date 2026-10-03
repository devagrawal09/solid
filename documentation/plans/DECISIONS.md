# DECISIONS — `@solidjs/blocks` build-out

Decision log for the blocks-library build-out on `blocks-lib`. One entry per decision: what was decided, the alternatives on the table, and why. New decisions append; a reversed decision is not edited but superseded by a new entry that names it. Forks of a topic branch are logged here too (see "Branch log").

> **Provenance.** The original of this file (26 entries, committed on `blocks-lib` in a container on 2026-10-04) was lost unpushed when that container's disk filled. This version was **reconstructed on 2026-10-04 from the session handoff**, which carried the decisions and their one-line rationale but not the full alternatives text. Where an entry's reasoning is thinner than it was, it says so. Entries whose content the handoff did not carry (D-015's text, D-025, D-026) are marked **lost** and left blank rather than invented. Per-entry ownership was not carried either: by D-002, design decisions are Dev's; process decisions were proposed by Claude and accepted by Dev. Re-affirm or correct any entry by appending, not editing.

Reading order with the rest of the plan: `blocks-library.md` (the reference), this file, `blocks-gate-baseline.md` (what "green" means).

## Index

| ID | Status | Decision |
| --- | --- | --- |
| D-001 | decided | Destination: standalone npm packages, not a PR to solidjs/solid |
| D-002 | decided | Audience: Dev as designer — a design lab; rigor over polish |
| D-003 | decided | JSX rule shipped as our own small Babel/Vite plugin |
| D-004 | decided | Solid PUBLIC API only, hard rule |
| D-005 | decided | One way per thing: remove aliases/overloads |
| D-006 | decided | Maximal strictness; no `read()`/`accessor()` escape hatches |
| D-007 | decided | Tip `dfe692cf` is the baseline; intent inferred and recorded |
| D-008 | decided | Gate per commit |
| D-009 | decided | Topic branches `bl/<topic>`, conventional commits + changesets, ff into `blocks-lib` |
| D-010 | decided | Order: tighten → standalone plugin → extract → extend |
| D-011 | decided | npm names unscoped |
| D-012 | decided | No-JSX `h`/`html` flavor is first-class |
| D-013 | decided | Rows and holes are bare `function*`; `$` and `$scope` removed |
| D-014 | decided | `$optimistic` / `$optimisticStore` mirror `$signal` / `$store` |
| D-015 | open | Repo layout for extraction (Q22) — **text lost** |
| D-016 | decided | Peer range `^2.0.0-rc`; twins' parity tests are the canary |
| D-017 | decided | Perf not in the gate |
| D-018 | dissolved | (open components) — dissolved by D-023 |
| D-019 | decided | Untyped sync throws: `[UNTYPED_THROW]` in dev, nearest `<Errored>` in prod |
| D-020 | decided | `$event` is always a transaction |
| D-021 | decided | Dev-mode receipt tracking → `[UNYIELDED_WRITE]` |
| D-022 | decided | Remove stray gitlink `async-reactivity-walkthrough` |
| D-023 | decided | Type linker removed; prop colors declared with `Async<T, E>` |
| D-024 | decided | Bare prop type = settled, never fails; async is opt-in |
| D-025 | **lost** | — |
| D-026 | **lost** | — |
| D-027 | decided | The gate pins `TZ=UTC` |
| D-028 | decided | A setter called outside a block run throws in dev |
| D-029 | decided | Pass-through props: explicit generics first; `Inherit<T>` only if the count is high |
| D-030 | decided | A row body is a setup |
| D-031 | decided | The JSX transform stays (D-003 stands) |
| D-032 | decided | A view has no body: reads only in JSX positions, structure only via flow controls |
| D-033 | decided | No boundary = the failure is re-thrown; D-019 reworded |

## Entries

### D-001 — Destination: standalone npm packages
**Decided.** `@solidjs/blocks` and its companions ship as their own packages, not as a pull request against `solidjs/solid`.
*Alternatives:* a PR to `solid` adding the packages to the monorepo; keeping the work only on a fork branch.
*Reasoning:* the library is a userland counterpart of `experiment/iterable-signals` (which bakes the same model into compiler/core). Shipping it standalone keeps the two routes independently evaluable and avoids coupling a design-lab artifact to Solid's release train. Consequences: D-004 (public API only, so the packages can live outside the repo) and Phase 3 (extraction).

### D-002 — Audience: Dev as designer
**Decided.** The audience is Dev designing the model, not end users. Rigor (strict types, exhaustive dev errors, parity tests, a decision log) over polish (docs for newcomers, ergonomics).
*Alternatives:* a user-facing library with onboarding docs first.
*Reasoning:* the point of the build-out is to find out whether the model holds up; every ambiguity surfaced is a finding. README should say "this is the strict dialect; the compiler route is the ergonomic one" (design review).

### D-003 — JSX rule as our own Babel/Vite plugin
**Decided.** The one JSX-transform rule (`yield* e` inside a JSX expression/attribute in a generator → `perform(e)` from `blocksModule`) ships as a small standalone plugin (`vite-plugin-solid-blocks`, Phase 2) with no dependency on `@solidjs/compiler`/`@solidjs/babel-plugin` carrying it.
*Alternatives:* keep the rule in the Rust compiler and babel-plugin (where it is at baseline); require the compiler route.
*Reasoning:* D-001 — a standalone package cannot depend on an unreleased upstream transform. The Rust implementation stays as the oracle for fixture parity. *Status:* decided; implementation is Phase 2.

### D-004 — Solid PUBLIC API only
**Decided, hard rule.** The runtime uses only exported, documented Solid 2 API. Anything the model needs that the public API cannot express is recorded in `blocks-library.md` §7 (Limitations) rather than reached for through internals.
*Alternatives:* patching core; importing from internal paths.
*Reasoning:* D-001 and D-016 — the packages must survive Solid's RC churn with the twins' parity tests as the only canary.

### D-005 — One way per thing
**Decided.** Aliases and overloads are removed rather than kept for convenience (examples: D-013 removes `$`/`$scope`; D-014 removes the `$optimistic` overload).
*Alternatives:* keep aliases as sugar with a lint preferring one form.
*Reasoning:* D-002 — in a design lab a second spelling hides whether the first is sufficient.

### D-006 — Maximal strictness; no escape hatches
**Decided.** No `read()`/`accessor()`/`paths()` escape hatches: every read and write in a block is a `yield*`. (The typed-failures v2 rewrite already removed them — see `.changeset/blocks-typed-failures-v2.md`.)
*Alternatives:* keep an escape hatch for interop, lint-gated.
*Reasoning:* the model's claim is that the generator protocol is complete; an escape hatch makes the claim untestable. Interop with plain Solid goes through `adopt()` and `context()` instead.

### D-007 — Baseline is `dfe692cf`
**Decided.** Dev's tip `dfe692cf` ("up", on top of "wip" `57d05dda`) is the baseline. Its unexplained intent was inferred from the diff and recorded in `.changeset/blocks-typed-failures-v2.md` and `blocks-library.md` §10 rather than reverted or re-derived.
*Alternatives:* baseline at the last documented commit `55f3c695` and re-apply.
*Reasoning:* the rewrite is coherent (typed failures v2) and the twins pass on it; recording intent is cheaper and more faithful than reconstruction. (Reconstructed note: this is also the baseline this file was rebuilt on after the container loss.)

### D-008 — Gate per commit
**Decided.** Every commit on a topic branch passes `scripts/blocks-gate.mjs`: for each of the 12 twins `test`, `typecheck`, `lint` (and `link:check` until Phase 1B removes it); `@solidjs/blocks` unit + type tests; `@solidjs/eslint-plugin-blocks` and `@solidjs/blocks-linker` tests; prettier check. Chromium/Playwright steps run only before pushes. "Green" = no step red that was green in the reference baseline run (see `blocks-gate-baseline.md`); pre-existing reds are listed there by name. *Reference run (reconstructed baseline, 2026-10-04, `09fa9de5`):* 52 pass / 2 fail / 1 skip over 55 steps; the reds are `pkg:blocks-linker:test` (3 staleness tests, fixture drift) and `pkg:compiler:test` (1 `blocks-summary` test not updated for `handler_fails` in `dfe692cf`), both pre-existing at the baseline and moot under D-023; `repo:oxlint` is SKIP (binary not installed). The babel-plugin and compiler steps run vitest only, against the already-built artifacts (the gate never builds). The timezone pin is D-027.
*Alternatives:* repo-wide `pnpm test` (too slow, and unrelated reds); gate only at merge.
*Reasoning:* the twins' DOM-parity tests are the model's only semantic oracle (D-016); running them per commit is what makes "ff when green" (D-009) meaningful. Build `@solidjs/blocks` with `--force` before gating — twins resolve it via `dist/`, and an unforced filtered build has produced spurious reds.

### D-009 — Branching and commit discipline
**Decided.** Topic branches `bl/<topic>` (branch names `blocks-lib/<x>` are impossible because `blocks-lib` exists as a branch). Conventional commits; one changeset per user-visible change; fast-forward into `blocks-lib` when the gate is green. Forks of a topic are logged in this file. Agent commits are authored `Claude <noreply@anthropic.com>`.
*Alternatives:* commit directly on `blocks-lib`; merge commits.
*Reasoning:* keeps `blocks-lib` linear and every commit gated, so bisecting a twin regression is one `git bisect` away.

### D-010 — Order of work
**Decided.** Phase 1A tighten (runtime/type hardening on the current repo) → Phase 1B declared prop colors → Phase 2 standalone plugin → Phase 3 extract to its own repo → Phase 4 extend.
*Alternatives:* extract first, then tighten in the new repo.
*Reasoning:* tightening needs the in-repo twins, the Rust compiler as oracle and the full Solid test infrastructure; extraction before that would duplicate all three. Phase 2 is file-disjoint from 1B and may run in parallel (Q23).

### D-011 — npm names unscoped
**Decided.** Published names are `solid-blocks`, `vite-plugin-solid-blocks`, `eslint-plugin-solid-blocks`. In-repo names stay `@solidjs/*` until extraction, where the rename is one commit.
*Alternatives:* `@solidjs/*` (implies org ownership we don't have); a personal scope.
*Reasoning:* D-001; unscoped names don't claim the Solid org's endorsement and need no scope access.

### D-012 — No-JSX flavor is first-class
**Decided.** The `h`/`html` flavor (`@solidjs/blocks/h`, `/html`) is first-class: same hole forms as JSX, same strictness, its own twins (`*-blocks-h`), and it must be a no-op for the JSX plugin.
*Alternatives:* JSX only; no-JSX as a best-effort subset.
*Reasoning:* the no-JSX flavor is the proof that the model does not depend on the transform (D-003): whatever JSX can express via the rule, `h` expresses without it.

### D-013 — Rows and holes are bare `function*`
**Decided.** A row (list item body) or a hole (a reactive child/attribute position) is a zero-arity generator function; the runtime wraps it (as `holes.ts` `toHole` does). The `$` and `$scope` helpers are removed (lint `no-dollar-block` with autofix first; the rule stays as a deprecated-usage rule). A derivation reused in several holes is a `yield* $memo`.
*Alternatives:* keep `$` as the explicit marker; keep `$scope` for shared derivations.
*Reasoning:* D-005 — `$` was a second spelling of "this is a block"; `$scope` was a second spelling of `$memo`. Migration size at decision time: 33 twin sites + 14 test sites. *Implementation:* Phase 1A item 4.

### D-014 — `$optimistic` / `$optimisticStore` symmetry
**Decided.** `$optimistic` is the scalar form and `$optimisticStore` the object-or-body form, mirroring `$signal` / `$store`; the overload of `$optimistic` that accepted a body is removed. `context()`, `$snapshot` and `start` are kept as they are.
*Alternatives:* merge everything into one `$optimistic`; remove `context()` in favour of `createContext()`.
*Reasoning:* D-005 and symmetry with the existing pair. Whether `context()` and `createContext()` stay separate long-term is deferred until after Phase 1B. *Implementation:* Phase 1A item 5.

### D-015 — Repo layout for extraction
**Open (Q22).** Original text **lost**; the handoff's recommendation was: a new pnpm monorepo `solid-blocks` with `packages/{blocks, vite-plugin-blocks, eslint-plugin-blocks}`, `examples/` twins plus vendored originals so the parity tests keep their oracle, the `@solidjs/web` JSX `.d.ts` vendored (today `types:jsx` builds it from `../web`), an exports-conditions matrix test, CI = the gate.

### D-016 — Peer range and canary
**Decided.** Peer dependency on Solid is `^2.0.0-rc`; the twins' parity tests are the canary for RC drift — a Solid change that breaks a twin is a finding, not a reason to pin.
*Alternatives:* pin exact RC versions.
*Reasoning:* D-004 — if the public API moves under us, we want to know on the next gate run.

### D-017 — Perf not in the gate
**Decided.** The runtime-cost harness (`blocks-library.md` §8) runs manually; no perf budgets in the gate yet.
*Alternatives:* budgets per twin in the gate.
*Reasoning:* budgets would be noisy across machines and the design is still moving; revisit when Phase 1 lands.

### D-018 — Open components
**Dissolved** by D-023: with declared prop colors there is no "open" (undeclared-color) component for the linker to resolve, so the question it answered no longer exists. (Reconstructed: the original question text was not carried by the handoff.)

### D-019 — Untyped sync throws
**Decided.** A plain `throw` (not a typed `raise`) inside a block is a bug, not a failure channel. Dev builds re-throw with the prefix `[UNTYPED_THROW] <host> in <Component>…` naming the host (setup/view/hole/event) and component; production routes it to the nearest `<Errored>` so the app degrades rather than dies.
*Alternatives:* treat untyped throws as `raise(unknown)`; swallow in prod.
*Reasoning:* D-006 — typed failures are complete for library-mediated failures; making a plain throw loud in dev is what keeps that claim honest, while prod behaviour must still be an error boundary. Doc §1 strictness bullet and §7 wording follow. *Amended by D-033:* "routes to the nearest `<Errored>` **if there is one**; with none, the failure is re-thrown". *Implementation:* Phase 1A item 7.

### D-020 — `$event` is always a transaction
**Decided.** Every `$event` handler runs as a Solid `action` (transaction) — no sync fast path.
*Alternatives:* sync handlers stay plain; transaction only when the handler awaits.
*Reasoning:* one semantics (D-005) and it is what typed failures v2 already does. Revisit only on a measured cliff (D-017 harness).

### D-021 — Dev-mode receipt tracking
**Decided.** In dev, a setter returns a receipt; a receipt not delegated (`yield*`-ed) by the end of the run is reported as `[UNYIELDED_WRITE]`. The lint rule `no-unyielded-write` stays for editor-time feedback; the runtime check is the authority.
*Alternatives:* lint only; make setters throw if called outside `yield*` (impossible without a transform).
*Reasoning:* the lint cannot see through helpers; the runtime can. Open: whether to carve a sync exception for `start(call)`. *Implementation:* Phase 1A item 8.

### D-022 — Remove stray gitlink
**Decided.** `async-reactivity-walkthrough` is a mode-160000 gitlink with no `.gitmodules` and no references in the tree; `git rm --cached` it.
*Reasoning:* it breaks fresh clones and worktrees for nothing. (Provenance, found during the changeset re-derivation: the gitlink was introduced by `57d05dda`/`dfe692cf` themselves.) *Implementation:* Phase 1A item 1 — done in `bl/bootstrap` (`f26f5ca2`).

### D-023 — Type linker removed; prop colors declared
**Decided.** `@solidjs/blocks-linker` (and the Rust `summarizeBlocks`, the `solid-props.gen.d.ts` files, each twin's `link:check`, the `typed-props-key` lint rule) are removed. A component declares a prop's color on its prop type: `Async<T, E>` for a prop that may be pending or fail; TypeScript then checks every render site with ordinary generics (variance: settled ⊂ pending, `never` ⊂ `E`).
*Alternatives:* keep the whole-program linker (infers colors across modules, needs a build step and generated files, and was the one pre-existing gate red); a TS language-service plugin.
*Reasoning:* the linker reproduced, with a generator and a check script, what a declared annotation gives for free and locally; the generated files were the main source of twin drift. *Validation:* after migrating the 12 twins, report Async-vs-total prop counts per twin — if most props need the annotation, the decision is wrong and must be said so, never papered over with `any`. The same report counts pass-through components that needed a generic signature (D-029). *Implementation:* Phase 1B.

### D-024 — Bare prop type is settled
**Decided.** A prop typed `T` is settled and never fails; `Async<T, E = never>` is the opt-in. Reads inside the child: bare → `Read<false, never>`, `Async<T, E>` → `Read<true, E>`. Pass-through carries the parent's declared color.
*Alternatives:* bare = "unknown color" (what the linker inferred); bare = async.
*Reasoning:* the common case must be the quiet one, and a settled default is the only one TS can enforce without inference across files. The call-site error should be readable via a branded `never` ("prop `todo` of TodoItem is settled; pass a settled value, or declare it `Async<Todo, FetchError>`").

### D-025 — **lost**
Not carried by the handoff. If you remember it, append it as a new entry naming D-025.

### D-026 — **lost**
Not carried by the handoff. If you remember it, append it as a new entry naming D-026.

### D-027 — The gate pins `TZ=UTC`
**Decided (2026-10-04).** `scripts/blocks-gate.mjs` runs every step with `TZ=UTC` (plus `FORCE_COLOR=0`, `NO_COLOR=1`, `CI=1`), whatever the host timezone.
*Alternatives:* pin the timezone inside the one twin that cares (`effect-blocks` formats a fixed 12:00 UTC timestamp in local time); leave it and accept a machine-dependent red.
*Reasoning:* the twin shares the assumption with its original — changing it would move the parity test away from its oracle — and a gate result must depend on the commit, not on the clock's locale. On an IST machine the step was red before the pin and green after; the lost container run was UTC, which is why it never showed there.

### D-028 — A setter called outside a block run throws in dev
**Decided (Dev, 2026-10-04).** After v2 a setter call returns a receipt and the write happens only at `yield*`. A setter invoked with no current block host (handed to foreign code: `onClick={setOpen}`, an `IntersectionObserver`, `setTimeout`) throws immediately in dev builds — `[SETTER_OUTSIDE_RUN] <setter> called outside a block run` — because the end-of-run receipt check of D-021 has no run to report at. Production keeps the silent no-op.
*Alternatives:* write eagerly when there is no host (a second behaviour for the same call, D-005); lint only ("setters are not values"), which misses dynamic cases; both.
*Reasoning:* the bug is at the call site and only the runtime sees it there; a lint can follow if the dev throw turns out to be found too late. *Implementation:* Phase 1A item 8, alongside the `[UNYIELDED_WRITE]` receipt check.

### D-029 — Pass-through props: explicit generics first
**Decided (Dev, 2026-10-04).** Under D-023 a component that forwards a prop it never reads (a `Card` handing `todo` to `TodoItem`) declares its color with an explicit type parameter: `type CardProps<P extends boolean = false, E = never> = { todo: Source<Todo, P, E> }` and `function* <P extends boolean, E>(props: CardProps<P, E>)`. The body is checked once for every color, so forwarding compiles only into a prop that accepts any color (`Async<…>`); forwarding into a bare (settled) prop is an error. Phase 1B's twin report counts these pass-through generics per twin next to the Async counts. An `Inherit<T>` marker — `$component` making the component implicitly generic over each `Inherit` prop, same rules, no type parameter to write — is added only if that count is high.
*Alternatives:* `Inherit<T>` from the start (less noise, more type machinery and worse error messages); declare every pass-through prop `Async<T, E>` (no generics anywhere, but ready values read as maybe-loading downstream and the component names errors it never sees); fix a numeric failure threshold up front.
*Reasoning:* options 1 and 2 have identical soundness — neither infers across files; 2 is sugar for 1 — so start with the one that has no machinery and makes the cost countable; the count decides whether the sugar earns its complexity.

### D-030 — A row body is a setup
**Decided (Dev, 2026-10-04).** The bare `function*` of a `<For>`/row (D-013) is a setup: it runs once per item and returns the row's view generator, the same shape as `$component` (setup returns view). `yield* $memo` inside it is correct and owned by the row.
*Alternatives:* row body is a view (per-row derivations unsupported; extract a `$component`); positional/hook-like idempotent `$memo` in a view (rejected: positional magic, D-006); keep `$scope` for rows only (partly reverses D-013).
*Reasoning:* it answers "where does a per-row derivation live once `$scope` is gone" without a new concept, by making rows and components the same shape. *Implementation:* Phase 1A item 4 — doc §1 states the symmetry; runtime test "a row memo is created once per item".

### D-031 — The JSX transform stays
**Decided (Dev, 2026-10-04).** The rule "`yield* e` in a JSX expression/attribute → `perform(e)`" stays; D-003 stands and Phase 2 builds the standalone plugin (plus a disable option in the Rust compiler, which has `blocksModule` but no off switch today).
*Alternatives:* drop the transform and require explicit `function*` holes everywhere (≈273 twin sites by a rough grep vs 20 explicit holes today; the `h` flavor already works that way). Rejected: the transform is the ergonomic path inside the strict dialect, and dropping it would not have removed the granularity cliff (D-032 does).
*Reasoning:* the view stays a `function*` for TypeScript's sake (a `yield*` must sit in a generator to be typed); at runtime the transform removes every view yield, which is consistent with D-032.

### D-032 — A view has no body
**Decided (Dev, 2026-10-04).** A view is `function* () { return <…/>; }`. Every read is a `yield*` directly in a JSX position (a hole); there is no `yield*` outside JSX, no `if`/early `return`, no local computation. All structure comes from flow controls (`<Show>`, `<Match>`, `<For>`, …), which take sources directly. The `h`/`html` flavor follows the same rule with explicit `function*` holes.
Consequences: (1) the whole-view read concept is deleted — `VY` is always `never`, so `ViewPending<VY, R>` collapses to `PendingOf<HOps<R>>`; a view is never pending or failing on its own, only its holes are; the runtime's whole-view detection (`viewRunning`/`jsxRead`, the machinery `a5faef57` patched) is repurposed into a dev error and otherwise removed (1A item 3 shrinks accordingly). (2) Enforcement at three levels: types (`Read` is not a `ViewOp`; type test "a view does not read"), dev runtime (`[READ_IN_VIEW] <Component>: read outside a JSX position`), lint `no-read-in-view-body` (error, in `recommended`). (3) Doc §3 row "A view reads; it does not create or write" becomes "A view does not read, create, write or branch; its holes read". (4) Twins migrate view-body reads and `if (yield* …)` branches (6 by grep) to holes and flow controls; the lint's first run gives the exact site count, which is recorded here.
*Alternatives:* keep whole-view reads and document the position-based granularity (§3 only); lint only the cliff case (a view-body read whose binding is used only in JSX); keep whole-view reads in the runtime for safety.
*Reasoning:* Dev: there should be no control flow or structure inside a view; all branching comes from flow controls, and a read is a hole. This removes the cliff (the same `yield* count` meaning a hole inside JSX and a whole-view re-render one line above) by removing the second meaning, not by warning about it. Fact that settled it: `ViewPending<VY, R> = PendingOf<VY | HOps<R>>` — holes were already tracked for pending/failures, so the whole-view read bought nothing but structure and a coarser scope. *Implementation:* new Phase 1A item 4b, after explicit holes (item 4).

### D-033 — No boundary: the failure is re-thrown
**Decided (Dev, 2026-10-04).** With no `<Errored>` on the path to the root, a failing view/memo is re-thrown by `reportError` and a failing `$event` rejects its promise (already the runtime's behaviour, tested for `$event`). The library installs no implicit root boundary and does not require one. D-019 is reworded accordingly.
*Alternatives:* `render()`/`hydrate()` install a default root `<Errored>` (feasible in one place, `rootOf(code)`); require a root boundary via a dev error and a lint.
*Reasoning:* crashing loudly with no boundary is the honest default for a strict dialect; a silent root fallback hides the failure. *Implementation:* doc §7 wording with 1A item 7; add the "no boundary → re-throw" runtime test for a view failure next to the existing `$event` one.

## Open questions

- **Q22** — repo layout for extraction (D-015).
- **Q23** — start Phase 2 in parallel with Phase 1B (recommended: yes; cheap now that worktrees are not disk-bound).
- D-032 migration: the exact count of view-body read / branch sites per twin, from the lint's first run.
- Whether `context()` and `createContext()` stay separate long-term (keep; revisit after 1B).
- Whether `no-unyielded-write` gets a sync exception for `start(call)` (D-021).

## Design-review items not yet turned into decisions

Async `$memo` is emulated over `createMemo` + `latest`/`isPending` → needs a deterministic pending-flip ordering test. The SSR path skips whole-view detection → needs a both-sides top-level-read hydration test. The JSX rule applies syntactically anywhere in a generator → lint "JSX only in views" or assert the host in `perform`. Refusals should be listed in one "what you can't write in a view" table. Port the experiment branch's `$`-block conformance harness (`packages/web/test`) as a semantics pin independent of the twins. Error-locality helpers (`view()`/`setup()` wrappers) are the biggest DX lever without a TS plugin.

## Branch log

| Date | Branch | Event |
| --- | --- | --- |
| 2026-10-04 | `blocks-lib` @ `b03535f6` (container) | Lost unpushed with the container (disk full). Contents: this file, the gate script and baseline, the v2 changeset, HANDOFF.md. |
| 2026-10-04 | `bl/bootstrap` off `dfe692cf` | Reconstruction of the lost commits from the handoff: `09fa9de5` changeset, `08d7a7d3` gate + baseline, `f26f5ca2` gitlink removal (D-022), then this file (`da03be74`); D-030…D-033 added after the design review. ff'd into `blocks-lib` and pushed to `fork` at `da03be74`; the review commit follows. |
| 2026-10-04 | `bl/tighten`, `bl/colors` (container) | Provisioned, no commits landed; recreated on demand. |
