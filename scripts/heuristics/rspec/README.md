# Runtime speculation (R1-R3)

Can the runtime close the compiler oracles' per-node gaps by itself, guessing a
fact and deoptimizing when it's wrong? The patches live in `runtime.patch`
(apply to a worktree of this branch) behind the `__RSPEC__` bitmask:

| Bit | Name | What the runtime does | Compiler oracle it replaces |
| --- | --- | --- | --- |
| 1 | R1 | every computation starts on the status-free path; a throw or an async-shaped result deopts it for good (async result handed to `handleAsync`) | H5 `statusFree` |
| 2 | R2 | `mapArray` tags results whose rows are all element/text nodes; `insert` skips flatten/normalize and reconciles directly | L1 single-element rows |
| 4 | R3 | `insert` writes text-to-text updates as one `.data` store, skipping normalize/insertExpression | H7 typed text |

R4 (lazy id formatting) was not built: the owner `id` field is read by hydration, `createUniqueId` and devtools, so making it lazy is an API change rather than an experiment. H8a (−6% to −8% on id-carrying trees) is its ceiling.

```sh
git worktree add ../rspec HEAD && (cd ../rspec && git apply <repo>/scripts/heuristics/rspec/runtime.patch && pnpm install)
node scripts/heuristics/rspec/build.mjs --worktree ../rspec     # node_modules/.cache/heuristics/rspec
node scripts/heuristics/rspec/icount.mjs --out documentation/plans/heuristic-oracles/rspec/icount.json
node scripts/heuristics/dom/bench.mjs --suite rspec-rows --out documentation/plans/heuristic-oracles/rspec/dom-rows.json
node scripts/heuristics/dom/bench.mjs --suite rspec-list --out documentation/plans/heuristic-oracles/rspec/dom-list.json
# safety: full suites with the speculation on (worktree)
(cd ../rspec/packages/signals && SIGNALS_RSPEC=1 npx vitest run)
```
