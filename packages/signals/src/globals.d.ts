declare global {
  /**
   * Checks tier: strict reads, owner-scope writes, invariants, console
   * reporting, dev-only error text. True only in dev builds.
   */
  const __DEV__: boolean;
  /**
   * Wiring tier: attribution hook sites, `_name` labels, graph edge counters,
   * the diagnostics event channel. True in dev AND observe builds — every
   * dev build is an observe build (`__DEV__` implies `__OBSERVE__`; dev.ts
   * asserts it). Gate a site on this when production observability needs
   * it; on `__DEV__` when only a developer at a console does.
   */
  const __OBSERVE__: boolean;
  const __TEST__: boolean;
  /**
   * Async capability (Track A stage 2). True in every standard build. The
   * async-free entry (`@solidjs/signals/sync`, selected by the capability
   * linker only for graphs proven async-free) is built with it false:
   * Promise / AsyncIterable handling, pending status and its propagation,
   * NotReadyError production, flight cancellation and async transitions
   * fold out, and the async-only APIs become stubs that throw
   * `[ASYNC_CAPABILITY_EXCLUDED]`.
   */
  const __ASYNC__: boolean;
  /**
   * Heuristic oracles (documentation/plans/heuristic-oracles.md). False in
   * every shipped build, so each oracle arm folds out. True only in the
   * measurement build (`dist/oracle`) and the test suite: there a node opts
   * into an assumed-true fact through the `oracle` option (CONFIG_ORACLE_* bits)
   * or an effect `equals`, and the runtime takes the shortcut that fact
   * would license. Nothing proves the fact — that is the compiler's job,
   * built only for oracles whose measured benefit earns it.
   */
  const __ORACLE__: boolean;
}

export {};
