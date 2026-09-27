/**
 * Link-time feature switches (documentation/plans/core-runtime-slicing.md).
 *
 * Every switch is `true` in every published build, so this module changes no
 * behavior on its own. The capability linker (`@solidjs/compiler/capabilities`)
 * may substitute a module with some switches `false` for an application graph
 * it has PROVEN never uses the feature. The core gates the feature's inline
 * seams (hot-path branches, node-literal terms, hook calls) on these
 * constants; an app bundler folds an imported `false` constant — rollup
 * outside `try`, the minifier everywhere — so the seams leave the bundle.
 *
 * Rules for a switch:
 * - It only removes code. Turning it off must never change the behavior of a
 *   graph that does not use the feature (the linker's proof guarantees that
 *   condition; `tests/slices.test.ts` checks it on the core suites' programs).
 * - The feature's public entry points stay importable: they throw
 *   `[FEATURE_EXCLUDED]` when reached with the switch off (the proof was
 *   wrong), mirroring `[ASYNC_CAPABILITY_EXCLUDED]` in the async-free entry.
 * - Feature modules (optimistic.ts, store/, …) never read their own switch at
 *   module scope: they shake out by import reachability, as before.
 */

/** Optimistic overrides, lanes, held truth and override supersession. Off
 * requires `createOptimistic` and `createOptimisticStore` unused AND
 * `VERDICTS` off (the verdict layer's companions are optimistic nodes that
 * ride lanes). An async capability: off in the async-free runtime. */
export const OPTIMISTIC = __ASYNC__;
/** The verdict layer's read-path seams: `latest()` read windows,
 * `isPending()` probes and their companion signals. Off requires `isPending`
 * and `latest` unused. An async capability: off in the async-free runtime. */
export const VERDICTS = __ASYNC__;
/** Store and projection nodes in the core: firewall children (projection
 * leaves), slot nodes and their shared unobserved hook, projection-write
 * posture. Implies no `createStore`, `createProjection`,
 * `createOptimisticStore`, `mapArray`-over-store, `$store`. */
export const STORES = true;
/** Hydration snapshots: snapshot capture, snapshot scopes and the stale-read
 * substitution in read()/setSignal. Off for client-only graphs (no
 * `hydrate`) and servers that do not stream snapshots. */
export const SNAPSHOTS = true;
/** `yield* accessor` support: the shared `Symbol.iterator` installed on every
 * signal/memo accessor for generator blocks. Off when no generator block
 * (`$`, `$component`, … v2 blocks) or `generatorMemo/Effect` is in the graph. */
export const ITERABLE = true;
/** Compiler-emitted fast-path seams: the status-free recompute dispatch
 * (`noThrow`), effect `equals` (memo fusion). Off when no compiled output
 * in the graph requests them. */
export const COMPILED_SEAMS = true;
