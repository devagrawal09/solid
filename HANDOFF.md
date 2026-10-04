# HANDOFF — blocks-lib build-out (checkpoint 2026-10-04, macOS session)

Supersedes the container-era handoff. Everything below is pushed to `fork` (git@github.com:devagrawal09/solid.git). Nothing is unpushed.

## Where things are

| Branch | Head | Contents |
| --- | --- | --- |
| `blocks-lib` = `fork/blocks-lib` | `1a53ece8` | baseline `dfe692cf` + reconstruction (changeset, gate, DECISIONS.md) + Phase 1A items 2–8 (12 code commits) + the design-review decisions D-001…D-057 |
| `bl/bootstrap` | = `blocks-lib` | docs-only branch where DECISIONS.md is edited; ff'd into `blocks-lib` per commit |
| `bl/tighten` | = `blocks-lib` | Phase 1A; its agent session is continuable (see "Work queue") |
| `bl/colors`, `bl/plugin` | provisioned (worktrees installed + built), no commits | Phase 1B and Phase 2 |

Key documents, in reading order: `documentation/plans/blocks-library.md` (the reference), `documentation/plans/DECISIONS.md` (D-001…D-057, every decision with alternatives/reasoning; a "Phase 1A findings" section with the agent's verbatim stop-reports; reconstructed after the container loss — provenance note at the top), `documentation/plans/blocks-gate-baseline.md` (reference run `53 pass / 2 fail / 0 skip`; the two reds are the linker staleness tests and one `blocks-summary` compiler test, both pre-existing and removed by 1B).

## What changed since the container handoff (one screen)

- The lost commits were rebuilt (D-007 note): changeset `blocks-typed-failures-v2.md`, `scripts/blocks-gate.mjs` (55 steps, `TZ=UTC`, real `oxlint`), DECISIONS.md.
- Design review with Dev produced D-027…D-057. The ones that reshape the library: **D-032** a view has no body (reads only in JSX positions; structure via flow controls), **D-042** all props are reactive and a setup never reads (`$snapshot` → `$untrack` in reactive scopes), **D-023/D-024/D-029/D-040/D-056** declared prop colors as plain object types with `Async<T,E>` opt-in and explicit generics for pass-through, **D-034** error types carry a literal `kind`, **D-035/D-036/D-046/D-047** `start()`, `context()`, the `html` flavor and `adopt()` removed (blocks exports its own colored `lazy`), **D-038/D-050** holes in flow-control props; JSX hole is `yield*` only, **D-043** the fork's compiler goes pristine after Phase 2's plugin passes parity, **D-048** `$event(body, { latest: true })`, **D-052** `createContext(plainDefault)`, **D-054** `view()` typing wrapper, **D-055** rows receive `item: Source<T>`, `index: Source<number>`, **D-057** Phase 2 strictly after 1B, **D-015** extraction to a new monorepo `solid-blocks`.
- Phase 1A landed: duplicate-runtime guard; rows/holes as bare `function*` (`$`/`$scope` gone); no-body views (`[READ_IN_VIEW]`, lint `no-read-in-view-body`, 0 twin sites); `runAs` host state; `$optimistic` forms (`[OPTIMISTIC_FORM]`); path-proxy traps (`[PATH_OBJECT]`, lint `no-path-object-use`); blocks `lazy`, `adopt` removed; `html` dropped; flow-control holes; `[UNTYPED_THROW]` + `Failure` kind constraint; `[UNYIELDED_WRITE]` + `[SETTER_OUTSIDE_RUN]`; `start()`/`context()` removed. Package tests drive writes through an `$event` (`test/write.ts`).

## Open rulings for Dev (asked in text, with code, in the session)

- **F1 — D-042 vs server-component props in event/`ref` positions** (notes `AppView`, chat `Markdown`): hydration claims are keyed on the prop stub's identity; a setup may not read it, the transform refuses `yield*` in event/ref positions, wrapping it in an `$event` breaks the claim. Options: (A) event/ref positions accept a `Source` attached by value; (B) keep `$snapshot` for exactly this; (C) §7 limitation.
- **F2 — D-044 colored `$dynamic` forces boundaries the originals lack** (chat `Reply` in a row; hackernews `Nav`, notes `NoteList` under the router's children callback). Options: (A) revert D-044; (B) add three `<Errored>`s; (C) types match D-033 — a failing element is accepted at any position and re-throws if uncaught; only pending needs an admitting position. 1B hits the same wall with `Async` props; decide before dispatching 1B.

## Work queue

1. **1A follow-up** (continue the `bl/tighten` agent session; brief = decided items): D-048 `latest` option; D-052 `createContext` constant default and revert the `undefined`+`$memo` workaround in room/rendering; D-054 `view()` wrapper (no `setup()`), lint `prefer-view-wrapper`; D-055 row-signature type test + in-place item change test; D-041 lint `jsx-only-in-view` + `[JSX_IN_SETUP]` (two twins build `<Router>` JSX in setup — report the sites); 4c per F1 (`$snapshot` → `$untrack`; 33 sites / 16 files surveyed in DECISIONS); 4d remainder per F2. Then full gate, ff, push.
2. **Phase 1B** on `bl/colors` (brief drafted as notebook value `colorsBrief2`; D-056: `TypedProps` removed outright; removal list enumerated: 12 `solid-props.gen.d.ts`, 12 `link:check`, 13 linker dependents, `typed-props-key`; `summarizeBlocks` removal needs `RUSTUP_TOOLCHAIN=stable`). Report Async / generic-pass-through counts per twin (validates D-023/D-029).
3. **Phase 2** on `bl/plugin` after 1B (D-057; brief = `pluginBrief`): plugin lifted from `packages/babel-plugin/src/shared/blocks-rule.ts`; 5 fixtures / 5 refusal codes as oracle; `enforce: "pre"` so the compiler rule idles (no disable option, D-031 note); then D-043 removal (classify the non-blocks compiler hunks first); also give the library's `lazy` the module-URL pass the published Vite plugin only does for `solid-js`'s `lazy` (D-047 finding).
4. **Phase 3** extraction per D-015; **Phase 4** conformance harness port (D-039), getting-started doc, `README`: "this is the strict dialect; the compiler route is the ergonomic one".

## Environment notes (this machine: macOS, /Users/devagr/solid)
- Main checkout on `blocks-lib`; worktrees under `/Users/devagr/solid-wt/<branch>` (`bl-bootstrap`, `bl-tighten`). Each needs `pnpm install --frozen-lockfile --prefer-offline`, a copy of `packages/compiler/compiler.node` from the main checkout, and `pnpm exec turbo run build --filter=@solidjs/blocks --force` before gating. Disk is not a constraint (83 GB free); Rust/cargo/gcc are installed.
- Gate: `node scripts/blocks-gate.mjs --baseline documentation/plans/blocks-gate-baseline.json` (≈60-90 s, 55 steps, every step under `TZ=UTC` per D-027); `--fast` ≈16 s while iterating. Reference run is in `blocks-gate-baseline.md`; the two reds (`pkg:blocks-linker:test`, `pkg:compiler:test`) are pre-existing and moot under D-023. `oxlint` is a real step since D-037.
- The pre-commit hook is a silent no-op here: `scripts/pre-commit.sh` pipes through `rg`, which is not installed, so its file list is empty and prettier never runs from the hook. The gate's `repo:prettier` step covers it; run `pnpm exec prettier --check` by hand before committing non-gated files.
- Subagents (Claude Code, native harness) run sandboxed: they cannot write the pnpm store (`ERR_PNPM_UNEXPECTED_STORE`), so any `pnpm add`/install is done from the orchestrating session, then the agent continues. Agents may commit when told to; worktree git identity is set to `Claude <noreply@anthropic.com>` with `git config` per worktree.
- Push target: `fork` (git@github.com:devagrawal09/solid.git) over SSH; `git push fork blocks-lib bl/<topic>` works from the main checkout.
- D-009 flow in practice: topic worktree → gated commits → `git merge --ff-only bl/<topic>` in the main checkout → push. Keep DECISIONS.md edits on `bl/bootstrap` (docs-only) so topic branches rebase cleanly; a topic branch that appends to DECISIONS.md (e.g. D-032's migration count) rebases onto `blocks-lib` before its ff.
- **Incident:** three DECISIONS.md commits (`6ee17db2`, `8ba517ba`, `b47fde80`) pasted the file into itself — `String.replace(a, b)` with a string `b` expands `$`` to the text before the match, and the entry text contained a backtick-dollar-backtick. Repaired in `83b514ac` by rebuilding from the last clean revision. Rule: patch docs with function-form replacements (`s.replace(a, () => b)`); the scripts under `/tmp/*.cjs` in this session do.
- Subagent commits made after a rebase onto a corrupted revision were replayed with `git checkout --ours` on DECISIONS.md and the agent's findings re-appended (`1a53ece8`).
- `cargo test` on `packages/compiler` builds and passes here with `RUSTUP_TOOLCHAIN=stable` (1.99); the default toolchain (1.88) is below the crate's `rust-version = 1.95` and was left as is.
