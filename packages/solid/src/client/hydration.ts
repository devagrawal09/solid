import {
  NotReadyError,
  createLoadingBoundary as coreLoadingBoundary,
  createErrorBoundary as coreErrorBoundary,
  runWithOwner,
  getOwner,
  createRevealOrder as coreRevealOrder,
  createMemo as coreMemo,
  createSignal as coreSignal,
  createOptimistic as coreOptimistic,
  createProjection as coreProjection,
  createStore as coreStore,
  createOptimisticStore as coreOptimisticStore,
  createRenderEffect as coreRenderEffect,
  createEffect as coreEffect,
  type Accessor,
  type AnyBlock,
  type BlockAccessor,
  type BlockSignal,
  type BlockStore,
  type BlockStoreReturn,
  type BlockValue,
  type ReactiveHostBlock,
  type ComputeFunction,
  type MemoOptions,
  type NoInfer,
  type ProjectionOptions,
  type ProjectionBlock,
  type Refreshable,
  type Signal,
  type SignalOptions,
  type SourceAccessor,
  type Store,
  type StoreOptions,
  type StoreSetter,
  type RevealOrder,
  createOwner,
  createRoot,
  setContext
} from "@solidjs/signals";
import type { Element as SolidElement } from "../types.js";
import { IS_DEV } from "./core.js";
import { sharedConfig, slots, NoHydrateContext, installHydrationPhase } from "./hydration/state.js";
import { installSnapshotHydration } from "./hydration/snapshots.js";
import { installAsyncResultHydration } from "./hydration/async-results.js";
import { installSsrClientHydration, installSsrHybridHydration } from "./hydration/ssr-sources.js";
import { installStoreHydration } from "./hydration/stores.js";
import {
  installErrorMarkerHydration,
  installLoadingMarkerHydration
} from "./hydration/boundaries.js";
import { installStreamLedgerHydration } from "./hydration/stream-ledger.js";
import { installLazyAssetHydration } from "./hydration/lazy-assets.js";
import { installManifestGuards } from "./hydration/guards.js";
import { applyPatches } from "./hydration/drafts.js";
import { forwardIteratorReturn } from "./hydration/serialized.js";

export { sharedConfig, NoHydrateContext };
export {
  installSnapshotHydration,
  installAsyncResultHydration,
  installSsrClientHydration,
  installSsrHybridHydration,
  installStoreHydration,
  installErrorMarkerHydration,
  installLoadingMarkerHydration,
  installStreamLedgerHydration,
  installLazyAssetHydration
};
export { hydrationManifestViolation } from "./hydration/guards.js";

type HydrationSsrFields = {
  /**
   * Defer the SSR stream flush until this primitive's first value is
   * resolved. Lets late-resolving sources hold the document open
   * rather than forcing the surrounding `<Loading>` boundary to render
   * its fallback into the HTML. Server-only; ignored on the client.
   */
  deferStream?: boolean;
  /**
   * Hydration policy. Decides what initial value the client uses and
   * whether the compute re-runs.
   *
   * - `"server"` *(default)*: client uses the serialized server value
   *   as initial state. Compute does **not** re-run for the initial
   *   value — the serialized result is authoritative. Choose this when
   *   the compute is deterministic from server-available inputs.
   * - `"hybrid"`: client uses the serialized server value, then
   *   re-runs the compute to take over. Choose this for computes that
   *   mix server data with client-only signals (e.g. window size,
   *   user-locale).
   * - `"client"`: skip the server value entirely. Compute is deferred
   *   until hydration completes, then runs as if first-mounted.
   *   Choose this for client-only state where serialization is
   *   meaningless. Two forms decide what the pre-compute window
   *   renders: **bare** (structural) — the source suspends on the
   *   server as a final hole and the nearest `<Loading>` boundary
   *   renders its fallback, handing the position to the client; or a
   *   **declared commit #0** (value) — `loadingValue` on signal-family
   *   sources (`loadingValue: undefined` is a valid declaration),
   *   `seedLoadingValue: true` on store-family sources — which renders
   *   provisional data with no boundary involvement.
   */
  ssrSource?: "server" | "hybrid" | "client";
};
declare module "@solidjs/signals" {
  interface MemoOptions<T> extends HydrationSsrFields {}
  interface SignalOptions<T> extends HydrationSsrFields {}
  interface EffectOptions extends HydrationSsrFields {}
  interface ProjectionOptions extends HydrationSsrFields {}
}

/**
 * Options for `createProjection`, `createStore(fn, ...)`, and
 * `createOptimisticStore(fn, ...)`.
 *
 * `ssrSource` controls what initial value the client uses and whether
 * the projection's compute re-runs:
 *
 * - `"server"` *(default)*: client uses the serialized server value
 *   as initial state.
 * - `"hybrid"`: serialized value first, then re-run the compute on
 *   the client to take over.
 * - `"client"`: skip serialization; compute runs only after hydration
 *   completes. Bare = suspends on the server (nearest `<Loading>`
 *   renders its fallback and hands the position to the client);
 *   `seedLoadingValue: true` = the seed is the declared commit #0 and
 *   renders instead.
 *
 * See {@link HydrationSsrFields} for the fuller explanation.
 */
type HydrationMemoOptions<T> = MemoOptions<T>;
type HydrationSignalOptions<T> = SignalOptions<T> & MemoOptions<T>;
type HydrationProjectionOptions = ProjectionOptions;

export type HydrationContext = {};

// === Capability-selected hydration (optimization slice 7) ===
//
// Hydration is a set of independent capabilities, each installed by its own
// `install*Hydration()` function (see ./hydration/). `enableHydration()` is
// the universal switch — it installs every capability, because a hydrate()
// with no client manifest cannot know what the page will deliver.
// `enableHydrationWith(installers)` is the manifest-composed form: a
// generated client entry passes exactly the installers its client graph
// needs, so the rest never enter its module graph. In development builds the
// omitted capabilities get asserting guards (./hydration/guards.ts).

/**
 * Every capability installer, in canonical order. Referenced only by the
 * universal `enableHydration()`.
 */
const ALL_CAPABILITIES = [
  installSnapshotHydration,
  installAsyncResultHydration,
  installSsrClientHydration,
  installSsrHybridHydration,
  installStoreHydration,
  installErrorMarkerHydration,
  installLoadingMarkerHydration,
  installStreamLedgerHydration,
  installLazyAssetHydration
];

/**
 * Switches the primitive wrappers (`createMemo`, `createSignal`,
 * `createStore`, etc.) into hydration-aware mode with only the given
 * capability installers. Called by manifest-composed client entries (through
 * `@solidjs/web`'s `createHydrator`); never an end-user feature switch — the
 * installer list is generated from the client graph's capability manifest.
 * Development builds assert that the page never needs an omitted capability.
 *
 * @internal
 */
export function enableHydrationWith(installers: readonly (() => void)[]): void {
  for (let i = 0; i < installers.length; i++) installers[i]();
  installHydrationPhase();
  if (IS_DEV) installManifestGuards();
}

/**
 * Switches the primitive wrappers above (`createMemo`, `createSignal`,
 * `createStore`, etc.) into hydration-aware mode with every hydration
 * capability. Called by `hydrate()` before mounting; cross-package wiring not
 * part of the user-facing API.
 *
 * @internal
 */
export function enableHydration(): void {
  enableHydrationWith(ALL_CAPABILITIES);
}

/**
 * Materialize a container TRACE — snapshot then patch batches, the
 * continuation protocol a server projection serializes as when it crosses a
 * boundary (hydration resume above; the slot border via the serializer's
 * container plugin) — into a live local projection. The result reads like
 * the server value did: not-ready until the snapshot lands, then a
 * read-only store the batches keep updating, done when the trace ends.
 *
 * Created DETACHED (`runWithOwner(null)`): revival can run inside a render
 * effect's owner, and the store is memoized per trace (see the plugin's
 * WeakMap) — a store owned by its first reader would be disposed by that
 * reader's re-render while other readers still hold it. Consumption is
 * pull-driven and the trace is response-bounded, so the projection settles
 * on its own; GC collects the pair with the trace.
 *
 * @internal — consumed by the serialization layer (@solidjs/web).
 */
export function materializeContainerTrace(marker: {
  $tr: AsyncIterable<any> | { __SEROVAL_STREAM__: true };
  $ta?: number;
}): Store<any> {
  const src = marker.$tr as any;
  // Raw seroval stream (the wire shape since the stream-mint protocol):
  // `.on()` replays buffered emissions SYNCHRONOUSLY, so a snapshot the
  // document already delivered is applied before the first read — the store
  // reads as READY during hydration's synchronous claim walk, matching the
  // page's settled markup. The async-iterable branch below (pre-stream
  // payloads) can only surface its buffer through microtasks, which made a
  // settled-inline boundary suspend at the walk and hydrate a phantom
  // fallback over settled markup (the chat welcome/status meter miss).
  if (src != null && src.__SEROVAL_STREAM__ === true) {
    const queue: any[] = [];
    let failed: { error: any } | undefined;
    let cursor = 0;
    let first = true;
    // Everything lives under the detached root (see the block comment
    // below): materialization runs at arg-read inside a reader's render
    // scope, and a version signal owned by that reader would be disposed by
    // its re-render while the memoized store lives on.
    return createRoot(() => {
      const [version, setVersion] = coreSignal(0);
      // Subscribe before creating the projection: the buffered replay runs
      // synchronously inside on(), filling the queue the first compute
      // drains. Replayed values must NOT bump the version — the replay can
      // run inside an owned render scope where reactive writes are illegal,
      // and the projection doesn't exist yet to need waking. Only live
      // emissions (stream callbacks on later tasks) bump.
      let live = false;
      const bump = () => live && setVersion(n => n + 1);
      src.on({
        next(value: any) {
          queue.push(value);
          bump();
        },
        // The trace ended: the last applied state latches (same contract as
        // the iterable path's `done`).
        return() {},
        throw(error: any) {
          failed = { error };
          bump();
        }
      });
      live = true;
      return createProjection(
        (draft: any) => {
          version();
          while (cursor < queue.length) {
            const value = queue[cursor++];
            if (first) {
              first = false;
              // Full authoritative snapshot into a fresh {}/[] seed — pure
              // writes, no draft reads (see the iterable branch below).
              if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) draft[i] = value[i];
                draft.length = value.length;
              } else {
                Object.assign(draft, value);
              }
            } else {
              applyPatches(draft, value);
            }
          }
          if (failed) throw failed.error;
          // Nothing buffered yet (revival raced ahead of the record's data
          // script): pending until the snapshot lands, marked on the
          // projection's own node — the version bump reruns this compute.
          if (first) throw new NotReadyError(getOwner());
        },
        (marker.$ta ? [] : {}) as any
      );
    })!;
  }
  // A root, not a bare null owner: the projection's async machinery routes
  // its pending/error states through the owner's queue, and with no owner
  // at all the internal NotReadyError (the "pending until snapshot" mark)
  // surfaces as an unhandled error in dev. The root is never disposed —
  // the projection settles itself when the trace ends and is collected
  // with the store.
  return createRoot(() =>
    createProjection(
      (draft: any) => ({
        [Symbol.asyncIterator]() {
          const srcIt = src[Symbol.asyncIterator]();
          let first = true;
          return {
            next: () =>
              Promise.resolve(srcIt.next()).then((res: any) => {
                if (res.done) return { done: true as const, value: undefined };
                if (first) {
                  first = false;
                  // The first yield is the full authoritative snapshot. The
                  // seed is a fresh empty {}/[] minted here, so this is pure
                  // writes — no reads of the draft, which is still PENDING
                  // (reading a pending proxy throws NotReadyError, which
                  // would reject this step and error the projection).
                  if (Array.isArray(res.value)) {
                    for (let i = 0; i < res.value.length; i++) draft[i] = res.value[i];
                    draft.length = res.value.length;
                  } else {
                    Object.assign(draft, res.value);
                  }
                } else {
                  applyPatches(draft, res.value);
                }
                return { done: false as const, value: undefined };
              }),
            return: (value?: any) => forwardIteratorReturn(srcIt, value)
          };
        }
      }),
      (marker.$ta ? [] : {}) as any
    )
  )!;
}

// Wrapped primitives — dispatch to an installed capability or the core primitive

/**
 * Creates a readonly derived reactive memoized signal.
 *
 * `compute(prev)` runs reactively — every reactive read inside it is
 * tracked, and the returned value becomes the memo's current value.
 * The memo is cached: it only recomputes when one of its tracked
 * sources changes.
 *
 * ```ts
 * const value = createMemo<T>(compute, options?: MemoOptions<T>);
 * ```
 *
 * @example
 * ```ts
 * const [first, setFirst] = createSignal("Ada");
 * const [last, setLast] = createSignal("Lovelace");
 *
 * const fullName = createMemo(() => `${first()} ${last()}`);
 *
 * fullName(); // "Ada Lovelace"
 * ```
 *
 * @example
 * ```ts
 * // Async memo — reads suspend inside <Loading>
 * const user = createMemo(async () => {
 *   const res = await fetch(`/users/${id()}`);
 *   return res.json();
 * });
 * ```
 *
 * **Hydration:** `MemoOptions` accepts an `ssrSource` field
 * (`"server"` | `"hybrid"` | `"client"`) that controls what initial
 * value the client uses and whether `compute` re-runs. See
 * {@link HydrationSsrFields}.
 *
 * @param compute receives the previous value, returns the new value
 * @param options `MemoOptions` — `id`, `name`, `equals`, `unobserved`,
 *   `lazy`, `transparent`, `ssrSource`
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-memo
 */
export const createMemo: {
  // A `$` block keeps its dependency / async / error metadata on the accessor.
  <B extends AnyBlock & ReactiveHostBlock>(
    compute: B,
    options?: HydrationMemoOptions<BlockValue<B>>
  ): BlockAccessor<B>;
  // Commit #0 (loadingValue) removes the uninitialized window: the accessor
  // never reads undefined — even for `ssrSource: "client"`, where the loading
  // value serves until the post-hydration compute lands — and `prev` is
  // always T (the loading value seeds the first compute). Bare
  // `ssrSource: "client"` is the structural form: the source suspends on the
  // server as a FINAL hole and the nearest <Loading> hands off to the client.
  <T>(
    compute: ComputeFunction<NoInfer<T>, T>,
    options: HydrationMemoOptions<T> & { loadingValue: T }
  ): SourceAccessor<T>;
  <T>(
    compute: ComputeFunction<undefined | NoInfer<T>, T>,
    options?: HydrationMemoOptions<T>
  ): SourceAccessor<T>;
} = ((compute: any, options?: any) =>
  sharedConfig.hydrating && !options?.transparent && slots.signal
    ? slots.signal(coreMemo, compute, options)
    : coreMemo(compute, options)) as any;

/**
 * Creates a simple reactive state with a getter and setter.
 *
 * - **Plain form** — `createSignal(value, options?: SignalOptions<T>)`:
 *   stores a value; the setter writes a new value or applies an
 *   updater `(prev) => next`.
 * - **Function form (writable memo)** —
 *   `createSignal(fn, options?: SignalOptions<T> & MemoOptions<T>)`:
 *   the value is computed by `fn` like a memo, but the setter can
 *   locally override it (useful for optimistic edits over a derived
 *   default).
 *
 * ```ts
 * // Plain
 * const [count, setCount] = createSignal(0);
 *
 * count();              // 0
 * setCount(1);          // explicit value
 * setCount(c => c + 1); // updater
 *
 * // Writable memo: starts as `fn()`, can be locally overwritten.
 * const [user, setUser] = createSignal(() => fetchUser(userId()));
 * setUser({ ...user(), name: "Alice" }); // optimistic local edit
 * ```
 *
 * **Hydration:** in the function form, `SignalOptions & MemoOptions`
 * accepts an `ssrSource` field (`"server"` | `"hybrid"` | `"client"`)
 * that controls what initial value the client uses and whether `fn`
 * re-runs. See {@link HydrationSsrFields}.
 *
 * @returns `[state: Accessor<T>, setState: Setter<T>]`
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-signal
 */
export const createSignal: {
  <T>(): Signal<T | undefined>;
  <T>(value: Exclude<T, Function>, options?: SignalOptions<T>): Signal<T>;
  <B extends AnyBlock & ReactiveHostBlock>(
    fn: B,
    options?: HydrationSignalOptions<BlockValue<B>>
  ): BlockSignal<B>;
  // Commit #0 (loadingValue): never undefined, `prev` is always T — see
  // createMemo (bare "client" is the structural form there too).
  <T>(
    fn: ComputeFunction<NoInfer<T>, T>,
    options: HydrationSignalOptions<T> & { loadingValue: T }
  ): Signal<T>;
  <T>(
    fn: ComputeFunction<undefined | NoInfer<T>, T>,
    options?: HydrationSignalOptions<T>
  ): Signal<T>;
} = ((...args: any[]) =>
  typeof args[0] === "function" && sharedConfig.hydrating && slots.signal
    ? slots.signal(coreSignal, args[0], args[1])
    : (coreSignal as Function)(...args)) as any;

/**
 * Internal primitive that backs the `<Errored>` flow control.
 * Catches errors thrown inside `fn` and renders `fallback(error,
 * reset)` instead. `error` is an accessor for the latest captured error;
 * `reset()` recomputes the failing sources so the boundary can attempt to recover.
 *
 * App code should use `<Errored fallback={...}>` directly. This primitive is
 * kept exported for renderer, test, and compatibility use, but it is not part
 * of the recommended application authoring surface.
 *
 * **Hydration:** if the server serialized an error for this boundary,
 * the client re-throws it on the first hydration pass so `fallback`
 * renders the same content the server emitted.
 *
 * @internal
 */
export const createErrorBoundary = ((fn: any, fallback: any) =>
  sharedConfig.hydrating && slots.error
    ? slots.error(fn, fallback)
    : coreErrorBoundary(fn, fallback)) as <T, U>(
  fn: () => T,
  fallback: (error: Accessor<unknown>, reset: () => void) => U
) => Accessor<T | U>;

/**
 * Internal primitive that backs `<Reveal>` coordination of sibling loading
 * boundaries. App code should use `<Reveal>` directly.
 *
 * @internal
 */
export function createRevealOrder<T>(
  fn: () => T,
  options?: { order?: () => RevealOrder; collapsed?: () => boolean }
): T {
  return coreRevealOrder(fn, options);
}

/**
 * Creates an optimistic signal — a `Signal<T>` whose writes are
 * tentative inside an `action` transition: they show up immediately,
 * then auto-revert (or reconcile to the action's resolved value) once
 * the transition settles.
 *
 * Use this for single-value optimistic state. For collection-shaped
 * state, prefer `createOptimisticStore`.
 *
 * - **Plain form** — `createOptimistic(value, options?: SignalOptions<T>)`.
 * - **Function form** — `createOptimistic(fn, options?: SignalOptions<T> & MemoOptions<T>)`:
 *   the authoritative value is recomputed by `fn`; the optimistic
 *   overlay reverts after each transition.
 *
 * @example
 * ```ts
 * const [name, setName] = createOptimistic("Ada");
 *
 * const rename = action(function* (next: string) {
 *   setName(next);                 // optimistic
 *   yield api.rename(next);        // commits or reverts on settle
 * });
 * ```
 *
 * **Hydration:** in the function form, accepts an `ssrSource` field
 * (`"server"` | `"hybrid"` | `"client"`). See {@link HydrationSsrFields}.
 *
 * @returns `[state: Accessor<T>, setState: Setter<T>]`
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-optimistic-signal
 */
export const createOptimistic: {
  <T>(): Signal<T | undefined>;
  <T>(value: Exclude<T, Function>, options?: SignalOptions<T>): Signal<T>;
  // Commit #0 (loadingValue): never undefined, `prev` is always T — see
  // createMemo (bare "client" is the structural form there too).
  <T>(
    fn: ComputeFunction<NoInfer<T>, T>,
    options: HydrationSignalOptions<T> & { loadingValue: T }
  ): Signal<T>;
  <T>(
    fn: ComputeFunction<undefined | NoInfer<T>, T>,
    options?: HydrationSignalOptions<T>
  ): Signal<T>;
} = ((...args: any[]) =>
  // Passing coreOptimistic in here (instead of a dedicated hydrated impl
  // installed with the capability) is what lets the optimistic engine shake
  // out of hydrating bundles that never import this primitive.
  typeof args[0] === "function" && sharedConfig.hydrating && slots.signal
    ? slots.signal(coreOptimistic, args[0], args[1])
    : (coreOptimistic as Function)(...args)) as any;

/**
 * Creates a derived (projected) store — `createMemo` for stores. The
 * derive function receives a mutable draft and either mutates it in
 * place (canonical) or returns a new value. Either way the result is
 * reconciled against the previous draft by `options.key` (default
 * `"id"`), so surviving items keep their proxy identity — only
 * added/removed items are created/disposed.
 *
 * Returns the projected store directly (no setter — reads only).
 *
 * Reach for this when you want the structural-sharing / per-property
 * tracking of a store on top of a derived computation. For simple
 * read-only derivations, `createMemo` is lighter.
 *
 * @example
 * ```ts
 * // Mutation form — update individual fields on the draft.
 * const summary = createProjection<{ total: number; active: number }>(
 *   draft => {
 *     draft.total = users().length;
 *     draft.active = users().filter(u => u.active).length;
 *   },
 *   { total: 0, active: 0 }
 * );
 *
 * // Return form — produce a derived collection. Reconciled by `id`
 * // so each surviving user keeps the same store identity.
 * const activeUsers = createProjection<User[]>(
 *   () => allUsers().filter(u => u.active),
 *   []
 * );
 * ```
 *
 * **Hydration:** `ProjectionOptions` accepts an `ssrSource` field
 * (`"server"` | `"hybrid"` | `"client"`) for the same client-vs-server
 * tradeoffs as the other primitives. See {@link HydrationSsrFields}.
 */
export const createProjection: {
  <T extends object, B extends ProjectionBlock<T>>(
    fn: B & ProjectionBlock<T>,
    seed: Partial<T> | Store<NoFn<T>>,
    options?: HydrationProjectionOptions
  ): BlockStore<B, T>;
  <T extends object = {}>(
    fn: ((draft: T) => void | T | Promise<void | T> | AsyncIterable<void | T>) & ReactiveHostBlock,
    seed: Partial<T> | Store<NoFn<T>>,
    options?: HydrationProjectionOptions
  ): Refreshable<Store<T>>;
} = ((...args: any[]) =>
  // The store adapter is installed by the storeAdapters capability (see
  // ./hydration/stores.ts for the retention story).
  sharedConfig.hydrating && slots.store
    ? slots.store(coreProjection, args[0], args[1], args[2])
    : (coreProjection as Function)(...args)) as any;

type NoFn<T> = T extends Function ? never : T;

/**
 * Creates a deeply-reactive store backed by a Proxy. Reads track each
 * property accessed; only the parts that change trigger updates.
 *
 * Store properties hold **plain values**, not accessors. The proxy
 * already tracks reads per-property — wrapping a value in
 * `() => state.foo` produces a getter that *won't* track when called,
 * which looks like a reactivity bug but is just a category error. If
 * you have a signal-shaped piece of state, make it a property of the
 * store (`{ foo: 1 }`) rather than nesting an accessor inside
 * (`{ foo: () => signal() }`).
 *
 * The setter takes a **draft-mutating** function — mutate the draft
 * in place (canonical). The callback may also return a new value:
 * arrays are replaced by index (length adjusted), objects are
 * shallow-diffed at the top level (keys present in the returned value
 * are written, missing keys deleted). Use the return form for shapes
 * where mutation is awkward — most commonly removing items via
 * `filter`. The setter does **not** do keyed reconciliation; for
 * that, use the derived/projection form (or `createProjection`).
 *
 * - **Plain form** — `createStore(initialValue, options?)`: wraps a value in a
 *   reactive proxy.
 * - **Derived form** — `createStore(fn, seed, options?)`: a
 *   *projection store* whose contents are computed by `fn(draft)`.
 *   `fn` may be sync, async, or an `AsyncIterable`; the projection's
 *   result reconciles against the existing store by `options.key`
 *   (default `"id"`) for stable identity.
 *
 * @example
 * ```ts
 * const [state, setState] = createStore({
 *   user: { name: "Ada", age: 36 },
 *   todos: [] as { id: string; text: string; done: boolean }[]
 * });
 *
 * // Canonical: mutate the draft in place.
 * setState(s => { s.user.age = 37; });
 * setState(s => { s.todos.push({ id: "1", text: "x", done: false }); });
 *
 * // Return form: reach for it when mutation is awkward.
 * setState(s => s.todos.filter(t => !t.done));               // remove items
 * setState(s => ({ ...s, user: { name: "Grace", age: 85 } })); // shallow replace
 * ```
 *
 * @example
 * ```ts
 * // Derived store — auto-fetches & reconciles by `id`.
 * const [users] = createStore(
 *   async () => fetch("/users").then(r => r.json()),
 *   [] as User[]
 * );
 * ```
 *
 * **Hydration:** the derived form accepts `ProjectionOptions`, including
 * an `ssrSource` field
 * (`"server"` | `"hybrid"` | `"client"`). See {@link HydrationSsrFields}.
 *
 * @returns `[store: Store<T>, setStore: StoreSetter<T>]`
 */
export const createStore: {
  <T extends object = {}>(
    initialValue: NoFn<T> | Store<NoFn<T>>,
    options?: StoreOptions
  ): [get: Store<T>, set: StoreSetter<T>];
  <T extends object, B extends ProjectionBlock<T>>(
    fn: B & ProjectionBlock<T>,
    seed: Partial<T> | Store<NoFn<T>>,
    options?: HydrationProjectionOptions
  ): BlockStoreReturn<B, T>;
  <T extends object = {}>(
    fn: ((draft: T) => void | T | Promise<void | T> | AsyncIterable<void | T>) & ReactiveHostBlock,
    seed: Partial<T> | Store<NoFn<T>>,
    options?: HydrationProjectionOptions
  ): [get: Refreshable<Store<T>>, set: StoreSetter<T>];
} = ((...args: any[]) =>
  typeof args[0] === "function" && sharedConfig.hydrating && slots.store
    ? slots.store(coreStore, args[0], args[1] ?? {}, args[2])
    : (coreStore as Function)(...args)) as any;

/**
 * The store equivalent of `createOptimistic`. Writes inside an
 * `action` transition are tentative — they show up immediately but
 * auto-revert (or reconcile to the action's resolved value) once the
 * transition finishes.
 *
 * Use this for optimistic UI on collection-shaped data. For
 * single-value optimistic state, prefer `createOptimistic`.
 *
 * - **Plain form** — `createOptimisticStore(initialValue, options?)`.
 * - **Derived form** — `createOptimisticStore(fn, seed, options?)`:
 *   a projection store whose authoritative value is recomputed by
 *   `fn` and whose optimistic overlay reverts after each transition.
 *
 * In the derived form, `options.key` defaults to `"id"`; specify it only when your data
 * uses a different identity field (e.g. `{ key: "uuid" }` or
 * `{ key: t => t.slug }`). Restating the default just adds noise.
 *
 * @example
 * ```ts
 * const [todos, setTodos] = createOptimisticStore<Todo[]>([]);
 *
 * // Mutation: optimistic add, then in-place reconcile to the saved row.
 * const addTodo = action(function* (text: string) {
 *   const tempId = crypto.randomUUID();
 *   setTodos(t => { t.push({ id: tempId, text, pending: true }); });
 *   const saved = yield api.createTodo(text);
 *   setTodos(t => {
 *     const i = t.findIndex(x => x.id === tempId);
 *     if (i >= 0) t[i] = saved;
 *   });
 * });
 *
 * // Return form: filter is the natural shape for removal.
 * const removeTodo = action(function* (id: string) {
 *   setTodos(t => t.filter(x => x.id !== id));
 *   yield api.removeTodo(id);
 * });
 * ```
 *
 * **Hydration:** the derived form accepts `ProjectionOptions`, including
 * an `ssrSource` field
 * (`"server"` | `"hybrid"` | `"client"`). See {@link HydrationSsrFields}.
 *
 * @returns `[store: Store<T>, setStore: StoreSetter<T>]`
 */
export const createOptimisticStore: {
  <T extends object = {}>(
    initialValue: NoFn<T> | Store<NoFn<T>>,
    options?: StoreOptions
  ): [get: Store<T>, set: StoreSetter<T>];
  <T extends object, B extends ProjectionBlock<T>>(
    fn: B & ProjectionBlock<T>,
    seed: Partial<T> | Store<NoFn<T>>,
    options?: HydrationProjectionOptions
  ): BlockStoreReturn<B, T>;
  <T extends object = {}>(
    fn: ((draft: T) => void | T | Promise<void | T> | AsyncIterable<void | T>) & ReactiveHostBlock,
    seed: Partial<T> | Store<NoFn<T>>,
    options?: HydrationProjectionOptions
  ): [get: Refreshable<Store<T>>, set: StoreSetter<T>];
} = ((...args: any[]) =>
  typeof args[0] === "function" && sharedConfig.hydrating && slots.store
    ? slots.store(coreOptimisticStore, args[0], args[1] ?? {}, args[2])
    : (coreOptimisticStore as Function)(...args)) as any;

/**
 * Creates a reactive computation that runs during the render phase as
 * DOM elements are created and updated but not necessarily connected.
 *
 * Same compute/effect split as `createEffect` (`compute(prev)` tracks,
 * `effect(next, prev?)` runs imperatively), but scheduled inside the
 * render queue rather than after it. Reach for this only when
 * authoring renderer plumbing — app code should use `createEffect`.
 *
 * ```ts
 * createRenderEffect<T>(compute, effectFn, options?: EffectOptions);
 * ```
 *
 * **Hydration:** `EffectOptions` accepts an `ssrSource` field
 * (`"server"` | `"hybrid"` | `"client"`). See {@link HydrationSsrFields}.
 * `transparent: true` makes the effect invisible to hydration entirely —
 * it consumes no hydration id slot and its compute runs live rather than
 * adopting the serialized server value — for client-only effects the
 * server never created.
 *
 * @example
 * ```ts
 * // Custom directive: bind an element's textContent to a reactive source
 * // synchronously during render. App code should use `createEffect` for
 * // post-render side effects.
 * function bindText(el: HTMLElement, source: () => string) {
 *   createRenderEffect(
 *     () => source(),
 *     value => { el.textContent = value; }
 *   );
 * }
 * ```
 *
 * @description https://docs.solidjs.com/reference/secondary-primitives/create-render-effect
 */
export const createRenderEffect: typeof coreRenderEffect = ((
  compute: any,
  effectFn: any,
  options?: any
) =>
  sharedConfig.hydrating && !options?.transparent && slots.effect
    ? slots.effect(coreRenderEffect, compute, effectFn, options)
    : coreRenderEffect(compute, effectFn, options)) as typeof coreRenderEffect;

/**
 * Creates a reactive effect with **separate compute and effect phases**.
 *
 * - `compute(prev)` runs reactively — *put all reactive reads here*.
 *   The returned value is passed to `effect` and is also the new
 *   "previous" value for the next run.
 * - `effect(next, prev?)` runs imperatively (untracked) after the
 *   queue flushes. *Put DOM writes / fetch / logging / subscriptions
 *   here.* It may return a cleanup function which runs before the
 *   next effect or on disposal.
 *
 * Reactive reads inside `effect` will *not* re-trigger this effect —
 * that's intentional. If you need a single-phase tracked effect, use
 * `createTrackedEffect` (with the tradeoffs noted there).
 *
 * Pass an `EffectBundle` (`{ effect, error }`) instead of a plain
 * function to intercept errors thrown from the compute or effect
 * phases.
 *
 * ```ts
 * createEffect<T>(compute, effectFn | { effect, error }, options?: EffectOptions);
 * ```
 *
 * @example
 * ```ts
 * const [count, setCount] = createSignal(0);
 *
 * createEffect(
 *   () => count(),                  // compute: tracks `count`
 *   value => console.log(value)     // effect: side effect
 * );
 *
 * setCount(1); // logs 1 after the next flush
 * ```
 *
 * @example
 * ```ts
 * createEffect(
 *   () => userId(),
 *   id => {
 *     const ctrl = new AbortController();
 *     fetch(`/users/${id}`, { signal: ctrl.signal });
 *     return () => ctrl.abort(); // cleanup before next run / disposal
 *   }
 * );
 * ```
 *
 * **Hydration:** `EffectOptions` accepts an `ssrSource` field
 * (`"server"` | `"hybrid"` | `"client"`). See {@link HydrationSsrFields}.
 * `transparent: true` makes the effect invisible to hydration entirely —
 * it consumes no hydration id slot and its compute runs live rather than
 * adopting the serialized server value — for client-only effects the
 * server never created.
 *
 * @description https://docs.solidjs.com/reference/basic-reactivity/create-effect
 */
export const createEffect: typeof coreEffect = ((compute: any, effectFn: any, options?: any) =>
  sharedConfig.hydrating && !options?.transparent && slots.effect
    ? slots.effect(coreEffect, compute, effectFn, options)
    : coreEffect(compute, effectFn, options)) as typeof coreEffect;

/**
 * Internal primitive that backs the `<Loading>` component. Returns a
 * computation that yields `fallback()` while async reads inside `fn` are
 * pending, and `fn()` once they have settled. App code should use `<Loading>`
 * directly. This primitive is kept exported for renderer, test, and
 * compatibility use, but it is not part of the recommended application
 * authoring surface.
 *
 * @internal
 */
export const createLoadingBoundary = (<T, U>(
  fn: () => T,
  fallback: () => U,
  options?: { on?: () => any }
): Accessor<T | U> =>
  sharedConfig.hydrating && slots.loading
    ? slots.loading(fn, fallback, options)
    : coreLoadingBoundary(fn, fallback, options)) as <T, U>(
  fn: () => T,
  fallback: () => U,
  options?: { on?: () => any }
) => Accessor<T | U>;

/**
 * Disables hydration for its children on the client.
 * During hydration, skips the subtree entirely (returns undefined so DOM is left untouched).
 * After hydration, renders children fresh.
 *
 * @example
 * ```tsx
 * // Mount a client-only widget that the server didn't render. The subtree
 * // is left empty during hydration, then renders fresh once hydration ends.
 * <NoHydration>
 *   <ClientOnlyMap />
 * </NoHydration>
 * ```
 */
export function NoHydration(props: { children: SolidElement }): SolidElement {
  const o = createOwner();
  return runWithOwner(o, () => {
    setContext(NoHydrateContext, true);
    if (sharedConfig.hydrating) return undefined as unknown as SolidElement;
    return props.children;
  }) as unknown as SolidElement;
}

/**
 * Re-enables hydration within a `<NoHydration>` zone (passthrough on the
 * client). Use it to opt a subtree back into hydration when the surrounding
 * region was opted out.
 *
 * @example
 * ```tsx
 * // Inside a `<NoHydration>` region, re-enable hydration for one inner
 * // subtree that does need to match a server-rendered fragment.
 * <NoHydration>
 *   <ClientOnlyShell>
 *     <Hydration>
 *       <ServerHydratedWidget />
 *     </Hydration>
 *   </ClientOnlyShell>
 * </NoHydration>
 * ```
 */
export function Hydration(props: { id?: string; children: SolidElement }): SolidElement {
  return props.children as unknown as SolidElement;
}
