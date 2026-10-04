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
| D-034 | decided | Error types carry a literal `kind`; one `Failure` constraint at every `E` entry point |
| D-035 | decided | `start()` removed |
| D-036 | decided | `context()` removed; `yield* Ctx` is the one way to read a context |
| D-037 | decided | D-008 amended: no Chromium clause; `oxlint` is a real gate step |
| D-038 | decided | Flow controls accept holes as well as sources |
| D-039 | decided | Conformance harness ported in Phase 4 |
| D-040 | decided | `Async<T, E>` on a prop is permission only |
| D-041 | decided | JSX only in view / hole / row returns; a setup never creates elements |
| D-042 | decided | All props are reactive; no static prop kind; `$snapshot` removed; `$untrack` in reactive scopes only |
| D-043 | decided | After plugin parity, the fork's compiler and babel-plugin go back to pristine upstream |
| D-044 | decided | `$dynamic` returns a colored component |
| D-045 | decided | Parity is the only Solid-drift canary; no golden snapshots |
| D-046 | decided | `html`` ` flavor dropped; `h()` is the no-JSX flavor (D-012 amended) |
| D-047 | decided | `@solidjs/blocks` exports `lazy` (colored); `adopt()` removed |
| D-048 | open | `$event` paused on a pending read: independent runs / latest-wins / timeout |
| D-049 | decided | `h` flavor: the no-body rule is type-level only (`[HVIEW_READ]`) |
| D-050 | decided | D-013 amended: in JSX the hole is `yield*` only |
| D-051 | decided | D-032 amended: JSX enforcement is runtime + lint; type-level form for `h` only |

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
**Decided.** Every commit on a topic branch passes `scripts/blocks-gate.mjs`: for each of the 12 twins `test`, `typecheck`, `lint` (and `link:check` until Phase 1B removes it); `@solidjs/blocks` unit + type tests; `@solidjs/eslint-plugin-blocks` and `@solidjs/blocks-linker` tests; prettier check. ~~Chromium/Playwright steps run only before pushes.~~ (Dropped by D-037: no browser test exists.) "Green" = no step red that was green in the reference baseline run (see `blocks-gate-baseline.md`); pre-existing reds are listed there by name. *Reference run (reconstructed baseline, 2026-10-04, `09fa9de5`):* 52 pass / 2 fail / 1 skip over 55 steps; the reds are `pkg:blocks-linker:test` (3 staleness tests, fixture drift) and `pkg:compiler:test` (1 `blocks-summary` test not updated for `handler_fails` in `dfe692cf`), both pre-existing at the baseline and moot under D-023; `repo:oxlint` is SKIP (binary not installed). The babel-plugin and compiler steps run vitest only, against the already-built artifacts (the gate never builds). The timezone pin is D-027.
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
*Reasoning:* the no-JSX flavor is the proof that the model does not depend on the transform (D-003): whatever JSX can express via the rule, `h` expresses without it. *Amended by D-046:* the flavor is `h()` only; the `html`` ` tagged template is dropped.

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
*Reasoning:* the view stays a `function*` for TypeScript's sake (a `yield*` must sit in a generator to be typed); at runtime the transform removes every view yield, which is consistent with D-032. *Implementation note (2026-10-04):* no compiler disable option is needed after all. The twins get the fork's rule because the published `@solidjs/vite-plugin@3.0.0-next.35` links the workspace `packages/compiler`/`packages/babel-plugin`; the standalone plugin runs `enforce: "pre"`, so by the time the compiler sees a file every `yield*` in JSX is already `perform(…)` and the Rust rule is a no-op. Sequence: plugin → fixture parity (5 fixtures, 5 refusal codes) → twins through the plugin with the compiler rule idle → D-043 removes the rule.

### D-032 — A view has no body
**Decided (Dev, 2026-10-04).** A view is `function* () { return <…/>; }`. Every read is a `yield*` directly in a JSX position (a hole); there is no `yield*` outside JSX, no `if`/early `return`, no local computation. All structure comes from flow controls (`<Show>`, `<Match>`, `<For>`, …), which take sources directly. The `h`/`html` flavor follows the same rule with explicit `function*` holes.
Consequences: (1) the whole-view read concept is deleted — `VY` is always `never`, so `ViewPending<VY, R>` collapses to `PendingOf<HOps<R>>`; a view is never pending or failing on its own, only its holes are; the runtime's whole-view detection (`viewRunning`/`jsxRead`, the machinery `a5faef57` patched) is repurposed into a dev error and otherwise removed (1A item 3 shrinks accordingly). (2) Enforcement at three levels: types (`Read` is not a `ViewOp`; type test "a view does not read"), dev runtime (`[READ_IN_VIEW] <Component>: read outside a JSX position`), lint `no-read-in-view-body` (error, in `recommended`). (3) Doc §3 row "A view reads; it does not create or write" becomes "A view does not read, create, write or branch; its holes read". (4) Twins migrate view-body reads and `if (yield* …)` branches (6 by grep) to holes and flow controls; the lint's first run gives the exact site count, which is recorded here.
*Alternatives:* keep whole-view reads and document the position-based granularity (§3 only); lint only the cliff case (a view-body read whose binding is used only in JSX); keep whole-view reads in the runtime for safety.
*Reasoning:* Dev: there should be no control flow or structure inside a view; all branching comes from flow controls, and a read is a hole. This removes the cliff (the same `yield* count` meaning a hole inside JSX and a whole-view re-render one line above) by removing the second meaning, not by warning about it. Fact that settled it: `ViewPending<VY, R> = PendingOf<VY | HOps<R>>` — holes were already tracked for pending/failures, so the whole-view read bought nothing but structure and a coarser scope. *Implementation:* new Phase 1A item 4b, after explicit holes (item 4).

### D-033 — No boundary: the failure is re-thrown
**Decided (Dev, 2026-10-04).** With no `<Errored>` on the path to the root, a failing view/memo is re-thrown by `reportError` and a failing `$event` rejects its promise (already the runtime's behaviour, tested for `$event`). The library installs no implicit root boundary and does not require one. D-019 is reworded accordingly.
*Alternatives:* `render()`/`hydrate()` install a default root `<Errored>` (feasible in one place, `rootOf(code)`); require a root boundary via a dev error and a lint.
*Reasoning:* crashing loudly with no boundary is the honest default for a strict dialect; a silent root fallback hides the failure. *Implementation:* doc §7 wording with 1A item 7; add the "no boundary → re-throw" runtime test for a view failure next to the existing `$event` one.

### D-034 — Error types carry a literal `kind`
**Decided (Dev, 2026-10-04).** `attempt`/`until`/`raise`/`<Errored catch>` remove a handled class from a failure union *structurally* (TS compares shapes) but match at runtime with `instanceof` (nominal). Two classes without a discriminant are one type to TS, so `catch={[A]}` would also erase `B` from the type while the runtime rethrows `B`. The types now enforce the convention every twin already follows: an error type accepted anywhere as `E` must satisfy one shared constraint `Failure = Error & { readonly kind: <string literal> }` (a plain `string` `kind`, or none, fails with a branded-never message: "error class X needs `readonly kind = \"x\" as const` so its failure can be told apart"). Entry points: `attempt<T, E>`, `until<T, E>`, `raise<E>` (unconstrained before this), `Errored`'s `catch`, and `Async<T, E>` in Phase 1B; everything else inherits.
*Alternatives:* require any own literal member without fixing the name (looser, worse message); document as a §7 limitation and rely on convention.
*Reasoning:* a typed-failure system whose type-level removal and runtime matching can disagree is unsound in exactly the case it exists for; the constraint costs one line per error class, which every twin already pays. *Implementation:* Phase 1A, with item 7; type test for the two-identical-classes case.

### D-035 — `start()` removed
**Decided (Dev, 2026-10-04).** `yield* start(call)` (v2: run an event call without waiting and without absorbing its colors) is removed, with its op, its tests and its doc mention. It existed for one typing corner — an `$effect` cannot wait, so an effect could not otherwise trigger an async event — and no twin uses it (1 runtime test, 3 type-test lines). An effect may delegate only to a sync event (already the rule); "an effect triggers an async event" is written in §7 as "model it as an event calling an event, or a `$memo`". If a twin or test turns out to need the escape, that is the finding to record here.
*Alternatives:* keep it with one spelling (`yield* start(call)`); keep it legal only inside `$effect`; allow a bare `start(call)` statement (the handoff's open question — now moot).
*Reasoning:* D-005 — an unused second way to call an event; its presence also forced the odd "yield in order to not wait" spelling. *Implementation:* Phase 1A, with item 8 (the `no-unyielded-write` rule loses its `start` special case).

### D-036 — `context()` removed
**Decided (Dev, 2026-10-04).** `context(Ctx)` ("read a context this library did not create") is removed. `yield* Ctx` on a context created with the library's `createContext` is the one way to read a context. Fact that settled it: no twin uses `context(Ctx)` and no twin creates a raw Solid context. A foreign context (a router's, an i18n library's) is reached by adopting the component that provides it (`adopt()`) or by wrapping the value once in a library context; if a twin or the router integration turns out to need the bridge, that is the finding to record here. Closes the handoff's deferred "do `context()` and `createContext()` stay separate" question.
*Alternatives:* keep it as the sanctioned interop bridge (and add a test that uses it); make `yield* Ctx` accept any Solid context.
*Reasoning:* D-005 and D-006 — an unused second name that is also an escape hatch. *Implementation:* Phase 1A, with item 8's surface cleanup; doc §1 setup-operations bullet.

### D-037 — D-008 amended: gate contents
**Decided (Dev, 2026-10-04).** (a) The "Chromium/Playwright steps run only before pushes" clause is dropped: no twin or blocks package has a browser test, so the clause was vestigial (three pushes were made under it without one). It returns when a browser test exists. (b) `oxlint` becomes a root devDependency so `repo:oxlint` runs for real instead of being SKIP forever (`.oxlintrc.json` existed since `dfe692cf` with no binary anywhere in the lockfile); the baseline is regenerated and any reds it adds are recorded, not hidden.
*Alternatives:* delete `.oxlintrc.json` and the step (eslint-plugin-blocks as the only lint); keep both clauses as written.
*Reasoning:* a gate step that can never run and a rule that is never exercised both make "green" mean less than it says. *Implementation:* `bl/bootstrap`, gate agent; baseline regenerated at the same commit.

### D-038 — Flow controls accept holes as well as sources
**Decided (Dev, 2026-10-04).** `<Show when>`, `<Match when>`, `<For each>` and the other flow controls accept a `Source` **or** a zero-arity `function*` (a hole, the same form as a JSX attribute hole): `<Show when={function* () { return (yield* todos).length > 0; }}>`. Derived conditions stay local to the view; one hole form everywhere (D-013). The D-013 rule still applies: a derivation used in more than one place is a `yield* $memo`.
*Alternatives:* sources only, every derived condition a named `$memo` in setup (verbose; the todos `when={todos().length > 0}` would need a memo per condition).
*Reasoning:* D-032 removed the view body, which is where derived conditions used to be computed; without this the migration would move every one of them into setup. *Implementation:* Phase 1A item 4b (types: the `when`/`each` prop types admit a hole; type + runtime test; `h` flavor too).

### D-039 — Conformance harness ported in Phase 4
**Decided (Dev, 2026-10-04).** The experiment branch's conformance harness (`packages/web/test/conformance` on `experiment/iterable-signals`: `conformance.spec.ts`, golden client/hydrate/server traces, 8 server-reference vs blocks-compiled HTML scenario pairs, `COVERAGE.md`) is ported as a semantics pin for the library route in Phase 4, after extraction; until then the 12 twins are the oracle. Note for the port: the `blocks-context` scenario is moot after D-036 and `blocks-effect` must be re-read against D-032.
*Alternatives:* port now as 1A's last item (pin before more runtime surgery); never (twins suffice).
*Reasoning:* the harness pins semantics independently of the twins, which is valuable, but it is most valuable once the runtime stops moving and the repo is standalone.

### D-040 — `Async<T, E>` on a prop is permission only
**Decided (Dev, 2026-10-04).** Declaring `todo: Async<Todo, FetchError>` says "I can be given unsettled data"; it creates no obligation to handle it. A pending read or a failure from that prop propagates to the nearest `<Loading>`/`<Errored>` wherever it is — possibly in the parent — exactly as a pending read propagates in Solid. A bare prop means "give me settled data; I am never the one that is pending". The declaration is a type permission, not a UI duty.
*Alternatives:* duty — a component with an `Async` prop must contain the boundary for it (dev error when its pending escapes); permission plus a one-time dev hint when it escapes a component with no boundary.
*Reasoning:* boundaries are placed by whoever owns the layout, not by whoever declares a type; a duty would force a boundary per component and fight Solid's propagation model. Doc: 1B's §6 ("Declared colors") states this in one sentence.

### D-041 — JSX only in view / hole / row returns
**Decided (Dev, 2026-10-04).** JSX appears only as the return of a view, of a hole, or of a row's view. A setup never creates elements: `const header = <h1>{yield* title}</h1>` in a setup is an error. Elements are not values in a block. Enforcement: lint `jsx-only-in-view` (error, in `recommended`); the transform's `perform` asserts the host in dev — a hole performed while a setup is the host is `[JSX_IN_SETUP] <Component>: JSX in a setup`; Phase 2's plugin inherits the rule unchanged. Closes the design-review item "the JSX rule applies syntactically anywhere in a generator".
*Alternatives:* JSX as a settled value anywhere (a slot element passed as a prop); JSX in a setup only through a creator (`$memo` returning a view, `$dynamic`).
*Reasoning:* D-032 made a view nothing but structure and holes; letting a setup build elements would reintroduce a second place where reads become holes, with a different host and different pending scope. *Implementation:* Phase 1A, with item 4b's lint work (new rule + tests; twin sites counted on first run and recorded here).

### D-042 — All props are reactive; a setup never reads; `$snapshot` removed
**Decided (Dev, 2026-10-04).** Every prop is a `Source`; there is no static/plain prop kind. A setup never reads — the "take a value with `$snapshot`" exception in §3 row 7 is gone and `$snapshot` is deleted. "Take the value once and ignore updates" is written where Solid writes it: inside a reactive scope, untracked — `yield* $untrack(source)`, a read op admitted in holes, memos, effects and events (`HoleOp`/`MemoOp`/`EffectOp`/`EventOp`), never in a setup. Facts that settled it: the 16 twin files using `$snapshot` all snapshot *props* that are components, slots, callbacks or config (`props.AppShell`, `props.editor`, `props.toggle`, `props.onSearch`, `props.copy`, `props.log`) — i.e. `$snapshot` existed only because a setup could not otherwise hold a prop it needed, and it silently froze a value the parent believed was live. Migration: a component prop is read in a `$dynamic` body or a hole; a callback is read inside the event that calls it (`(yield* props.onSearch)(q)`); config and objects are read in holes/events. The migration count per twin is recorded here on the lint's first run.
*Alternatives:* a declared `Once<T>`/`Static<T>` prop kind (a plain value, usable in setup, call-site type error for a changing source) — rejected: a second kind of prop; keep `$snapshot` as is; forbid `$snapshot` only on props.
*Reasoning:* Dev: reading in setup should not be allowed; if the use case is "take once", do it in a reactive scope under `untrack`; and all props are reactive — one model, no plain-value escape. *Implementation:* Phase 1A (new item 4c after 4b: remove `$snapshot`, add `$untrack` with type/runtime/lint tests, migrate the 16 files, doc §1/§3). If no twin needs `$untrack` after migration, record that count here; it is then a D-005 candidate.

### D-043 — After plugin parity, the fork's compiler goes back to pristine upstream
**Decided (Dev, 2026-10-04).** Once Phase 2's standalone plugin passes fixture parity against the Rust rule, the blocks footprint is removed from the fork's `@solidjs/compiler` and `@solidjs/babel-plugin`: `blocks_rule.rs` (364 lines), `blocks_summary.rs` (1,230 lines; its `summarizeBlocks` export was never released — only announced in the pending `compiler-blocks-rule` changeset), `tests/blocks-rule-fixtures.json`'s compiler side, `__tests__/blocks-*.test.js`, the `blocks_module` option and the `index.js`/`types.d.ts`/`compiler.rs`/`config.rs`/`lib.rs`/`node_adapter.rs` hunks, the babel copy `src/shared/blocks-rule.ts` with its `preprocess.ts`/`config.ts`/`types.ts` hunks and `test/blocks-rule.spec.js`, and the `compiler-blocks-rule.md` changeset. The plugin's checked-in expected outputs (generated once from the Rust rule) become the oracle. D-001/D-003 taken to their end: nothing of blocks remains in Solid's packages.
Facts for the executor: the diff of `packages/compiler` + `packages/babel-plugin` between `blocks-lib` and its upstream merge-base `644eaf3b` (`origin/next`) is 23 files / +2,047; the hunks in `directives/`, `refresh/`, `tsrx/` and `dom/` must be classified first — they may be unrelated fork work and are not removed by this decision. The crate requires `rust-version = "1.95"`; this machine's default toolchain is 1.88 with stable 1.99 installed — run cargo with `RUSTUP_TOOLCHAIN=stable`. Validation: `cargo clippy -- -D warnings`, `cargo test`, the compiler's 5,990-test vitest suite (the one pre-existing `blocks-summary` red disappears with the file), rebuild `compiler.node`, full gate.
*Alternatives:* keep the Rust rule as the oracle, disabled by default; keep both as supported routes (twins gated under both).
*Reasoning:* a reference implementation nobody ships drifts; checked-in outputs don't. *Implementation:* Phase 2's last commit (sequenced after the plugin's parity commit); `summarizeBlocks` alone goes earlier, in 1B.

### D-044 — `$dynamic` returns a colored component
**Decided (Dev, 2026-10-04).** `$dynamic(body)` no longer returns a plain `SolidComponent`. Its body's colors are already known (`Y extends MemoOp` may read pending sources; `SyncReturn<R>` routes failures through `attempt`); the returned component now carries them, and rendering it in a view (`<Reply/>`, or `h(Reply)`) contributes `PendingOf<Y> | FailsOf<Y>` to the enclosing view's hole ops — the same mechanism holes use, so a view rendering a pending `$dynamic` is pending in its type. Runtime is unchanged (Solid's `dynamic()`; pending reaches the nearest boundary per D-040). Facts that settled it: 9 twin files use `$dynamic`, none has a boundary of its own, and the type said settled.
*Alternatives:* document as a §7 limitation; require a settled body (kills the server-component-call use that motivated `$dynamic`).
*Reasoning:* typed failures are "complete for library-mediated failures" (D-019); a library creator that drops known colors on the floor is a hole in that claim. *Implementation:* Phase 1A item 4d (element/`h` types admit a colored component; type test "a view rendering a pending `$dynamic` is pending"; runtime test unchanged behaviour). Note for `adopt()`: the same question applies to `adopt(lazy(X))` (7 twin uses) — a lazy chunk is pending while it loads; see the next decision on it.

### D-045 — Parity is the only Solid-drift canary
**Decided (Dev, 2026-10-04).** The twins' parity tests (one script against the original and the twin, DOM snapshot after each step, hydration keys normalized) remain the canary for Solid RC drift, as D-016 says. No golden snapshots of the originals are checked in, and the standalone repo keeps the caret peer range. If a Solid change alters the original and the twin identically, parity passes and that is the intended outcome: the library followed Solid.
*Alternatives:* golden snapshots of the originals per Solid version (a separate "Solid drift" gate step); pin an exact RC and bump deliberately.
*Reasoning:* the library's claim is parity with Solid, not stability against it. *Implementation:* none; Phase 3 vendors the originals runnable so the harness keeps its oracle.

### D-046 — `html`` ` flavor dropped
**Decided (Dev, 2026-10-04).** `@solidjs/blocks/html` (Solid's tagged templates with typed holes) is removed; `h()` is the no-JSX flavor. Facts that settled it: both `-h` twins use `h()` only; no twin, fixture or doc example exercises `html`` ` beyond the package's own unit tests (5 cases in `nojsx.spec.ts`, 3 in `nojsx.type-tests.ts`), and `html.ts`'s docstring still showed the `$(function* …)` form D-013 removed. Removal list: `src/html.ts`, the two `html` entries in `scripts/build.mjs`, the `./html` export and the `@solidjs/html` dependency in `package.json`, the 8 test cases, doc §1/§2 mentions (lines 11, 26, 33, 44–46 at `46124409`).
*Alternatives:* keep it and add an `html` twin; keep it on unit tests only.
*Reasoning:* D-005/D-012 — a second no-JSX surface with no twin cannot be kept in parity with the first. *Implementation:* Phase 1A item 4e.

### D-047 — `@solidjs/blocks` exports `lazy`; `adopt()` removed
**Decided (Dev, 2026-10-04).** The library exports its own `lazy`, wrapping `solid-js`'s with the same signature (`preload` / `moduleUrl` kept, so the Vite plugin's module-URL pass still works); the result is a block component colored **pending while its chunk loads**, unioned with the inner block component's own declared colors, and usable in call form (`{yield* Home()}`) as before. `adopt()` — "a component this library did not create, usable in call form" — is deleted: all 7 twin uses were `adopt(lazy(…))` (`rendering-blocks`), the general case had none, and its return type dropped the chunk-loading pending (the D-044 gap one level up). Foreign non-lazy components have no bridge; if a twin needs one, that is the finding.
*Alternatives:* blocks `lazy` plus keep `adopt` as the general bridge; keep `adopt` and overload it on Solid's lazy return type (`T & { preload; moduleUrl? }`).
*Reasoning:* Dev: if it is for lazy, build it into lazy; D-004 forbids patching Solid's, so the library wraps it; D-005 removes the now-unused bridge. *Implementation:* Phase 1A item 4d with D-044 (type test "a view rendering a loading `lazy` is pending"; the 7 sites change import only).

### D-048 — `$event` paused on a pending read
**Open (2026-10-04).** A read inside an event that hits a pending source waits for its data (tested: "an event that reads a pending source waits for its data"); the wait is unbounded (only `until` has a timeout) and a second call of the same event starts another independent run while the first keeps waiting. Nested event calls already merge into the outer transaction (Solid's `action`: "a nested action … runs inside the OUTER action's slice"), so that part is settled. Options on the table: keep independent runs (document only); `$event(body, { latest: true })` closing the paused earlier run (the runtime already closes superseded generators with `gen.return()` in the memo and event paths); a per-event timeout failing with a typed `TimeoutError`.

### D-049 — `h` flavor: the no-body rule is type-level only
**Decided (Dev, 2026-10-04).** For `h()` views, "a view reads only in holes" is enforced by the existing type check `[HVIEW_READ]` (`HViewOp = never`) only; the lint `no-read-in-view-body` and the dev error `[READ_IN_VIEW]` stay JSX-only.
*Alternatives:* the same three levels for both flavors by generator nesting; runtime only for `h`.
*Reasoning:* `h` views are the rarer form and already have the strongest (type-level) check — the one JSX cannot have (D-051).

### D-050 — D-013 amended: in JSX the hole is `yield*` only
**Decided (Dev, 2026-10-04, from a Phase 1A finding).** A bare `function*` as a JSX child or attribute value cannot be a hole: the JSX compiler passes it straight to `@solidjs/web`'s `insert()`/`setAttribute()`, which never call the library. In JSX the hole form is `{yield* x}` (the transform's `perform`); a `function*` block is the `h` flavor's hole form and the form for flow-control **props** (`<Show when={function* () { … }}>` reaches the component, D-038). A `function*` JSX child/attribute is a type error, pinned by a type test.
*Alternatives:* a second transform rule rewriting a `function*` JSX child/attribute into a hole call — rejected, it reverses D-031's one-rule stance.
*Reasoning:* the transform is the ergonomic path (D-031); the one thing it rewrites is `yield*`. Implemented in `9f0dac54` on `bl/tighten`.

### D-051 — D-032 amended: JSX enforcement is runtime + lint
**Decided (Dev, 2026-10-04, from a Phase 1A finding).** At the type level a JSX view's hole reads *are* its yields — TypeScript types `{yield* user.name}` inside JSX exactly like a statement yield — and that is the only channel for a JSX view's colors (`ViewPending<VY, R> = PendingOf<VY | HOps<R>>`). So "`Read` is not a `ViewOp`" holds for `h` (`HViewOp = never`, `[HVIEW_READ]`) but cannot for JSX. For JSX the no-body rule is enforced by the dev error `[READ_IN_VIEW]` and the lint `no-read-in-view-body` (which replaces `no-read-outside-hole`, D-005); migration count on the lint's first run: 0 in every twin (the old rule already enforced it). Recorded in §7 as a limitation of the transform route.
*Alternatives:* time-boxed research into branding `perform`'s yield (`HoleRead`) so a statement-level `Read` is rejected while JSX reads pass.
*Reasoning:* no parity test failed and the rule is enforced at two of three levels; a type-level form for JSX may not be expressible in TS. Implemented in `b1634e33` on `bl/tighten`.

### Phase 1A log (items 2–6, `bl/tighten`)
`5a3bfba2` duplicate-runtime guard · `9f0dac54` rows and holes are bare `function*`, `# DECISIONS — `@solidjs/blocks` build-out

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
| D-034 | decided | Error types carry a literal `kind`; one `Failure` constraint at every `E` entry point |
| D-035 | decided | `start()` removed |
| D-036 | decided | `context()` removed; `yield* Ctx` is the one way to read a context |
| D-037 | decided | D-008 amended: no Chromium clause; `oxlint` is a real gate step |
| D-038 | decided | Flow controls accept holes as well as sources |
| D-039 | decided | Conformance harness ported in Phase 4 |
| D-040 | decided | `Async<T, E>` on a prop is permission only |
| D-041 | decided | JSX only in view / hole / row returns; a setup never creates elements |
| D-042 | decided | All props are reactive; no static prop kind; `$snapshot` removed; `$untrack` in reactive scopes only |
| D-043 | decided | After plugin parity, the fork's compiler and babel-plugin go back to pristine upstream |
| D-044 | decided | `$dynamic` returns a colored component |
| D-045 | decided | Parity is the only Solid-drift canary; no golden snapshots |
| D-046 | decided | `html`` ` flavor dropped; `h()` is the no-JSX flavor (D-012 amended) |
| D-047 | decided | `@solidjs/blocks` exports `lazy` (colored); `adopt()` removed |
| D-048 | open | `$event` paused on a pending read: independent runs / latest-wins / timeout |
| D-049 | decided | `h` flavor: the no-body rule is type-level only (`[HVIEW_READ]`) |
| D-050 | decided | D-013 amended: in JSX the hole is `yield*` only |
| D-051 | decided | D-032 amended: JSX enforcement is runtime + lint; type-level form for `h` only |

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
**Decided.** Every commit on a topic branch passes `scripts/blocks-gate.mjs`: for each of the 12 twins `test`, `typecheck`, `lint` (and `link:check` until Phase 1B removes it); `@solidjs/blocks` unit + type tests; `@solidjs/eslint-plugin-blocks` and `@solidjs/blocks-linker` tests; prettier check. ~~Chromium/Playwright steps run only before pushes.~~ (Dropped by D-037: no browser test exists.) "Green" = no step red that was green in the reference baseline run (see `blocks-gate-baseline.md`); pre-existing reds are listed there by name. *Reference run (reconstructed baseline, 2026-10-04, `09fa9de5`):* 52 pass / 2 fail / 1 skip over 55 steps; the reds are `pkg:blocks-linker:test` (3 staleness tests, fixture drift) and `pkg:compiler:test` (1 `blocks-summary` test not updated for `handler_fails` in `dfe692cf`), both pre-existing at the baseline and moot under D-023; `repo:oxlint` is SKIP (binary not installed). The babel-plugin and compiler steps run vitest only, against the already-built artifacts (the gate never builds). The timezone pin is D-027.
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
*Reasoning:* the no-JSX flavor is the proof that the model does not depend on the transform (D-003): whatever JSX can express via the rule, `h` expresses without it. *Amended by D-046:* the flavor is `h()` only; the `html`` ` tagged template is dropped.

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
*Reasoning:* the view stays a `function*` for TypeScript's sake (a `yield*` must sit in a generator to be typed); at runtime the transform removes every view yield, which is consistent with D-032. *Implementation note (2026-10-04):* no compiler disable option is needed after all. The twins get the fork's rule because the published `@solidjs/vite-plugin@3.0.0-next.35` links the workspace `packages/compiler`/`packages/babel-plugin`; the standalone plugin runs `enforce: "pre"`, so by the time the compiler sees a file every `yield*` in JSX is already `perform(…)` and the Rust rule is a no-op. Sequence: plugin → fixture parity (5 fixtures, 5 refusal codes) → twins through the plugin with the compiler rule idle → D-043 removes the rule.

### D-032 — A view has no body
**Decided (Dev, 2026-10-04).** A view is `function* () { return <…/>; }`. Every read is a `yield*` directly in a JSX position (a hole); there is no `yield*` outside JSX, no `if`/early `return`, no local computation. All structure comes from flow controls (`<Show>`, `<Match>`, `<For>`, …), which take sources directly. The `h`/`html` flavor follows the same rule with explicit `function*` holes.
Consequences: (1) the whole-view read concept is deleted — `VY` is always `never`, so `ViewPending<VY, R>` collapses to `PendingOf<HOps<R>>`; a view is never pending or failing on its own, only its holes are; the runtime's whole-view detection (`viewRunning`/`jsxRead`, the machinery `a5faef57` patched) is repurposed into a dev error and otherwise removed (1A item 3 shrinks accordingly). (2) Enforcement at three levels: types (`Read` is not a `ViewOp`; type test "a view does not read"), dev runtime (`[READ_IN_VIEW] <Component>: read outside a JSX position`), lint `no-read-in-view-body` (error, in `recommended`). (3) Doc §3 row "A view reads; it does not create or write" becomes "A view does not read, create, write or branch; its holes read". (4) Twins migrate view-body reads and `if (yield* …)` branches (6 by grep) to holes and flow controls; the lint's first run gives the exact site count, which is recorded here.
*Alternatives:* keep whole-view reads and document the position-based granularity (§3 only); lint only the cliff case (a view-body read whose binding is used only in JSX); keep whole-view reads in the runtime for safety.
*Reasoning:* Dev: there should be no control flow or structure inside a view; all branching comes from flow controls, and a read is a hole. This removes the cliff (the same `yield* count` meaning a hole inside JSX and a whole-view re-render one line above) by removing the second meaning, not by warning about it. Fact that settled it: `ViewPending<VY, R> = PendingOf<VY | HOps<R>>` — holes were already tracked for pending/failures, so the whole-view read bought nothing but structure and a coarser scope. *Implementation:* new Phase 1A item 4b, after explicit holes (item 4).

### D-033 — No boundary: the failure is re-thrown
**Decided (Dev, 2026-10-04).** With no `<Errored>` on the path to the root, a failing view/memo is re-thrown by `reportError` and a failing `$event` rejects its promise (already the runtime's behaviour, tested for `$event`). The library installs no implicit root boundary and does not require one. D-019 is reworded accordingly.
*Alternatives:* `render()`/`hydrate()` install a default root `<Errored>` (feasible in one place, `rootOf(code)`); require a root boundary via a dev error and a lint.
*Reasoning:* crashing loudly with no boundary is the honest default for a strict dialect; a silent root fallback hides the failure. *Implementation:* doc §7 wording with 1A item 7; add the "no boundary → re-throw" runtime test for a view failure next to the existing `$event` one.

### D-034 — Error types carry a literal `kind`
**Decided (Dev, 2026-10-04).** `attempt`/`until`/`raise`/`<Errored catch>` remove a handled class from a failure union *structurally* (TS compares shapes) but match at runtime with `instanceof` (nominal). Two classes without a discriminant are one type to TS, so `catch={[A]}` would also erase `B` from the type while the runtime rethrows `B`. The types now enforce the convention every twin already follows: an error type accepted anywhere as `E` must satisfy one shared constraint `Failure = Error & { readonly kind: <string literal> }` (a plain `string` `kind`, or none, fails with a branded-never message: "error class X needs `readonly kind = \"x\" as const` so its failure can be told apart"). Entry points: `attempt<T, E>`, `until<T, E>`, `raise<E>` (unconstrained before this), `Errored`'s `catch`, and `Async<T, E>` in Phase 1B; everything else inherits.
*Alternatives:* require any own literal member without fixing the name (looser, worse message); document as a §7 limitation and rely on convention.
*Reasoning:* a typed-failure system whose type-level removal and runtime matching can disagree is unsound in exactly the case it exists for; the constraint costs one line per error class, which every twin already pays. *Implementation:* Phase 1A, with item 7; type test for the two-identical-classes case.

### D-035 — `start()` removed
**Decided (Dev, 2026-10-04).** `yield* start(call)` (v2: run an event call without waiting and without absorbing its colors) is removed, with its op, its tests and its doc mention. It existed for one typing corner — an `$effect` cannot wait, so an effect could not otherwise trigger an async event — and no twin uses it (1 runtime test, 3 type-test lines). An effect may delegate only to a sync event (already the rule); "an effect triggers an async event" is written in §7 as "model it as an event calling an event, or a `$memo`". If a twin or test turns out to need the escape, that is the finding to record here.
*Alternatives:* keep it with one spelling (`yield* start(call)`); keep it legal only inside `$effect`; allow a bare `start(call)` statement (the handoff's open question — now moot).
*Reasoning:* D-005 — an unused second way to call an event; its presence also forced the odd "yield in order to not wait" spelling. *Implementation:* Phase 1A, with item 8 (the `no-unyielded-write` rule loses its `start` special case).

### D-036 — `context()` removed
**Decided (Dev, 2026-10-04).** `context(Ctx)` ("read a context this library did not create") is removed. `yield* Ctx` on a context created with the library's `createContext` is the one way to read a context. Fact that settled it: no twin uses `context(Ctx)` and no twin creates a raw Solid context. A foreign context (a router's, an i18n library's) is reached by adopting the component that provides it (`adopt()`) or by wrapping the value once in a library context; if a twin or the router integration turns out to need the bridge, that is the finding to record here. Closes the handoff's deferred "do `context()` and `createContext()` stay separate" question.
*Alternatives:* keep it as the sanctioned interop bridge (and add a test that uses it); make `yield* Ctx` accept any Solid context.
*Reasoning:* D-005 and D-006 — an unused second name that is also an escape hatch. *Implementation:* Phase 1A, with item 8's surface cleanup; doc §1 setup-operations bullet.

### D-037 — D-008 amended: gate contents
**Decided (Dev, 2026-10-04).** (a) The "Chromium/Playwright steps run only before pushes" clause is dropped: no twin or blocks package has a browser test, so the clause was vestigial (three pushes were made under it without one). It returns when a browser test exists. (b) `oxlint` becomes a root devDependency so `repo:oxlint` runs for real instead of being SKIP forever (`.oxlintrc.json` existed since `dfe692cf` with no binary anywhere in the lockfile); the baseline is regenerated and any reds it adds are recorded, not hidden.
*Alternatives:* delete `.oxlintrc.json` and the step (eslint-plugin-blocks as the only lint); keep both clauses as written.
*Reasoning:* a gate step that can never run and a rule that is never exercised both make "green" mean less than it says. *Implementation:* `bl/bootstrap`, gate agent; baseline regenerated at the same commit.

### D-038 — Flow controls accept holes as well as sources
**Decided (Dev, 2026-10-04).** `<Show when>`, `<Match when>`, `<For each>` and the other flow controls accept a `Source` **or** a zero-arity `function*` (a hole, the same form as a JSX attribute hole): `<Show when={function* () { return (yield* todos).length > 0; }}>`. Derived conditions stay local to the view; one hole form everywhere (D-013). The D-013 rule still applies: a derivation used in more than one place is a `yield* $memo`.
*Alternatives:* sources only, every derived condition a named `$memo` in setup (verbose; the todos `when={todos().length > 0}` would need a memo per condition).
*Reasoning:* D-032 removed the view body, which is where derived conditions used to be computed; without this the migration would move every one of them into setup. *Implementation:* Phase 1A item 4b (types: the `when`/`each` prop types admit a hole; type + runtime test; `h` flavor too).

### D-039 — Conformance harness ported in Phase 4
**Decided (Dev, 2026-10-04).** The experiment branch's conformance harness (`packages/web/test/conformance` on `experiment/iterable-signals`: `conformance.spec.ts`, golden client/hydrate/server traces, 8 server-reference vs blocks-compiled HTML scenario pairs, `COVERAGE.md`) is ported as a semantics pin for the library route in Phase 4, after extraction; until then the 12 twins are the oracle. Note for the port: the `blocks-context` scenario is moot after D-036 and `blocks-effect` must be re-read against D-032.
*Alternatives:* port now as 1A's last item (pin before more runtime surgery); never (twins suffice).
*Reasoning:* the harness pins semantics independently of the twins, which is valuable, but it is most valuable once the runtime stops moving and the repo is standalone.

### D-040 — `Async<T, E>` on a prop is permission only
**Decided (Dev, 2026-10-04).** Declaring `todo: Async<Todo, FetchError>` says "I can be given unsettled data"; it creates no obligation to handle it. A pending read or a failure from that prop propagates to the nearest `<Loading>`/`<Errored>` wherever it is — possibly in the parent — exactly as a pending read propagates in Solid. A bare prop means "give me settled data; I am never the one that is pending". The declaration is a type permission, not a UI duty.
*Alternatives:* duty — a component with an `Async` prop must contain the boundary for it (dev error when its pending escapes); permission plus a one-time dev hint when it escapes a component with no boundary.
*Reasoning:* boundaries are placed by whoever owns the layout, not by whoever declares a type; a duty would force a boundary per component and fight Solid's propagation model. Doc: 1B's §6 ("Declared colors") states this in one sentence.

### D-041 — JSX only in view / hole / row returns
**Decided (Dev, 2026-10-04).** JSX appears only as the return of a view, of a hole, or of a row's view. A setup never creates elements: `const header = <h1>{yield* title}</h1>` in a setup is an error. Elements are not values in a block. Enforcement: lint `jsx-only-in-view` (error, in `recommended`); the transform's `perform` asserts the host in dev — a hole performed while a setup is the host is `[JSX_IN_SETUP] <Component>: JSX in a setup`; Phase 2's plugin inherits the rule unchanged. Closes the design-review item "the JSX rule applies syntactically anywhere in a generator".
*Alternatives:* JSX as a settled value anywhere (a slot element passed as a prop); JSX in a setup only through a creator (`$memo` returning a view, `$dynamic`).
*Reasoning:* D-032 made a view nothing but structure and holes; letting a setup build elements would reintroduce a second place where reads become holes, with a different host and different pending scope. *Implementation:* Phase 1A, with item 4b's lint work (new rule + tests; twin sites counted on first run and recorded here).

### D-042 — All props are reactive; a setup never reads; `$snapshot` removed
**Decided (Dev, 2026-10-04).** Every prop is a `Source`; there is no static/plain prop kind. A setup never reads — the "take a value with `$snapshot`" exception in §3 row 7 is gone and `$snapshot` is deleted. "Take the value once and ignore updates" is written where Solid writes it: inside a reactive scope, untracked — `yield* $untrack(source)`, a read op admitted in holes, memos, effects and events (`HoleOp`/`MemoOp`/`EffectOp`/`EventOp`), never in a setup. Facts that settled it: the 16 twin files using `$snapshot` all snapshot *props* that are components, slots, callbacks or config (`props.AppShell`, `props.editor`, `props.toggle`, `props.onSearch`, `props.copy`, `props.log`) — i.e. `$snapshot` existed only because a setup could not otherwise hold a prop it needed, and it silently froze a value the parent believed was live. Migration: a component prop is read in a `$dynamic` body or a hole; a callback is read inside the event that calls it (`(yield* props.onSearch)(q)`); config and objects are read in holes/events. The migration count per twin is recorded here on the lint's first run.
*Alternatives:* a declared `Once<T>`/`Static<T>` prop kind (a plain value, usable in setup, call-site type error for a changing source) — rejected: a second kind of prop; keep `$snapshot` as is; forbid `$snapshot` only on props.
*Reasoning:* Dev: reading in setup should not be allowed; if the use case is "take once", do it in a reactive scope under `untrack`; and all props are reactive — one model, no plain-value escape. *Implementation:* Phase 1A (new item 4c after 4b: remove `$snapshot`, add `$untrack` with type/runtime/lint tests, migrate the 16 files, doc §1/§3). If no twin needs `$untrack` after migration, record that count here; it is then a D-005 candidate.

### D-043 — After plugin parity, the fork's compiler goes back to pristine upstream
**Decided (Dev, 2026-10-04).** Once Phase 2's standalone plugin passes fixture parity against the Rust rule, the blocks footprint is removed from the fork's `@solidjs/compiler` and `@solidjs/babel-plugin`: `blocks_rule.rs` (364 lines), `blocks_summary.rs` (1,230 lines; its `summarizeBlocks` export was never released — only announced in the pending `compiler-blocks-rule` changeset), `tests/blocks-rule-fixtures.json`'s compiler side, `__tests__/blocks-*.test.js`, the `blocks_module` option and the `index.js`/`types.d.ts`/`compiler.rs`/`config.rs`/`lib.rs`/`node_adapter.rs` hunks, the babel copy `src/shared/blocks-rule.ts` with its `preprocess.ts`/`config.ts`/`types.ts` hunks and `test/blocks-rule.spec.js`, and the `compiler-blocks-rule.md` changeset. The plugin's checked-in expected outputs (generated once from the Rust rule) become the oracle. D-001/D-003 taken to their end: nothing of blocks remains in Solid's packages.
Facts for the executor: the diff of `packages/compiler` + `packages/babel-plugin` between `blocks-lib` and its upstream merge-base `644eaf3b` (`origin/next`) is 23 files / +2,047; the hunks in `directives/`, `refresh/`, `tsrx/` and `dom/` must be classified first — they may be unrelated fork work and are not removed by this decision. The crate requires `rust-version = "1.95"`; this machine's default toolchain is 1.88 with stable 1.99 installed — run cargo with `RUSTUP_TOOLCHAIN=stable`. Validation: `cargo clippy -- -D warnings`, `cargo test`, the compiler's 5,990-test vitest suite (the one pre-existing `blocks-summary` red disappears with the file), rebuild `compiler.node`, full gate.
*Alternatives:* keep the Rust rule as the oracle, disabled by default; keep both as supported routes (twins gated under both).
*Reasoning:* a reference implementation nobody ships drifts; checked-in outputs don't. *Implementation:* Phase 2's last commit (sequenced after the plugin's parity commit); `summarizeBlocks` alone goes earlier, in 1B.

### D-044 — `$dynamic` returns a colored component
**Decided (Dev, 2026-10-04).** `$dynamic(body)` no longer returns a plain `SolidComponent`. Its body's colors are already known (`Y extends MemoOp` may read pending sources; `SyncReturn<R>` routes failures through `attempt`); the returned component now carries them, and rendering it in a view (`<Reply/>`, or `h(Reply)`) contributes `PendingOf<Y> | FailsOf<Y>` to the enclosing view's hole ops — the same mechanism holes use, so a view rendering a pending `$dynamic` is pending in its type. Runtime is unchanged (Solid's `dynamic()`; pending reaches the nearest boundary per D-040). Facts that settled it: 9 twin files use `$dynamic`, none has a boundary of its own, and the type said settled.
*Alternatives:* document as a §7 limitation; require a settled body (kills the server-component-call use that motivated `$dynamic`).
*Reasoning:* typed failures are "complete for library-mediated failures" (D-019); a library creator that drops known colors on the floor is a hole in that claim. *Implementation:* Phase 1A item 4d (element/`h` types admit a colored component; type test "a view rendering a pending `$dynamic` is pending"; runtime test unchanged behaviour). Note for `adopt()`: the same question applies to `adopt(lazy(X))` (7 twin uses) — a lazy chunk is pending while it loads; see the next decision on it.

### D-045 — Parity is the only Solid-drift canary
**Decided (Dev, 2026-10-04).** The twins' parity tests (one script against the original and the twin, DOM snapshot after each step, hydration keys normalized) remain the canary for Solid RC drift, as D-016 says. No golden snapshots of the originals are checked in, and the standalone repo keeps the caret peer range. If a Solid change alters the original and the twin identically, parity passes and that is the intended outcome: the library followed Solid.
*Alternatives:* golden snapshots of the originals per Solid version (a separate "Solid drift" gate step); pin an exact RC and bump deliberately.
*Reasoning:* the library's claim is parity with Solid, not stability against it. *Implementation:* none; Phase 3 vendors the originals runnable so the harness keeps its oracle.

### D-046 — `html`` ` flavor dropped
**Decided (Dev, 2026-10-04).** `@solidjs/blocks/html` (Solid's tagged templates with typed holes) is removed; `h()` is the no-JSX flavor. Facts that settled it: both `-h` twins use `h()` only; no twin, fixture or doc example exercises `html`` ` beyond the package's own unit tests (5 cases in `nojsx.spec.ts`, 3 in `nojsx.type-tests.ts`), and `html.ts`'s docstring still showed the `$(function* …)` form D-013 removed. Removal list: `src/html.ts`, the two `html` entries in `scripts/build.mjs`, the `./html` export and the `@solidjs/html` dependency in `package.json`, the 8 test cases, doc §1/§2 mentions (lines 11, 26, 33, 44–46 at `46124409`).
*Alternatives:* keep it and add an `html` twin; keep it on unit tests only.
*Reasoning:* D-005/D-012 — a second no-JSX surface with no twin cannot be kept in parity with the first. *Implementation:* Phase 1A item 4e.

### D-047 — `@solidjs/blocks` exports `lazy`; `adopt()` removed
**Decided (Dev, 2026-10-04).** The library exports its own `lazy`, wrapping `solid-js`'s with the same signature (`preload` / `moduleUrl` kept, so the Vite plugin's module-URL pass still works); the result is a block component colored **pending while its chunk loads**, unioned with the inner block component's own declared colors, and usable in call form (`{yield* Home()}`) as before. `adopt()` — "a component this library did not create, usable in call form" — is deleted: all 7 twin uses were `adopt(lazy(…))` (`rendering-blocks`), the general case had none, and its return type dropped the chunk-loading pending (the D-044 gap one level up). Foreign non-lazy components have no bridge; if a twin needs one, that is the finding.
*Alternatives:* blocks `lazy` plus keep `adopt` as the general bridge; keep `adopt` and overload it on Solid's lazy return type (`T & { preload; moduleUrl? }`).
*Reasoning:* Dev: if it is for lazy, build it into lazy; D-004 forbids patching Solid's, so the library wraps it; D-005 removes the now-unused bridge. *Implementation:* Phase 1A item 4d with D-044 (type test "a view rendering a loading `lazy` is pending"; the 7 sites change import only).

/`$scope` removed (32 twin + 13 test sites; new dev error `[ROW_VIEW]` for a row returning markup directly, D-030) · `b1634e33` a view has no body (`[READ_IN_VIEW]`, `no-read-in-view-body`) · `4f5f0dd1` one host state per run via `runAs` · `6200928e` `$optimistic` scalar / `$optimisticStore` object-or-body — D-014's "overload" never existed in this history; a dev error `[OPTIMISTIC_FORM]` now refuses the wrong form in both directions · `c9179cc5` path-proxy traps (`[PATH_OBJECT]`, lint `no-path-object-use`). Finding still open: removing `# DECISIONS — `@solidjs/blocks` build-out

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
| D-034 | decided | Error types carry a literal `kind`; one `Failure` constraint at every `E` entry point |
| D-035 | decided | `start()` removed |
| D-036 | decided | `context()` removed; `yield* Ctx` is the one way to read a context |
| D-037 | decided | D-008 amended: no Chromium clause; `oxlint` is a real gate step |
| D-038 | decided | Flow controls accept holes as well as sources |
| D-039 | decided | Conformance harness ported in Phase 4 |
| D-040 | decided | `Async<T, E>` on a prop is permission only |
| D-041 | decided | JSX only in view / hole / row returns; a setup never creates elements |
| D-042 | decided | All props are reactive; no static prop kind; `$snapshot` removed; `$untrack` in reactive scopes only |
| D-043 | decided | After plugin parity, the fork's compiler and babel-plugin go back to pristine upstream |
| D-044 | decided | `$dynamic` returns a colored component |
| D-045 | decided | Parity is the only Solid-drift canary; no golden snapshots |
| D-046 | decided | `html`` ` flavor dropped; `h()` is the no-JSX flavor (D-012 amended) |
| D-047 | decided | `@solidjs/blocks` exports `lazy` (colored); `adopt()` removed |
| D-048 | open | `$event` paused on a pending read: independent runs / latest-wins / timeout |
| D-049 | decided | `h` flavor: the no-body rule is type-level only (`[HVIEW_READ]`) |
| D-050 | decided | D-013 amended: in JSX the hole is `yield*` only |
| D-051 | decided | D-032 amended: JSX enforcement is runtime + lint; type-level form for `h` only |

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
**Decided.** Every commit on a topic branch passes `scripts/blocks-gate.mjs`: for each of the 12 twins `test`, `typecheck`, `lint` (and `link:check` until Phase 1B removes it); `@solidjs/blocks` unit + type tests; `@solidjs/eslint-plugin-blocks` and `@solidjs/blocks-linker` tests; prettier check. ~~Chromium/Playwright steps run only before pushes.~~ (Dropped by D-037: no browser test exists.) "Green" = no step red that was green in the reference baseline run (see `blocks-gate-baseline.md`); pre-existing reds are listed there by name. *Reference run (reconstructed baseline, 2026-10-04, `09fa9de5`):* 52 pass / 2 fail / 1 skip over 55 steps; the reds are `pkg:blocks-linker:test` (3 staleness tests, fixture drift) and `pkg:compiler:test` (1 `blocks-summary` test not updated for `handler_fails` in `dfe692cf`), both pre-existing at the baseline and moot under D-023; `repo:oxlint` is SKIP (binary not installed). The babel-plugin and compiler steps run vitest only, against the already-built artifacts (the gate never builds). The timezone pin is D-027.
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
*Reasoning:* the no-JSX flavor is the proof that the model does not depend on the transform (D-003): whatever JSX can express via the rule, `h` expresses without it. *Amended by D-046:* the flavor is `h()` only; the `html`` ` tagged template is dropped.

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
*Reasoning:* the view stays a `function*` for TypeScript's sake (a `yield*` must sit in a generator to be typed); at runtime the transform removes every view yield, which is consistent with D-032. *Implementation note (2026-10-04):* no compiler disable option is needed after all. The twins get the fork's rule because the published `@solidjs/vite-plugin@3.0.0-next.35` links the workspace `packages/compiler`/`packages/babel-plugin`; the standalone plugin runs `enforce: "pre"`, so by the time the compiler sees a file every `yield*` in JSX is already `perform(…)` and the Rust rule is a no-op. Sequence: plugin → fixture parity (5 fixtures, 5 refusal codes) → twins through the plugin with the compiler rule idle → D-043 removes the rule.

### D-032 — A view has no body
**Decided (Dev, 2026-10-04).** A view is `function* () { return <…/>; }`. Every read is a `yield*` directly in a JSX position (a hole); there is no `yield*` outside JSX, no `if`/early `return`, no local computation. All structure comes from flow controls (`<Show>`, `<Match>`, `<For>`, …), which take sources directly. The `h`/`html` flavor follows the same rule with explicit `function*` holes.
Consequences: (1) the whole-view read concept is deleted — `VY` is always `never`, so `ViewPending<VY, R>` collapses to `PendingOf<HOps<R>>`; a view is never pending or failing on its own, only its holes are; the runtime's whole-view detection (`viewRunning`/`jsxRead`, the machinery `a5faef57` patched) is repurposed into a dev error and otherwise removed (1A item 3 shrinks accordingly). (2) Enforcement at three levels: types (`Read` is not a `ViewOp`; type test "a view does not read"), dev runtime (`[READ_IN_VIEW] <Component>: read outside a JSX position`), lint `no-read-in-view-body` (error, in `recommended`). (3) Doc §3 row "A view reads; it does not create or write" becomes "A view does not read, create, write or branch; its holes read". (4) Twins migrate view-body reads and `if (yield* …)` branches (6 by grep) to holes and flow controls; the lint's first run gives the exact site count, which is recorded here.
*Alternatives:* keep whole-view reads and document the position-based granularity (§3 only); lint only the cliff case (a view-body read whose binding is used only in JSX); keep whole-view reads in the runtime for safety.
*Reasoning:* Dev: there should be no control flow or structure inside a view; all branching comes from flow controls, and a read is a hole. This removes the cliff (the same `yield* count` meaning a hole inside JSX and a whole-view re-render one line above) by removing the second meaning, not by warning about it. Fact that settled it: `ViewPending<VY, R> = PendingOf<VY | HOps<R>>` — holes were already tracked for pending/failures, so the whole-view read bought nothing but structure and a coarser scope. *Implementation:* new Phase 1A item 4b, after explicit holes (item 4).

### D-033 — No boundary: the failure is re-thrown
**Decided (Dev, 2026-10-04).** With no `<Errored>` on the path to the root, a failing view/memo is re-thrown by `reportError` and a failing `$event` rejects its promise (already the runtime's behaviour, tested for `$event`). The library installs no implicit root boundary and does not require one. D-019 is reworded accordingly.
*Alternatives:* `render()`/`hydrate()` install a default root `<Errored>` (feasible in one place, `rootOf(code)`); require a root boundary via a dev error and a lint.
*Reasoning:* crashing loudly with no boundary is the honest default for a strict dialect; a silent root fallback hides the failure. *Implementation:* doc §7 wording with 1A item 7; add the "no boundary → re-throw" runtime test for a view failure next to the existing `$event` one.

### D-034 — Error types carry a literal `kind`
**Decided (Dev, 2026-10-04).** `attempt`/`until`/`raise`/`<Errored catch>` remove a handled class from a failure union *structurally* (TS compares shapes) but match at runtime with `instanceof` (nominal). Two classes without a discriminant are one type to TS, so `catch={[A]}` would also erase `B` from the type while the runtime rethrows `B`. The types now enforce the convention every twin already follows: an error type accepted anywhere as `E` must satisfy one shared constraint `Failure = Error & { readonly kind: <string literal> }` (a plain `string` `kind`, or none, fails with a branded-never message: "error class X needs `readonly kind = \"x\" as const` so its failure can be told apart"). Entry points: `attempt<T, E>`, `until<T, E>`, `raise<E>` (unconstrained before this), `Errored`'s `catch`, and `Async<T, E>` in Phase 1B; everything else inherits.
*Alternatives:* require any own literal member without fixing the name (looser, worse message); document as a §7 limitation and rely on convention.
*Reasoning:* a typed-failure system whose type-level removal and runtime matching can disagree is unsound in exactly the case it exists for; the constraint costs one line per error class, which every twin already pays. *Implementation:* Phase 1A, with item 7; type test for the two-identical-classes case.

### D-035 — `start()` removed
**Decided (Dev, 2026-10-04).** `yield* start(call)` (v2: run an event call without waiting and without absorbing its colors) is removed, with its op, its tests and its doc mention. It existed for one typing corner — an `$effect` cannot wait, so an effect could not otherwise trigger an async event — and no twin uses it (1 runtime test, 3 type-test lines). An effect may delegate only to a sync event (already the rule); "an effect triggers an async event" is written in §7 as "model it as an event calling an event, or a `$memo`". If a twin or test turns out to need the escape, that is the finding to record here.
*Alternatives:* keep it with one spelling (`yield* start(call)`); keep it legal only inside `$effect`; allow a bare `start(call)` statement (the handoff's open question — now moot).
*Reasoning:* D-005 — an unused second way to call an event; its presence also forced the odd "yield in order to not wait" spelling. *Implementation:* Phase 1A, with item 8 (the `no-unyielded-write` rule loses its `start` special case).

### D-036 — `context()` removed
**Decided (Dev, 2026-10-04).** `context(Ctx)` ("read a context this library did not create") is removed. `yield* Ctx` on a context created with the library's `createContext` is the one way to read a context. Fact that settled it: no twin uses `context(Ctx)` and no twin creates a raw Solid context. A foreign context (a router's, an i18n library's) is reached by adopting the component that provides it (`adopt()`) or by wrapping the value once in a library context; if a twin or the router integration turns out to need the bridge, that is the finding to record here. Closes the handoff's deferred "do `context()` and `createContext()` stay separate" question.
*Alternatives:* keep it as the sanctioned interop bridge (and add a test that uses it); make `yield* Ctx` accept any Solid context.
*Reasoning:* D-005 and D-006 — an unused second name that is also an escape hatch. *Implementation:* Phase 1A, with item 8's surface cleanup; doc §1 setup-operations bullet.

### D-037 — D-008 amended: gate contents
**Decided (Dev, 2026-10-04).** (a) The "Chromium/Playwright steps run only before pushes" clause is dropped: no twin or blocks package has a browser test, so the clause was vestigial (three pushes were made under it without one). It returns when a browser test exists. (b) `oxlint` becomes a root devDependency so `repo:oxlint` runs for real instead of being SKIP forever (`.oxlintrc.json` existed since `dfe692cf` with no binary anywhere in the lockfile); the baseline is regenerated and any reds it adds are recorded, not hidden.
*Alternatives:* delete `.oxlintrc.json` and the step (eslint-plugin-blocks as the only lint); keep both clauses as written.
*Reasoning:* a gate step that can never run and a rule that is never exercised both make "green" mean less than it says. *Implementation:* `bl/bootstrap`, gate agent; baseline regenerated at the same commit.

### D-038 — Flow controls accept holes as well as sources
**Decided (Dev, 2026-10-04).** `<Show when>`, `<Match when>`, `<For each>` and the other flow controls accept a `Source` **or** a zero-arity `function*` (a hole, the same form as a JSX attribute hole): `<Show when={function* () { return (yield* todos).length > 0; }}>`. Derived conditions stay local to the view; one hole form everywhere (D-013). The D-013 rule still applies: a derivation used in more than one place is a `yield* $memo`.
*Alternatives:* sources only, every derived condition a named `$memo` in setup (verbose; the todos `when={todos().length > 0}` would need a memo per condition).
*Reasoning:* D-032 removed the view body, which is where derived conditions used to be computed; without this the migration would move every one of them into setup. *Implementation:* Phase 1A item 4b (types: the `when`/`each` prop types admit a hole; type + runtime test; `h` flavor too).

### D-039 — Conformance harness ported in Phase 4
**Decided (Dev, 2026-10-04).** The experiment branch's conformance harness (`packages/web/test/conformance` on `experiment/iterable-signals`: `conformance.spec.ts`, golden client/hydrate/server traces, 8 server-reference vs blocks-compiled HTML scenario pairs, `COVERAGE.md`) is ported as a semantics pin for the library route in Phase 4, after extraction; until then the 12 twins are the oracle. Note for the port: the `blocks-context` scenario is moot after D-036 and `blocks-effect` must be re-read against D-032.
*Alternatives:* port now as 1A's last item (pin before more runtime surgery); never (twins suffice).
*Reasoning:* the harness pins semantics independently of the twins, which is valuable, but it is most valuable once the runtime stops moving and the repo is standalone.

### D-040 — `Async<T, E>` on a prop is permission only
**Decided (Dev, 2026-10-04).** Declaring `todo: Async<Todo, FetchError>` says "I can be given unsettled data"; it creates no obligation to handle it. A pending read or a failure from that prop propagates to the nearest `<Loading>`/`<Errored>` wherever it is — possibly in the parent — exactly as a pending read propagates in Solid. A bare prop means "give me settled data; I am never the one that is pending". The declaration is a type permission, not a UI duty.
*Alternatives:* duty — a component with an `Async` prop must contain the boundary for it (dev error when its pending escapes); permission plus a one-time dev hint when it escapes a component with no boundary.
*Reasoning:* boundaries are placed by whoever owns the layout, not by whoever declares a type; a duty would force a boundary per component and fight Solid's propagation model. Doc: 1B's §6 ("Declared colors") states this in one sentence.

### D-041 — JSX only in view / hole / row returns
**Decided (Dev, 2026-10-04).** JSX appears only as the return of a view, of a hole, or of a row's view. A setup never creates elements: `const header = <h1>{yield* title}</h1>` in a setup is an error. Elements are not values in a block. Enforcement: lint `jsx-only-in-view` (error, in `recommended`); the transform's `perform` asserts the host in dev — a hole performed while a setup is the host is `[JSX_IN_SETUP] <Component>: JSX in a setup`; Phase 2's plugin inherits the rule unchanged. Closes the design-review item "the JSX rule applies syntactically anywhere in a generator".
*Alternatives:* JSX as a settled value anywhere (a slot element passed as a prop); JSX in a setup only through a creator (`$memo` returning a view, `$dynamic`).
*Reasoning:* D-032 made a view nothing but structure and holes; letting a setup build elements would reintroduce a second place where reads become holes, with a different host and different pending scope. *Implementation:* Phase 1A, with item 4b's lint work (new rule + tests; twin sites counted on first run and recorded here).

### D-042 — All props are reactive; a setup never reads; `$snapshot` removed
**Decided (Dev, 2026-10-04).** Every prop is a `Source`; there is no static/plain prop kind. A setup never reads — the "take a value with `$snapshot`" exception in §3 row 7 is gone and `$snapshot` is deleted. "Take the value once and ignore updates" is written where Solid writes it: inside a reactive scope, untracked — `yield* $untrack(source)`, a read op admitted in holes, memos, effects and events (`HoleOp`/`MemoOp`/`EffectOp`/`EventOp`), never in a setup. Facts that settled it: the 16 twin files using `$snapshot` all snapshot *props* that are components, slots, callbacks or config (`props.AppShell`, `props.editor`, `props.toggle`, `props.onSearch`, `props.copy`, `props.log`) — i.e. `$snapshot` existed only because a setup could not otherwise hold a prop it needed, and it silently froze a value the parent believed was live. Migration: a component prop is read in a `$dynamic` body or a hole; a callback is read inside the event that calls it (`(yield* props.onSearch)(q)`); config and objects are read in holes/events. The migration count per twin is recorded here on the lint's first run.
*Alternatives:* a declared `Once<T>`/`Static<T>` prop kind (a plain value, usable in setup, call-site type error for a changing source) — rejected: a second kind of prop; keep `$snapshot` as is; forbid `$snapshot` only on props.
*Reasoning:* Dev: reading in setup should not be allowed; if the use case is "take once", do it in a reactive scope under `untrack`; and all props are reactive — one model, no plain-value escape. *Implementation:* Phase 1A (new item 4c after 4b: remove `$snapshot`, add `$untrack` with type/runtime/lint tests, migrate the 16 files, doc §1/§3). If no twin needs `$untrack` after migration, record that count here; it is then a D-005 candidate.

### D-043 — After plugin parity, the fork's compiler goes back to pristine upstream
**Decided (Dev, 2026-10-04).** Once Phase 2's standalone plugin passes fixture parity against the Rust rule, the blocks footprint is removed from the fork's `@solidjs/compiler` and `@solidjs/babel-plugin`: `blocks_rule.rs` (364 lines), `blocks_summary.rs` (1,230 lines; its `summarizeBlocks` export was never released — only announced in the pending `compiler-blocks-rule` changeset), `tests/blocks-rule-fixtures.json`'s compiler side, `__tests__/blocks-*.test.js`, the `blocks_module` option and the `index.js`/`types.d.ts`/`compiler.rs`/`config.rs`/`lib.rs`/`node_adapter.rs` hunks, the babel copy `src/shared/blocks-rule.ts` with its `preprocess.ts`/`config.ts`/`types.ts` hunks and `test/blocks-rule.spec.js`, and the `compiler-blocks-rule.md` changeset. The plugin's checked-in expected outputs (generated once from the Rust rule) become the oracle. D-001/D-003 taken to their end: nothing of blocks remains in Solid's packages.
Facts for the executor: the diff of `packages/compiler` + `packages/babel-plugin` between `blocks-lib` and its upstream merge-base `644eaf3b` (`origin/next`) is 23 files / +2,047; the hunks in `directives/`, `refresh/`, `tsrx/` and `dom/` must be classified first — they may be unrelated fork work and are not removed by this decision. The crate requires `rust-version = "1.95"`; this machine's default toolchain is 1.88 with stable 1.99 installed — run cargo with `RUSTUP_TOOLCHAIN=stable`. Validation: `cargo clippy -- -D warnings`, `cargo test`, the compiler's 5,990-test vitest suite (the one pre-existing `blocks-summary` red disappears with the file), rebuild `compiler.node`, full gate.
*Alternatives:* keep the Rust rule as the oracle, disabled by default; keep both as supported routes (twins gated under both).
*Reasoning:* a reference implementation nobody ships drifts; checked-in outputs don't. *Implementation:* Phase 2's last commit (sequenced after the plugin's parity commit); `summarizeBlocks` alone goes earlier, in 1B.

### D-044 — `$dynamic` returns a colored component
**Decided (Dev, 2026-10-04).** `$dynamic(body)` no longer returns a plain `SolidComponent`. Its body's colors are already known (`Y extends MemoOp` may read pending sources; `SyncReturn<R>` routes failures through `attempt`); the returned component now carries them, and rendering it in a view (`<Reply/>`, or `h(Reply)`) contributes `PendingOf<Y> | FailsOf<Y>` to the enclosing view's hole ops — the same mechanism holes use, so a view rendering a pending `$dynamic` is pending in its type. Runtime is unchanged (Solid's `dynamic()`; pending reaches the nearest boundary per D-040). Facts that settled it: 9 twin files use `$dynamic`, none has a boundary of its own, and the type said settled.
*Alternatives:* document as a §7 limitation; require a settled body (kills the server-component-call use that motivated `$dynamic`).
*Reasoning:* typed failures are "complete for library-mediated failures" (D-019); a library creator that drops known colors on the floor is a hole in that claim. *Implementation:* Phase 1A item 4d (element/`h` types admit a colored component; type test "a view rendering a pending `$dynamic` is pending"; runtime test unchanged behaviour). Note for `adopt()`: the same question applies to `adopt(lazy(X))` (7 twin uses) — a lazy chunk is pending while it loads; see the next decision on it.

### D-045 — Parity is the only Solid-drift canary
**Decided (Dev, 2026-10-04).** The twins' parity tests (one script against the original and the twin, DOM snapshot after each step, hydration keys normalized) remain the canary for Solid RC drift, as D-016 says. No golden snapshots of the originals are checked in, and the standalone repo keeps the caret peer range. If a Solid change alters the original and the twin identically, parity passes and that is the intended outcome: the library followed Solid.
*Alternatives:* golden snapshots of the originals per Solid version (a separate "Solid drift" gate step); pin an exact RC and bump deliberately.
*Reasoning:* the library's claim is parity with Solid, not stability against it. *Implementation:* none; Phase 3 vendors the originals runnable so the harness keeps its oracle.

### D-046 — `html`` ` flavor dropped
**Decided (Dev, 2026-10-04).** `@solidjs/blocks/html` (Solid's tagged templates with typed holes) is removed; `h()` is the no-JSX flavor. Facts that settled it: both `-h` twins use `h()` only; no twin, fixture or doc example exercises `html`` ` beyond the package's own unit tests (5 cases in `nojsx.spec.ts`, 3 in `nojsx.type-tests.ts`), and `html.ts`'s docstring still showed the `$(function* …)` form D-013 removed. Removal list: `src/html.ts`, the two `html` entries in `scripts/build.mjs`, the `./html` export and the `@solidjs/html` dependency in `package.json`, the 8 test cases, doc §1/§2 mentions (lines 11, 26, 33, 44–46 at `46124409`).
*Alternatives:* keep it and add an `html` twin; keep it on unit tests only.
*Reasoning:* D-005/D-012 — a second no-JSX surface with no twin cannot be kept in parity with the first. *Implementation:* Phase 1A item 4e.

### D-047 — `@solidjs/blocks` exports `lazy`; `adopt()` removed
**Decided (Dev, 2026-10-04).** The library exports its own `lazy`, wrapping `solid-js`'s with the same signature (`preload` / `moduleUrl` kept, so the Vite plugin's module-URL pass still works); the result is a block component colored **pending while its chunk loads**, unioned with the inner block component's own declared colors, and usable in call form (`{yield* Home()}`) as before. `adopt()` — "a component this library did not create, usable in call form" — is deleted: all 7 twin uses were `adopt(lazy(…))` (`rendering-blocks`), the general case had none, and its return type dropped the chunk-loading pending (the D-044 gap one level up). Foreign non-lazy components have no bridge; if a twin needs one, that is the finding.
*Alternatives:* blocks `lazy` plus keep `adopt` as the general bridge; keep `adopt` and overload it on Solid's lazy return type (`T & { preload; moduleUrl? }`).
*Reasoning:* Dev: if it is for lazy, build it into lazy; D-004 forbids patching Solid's, so the library wraps it; D-005 removes the now-unused bridge. *Implementation:* Phase 1A item 4d with D-044 (type test "a view rendering a loading `lazy` is pending"; the 7 sites change import only).

 left no way to create a constant source outside a setup (room's `NOBODY` context default, rendering's detached-router default); the agent made context defaults `undefined` with a `$memo` fallback in the consumer's setup — see the next decision once taken.

## Open questions

- **Q22** — repo layout for extraction (D-015).
- **Q23** — start Phase 2 in parallel with Phase 1B (recommended: yes; cheap now that worktrees are not disk-bound).
- D-032 migration: the exact count of view-body read / branch sites per twin, from the lint's first run.
- ~~Whether `context()` and `createContext()` stay separate long-term.~~ Decided: `context()` removed (D-036).
- ~~Whether `no-unyielded-write` gets a sync exception for `start(call)` (D-021).~~ Moot: `start` removed (D-035).

## Design-review items not yet turned into decisions

Async `$memo` is emulated over `createMemo` + `latest`/`isPending` → needs a deterministic pending-flip ordering test. The SSR path skips whole-view detection → needs a both-sides top-level-read hydration test. The JSX rule applies syntactically anywhere in a generator → lint "JSX only in views" or assert the host in `perform`. Refusals should be listed in one "what you can't write in a view" table. Port the experiment branch's `$`-block conformance harness (`packages/web/test`) as a semantics pin independent of the twins. Error-locality helpers (`view()`/`setup()` wrappers) are the biggest DX lever without a TS plugin.

## Branch log

| Date | Branch | Event |
| --- | --- | --- |
| 2026-10-04 | `blocks-lib` @ `b03535f6` (container) | Lost unpushed with the container (disk full). Contents: this file, the gate script and baseline, the v2 changeset, HANDOFF.md. |
| 2026-10-04 | `bl/bootstrap` off `dfe692cf` | Reconstruction of the lost commits from the handoff: `09fa9de5` changeset, `08d7a7d3` gate + baseline, `f26f5ca2` gitlink removal (D-022), then this file (`da03be74`); D-030…D-033 added after the design review. ff'd into `blocks-lib` and pushed to `fork` at `da03be74`; the review commit follows. |
| 2026-10-04 | `bl/tighten`, `bl/colors` (container) | Provisioned, no commits landed; recreated on demand. |
