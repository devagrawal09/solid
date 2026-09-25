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
}

export {};
