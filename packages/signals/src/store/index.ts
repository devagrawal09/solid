export type {
  Store,
  StoreReturn,
  ProjectionStoreReturn,
  ProjectionBlock,
  BlockStore,
  BlockStoreReturn,
  StoreSetter,
  StoreNode,
  StoreOptions,
  ProjectionOptions,
  NotWrappable,
  SolidStore
} from "./store.js";
export type { Merge, Omit } from "./utils.js";

export { isWrappable, $TRACK, $PROXY, $TARGET, $RECORD } from "./store.js";
export {
  mergeSources,
  mergeView,
  viewOf,
  omitView,
  sourceKeys,
  sourceHas,
  sourceGet,
  hasStaticKeys,
  isStatic,
  resolvedTable,
  OmitView,
  MergeView,
  SOURCE_PLAIN,
  SOURCE_OMIT,
  SOURCE_PROXY,
  SOURCE_MEMO,
  SOURCE_MERGE,
  sourceOwners
} from "./utils.js";
export type { SourceKind } from "./utils.js";

import type {
  BlockStoreReturn,
  NoFn,
  ProjectionBlock,
  ProjectionOptions,
  Store,
  StoreOptions,
  StoreSetter
} from "./store.js";
import type { Refreshable } from "../core/index.js";
import type { ReactiveHostBlock } from "../generator.js";
import {
  createStoreNext,
  deepNext,
  nameStore,
  snapshotNext,
  type SetStoreNextFunction
} from "./next/store.js";
import { reconcileNextState } from "./next/reconcile.js";
import { createStoreDerivedNext } from "./next/projection.js";

export { createProjectionNext as createProjection } from "./next/projection.js";
export { storeIsShallow, storeHasFamily, storeHasOptimisticFamily } from "./next/store.js";
export { createStoreHandle, storeHandle, storeProxy } from "./next/store.js";
export { createOptimisticStoreNext as createOptimisticStore } from "./next/optimistic.js";

/** Public createStore: plain form `(initialValue, options?)` and derived writable
 * form `(fn, seed, options?)` — `fn` an ordinary function or a `$` block (whose
 * effect metadata the returned store retains; see `ProjectionBlock`). */
export function createStore<T extends object = {}>(
  initialValue: NoFn<T> | Store<NoFn<T>>,
  options?: StoreOptions
): [get: Store<T>, set: StoreSetter<T>];
export function createStore<T extends object, B extends ProjectionBlock<T>>(
  fn: B & ProjectionBlock<T>,
  seed: Partial<T> | Store<NoFn<T>>,
  options?: ProjectionOptions
): BlockStoreReturn<B, T>;
export function createStore<T extends object = {}>(
  fn: ((draft: T) => void | T | Promise<void | T> | AsyncIterable<void | T>) & ReactiveHostBlock,
  seed: Partial<T> | Store<NoFn<T>>,
  options?: ProjectionOptions
): [get: Refreshable<Store<T>>, set: StoreSetter<T>];
export function createStore(first: any, second?: any, third?: any): any {
  if (typeof first === "function") return createStoreDerivedNext(first, second, third);
  if (__OBSERVE__) {
    const store = createStoreNext(first, !!second?.shallow);
    if (second?.name) nameStore(store[0], second.name);
    return store;
  }
  return createStoreNext(first, !!second?.shallow);
}

/**
 * The plain form of `createStore` alone: `createPlainStore(value, options?)`
 * is `createStore(value, options?)`. The compiler rewrites a `createStore`
 * call whose first argument is statically not a function to this export, so
 * a bundle that never derives a store sheds the projection and reconcile
 * machinery the derived overload statically couples
 * (documentation/plans/core-runtime-slicing.md, coupling 3).
 */
export function createPlainStore<T extends object = {}>(
  initialValue: NoFn<T> | Store<NoFn<T>>,
  options?: StoreOptions
): [get: Store<T>, set: StoreSetter<T>] {
  return createStoreNext(initialValue as any, !!options?.shallow) as any;
}

/**
 * The derived form of `createStore` alone: `createDerivedStore(fn, seed,
 * options?)` is `createStore(fn, seed, options?)` (a projection store with
 * its setter). The compiler's target for a `createStore` call whose first
 * argument is a function or a block.
 */
export function createDerivedStore<T extends object, B extends ProjectionBlock<T>>(
  fn: B & ProjectionBlock<T>,
  seed: Partial<T> | Store<NoFn<T>>,
  options?: ProjectionOptions
): BlockStoreReturn<B, T>;
export function createDerivedStore<T extends object = {}>(
  fn: ((draft: T) => void | T | Promise<void | T> | AsyncIterable<void | T>) & ReactiveHostBlock,
  seed: Partial<T> | Store<NoFn<T>>,
  options?: ProjectionOptions
): [get: Refreshable<Store<T>>, set: StoreSetter<T>];
export function createDerivedStore(fn: any, seed: any, options?: any): any {
  return createStoreDerivedNext(fn, seed, options);
}

export function reconcile<T extends U, U>(
  value: T,
  key: string | ((item: NonNullable<any>) => any) | null = "id"
) {
  return (state: U): T => reconcileNextState(value, state, key) as any;
}

export function snapshot<T>(value: T): T {
  return snapshotNext(value);
}

export function deep<T>(value: T): T {
  return deepNext(value);
}

export { storePath } from "./storePath.js";
export type {
  PathSetter,
  Part,
  StorePathRange,
  ArrayFilterFn,
  CustomPartial
} from "./storePath.js";

export { merge, omit } from "./utils.js";
