// Capability: ssrSources — the `ssrSource: "client"` and `ssrSource: "hybrid"`
// hydration policies, selectable independently. The default "server" policy
// is serialized-result adoption (asyncResults / storeAdapters) and needs
// nothing from this module. A client graph with no primitive declaring
// "client" or "hybrid" omits both.
import { getOwner, createSignal as coreSignal } from "@solidjs/signals";
import {
  sharedConfig,
  slots,
  markInstalled,
  CAP_SSR_CLIENT,
  CAP_SSR_HYBRID,
  type SsrSourcePolicy
} from "./state.js";
import { hydrateSignalLike, hydratedEffect } from "./dispatch.js";
import {
  subFetch,
  readHydratedValue,
  readSerializedOrCompute,
  isAsyncIterable
} from "./serialized.js";
import { createShadowDraft, wrapFirstYield } from "./drafts.js";

/**
 * A thenable that never settles. The pre-hydration gate on an
 * `ssrSource: "client"` source returns this instead of prev: a sync return
 * would count as the node's first real answer — for a loading-window node it
 * would close the window, making the post-hydration compute pending-class
 * (isPending true) even though that compute IS the node's first question;
 * for a bare node it would commit `undefined` as an observed answer. A
 * never-landing flight keeps the node unasked through the gate — commit #0
 * (when declared) serves verdict-quiet, a bare node stays uninitialized —
 * until the real first flight lands, exactly like a fresh CSR mount. The
 * gate flip's recompute supersedes it (`_inFlight` is replaced; the
 * callbacks never fire), so sharing one frozen instance is safe.
 */
const UNASKED: PromiseLike<never> = { then() {} } as any;

// The shared pre-hydration gate lifecycle for the ssrSource branches
// (signal/store × client/hybrid): create the node with a compute that
// branches on the gate, then flip it — the flip's recompute is the node's
// first real run. `ownedWrite` because the write happens inside the node's
// own creation scope. The flip is a write during the claim pass: readers see
// the pre-flip value only through the snapshot setup, which is why the
// manifest validator requires `snapshots` for any ssrSource policy.
function withHydrationGate(create: (hydrated: () => boolean) => any) {
  const [hydrated, setHydrated] = coreSignal(false, { ownedWrite: true });
  const result = create(hydrated);
  setHydrated(true);
  return result;
}

const clientPolicy: SsrSourcePolicy = {
  signal(coreFn, fn, options) {
    return withHydrationGate(hydrated =>
      coreFn((prev: any) => {
        // UNASKED (never prev) — a sync return would count as a first answer:
        // it would close a loading window before the real compute ever runs,
        // or commit `undefined` on a bare node (see UNASKED).
        if (!hydrated()) return UNASKED;
        return fn(prev);
      }, options)
    );
  },
  store(coreFn, fn, initialValue, options) {
    return withHydrationGate(hydrated =>
      coreFn(
        (draft: any) => {
          // Keep client-only stores unasked through hydration. With
          // seedLoadingValue the seed is commit #0 and remains readable;
          // otherwise the store suspends until its first client result.
          if (!hydrated()) return UNASKED;
          return fn(draft);
        },
        initialValue,
        options
      )
    );
  },
  effect(coreFn, compute, effectFn, options) {
    let active = false;
    withHydrationGate(hydrated =>
      coreFn(
        (prev: any) => {
          if (!hydrated()) return prev;
          active = true;
          return compute(prev);
        },
        (next: any, prev: any) => {
          if (!active) return;
          return effectFn(next, prev);
        },
        options
      )
    );
  }
};

const hybridPolicy: SsrSourcePolicy = {
  // Hybrid async-iterable takeover (#2993). The server consumes exactly one
  // yield from its iterator and serializes it as a plain promise — the
  // contract is that the CLIENT continues the iteration. Stores get that
  // through the store policy's shadow-draft re-run; without this branch a
  // signal-shaped node would adopt the first yield and latch there forever
  // (readSerializedOrCompute only re-runs the compute on invalidation).
  // Value semantics make the takeover simpler than the store's: re-run the
  // generator plainly — its first yield reproduces the value the server
  // rendered (hybrid's determinism contract, same assumption the store path
  // makes), so nothing needs discarding; equal values dedupe at the node.
  // The takeover only ARMS when the adoption pass saw an async-iterable
  // compute: sync and promise-shaped hybrid computes keep their documented
  // adopt-the-serialized-value semantics (re-running those would clobber the
  // server value / trigger a client refetch). Reached only when the server
  // serialized a value for the node (see dispatch.ts).
  signal(coreFn, fn, options) {
    let takeover = false;
    const detect = (prev: any) => {
      const r = fn(prev);
      takeover = isAsyncIterable(r);
      return r;
    };
    return withHydrationGate(hydrated =>
      coreFn((prev: any) => {
        if (hydrated() && takeover) return fn(prev);
        return readSerializedOrCompute(detect, prev, options);
      }, options)
    );
  },
  store(coreFn, fn, initialValue, options) {
    return withHydrationGate(hydrated =>
      coreFn(
        (draft: any) => {
          const o = getOwner()!;
          if (!hydrated()) {
            if (sharedConfig.has!(o.id!))
              return readHydratedValue(
                sharedConfig.load!(o.id!),
                () => subFetch(fn, draft),
                options
              );
            return fn(draft);
          }
          const { proxy, activate } = createShadowDraft(draft);
          const r = fn(proxy);
          return isAsyncIterable(r) ? wrapFirstYield(r, activate) : r;
        },
        initialValue,
        options
      )
    );
  }
};

/**
 * Capability installer: the `ssrSource: "client"` policy (pre-hydration gate;
 * the compute first runs after hydration completes).
 *
 * @internal
 */
export function installSsrClientHydration(): void {
  slots.client = clientPolicy;
  slots.signal = hydrateSignalLike;
  slots.effect = hydratedEffect;
  markInstalled(CAP_SSR_CLIENT);
}

/**
 * Capability installer: the `ssrSource: "hybrid"` policy (adopt the
 * serialized value, then let the client compute take over).
 *
 * @internal
 */
export function installSsrHybridHydration(): void {
  slots.hybrid = hybridPolicy;
  slots.signal = hydrateSignalLike;
  markInstalled(CAP_SSR_HYBRID);
}
