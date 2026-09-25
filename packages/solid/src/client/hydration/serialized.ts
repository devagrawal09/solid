// Serialized-value helpers shared by every capability that adopts a server
// record: signal-family async results (async-results.ts), the store adapters
// (stores.ts), and the "hybrid" ssrSource policy (ssr-sources.ts). This
// module installs nothing; it is retained exactly when one of those
// capabilities is. The overlap is real — a graph that selects only store
// adapters still pays for these helpers — and is reported as such in the
// slice-7 measurements.
import { getOwner, createSignal as coreSignal } from "@solidjs/signals";
import { sharedConfig, onHydrationEnd } from "./state.js";

// A `static {}` block marks the class as side-effectful, so bundlers retain
// it in EVERY client bundle even with zero references; the PURE-annotated
// factory shakes with its only consumer, subFetch (#2883 phase 3).
const MockPromise = /* @__PURE__ */ (() => {
  class MockPromise {
    catch() {
      return new MockPromise();
    }
    then() {
      return new MockPromise();
    }
    finally() {
      return new MockPromise();
    }
  }
  for (const k of ["all", "allSettled", "any", "race", "reject", "resolve"] as const) {
    (MockPromise as any)[k] = () => new MockPromise();
  }
  return MockPromise;
})();

export function subFetch<T>(fn: (prev?: T) => any, prev?: T) {
  const ogFetch = fetch;
  const ogPromise = Promise;
  try {
    window.fetch = () => new MockPromise() as any;
    Promise = MockPromise as any;
    const result = fn(prev);
    if (result && typeof result[Symbol.asyncIterator] === "function") {
      result[Symbol.asyncIterator]().next();
    }
    // The trace run's flight is never consumed (the serialized value is
    // authoritative) — an async fn returns a REAL promise (engine-internal,
    // the MockPromise swap can't intercept it), so a rejecting compute
    // (#2997: server-rejected async adopted on the client) must be observed
    // here or it surfaces as an unhandled rejection.
    if (result && typeof result.then === "function") result.then(undefined, () => {});
    return result;
  } finally {
    window.fetch = ogFetch;
    Promise = ogPromise;
  }
}

export function syncThenable(value: any) {
  return {
    then(fn: any) {
      fn(value);
    }
  };
}

/**
 * Unwrap a serialized hydration map entry. Only call when the map HAS an
 * entry for this id — presence is the caller's decision (`sharedConfig.has`),
 * because the serialized value itself may be null/undefined (#2914).
 *
 * Settled serialization refs are (promise) objects stamped with a numeric
 * status `s` (1 = fulfilled, 2 = rejected) and payload `v`. The payload is
 * read directly — `v ?? ref` would leak the ref object for nullish payloads.
 */
export function readHydratedValue(initP: any, refresh: () => void, options?: any) {
  refresh();
  if (initP != null && typeof initP === "object") {
    // Commit #0 (loadingValue/seedLoadingValue): the server flushed markup
    // from the loading value, so the hydrating client must serve the same
    // value through the synchronous claim walk — a settled landing must NOT
    // unwrap synchronously here (structure computed from the real data would
    // claim against placeholder DOM). Hand the async runtime a clean thenable
    // (the settled refs are stamped `s`/`v`, which the core would also
    // fast-adopt): the landing applies on the microtask after the walk.
    if (hasLoadingWindow(options) && typeof initP.then === "function")
      return { then: initP.then.bind(initP) };
    if (initP.s === 2) {
      // The stamp is the consumption: nothing ever `.then`s the serialized
      // promise itself, so observe its rejection here or the deserialized
      // record surfaces as an unhandled rejection (#2997).
      if (typeof initP.then === "function") initP.then(undefined, () => {});
      throw initP.v;
    }
    if (initP.s === 1) return initP.v;
  }
  return initP;
}

/**
 * Nodes that have taken the serialized-adoption path once. Any LATER entry
 * means a dependency changed while the node was held on its server value —
 * the recompute itself is absorbed (the latch re-serves the serialized
 * value, as it must), and with the node then clean, nothing would ever
 * re-run it after hydration: the mid-stream change would be silently lost,
 * not deferred. Arming the takeover gate on that re-entry re-runs exactly
 * the diverged nodes against their live sources when hydration ends.
 * (Async settles commit through the adopted thenable without re-entering
 * the wrapper, so re-entry here is always invalidation-driven.)
 */
const latchedOnce = new WeakSet<object>();

/** Shared “serialized init or run compute” path for memo/signal/optimistic/effect under hydration. */
export function readSerializedOrCompute(compute: (prev: any) => any, prev: any, options?: any) {
  const o = getOwner()!;
  // A computation must adopt its serialized server value for the whole
  // hydration lifecycle (`!done`), not just inside a synchronous resume window.
  // A streamed section can recompute between chunks; running the client body
  // there would commit a fresh Promise and orphan the server-streamed fragment.
  // So short-circuit to the server value whenever one is still waiting; once
  // hydration is `done`, always compute.
  if (sharedConfig.done || !sharedConfig.has!(o.id!)) return compute(prev);
  // Divergence arming is a "server"/default-mode contract only: the hybrid
  // signal-like wrapper runs this path under withHydrationGate, whose
  // synchronous flip guarantees one internal re-entry that is not user
  // divergence — and hybrid's sync/promise flavor deliberately latches
  // (re-running its compute at done would clobber the adopted value).
  if (latchedOnce.has(o)) {
    if (options?.ssrSource !== "hybrid") armLiveTakeover();
  } else latchedOnce.add(o);
  return readHydratedValue(
    sharedConfig.load!(o.id!),
    () => {
      const traced = subFetch(compute, prev);
      if (options?.ssrSource !== "hybrid" && traced != null && traced[LIVE_SOURCE])
        armLiveTakeover();
      return traced;
    },
    options
  );
}

/**
 * Live-source brand (registered symbol — set by the transport's `live()`
 * declaration; registered so separately bundled copies agree). See the
 * server counterpart in server/signals.ts: the server takes a live
 * source's first value and closes (auto-hybrid), so the client's adopted
 * value is only the t=0 face — the node must re-run its compute after
 * hydration to reconnect. The brand is detected in the trace run the
 * adoption path already performs (subFetch invokes the compute; a live
 * call constructs its iterable synchronously with no wire activity).
 */
const LIVE_SOURCE = Symbol.for("solid.LiveSource");

// One shared gate for all live-armed nodes in a hydration pass: nodes that
// trace-detected a live compute read it (tracked); hydration end flips it,
// recomputing exactly those nodes — whose compute wrapper now sees
// `sharedConfig.done` and runs the real compute, reconnecting. The stale
// adopted value serves until the reconnect's first yield lands (pending
// recomputes serve prev), so takeover is seam-free. The gate is discarded
// on flip so a later hydration pass (islands) arms a fresh one.
let liveGate: (() => boolean) | undefined;
function armLiveTakeover() {
  if (!liveGate) {
    const [read, write] = coreSignal(false);
    liveGate = read;
    onHydrationEnd(() => {
      liveGate = undefined;
      write(true);
    });
  }
  liveGate();
}

/** Options carry commit #0 — the loading window must hold through the claim walk. */
export function hasLoadingWindow(options: any): boolean {
  return (
    options != null &&
    typeof options === "object" &&
    ("loadingValue" in options || options.seedLoadingValue === true)
  );
}

export function forwardIteratorReturn(it: any, value?: any) {
  const returned = it.return?.(value);
  return returned && typeof returned.then === "function"
    ? returned
    : syncThenable(returned ?? { done: true, value });
}

export function isAsyncIterable(v: any): boolean {
  return v != null && typeof v[Symbol.asyncIterator] === "function";
}
