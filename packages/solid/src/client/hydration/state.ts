// Shared hydration state: the cross-package `sharedConfig` seam, the
// capability slots the primitive wrappers dispatch through, and the
// hydration-phase bookkeeping every hydrating client needs regardless of
// which capabilities its manifest selects.
//
// Nothing in this module references a capability implementation. Each
// capability lives in its own module and becomes reachable only through its
// `install*Hydration()` function — the universal `enableHydration()` calls
// all of them (a hydrate() with no manifest cannot know what the page will
// deliver), while a manifest-composed client entry calls exactly the ones the
// client graph needs, so the rest shake out of the bundle (optimization
// slice 7, capability-selected hydration runtime).
import {
  getOwner,
  getContext,
  getNextChildId,
  flush,
  setSnapshotCapture,
  type Accessor,
  type Context,
  type Owner
} from "@solidjs/signals";
import { IS_DEV } from "../core.js";

/**
 * Internal context flag set by `<NoHydration>` to disable hydration for its
 * subtree. Cross-package wiring; not part of the user-facing API.
 *
 * @internal
 */
export const NoHydrateContext: Context<boolean> = {
  id: Symbol("NoHydrateContext"),
  defaultValue: false
};

export type SharedConfig = {
  hydrating: boolean;
  resources?: { [key: string]: any };
  load?: (id: string) => Promise<any> | any;
  has?: (id: string) => boolean;
  gather?: (key: string) => void;
  /**
   * Per-boundary capture of the root-scoped registry/gather pair, installed
   * by the DOM runtime's hydrate(). Boundary registration stores the current
   * pair keyed by the full boundary id; the resume path swaps it in for its
   * synchronous window so a late resume claims against the root it
   * registered under, not whichever root hydrated last (#2917). Entries are
   * removed when the boundary's pending count releases.
   */
  boundaryScopes?: Map<string, { registry?: Map<string, object>; gather?: (key: string) => void }>;
  captureBoundaryScope?: (id: string) => void;
  cleanupFragment?: (id: string) => void;
  loadModuleAssets?: (mapping: Record<string, string>) => Promise<void> | undefined;
  registry?: Map<string, object>;
  completed?: WeakSet<object> | null;
  events?: any[] | null;
  verifyHydration?: () => void;
  done: boolean;
  // Assigned by enableHydration(); callers only reach it behind a
  // `sharedConfig.hydrating` check, which can never be true before that.
  getNextContextId?: () => string;
  /**
   * Whether a hydration pass is still claiming server-rendered DOM — true
   * from hydrate()'s synchronous walk until every streamed boundary has
   * resumed or been cancelled. Consumed by dev tooling (the refresh runtime
   * defers hot swaps that would race the claim, #2919). Assigned by
   * enableHydration(); absent in CSR bundles and on the server sharedConfig —
   * treat absence as "not hydrating". Cross-package wiring; not part of the
   * user-facing API.
   *
   * @internal
   */
  isHydrationInProgress?: () => boolean;
  /**
   * Registers a callback to run once when all hydration completes (all
   * boundaries hydrated or cancelled). If hydration is already complete (or
   * not hydrating), fires via queueMicrotask. Assigned by enableHydration();
   * absent in CSR bundles and on the server sharedConfig — when absent,
   * hydration is definitionally complete, so fire the callback via
   * queueMicrotask yourself. Cross-package wiring; not part of the
   * user-facing API.
   *
   * @internal
   */
  onHydrationEnd?: (callback: () => void) => void;
};

/**
 * Shared hydration coordination object — populated by `enableHydration()` and
 * consumed by the hydration-aware primitive wrappers and SSR streaming
 * runtime. Cross-package wiring; not part of the user-facing API.
 *
 * @internal
 */
export const sharedConfig: SharedConfig = {
  hydrating: false,
  registry: undefined,
  done: false
};

// === Capability slots ===
//
// The public primitive wrappers (createMemo, createStore, …) consult these
// only while `sharedConfig.hydrating` is true; an empty slot means "this
// client graph does not hydrate that protocol" and the wrapper takes the
// plain core path. Slots are assigned only by the capability installers (or,
// in development builds, by the manifest guards that assert an omitted
// capability is really unused — see guards.ts).

type AnyFn = (...args: any[]) => any;

/** An `ssrSource` hydration policy ("client" or "hybrid"), per primitive family. */
export type SsrSourcePolicy = {
  signal: (coreFn: AnyFn, fn: any, options: any) => any;
  store: (coreFn: AnyFn, fn: any, initialValue: any, options: any) => any;
  effect?: (coreFn: AnyFn, compute: any, effectFn: any, options: any) => void;
};

/** The snapshot/deferred-source setup (snapshots.ts). */
export type SnapshotHooks = {
  /** A hydration pass starts: open snapshot capture. */
  begin(): void;
  /** First hydration-aware primitive of a pass: mark its root owner as a snapshot scope. */
  markTop(): void;
  /** The synchronous hydration pass ends: release the root scope. */
  endRoot(): void;
  /** A boundary resume window opens under `o`. */
  enter(o: Owner): void;
  /** That resume window closes. */
  leave(o: Owner): void;
  /** Global hydration completed: drop every captured snapshot. */
  clear(): void;
};

export type HydrationSlots = {
  /** Signal-family dispatcher (memo / computed signal / computed optimistic). */
  signal?: (coreFn: AnyFn, fn: any, options: any) => any;
  /** Effect dispatcher (render effects and user effects). */
  effect?: (coreFn: AnyFn, compute: any, effectFn: any, options: any) => void;
  /** asyncResults: serialized async result adoption for the signal family. */
  adopt?: (coreFn: AnyFn, fn: any, options: any) => any;
  /** asyncResults: serialized value adoption for effects. */
  adoptEffect?: (coreFn: AnyFn, compute: any, effectFn: any, options: any) => void;
  /** ssrSources "client" policy. */
  client?: SsrSourcePolicy;
  /** ssrSources "hybrid" policy. */
  hybrid?: SsrSourcePolicy;
  /** storeAdapters: derived store / projection / optimistic-store hydration. */
  store?: (coreFn: AnyFn, fn: any, initialValue: any, options: any) => any;
  /** errorMarkers: adopt a serialized boundary error. */
  error?: (fn: () => any, fallback: (error: Accessor<unknown>, reset: () => void) => any) => any;
  /** loadingMarkers: adopt serialized loading-boundary markers. */
  loading?: (fn: () => any, fallback: () => any, options?: { on?: () => any }) => any;
  /** streamLedger: the streamed-fragment (`<id>_fr`) branch of a loading boundary. */
  stream?: (
    o: Owner,
    id: string,
    fn: () => any,
    fallback: () => any,
    options: { on?: () => any } | undefined,
    assetPromise: Promise<void> | undefined,
    state: { q: boolean }
  ) => any;
  /** streamLedger: retire a boundary's fragment claim when it releases. */
  releaseFragment?: (id: string) => void;
  /** lazyAssets: a boundary's serialized module map (`<id>_assets`), preloaded. */
  assets?: (id: string) => Promise<void> | undefined;
  /** lazyAssets: lazy()'s synchronous preloaded-module lookup. */
  lazy?: <T>(
    comp: (() => T | undefined) | undefined,
    moduleUrl?: string,
    exportName?: string
  ) => (() => T) | undefined;
  /** snapshots: snapshot/deferred-source setup. */
  snap?: SnapshotHooks;
};

/** @internal */
export const slots: HydrationSlots = {};

// Capability bits recorded by the installers. Development builds compare the
// installed set against what the page actually delivers (guards.ts); the
// production build never reads them.
export const CAP_SNAPSHOTS = 1;
export const CAP_ASYNC_RESULTS = 2;
export const CAP_SSR_CLIENT = 4;
export const CAP_SSR_HYBRID = 8;
export const CAP_STORES = 16;
export const CAP_ERROR_MARKERS = 32;
export const CAP_LOADING_MARKERS = 64;
export const CAP_STREAM_LEDGER = 128;
export const CAP_LAZY_ASSETS = 256;

export let installedCapabilities = 0;
export function markInstalled(bit: number): void {
  if (IS_DEV) installedCapabilities |= bit;
}

/**
 * Run `fn` with snapshot capture suspended — only when the snapshot setup is
 * installed; without it capture is never on, and toggling it back on here
 * would start capturing for a client graph whose manifest proved it needs no
 * snapshots.
 */
export function pauseSnapshots<T>(fn: () => T): T {
  if (!slots.snap) return fn();
  setSnapshotCapture(false);
  try {
    return fn();
  } finally {
    setSnapshotCapture(true);
  }
}

// === Hydration phase (always installed by enableHydration*) ===

// Installed on sharedConfig by enableHydration(): defining it in the object
// literal above retains getContext/NoHydrateContext/getNextChildId (and the
// signals context/error machinery behind them) in every CSR bundle that
// imports sharedConfig, i.e. all of them (#2883 phase 3).
function hydrationGetNextContextId(): string {
  const o = getOwner();
  if (!o) throw new Error(`getNextContextId cannot be used under non-hydrating context`);
  if (getContext(NoHydrateContext)) return undefined as unknown as string;
  return getNextChildId(o);
}

let _hydrationEndCallbacks: (() => void)[] | null = null;
let _pendingBoundaries = 0;
let _hydrationDone = false;
// Backing values for the property interceptors installed below.
let _hydratingValue = false;
let _doneValue = false;

/** Whether global hydration has completed (every boundary resumed or cancelled). */
export function isHydrationDone(): boolean {
  return _hydrationDone;
}

/** Whether a synchronous hydration pass is running (raw, no interceptor side effects). */
export function isHydratingRaw(): boolean {
  return _hydratingValue;
}

/**
 * Flip the hydrating flag WITHOUT the interceptor's pass bookkeeping — the
 * boundary resume window uses this: its synchronous claim is a sub-pass of a
 * hydration that is already in progress.
 */
export function setHydratingRaw(v: boolean): void {
  _hydratingValue = v;
}

/** A boundary registered a pending resume; hydration stays in progress until it releases. */
export function retainBoundary(): void {
  _pendingBoundaries++;
}

/** The boundary registered by retainBoundary() resumed or was disposed. */
export function releaseBoundary(): void {
  _pendingBoundaries--;
}

// Whether a hydration pass is still claiming server-rendered DOM. Reached by
// the refresh runtime as `sharedConfig.isHydrationInProgress` (#2919) —
// deliberately NOT a named export so app code isn't invited to branch on
// hydration state.
function isHydrationInProgress(): boolean {
  return !_hydrationDone && (sharedConfig.hydrating || _pendingBoundaries > 0);
}

// Registers a callback to run once when all hydration completes (all
// boundaries hydrated or cancelled). If hydration is already complete (or not
// hydrating), fires via queueMicrotask. Reached as
// `sharedConfig.onHydrationEnd`.
export function onHydrationEnd(callback: () => void): void {
  if (_hydrationDone || (!sharedConfig.hydrating && _pendingBoundaries === 0)) {
    queueMicrotask(callback);
    return;
  }
  if (!_hydrationEndCallbacks) _hydrationEndCallbacks = [];
  _hydrationEndCallbacks.push(callback);
}

function drainHydrationCallbacks() {
  if (_hydrationDone) return;
  _hydrationDone = true;
  _doneValue = true;
  slots.snap?.clear();
  flush();
  const cbs = _hydrationEndCallbacks;
  _hydrationEndCallbacks = null;
  if (cbs) for (const cb of cbs) cb();
  setTimeout(() => {
    if (IS_DEV && sharedConfig.verifyHydration) sharedConfig.verifyHydration();
    if ((globalThis as any)._$HY) (globalThis as any)._$HY.done = true;
    sharedConfig.registry?.clear();
  });
}

export function checkHydrationComplete(): void {
  // Not while a root's synchronous pass is running: a disposal-time release
  // (#2917) may hit zero while another root is still claiming DOM.
  if (!_hydratingValue && _pendingBoundaries === 0) drainHydrationCallbacks();
}

/**
 * Install the hydration phase: the context-id allocator, the completion
 * channel, and the `hydrating`/`done` interceptors that drive pass
 * bookkeeping. Every hydrating client needs exactly this, whatever its
 * manifest selects.
 */
export function installHydrationPhase(): void {
  sharedConfig.getNextContextId = hydrationGetNextContextId;
  // Installed here rather than in the sharedConfig literal so CSR bundles
  // shake the hydration-phase bookkeeping these close over. Consumers treat
  // absence as "not hydrating": the refresh runtime optional-chains
  // isHydrationInProgress, and clientOnly falls back to a bare microtask —
  // the exact CSR behavior onHydrationEnd itself had.
  sharedConfig.isHydrationInProgress = isHydrationInProgress;
  sharedConfig.onHydrationEnd = onHydrationEnd;

  _hydratingValue = sharedConfig.hydrating;
  _doneValue = sharedConfig.done;
  Object.defineProperty(sharedConfig, "hydrating", {
    get() {
      return _hydratingValue;
    },
    set(v: boolean) {
      const was = _hydratingValue;
      _hydratingValue = v;
      if (!was && v) {
        _hydrationDone = false;
        _doneValue = false;
        // Deliberately NOT zeroing _pendingBoundaries: a second hydration
        // root can start while an earlier root still has pending boundaries
        // (#2917). The counter spans roots — hydration is globally done only
        // when every root's boundaries have resumed.
        slots.snap?.begin();
      } else if (was && !v) {
        slots.snap?.endRoot();
        checkHydrationComplete();
      }
    },
    configurable: true,
    enumerable: true
  });
  Object.defineProperty(sharedConfig, "done", {
    get() {
      return _doneValue;
    },
    set(v: boolean) {
      _doneValue = v;
      if (v) drainHydrationCallbacks();
    },
    configurable: true,
    enumerable: true
  });
}
