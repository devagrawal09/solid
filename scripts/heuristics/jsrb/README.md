# js-reactivity-benchmark lane (Tier 2, Node)

Validates the runtime-level results of the heuristic oracles on
[js-reactivity-benchmark](https://github.com/milomg/js-reactivity-benchmark)
(the repo's Tier-2 Node lane, `documentation/benchmarking-strategy.md`).
Only this repo's `@solidjs/signals` builds are measured, each in its own
process, three interleaved rounds:

| Adapter | Runtime | Stands for |
| --- | --- | --- |
| `solid-next-prod` | `packages/signals/dist/prod` | shipped |
| `solid-next-h5` | same, every memo created with `statusFree` | the compiler's H5 fact (every jsrb computed is synchronous and non-throwing) |
| `solid-next-r0` | `node_modules/.cache/heuristics/rspec/signals-r0` | control for the rspec builds |
| `solid-next-r1b` | `…/rspec/signals-r16` | R1b runtime speculation |

Compiler fusion (H1) and the store/async/action heuristics cannot be expressed
through jsrb's framework adapter (`signal`/`computed`/`effect`), so this lane
covers H5 and R1b only; the Tier-1 benches and the DOM lane cover the rest.

```sh
git clone https://github.com/milomg/js-reactivity-benchmark jsrb && (cd jsrb && pnpm install --ignore-scripts)
cp scripts/heuristics/jsrb/solidLocal_*.ts jsrb/packages/core/src/frameworks/
cp scripts/heuristics/jsrb/frameworksList.ts jsrb/packages/core/src/frameworksList.ts
C=node_modules/.cache/heuristics/rspec
(cd jsrb/packages/node && npx esbuild src/index.ts --bundle --format=esm --target=esnext --outfile=dist/index.js \
  --alias:sig-prod=$PWD/../../../packages/signals/dist/prod/index.js \
  --alias:sig-r0=$PWD/../../../$C/signals-r0/index.js --alias:sig-r1b=$PWD/../../../$C/signals-r16/index.js)
for round in 1 2 3; do for fw in prod h5 r0 r1b; do
  (cd jsrb/packages/node && JSRB_ONLY=solid-next-$fw node dist/index.js) > documentation/plans/heuristic-oracles/jsrb/solid-next-$fw-$round.csv
done; done
node scripts/heuristics/jsrb/report.mjs
```

jsrb's pull-count assertions (`2-10x5 - lazy80%`, `6-10x10 - dyn25% - lazy80%`)
fail identically for every build (8,400,000 vs 3,480,000 and 1,290,000 vs
1,155,000): Solid 2 re-runs memos jsrb expects to stay lazy. The value sums
pass for every build.
