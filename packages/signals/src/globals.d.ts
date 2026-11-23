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
   * Store feature switches. `true` in every shipped tier but `dist/select`,
   * where each is left to the consuming bundler's `define`
   * (`__SOLID_STORE_<NAME>__`, `true` when undefined): `false` folds the
   * feature's arms out of the store, as a bundle that never installs
   * `optHooks` drops the optimistic arm. A switch only removes code; a program
   * that uses a feature it switched off is outside the contract.
   */
  /** Accessor properties, class instances (prototype getters and methods with
   * the proxy as receiver), `defineProperty`, non-enumerable and symbol keys. */
  const __STORE_ACCESSORS__: boolean;
  /** The `constructor` / `__proto__` / `prototype` key guards. */
  const __STORE_GUARDS__: boolean;
  /** `createStore(value, { shallow: true })`. */
  const __STORE_SHALLOW__: boolean;
  /** Derived stores (`createStore(fn, seed)`, `createProjection`,
   * `createOptimisticStore`) and a store whose backing is another store's. */
  const __STORE_FAMILIES__: boolean;
  /** `createOptimisticStore` (needs `__STORE_FAMILIES__`). */
  const __STORE_OPTIMISTIC__: boolean;
  /** `delete draft[key]`, and so `pop`/`shift`/`splice` on a draft proxy. */
  const __STORE_DELETE__: boolean;
}

export {};
