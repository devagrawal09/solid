# Runtime speculation (R1-R5)

Can the runtime close the compiler oracles' per-node gaps by itself, guessing a
fact and deoptimizing when it's wrong? The patches live in `runtime.patch`
(apply to a worktree of this branch) behind the `__RSPEC__` bitmask. Each bit
is replaced by its own boolean at build time (`"__RSPEC__ & N"`), because
rollup does not fold `0 & 1`: an unfolded arm left dead code (and unused
imports) in the r0 control.

| Bit | Name | What the runtime does | Compiler oracle it replaces |
| --- | --- | --- | --- |
| 1 | R1 | every computation starts on the status-free path; a throw or an async-shaped result deopts it for good (async result handed to `handleAsync`) | H5 `statusFree` |
| 16 | R1b | a **memo** is promoted to the status-free path at the entry of its second run when it has no extension (`_x`) and no status: it never went async or threw. Never at creation. A throw or async result there deopts it for good, without the NOTHROW diagnostic. (The first cut promoted at the end of the first run and cost +1–2% at mount; `icount-r1b-*.json` vs `icount-r1b-entry-*.json`.) | H5 `statusFree` |
| 2 | R2 | `mapArray` tags results whose rows are all element/text nodes (probe untracked; tag non-enumerable); `insert` skips flatten/normalize and reconciles directly | L1 single-element rows |
| 4 | R3 | `insert` writes text-to-text updates as one `.data` store, skipping normalize/insertExpression | H7 typed text |
| 8 | R5 | `action` runs its first slice in the ambient batch and creates the transaction only when the body yields | A1 sync action → batch |

R4 (lazy id formatting) was not built: the owner `id` field is read by hydration, `createUniqueId` and devtools, so making it lazy is an API change rather than an experiment. H8a (−6% to −8% on id-carrying trees) is its ceiling.

## Safety (full suites with the bit on, against the r0 control)

| Variant | `@solidjs/signals` (1,878 tests) | `@solidjs/web`, all five configs |
| --- | --- | --- |
| R1 | **528 extra failures** (async semantics: waterfalls, shared pending, `isPending`; the status-free catch emulates only the plain world, and dev reports every speculated throw as a broken proof) | – |
| R1b | 0 behavioural. Artifacts: core floor 23,019 B over a 23,000 B budget (`treeshake`), the H2 oracle arm bypassed on promoted memos, and tests that count fast-path runs (`status-free`, `track-a-equivalence`: their trace assertions pass, their "no fast runs" counts do not) | – |
| R2 (first cut) | 4: the tag was an enumerable own symbol (deep equality saw it) and the `nodeType` probe created a tracked store node per store row | – |
| R2 (fixed) | 0 (the core-floor budget as R1b) | 0 (818 client, 204 hydration, 827 server, store handles) |
| R3 | – | 0 |
| R5 | **9 extra failures**: first-slice store (`reconcile`), optimistic and `until()` state is not adopted by the late transaction | – |

The web suites run against the packages' **built** dev bundles (`dist/web.dev.js`, `@solidjs/signals` `dist/dev.js`), so the bits must be compiled into those: the worktree's web rollup config replaces `__RSPEC__` from `WEB_RSPEC`, signals from `SIGNALS_RSPEC`. A vite `define` does not reach them.

```sh
git worktree add ../rspec HEAD && (cd ../rspec && git apply <repo>/scripts/heuristics/rspec/runtime.patch && pnpm install)
cp packages/compiler/compiler.node ../rspec/packages/compiler/   # the web tests' vite plugin needs the native compiler
node scripts/heuristics/rspec/build.mjs --worktree ../rspec     # node_modules/.cache/heuristics/rspec
node scripts/heuristics/rspec/icount.mjs --jobs 2 --variants r1 --out documentation/plans/heuristic-oracles/rspec/icount-1.json    # and -2
node scripts/heuristics/rspec/icount.mjs --jobs 2 --variants r16 --out documentation/plans/heuristic-oracles/rspec/icount-r1b-1.json # and -2
node scripts/heuristics/dom/bench.mjs --suite rspec-rows --n 1000 --reps 5 --out documentation/plans/heuristic-oracles/rspec/dom-rows-1.json # and -2
node scripts/heuristics/dom/bench.mjs --suite rspec-list --n 1000 --reps 5 --out documentation/plans/heuristic-oracles/rspec/dom-list-1.json # and -2
# safety: signals suite per bit (worktree)
(cd ../rspec/packages/signals && SIGNALS_RSPEC=16 npx vitest run)
# safety: web suites — rebuild signals, solid and web with the bits, then run every config
(cd ../rspec/packages/signals && SIGNALS_RSPEC=2 pnpm run build) && (cd ../rspec/packages/solid && pnpm run build) \
  && (cd ../rspec/packages/web && WEB_RSPEC=6 pnpm run build && for c in vite.config*.mjs; do npx vitest run --config $c; done)
```
