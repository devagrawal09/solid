# experiment/iterable-signals vs upstream Solid v2 `next` (2.0.0-rc.9)

A measurement, not a plan: this branch against upstream `next` at
`1a7d14fc` (2.0.0-rc.9, 2026-09), on bundle bytes, the signals core floor,
runtime instruction counts and SSR / hydration. Every number here comes from
each tree's own built packages and its own native compiler. Neither tree's
`packages/*/src` was modified.

Trees measured:

| label | tree | notes |
| --- | --- | --- |
| **upstream** | `solidjs/solid` `next` @ `1a7d14fc` (2.0.0-rc.9) | `pnpm install --frozen-lockfile --prefer-offline` (offline install lacked `@solidjs/router` in the store), then `pnpm build` in signals / solid / web / h, then the Rust compiler (`packages/compiler`, the same Oxc-based native compiler as the branch's; `@solidjs/vite-plugin` 3.0.0-next.35 resolves it from the workspace) |
| **branch** | `experiment/iterable-signals` @ `6b7f87d7`…`0f1747be` (package sources did not change between the runs; the compiler binary is the one built at 00:08 from `7ac6f164`) | packages as built in the checkout |
| **fork point** | `344ed054`, `git merge-base HEAD 1a7d14fc` (2.0.0-rc.8) | reference only: `git archive` into a scratch dir, built the same way as upstream |

The branch forked from `next` at `344ed054`. Since then upstream has landed
**290 commits** (rc.8 → rc.9, including live server components, the
records/attribution channel and a number of optimistic/lane fixes), and the
branch has landed **151**. So "branch vs upstream" mixes two things: what
the branch changed, and what upstream added after the fork. The fork-point
column is there to separate them. It is a reference, not a controlled
attribution: the branch did not merge any upstream work after the fork.

## Summary

- **Bundle bytes: the branch is smaller than upstream on every shared example,
  by −2.8% (effect) to −32.3% (hackernews-spa) gz with the default build.**
  Almost all of that gap comes from upstream growing after the fork, not
  from branch savings. Against its own fork point the branch default build
  is **+1.0% to +2.9% gz larger**. The capability linker takes back
  **0.6–7.3% gz** where it can slice (sierpinski −7.3%, migrating-element
  −6.1% vs branch default), and nothing on the SSR / router apps (it
  refuses them because the virtual SSR entry has no summary). The large SSR-app gaps
  (hackernews −28.8%, hackernews-spa −32.3%, notes −24.7%) come mostly from
  upstream's client bundle carrying `@solidjs/web/server-functions/dist/server.js`:
  100 KB rendered in hackernews-spa on upstream vs 4.6 KB on the branch.
- **Core floor: 27,898 / 10,952 B (upstream) vs 24,594 / 9,784 B (branch,
  −10.7% gz)**, fork point 23,512 / 9,340 B. The branch's async-free entry
  is 15,023 / 6,327 B (−42% gz vs upstream).
- **Runtime (Ir/op, n=300): handwritten Solid on the branch runtime is within
  ±8% of upstream on 11 of 12 cells.** It is 37% cheaper on `async` (upstream
  regressed there after the fork: fork point 45.2M, branch 45.5M, upstream
  72.7M) and 6–8% cheaper on `memo`/`paths`. **Blocks v2 compiled on the
  branch vs handwritten upstream** ranges from −36% (`async`) to +52%
  (`asyncEvent`), with `create` mount at +15% and `view` update at +9%.
  **Against its own fork point, the branch's handwritten cells are 8–16% more
  expensive on 10 of 12 cells.** Upstream drifted up over the same period (it is
  above the fork point on every cell too), so the branch does not look slower
  than upstream today. But the branch is not cheaper than rc.8 was.
- **SSR / hydration (today's hydration, variant A): the branch and upstream are
  at parity.** Same HTML bytes. JS gz is 2.1 KB smaller on the branch for hn and 2.3 KB
  smaller for handwritten todos. Hydrate/script times are within noise, and the
  same hydration work counts. Branch islands (C-lazy / C-eager) are what
  change the picture: hn ships 0.7 KB gz JS instead of 24.5 KB and a 188 KB gz
  page instead of 406 KB, with script time 1.6 ms vs 75 ms at 1x. Those islands
  are a different, blocks-ported app on a branch-only architecture, not a
  runtime-for-runtime comparison.

## 1. Bundle size (client JS)

Method (mirrors `scripts/slices/measure-apps.mjs`): `vite build` of each
example with its own `vite.config.*`, `build.write: false`, against the
tree's built workspace packages and native compiler. The size is the sum of
every emitted JS chunk (vite's minify) and the sum of each chunk's gzip -9.
For the SSR examples (`start: {}`) vite's result is the client build, so these
are client bytes (server functions / frames client chunks included).
Upstream and fork point: `scripts/vs-upstream/measure-apps.mjs --root <tree>`,
the `baseline` column of the branch harness for a tree with no linker. As a
cross-check, run against the branch it reproduces the branch harness's
baseline byte-for-byte. Branch: `scripts/slices/measure-apps.mjs`
(`baseline` = default build, `sliced` = capability linker with feature slicing;
the `async`-only linker column equals `baseline` on every example here).

Min / gzip bytes:

| example | upstream rc.9 | fork point (rc.8) | branch default | branch + linker (sliced) | branch default vs upstream (gz) | branch + linker vs upstream (gz) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| todos | 87,608 / 31,675 | 79,745 / 28,753 | 81,610 / 29,534 | 81,081 / 29,365 | −6.8% | −7.3% |
| sierpinski | 40,557 / 15,755 | 34,624 / 13,617 | 35,618 / 14,014 | 32,950 / 12,989 | −11.1% | −17.6% |
| hackernews | 291,504 / 102,045 | 209,917 / 71,572 | 212,841 / 72,656 | 212,841 / 72,656 | −28.8% | −28.8% |
| hackernews-spa | 228,807 / 80,769 | 156,841 / 53,963 | 158,929 / 54,672 | 158,929 / 54,672 | −32.3% | −32.3% |
| notes | 334,436 / 115,571 | 252,371 / 85,961 | 255,302 / 87,067 | 255,302 / 87,067 | −24.7% | −24.7% |
| chat | 200,978 / 67,570 | 182,358 / 61,219 | 185,076 / 62,288 | 185,076 / 62,288 | −7.8% | −7.8% |
| effect | 239,430 / 81,226 | 230,979 / 78,109 | 232,847 / 78,925 | 232,847 / 78,925 | −2.8% | −2.8% |
| migrating-element | 45,773 / 18,186 | 41,284 / 16,522 | 42,172 / 16,878 | 39,506 / 15,848 | −7.2% | −12.9% |

Branch default vs fork point (gz): todos +2.7%, sierpinski +2.9%,
hackernews +1.5%, hackernews-spa +1.3%, notes +1.3%, chat +1.7%,
effect +1.0%, migrating-element +2.2%.

What the linker decided (branch, `sliced`):

| example | decision | features off |
| --- | --- | --- |
| todos | full runtime (imports `Loading`) | VERDICTS, SNAPSHOTS, ITERABLE, COMPILED_SEAMS |
| sierpinski | full runtime (imports `Loading`) | OPTIMISTIC, VERDICTS, STORES, SNAPSHOTS, ITERABLE, COMPILED_SEAMS |
| hackernews, hackernews-spa, notes, chat | refused (virtual `solid-ssr-entry-client.tsx` has no summary) | none |
| effect | refused (`<For each>` not proven synchronous) | none |
| migrating-element | full runtime | OPTIMISTIC, VERDICTS, STORES, SNAPSHOTS, ITERABLE, COMPILED_SEAMS |

Where upstream's extra bytes come from (rendered, pre-minify bytes per module
in the client build of hackernews-spa: upstream / branch):
`web/server-functions/dist/server.js` 100,189 / 4,571;
`solid/dist/solid.js` 35,533 / 30,066; `web/server-functions/dist/client.js`
23,657 / 20,639; serialization + decode 13,354 / 10,824. `@solidjs/signals`
rendered bytes in todos are 514,534 on upstream and 411,380 on the branch.

Not measured: `rendering` (three SSR configurations and no app; the branch
harness skips it for the same reason), `room` (upstream only, 320,243 /
110,913), `diagnostics`, `attribution-lab`, `islands` (branch only).

### Branch-only block apps (different apps, reference only)

`todos-blocks` is the generator-blocks v2 port of `todos`. `sync-blocks` is a
separate async-free blocks app with a different feature set. Both are compared
here against upstream's **handwritten `todos`** (31,675 B gz) only as a point of
reference. They are **not** the same program.

| app (branch) | default min / gz | + linker (sliced) min / gz | default vs upstream `todos` (gz) | + linker vs upstream `todos` (gz) | linker decision |
| --- | ---: | ---: | ---: | ---: | --- |
| todos-blocks | 90,295 / 32,437 | 89,902 / 32,331 | +2.4% | +2.1% | full (imports `Loading`) |
| sync-blocks | 64,611 / 23,702 | 54,955 / 20,220 | −25.2% | −36.2% | async-free entry; OPTIMISTIC, VERDICTS, SNAPSHOTS, ITERABLE, COMPILED_SEAMS off |

(`todos-blocks` vs the branch's own handwritten `todos`: +9.8% gz default.)

## 2. Signals core floor

`export { createSignal, createMemo, createEffect, createRoot, flush }` from
`packages/signals/dist/prod/index.js`, bundled with esbuild (minify, esm,
es2022), gzip -9 (`scripts/vs-upstream/floor.mjs`).

| tree | entry | min | gzip | gz vs upstream |
| --- | --- | ---: | ---: | ---: |
| upstream rc.9 | dist/prod/index.js | 27,898 | 10,952 | – |
| fork point rc.8 | dist/prod/index.js | 23,512 | 9,340 | −14.7% |
| branch | dist/prod/index.js | 24,594 | 9,784 | −10.7% |
| branch | dist/sync/index.sync.js (async-free entry) | 15,023 | 6,327 | −42.2% |

## 3. Runtime: instruction counts

Harness: `scripts/blocks-v2` (valgrind cachegrind; Ir/op =
(run(2·ops) − run(ops)) / ops, ops 20, warmup 60 mounts / 300 updates,
`node --predictable --single-threaded`). The cells are the harness's
scenarios. Each is one program, rendered through the jsdom-free fake
`@solidjs/web` (`scripts/blocks-v2/fake-web.mjs`), so the measurement is the
reactive machinery. n = 300 components.

Runtimes:
- **upstream**: upstream's `packages/signals/dist/prod` registered as a
  snapshot (`scripts/vs-upstream/snapshot-upstream.mjs`). The fake web
  imports four block entry points (`isBlock`, `blockFlags`, `renderBlock`,
  `dispatchBlock`) that rc.9 does not export. The snapshot adds inert
  stand-ins for them (`isBlock` → false; the other three throw and are never
  reached by a handwritten cell).
- **branch**: `node scripts/blocks-v2/build-prod.mjs --snapshot branch`.
- **fork point**: as upstream.

Compilers: each runtime's cells are compiled by **that tree's own compiler**
(`upstream+upstream-compiler`: the rc.9 `compiler.node` loaded through the
harness's saved-binary hook). This matters for two reasons:
- The branch compiler emits `createPlainStore` for the `paths` handwritten
  cell. rc.9 does not export it, so **`paths` handwritten fails to load on
  upstream when compiled by the branch compiler**. With upstream's own
  compiler it runs.
- rc.9's compiler emits delegated handlers as `el._$$click = h`, where the
  branch emits `el.$$click = h`. `scripts/vs-upstream/compare.mjs` rewrites
  the former to the fake web's `$$click` slot (the same single property
  store). Without that rewrite, `event` and `asyncEvent` never dispatch on
  upstream.

Equivalence was checked before measuring. Every handwritten cell on upstream
and on the fork point renders the same trace as on the branch (mount + 3
updates, n = 3), and `scripts/blocks-v2/check.mjs` passes on the branch.
All 12 handwritten cells run on upstream. None fails.

Ir/op at n = 300 (k = thousand instructions):

| cell | upstream rc.9 handwritten | fork point handwritten | branch handwritten | branch blocks v2 compiled | branch hw vs upstream | **branch v2 vs upstream hw** | branch hw vs fork point |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| memo update | 1,956k | 1,654k | 1,804k | 1,828k | −7.8% | −6.5% | +9.1% |
| create mount | 3,496k | 3,155k | 3,542k | 4,011k | +1.3% | +14.7% | +12.3% |
| view update | 814k | 715k | 775k | 889k | −4.8% | +9.2% | +8.4% |
| holes update | 1,940k | 1,744k | 1,952k | 1,952k | +0.6% | +0.6% | +11.9% |
| event update | 881k | 768k | 872k | 894k | −1.0% | +1.5% | +13.5% |
| attrs update | 1,366k | 1,237k | 1,388k | 1,400k | +1.6% | +2.5% | +12.2% |
| asyncEvent update | 1,059k | 1,007k | 1,111k | 1,605k | +4.9% | +51.6% | +10.3% |
| helpers mount | 5,053k | 4,373k | 5,052k | 5,056k | −0.0% | +0.1% | +15.5% |
| helpers update | 3,017k | 2,610k | 2,860k | 2,925k | −5.2% | −3.0% | +9.6% |
| effect update | 828k | 760k | 828k | 772k | +0.0% | −6.8% | +8.9% |
| paths update | 5,229k | 5,089k | 4,901k | 4,894k | −6.3% | −6.4% | −3.7% |
| async update | 72,684k | 45,230k | 45,465k | 46,248k | −37.4% | −36.4% | +0.5% |

"branch blocks v2 compiled" is the `compiled` variant: the v2 source
(`$component` / `$memo` / `yield*` holes) lowered by the branch compiler with
its default fusion. The comparison in bold answers "the same program written
in blocks v2 on the branch" vs "written by hand in Solid v2 today". Where blocks v2 costs more,
it is in component creation (+15%), whole-view re-runs (+9%) and async
event handlers (+52%). Where it costs less, it is in async memos (−36%, which
is upstream's regression: see the fork-point column), effects (−7%) and
memos (−7%).

## 4. SSR / hydration

Harness: `scripts/ssr-redesign/measure.mjs`. The server render uses the real
compiler SSR output and server runtime (median of 5 after a warm-up). The client
is bundled with esbuild (minify) from the prod dists. The gate checks that the
page after load and after a scripted session equals variant A's, and that
server nodes survive. Hydration work is counted in an instrumented build.
Timing uses an uninstrumented build in a fresh Chromium 141 context per rep, 7 reps (median), with the CPU at 1x and 4x.

To run the harness against upstream's dists,
`scripts/vs-upstream/ssr-root.mjs <tree> <dir>` stages a stand-in repo root.
`packages/` and `examples/` are symlinks into the tree, and the harness is a
copy with these adaptations:
- `islands-build.js` is optional;
- the counter patch anchors follow the tree's minified parameter names;
- `solid-js/internal` is aliased (rc.9's web imports it);
- one more app is added.

The added app is `todos-hw`: the harness's `todos` app **is `todos-blocks`**
(branch-only blocks code), so a handwritten-todos app with the same seed,
session and probes was added
(`scripts/vs-upstream/ssr/todos-hw/{server,client}.tsx`, rendering
`examples/todos/src/app`). hn's A variant is handwritten (the
hackernews-spa story page, 1,406 comments), and its source is identical in both
trees. The branch's `hn` / `todos` variants (A and the islands) ran in place.
Branch `todos-hw` ran through the same staging as upstream.

| app / variant | tree | JS gz (initial + lazy) | HTML gz (data) | hydrate 1x / 4x (ms) | script 1x / 4x (ms) | ready 1x / 4x (ms) | first interaction 1x / 4x (ms) | server render wall / CPU (ms) | gate |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| hn A (handwritten, today's hydration) | upstream | 24.5 KB | 405.6 KB (204.7) | 71.6 / 308.7 | 75.2 / 331.5 | 357.9 / 1486.5 | 1.2 / 6.4 | 29.0 / 60.1 | ref |
| hn A | branch | 22.4 KB | 405.6 KB (204.7) | 71.7 / 284.9 | 76.0 / 306.8 | 335.6 / 1399.1 | 1.1 / 6.1 | 26.2 / 65.5 | ref |
| hn C-eager (islands, hn-blocks) | branch | 0.7 KB | 188.3 KB (0.0) | 2.1 / 11.6 | 3.1 / 16.7 | 200.3 / 860.4 | 0.6 / 3.3 | 1.9 / 3.9 | = A |
| hn C-lazy (islands, hn-blocks) | branch | 0.7 + 0.5 KB | 188.3 KB (0.0) | 0.3 / 1.4 | 1.6 / 7.4 | 199.7 / 858.5 | 5.4 / 74.6 | 4.0 / 9.3 | = A |
| todos-hw A (handwritten `todos`) | upstream | 37.6 KB | 2.6 KB (1.2) | 22.3 / 97.4 | 23.8 / 105.4 | 46.2 / 191.6 | 4.0 / 19.9 | 402.8 / 3.4 | ref |
| todos-hw A (handwritten `todos`) | branch | 35.3 KB | 2.6 KB (1.2) | 26.6 / 98.8 | 28.1 / 105.7 | 49.4 / 196.4 | 3.9 / 20.1 | 403.5 / 3.4 | ref |
| todos A (`todos-blocks`) | branch | 38.1 KB | 2.6 KB (1.2) | 27.4 / 110.8 | 29.0 / 118.2 | 57.0 / 211.2 | 3.3 / 18.3 | 403.0 / 5.1 | ref |
| todos C-lazy (islands, `todos-blocks`) | branch | 0.8 + 25.2 KB | 1.6 KB (0.0) | 0.3 / 1.4 | 1.9 / 4.5 | 14.7 / 85.7 | 15.4 / 104.9 | 401.3 / 0.9 | = A |
| todos C-eager (islands, `todos-blocks`) | branch | 25.3 KB | 1.6 KB (0.0) | 17.0 / 64.4 | 18.2 / 65.8 | 45.5 / 173.2 | 3.2 / 17.2 | 401.3 / 1.1 | = A |

(The todos server render awaits a mock API that sleeps 400 ms, so CPU is the
comparable number. "C-lazy" for todos is the harness's variant `C`.)

Hydration work counts are identical between upstream and branch A. hn has
2,061 owners, 4,880 computeds, 13,775 recomputes, 654 signals and 2,712 template
claims. todos-hw has 105 / 321 / 632 / 107 / 105. The one difference is the
`_hk` gather time (hn 4.3 ms upstream vs 6.1 ms branch, instrumented build,
one sample). The branch's islands variants are a different architecture
(compiled island activation of a blocks-ported page). They are listed to show
what the branch offers beyond today's hydration, and they are gated equal to A's
DOM, but they are not the same code as A.

## After merging upstream `7f9bd7a6` (2026-09-29)

Branch `mergeNext`: `d3a093be` with upstream `next` @ `7f9bd7a6` merged
(`344ed054..7f9bd7a6`, 326 upstream commits, rc.8 to past rc.9). The fork
drift behind the numbers above is gone, so the comparison is now "upstream
plus the branch's additions" against upstream. Same methods as sections 1
and 2. Upstream's own app bytes were not re-measured at `7f9bd7a6` (that needs
its Rust compiler built). The app comparison below is against the rc.9
column above (`1a7d14fc`, about 40 commits older).

**Core floor** (`scripts/vs-upstream/floor.mjs`; upstream and `d3a093be`
signals built from `git archive` with this tree's toolchain):

| tree | entry | min | gzip | gz vs upstream `7f9bd7a6` |
| --- | --- | ---: | ---: | ---: |
| upstream `7f9bd7a6` | dist/prod/index.js | 27,917 | 10,951 | – |
| branch before the merge (`d3a093be`) | dist/prod/index.js | 24,594 | 9,785 | −10.6% |
| merged | dist/prod/index.js | 28,961 | 11,431 | +4.4% |
| merged | dist/sync/index.sync.js (async-free entry) | 16,928 | 7,007 | −36.0% |

What the branch adds to the core now costs 480 B gz on the floor, on top of
upstream. The
async-free entry grew 681 B gz (6,326 → 7,007) with upstream's core changes.

**App bytes** (`scripts/slices/measure-apps.mjs`, client JS gz; baseline =
default build, sliced = capability linker):

| example | branch before (section 1) | merged | merged + linker | merged vs before | merged vs upstream rc.9 | merged + linker vs upstream rc.9 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| todos | 29,534 | 32,925 | 32,704 | +11.5% | +3.9% | +3.2% |
| sierpinski | 14,014 | 16,102 | 14,981 | +14.9% | +2.2% | −4.9% |
| hackernews | 72,656 | 104,632 | 104,632 | +44.0% | +2.5% | +2.5% |
| hackernews-spa | 54,672 | 81,754 | 81,754 | +49.5% | +1.2% | +1.2% |
| notes | 87,067 | 117,003 | 117,003 | +34.4% | +1.2% | +1.2% |
| chat | 62,288 | 69,989 | 69,989 | +12.4% | +3.6% | +3.6% |
| effect | 78,925 | 82,489 | 82,489 | +4.5% | +1.6% | +1.6% |
| migrating-element | 16,878 | 18,540 | 17,365 | +9.8% | +1.9% | −4.5% |
| todos-blocks | 32,437 | 35,939 | 35,782 | +10.8% | – | – |
| sync-blocks | 23,702 | 25,961 | 21,714 | +9.5% | – | – |

The byte lead in section 1 came from upstream growth, and it is gone now
that the branch carries that growth. The branch's default builds are 1–4% gz
over upstream rc.9. The linker still slices the CSR examples it could slice
before (sierpinski −7.0%, migrating-element −6.3% vs merged default), which
puts those two 4–5% under rc.9. The SSR / router apps grew the most (+34% to
+50%), consistent with section 1's finding that upstream's client bundles
carry the server-functions runtime. The linker still refuses them for the
same reason (the virtual SSR entry has no summary). Linker decisions did not
change.

The runtime (section 3) and SSR (section 4) measurements were not re-run.
`node scripts/ssr-redesign/measure.mjs --check` passes on the merged tree
(every variant gates equal to A).

## Caveats

- **Fork drift dominates the byte comparison.** Upstream rc.9 is 290 commits
  past the branch's fork point. Most of the branch's byte advantage is
  upstream growth (server-functions in the client bundle, signals +17% gz at
  the floor). It is not branch optimization. Against the fork point the
  branch's default builds are 1–3% gz larger. The capability linker recovers
  that on the CSR examples it can slice, and on no SSR example.
- **Runtime: the fork-point column shows the branch's handwritten path is
  8–16% more Ir than rc.8** on most cells, while upstream is 3–18% above rc.8
  on the same cells (and +61% on `async`). Neither tree is the fork point plus only its own
  changes' costs in isolation. The fake web is the branch's (upstream only
  needed four inert stand-ins and the `_$$click` → `$$click` rewrite). Each
  tree's cells are compiled by its own compiler, so compiler output
  differences are part of the number, which is intended.
- The runtime harness measures reactive work only (no DOM). Blocks v2 cells
  are one program in three spellings, so they are the closest thing to an
  apples-to-apples "blocks vs handwritten" comparison. They are still synthetic.
- SSR timings are wall-clock medians of 7 on a shared 4-core container with
  other sessions active. Differences under ~10% (e.g. hn A 1x hydrate
  71.6 vs 71.7 ms, todos-hw 22.3 vs 26.6 ms) are within noise. Bytes and
  counts are exact.
- The branch's working tree moved while this ran (other sessions committed
  `7ac6f164` compiler hydration imports, docs, and these scripts). The branch
  numbers above were all taken with the compiler binary built at 00:08
  (`7ac6f164`). The app-byte run was repeated at `6b7f87d7` with identical
  results.
- `@solidjs/vite-plugin` is the same published 3.0.0-next.35 in both trees,
  resolving the workspace compiler. Both trees' examples use vite 7.3.3.

## Reproduce

```sh
# upstream tree (scratch), and the fork point for the reference column
git clone -b next https://github.com/solidjs/solid upstream-next && (cd upstream-next && git checkout 1a7d14fc)
git archive 344ed054 | tar -x -C mergebase        # from this repo
for T in upstream-next mergebase; do
  (cd $T && pnpm install --frozen-lockfile --prefer-offline &&
   for p in signals solid web h; do (cd packages/$p && pnpm build); done &&
   cd packages/compiler && RUSTUP_TOOLCHAIN=1.95 CARGO_TARGET_DIR=/scratch/target pnpm build)
done

# 1. bytes
node scripts/vs-upstream/measure-apps.mjs --root upstream-next --out up.json
node scripts/vs-upstream/measure-apps.mjs --root mergebase --out mb.json
node scripts/slices/measure-apps.mjs \
  --examples todos,sierpinski,hackernews,hackernews-spa,notes,chat,effect,migrating-element,todos-blocks,sync-blocks
# 2. core floor
node scripts/vs-upstream/floor.mjs upstream=upstream-next mergebase=mergebase branch=.

# 3. runtime
node scripts/blocks-v2/build-prod.mjs --snapshot branch
node scripts/vs-upstream/snapshot-upstream.mjs upstream-next --name upstream
cp upstream-next/packages/compiler/compiler.node node_modules/.cache/blocks-v2/runtimes/upstream-compiler.node
node scripts/vs-upstream/snapshot-upstream.mjs mergebase --name mergebase
cp mergebase/packages/compiler/compiler.node node_modules/.cache/blocks-v2/runtimes/mergebase-compiler.node
node scripts/vs-upstream/compare.mjs --n 300 --jobs 4 \
  --cols upstream+upstream-compiler:handwritten,branch:handwritten,branch:compiled
node scripts/vs-upstream/compare.mjs --n 300 --jobs 4 --cols mergebase+mergebase-compiler:handwritten

# 4. SSR / hydration
node scripts/vs-upstream/ssr-root.mjs upstream-next /scratch/ssr-up
node scripts/vs-upstream/ssr-root.mjs . /scratch/ssr-br
node /scratch/ssr-up/scripts/ssr-redesign/measure.mjs --apps hn,todos-hw --only A
node /scratch/ssr-br/scripts/ssr-redesign/measure.mjs --apps todos-hw --only A
node scripts/ssr-redesign/measure.mjs --apps hn,todos --only A,C,C-lazy,C-eager
```

(Stage the SSR root once per tree. The branch's islands variants must run in
place: a staged root reaches `examples/todos-blocks` through a symlink, and
the islands compiler's file set would then not match esbuild's real paths.)
