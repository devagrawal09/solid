// Capabilities: errorMarkers and loadingMarkers — adoption of the markers a
// server boundary serializes under its hydration id.
//
// - errorMarkers: an `<Errored>` boundary whose subtree failed on the server
//   serializes the error; the client re-throws it on the first pass so the
//   fallback it renders claims the server's fallback markup.
// - loadingMarkers: a `<Loading>` boundary serializes "$$f" (fallback shown,
//   content client-rendered), a settled or pending data ref, and — with
//   lazyAssets — a module map. The boundary adopts whichever it finds and
//   resumes hydration of its content when the data (and assets) settle.
//   Streamed fragments (`<id>_fr`) are the streamLedger capability, reached
//   through `slots.stream`.
//
// Neither changes the reactive core's boundary implementations; omitting them
// only means a boundary never looks for a server marker.
import {
  getOwner,
  peekNextChildId,
  flush,
  onCleanup,
  isDisposed,
  createMemo as coreMemo,
  createSignal as coreSignal,
  createLoadingBoundary as coreLoadingBoundary,
  createErrorBoundary as coreErrorBoundary,
  type Accessor,
  type Owner
} from "@solidjs/signals";
import {
  sharedConfig,
  slots,
  markInstalled,
  pauseSnapshots,
  checkHydrationComplete,
  setHydratingRaw,
  retainBoundary,
  releaseBoundary,
  CAP_ERROR_MARKERS,
  CAP_LOADING_MARKERS
} from "./state.js";

function hydratedCreateErrorBoundary<T, U>(
  fn: () => T,
  fallback: (error: () => unknown, reset: () => void) => U
): Accessor<T | U> {
  if (!sharedConfig.hydrating) return coreErrorBoundary(fn, fallback);
  slots.snap?.markTop();
  const parent = getOwner()!;
  const expectedId = peekNextChildId(parent);
  if (sharedConfig.has!(expectedId)) {
    const err = sharedConfig.load!(expectedId);
    if (err !== undefined) {
      let hydrated = true;
      return coreErrorBoundary(() => {
        if (hydrated) {
          hydrated = false;
          throw err;
        }
        return fn();
      }, fallback);
    }
  }
  return coreErrorBoundary(fn, fallback);
}

/**
 * Capability installer: serialized error-boundary marker adoption.
 *
 * @internal
 */
export function installErrorMarkerHydration(): void {
  slots.error = hydratedCreateErrorBoundary;
  markInstalled(CAP_ERROR_MARKERS);
}

// === Loading boundary resume machinery ===

function createBoundaryTrigger(): () => void {
  return pauseSnapshots(() => {
    const [s, set] = coreSignal(undefined, { equals: false });
    s();
    return set;
  });
}

function resumeBoundaryHydration(
  o: Owner,
  id: string,
  set: () => void,
  release: () => boolean,
  shouldHydrate = true
) {
  // Read before release(): releasing removes the boundaryScopes entry.
  const scope = sharedConfig.boundaryScopes?.get(id);
  // Disposal already released this boundary's pending count (#2917).
  if (!release()) return;
  if (isDisposed(o)) {
    checkHydrationComplete();
    return;
  }
  // A late resume must claim against the root this boundary registered
  // under — another hydrate() root may have replaced the global
  // registry/gather since (#2917). Swap the captured pair in for the
  // synchronous resume window; without a capture the live globals apply.
  const prevRegistry = sharedConfig.registry;
  const prevGather = sharedConfig.gather;
  if (scope) {
    sharedConfig.registry = scope.registry;
    sharedConfig.gather = scope.gather;
  }
  try {
    if (shouldHydrate) sharedConfig.gather?.(id);
    setHydratingRaw(shouldHydrate);
    if (shouldHydrate) slots.snap?.enter(o);
    set();
    flush();
    setHydratingRaw(false);
    if (shouldHydrate) slots.snap?.leave(o);
    flush();
  } finally {
    if (scope) {
      sharedConfig.registry = prevRegistry;
      sharedConfig.gather = prevGather;
    }
  }
  checkHydrationComplete();
}

export function initBoundaryResume(
  o: Owner,
  id: string
): [trigger: () => void, resume: (shouldHydrate?: boolean) => void, release: () => boolean] {
  retainBoundary();
  // Capture the current root's registry/gather pair for this boundary's
  // late resume (#2917). Runs while the registering root's globals are live:
  // during its hydrate() pass, or — for nested streamed boundaries — inside
  // an ancestor's resume window where that root's pair is swapped in.
  sharedConfig.captureBoundaryScope?.(id);
  // Each registration releases its pending count exactly once — via resume,
  // the $$f asset path, or disposal. The counter now spans hydration roots
  // (#2917), so a boundary that can never resume must not hold global
  // hydration open forever.
  let released = false;
  const release = () => {
    if (released) return false;
    released = true;
    releaseBoundary();
    sharedConfig.boundaryScopes?.delete(id);
    // Retire the fragment claim (stream ledger): after this boundary
    // resumes or is disposed, a late swap must be held rather than landing
    // in a range nobody will claim.
    slots.releaseFragment?.(id);
    return true;
  };
  onCleanup(() => {
    if (!isDisposed(o as Owner)) return;
    sharedConfig.cleanupFragment?.(id);
    if (release()) checkHydrationComplete();
  });
  const set = createBoundaryTrigger();
  return [
    set,
    shouldHydrate => resumeBoundaryHydration(o, id, set, release, shouldHydrate),
    release
  ];
}

export function waitAndResume(
  p: any,
  resume: (shouldHydrate?: boolean) => void,
  assetPromise?: Promise<void>,
  hydrateRejected = true,
  abort?: Promise<never>
) {
  // Settle data and assets independently: an asset error must not be written
  // into the data ref's rejected state, and a data rejection must still keep
  // its own hydrate semantics. (`p` may be an exotic thenable — coerce first.)
  // An abort promise (fragment truncation) races the data: its rejection
  // flows through the same rejected-state write as a server-sent rejection.
  const data: Promise<boolean> = (
    abort ? Promise.race([Promise.resolve(p), abort]) : Promise.resolve(p)
  ).then(
    () => {
      if (p && typeof p === "object") p.s = 1;
      return true;
    },
    (err: any) => {
      if (p && typeof p === "object") {
        p.s = 2;
        p.v = err;
      }
      return hydrateRejected;
    }
  );
  if (!assetPromise) {
    data.then(shouldHydrate => resume(shouldHydrate));
    return;
  }
  const assets = assetPromise.then(
    () => true,
    (err: any) => {
      reportAssetFailure(err);
      return false;
    }
  );
  Promise.all([data, assets]).then(([dataHydrate, assetsOk]) =>
    // Without its preloaded module the boundary can't claim server DOM —
    // render fresh so lazy's own import() retries through normal channels.
    resume(assetsOk ? dataHydrate : false)
  );
}

// A rejected module preload means the boundary's code can't hydrate the
// server DOM (lazy() has no module). Surface the error and resume with
// shouldHydrate=false: the boundary renders fresh client DOM and lazy's own
// import() retries through normal channels — never hang hydration silently.
export function reportAssetFailure(err: any) {
  console.error("Hydration module preload failed; rendering boundary content on the client:", err);
}

/**
 * Run `fn` once `assetPromise` settles (a microtask later, like every resume
 * path here); on a preload failure report it and run `fn` anyway. Without
 * an asset promise, just the microtask.
 */
export function afterAssets(assetPromise: Promise<void> | undefined, fn: () => void) {
  if (assetPromise)
    assetPromise.then(
      () => queueMicrotask(fn),
      err => {
        reportAssetFailure(err);
        queueMicrotask(fn);
      }
    );
  else queueMicrotask(fn);
}

export function scheduleResumeAfterAssets(
  id: string,
  resume: (shouldHydrate?: boolean) => void,
  assetPromise?: Promise<void>
): boolean {
  sharedConfig.gather?.(id);
  const doResume = () => queueMicrotask(resume);
  if (assetPromise) {
    assetPromise.then(doResume, err => {
      reportAssetFailure(err);
      queueMicrotask(() => resume(false));
    });
    return true;
  }
  doResume();
  return false;
}

function hydratedCreateLoadingBoundary<T, U>(
  fn: () => T,
  fallback: () => U,
  options?: { on?: () => any }
): Accessor<T | U> {
  if (!sharedConfig.hydrating) return coreLoadingBoundary(fn, fallback, options);
  // Shared with the stream-ledger branch: once a resume is queued for this
  // boundary, later runs of the memo must not register another one.
  const state = { q: false };

  return coreMemo(() => {
    const o = getOwner()!;
    const id = o.id!;

    // lazyAssets: the boundary's serialized module map, preloaded.
    const assetPromise = sharedConfig.hydrating ? slots.assets?.(id) : undefined;

    // Check boundary serialization key (sync SSR path: ctx.serialize(id, ...))
    if (sharedConfig.hydrating && sharedConfig.has!(id)) {
      const ref = sharedConfig.load!(id);
      let p: Promise<any> | any;
      if (ref) {
        if (typeof ref !== "object" || ref.s == null) p = ref;
        else if (ref.s === 1 || ref.s === 2) sharedConfig.gather?.(id);
        else p = ref;
      }
      if (ref && typeof ref === "object" && ref.s === 1 && p == null && !state.q) {
        if (assetPromise) {
          state.q = true;
          const [, resume] = initBoundaryResume(o, id);
          scheduleResumeAfterAssets(id, resume, assetPromise);
          return undefined;
        }
        // Already settled: the server rendered content and it is in the DOM.
        // Hydrate straight through — the fallback only hydrates when it is
        // actually showing. Rendering it here would create phantom client DOM
        // and poison insert's node bookkeeping (#2801 bug 1).
        return coreLoadingBoundary(fn, fallback, options);
      }
      if (p) {
        const [set, resume, release] = initBoundaryResume(o, id);
        if (p !== "$$f") {
          waitAndResume(p, resume, assetPromise);
        } else {
          // Server showed the fallback, so content is always fresh client
          // DOM; on preload failure proceed anyway and let lazy's own
          // import() retry/fail through normal channels.
          afterAssets(assetPromise, () => {
            if (!release()) return;
            set();
            checkHydrationComplete();
          });
        }
        return fallback();
      }
    }

    // Streamed fragment registration (streaming SSR path: registerFragment
    // sets id + "_fr") — the streamLedger capability.
    if (slots.stream && sharedConfig.hydrating && sharedConfig.has!(id + "_fr") && !state.q) {
      return slots.stream(o, id, fn, fallback, options, assetPromise, state);
    }

    if (assetPromise && !sharedConfig.has!(id)) {
      const [, resume] = initBoundaryResume(o, id);
      assetPromise.then(
        () => resume(),
        err => {
          reportAssetFailure(err);
          resume(false);
        }
      );
      return undefined;
    }
    return coreLoadingBoundary(fn, fallback, options);
  }) as unknown as Accessor<T | U>;
}

/**
 * Capability installer: serialized loading-boundary marker adoption ("$$f",
 * settled/pending data refs, deferred resume).
 *
 * @internal
 */
export function installLoadingMarkerHydration(): void {
  slots.loading = hydratedCreateLoadingBoundary;
  markInstalled(CAP_LOADING_MARKERS);
}
