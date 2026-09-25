// Capability: asyncResults — serialized async result adoption for the signal
// family (createMemo, computed createSignal / createOptimistic) and effects.
//
// The server serializes only asynchronous results (promises and async
// iterables; see server/signals.ts — synchronous computes are recreated by
// client execution). A client graph whose signal-family computes are proven
// synchronous never finds a record to adopt, so it can omit this capability
// and its memos/signals/effects take the plain core path under hydration.
// Store-family adoption is the separate storeAdapters capability.
import { getOwner, peekNextChildId } from "@solidjs/signals";
import { sharedConfig, slots, markInstalled, CAP_ASYNC_RESULTS } from "./state.js";
import { hydrateSignalLike, hydratedEffect } from "./dispatch.js";
import {
  subFetch,
  syncThenable,
  hasLoadingWindow,
  forwardIteratorReturn,
  isAsyncIterable,
  readSerializedOrCompute
} from "./serialized.js";

function normalizeIterator(it: any, deferFirst?: boolean) {
  let first = true;
  let buffered: any = null;
  return {
    next() {
      if (first) {
        first = false;
        const r = it.next();
        if (r && typeof r.then === "function") return r;
        // Loading window (loadingValue): commit #0 must serve through the
        // synchronous claim walk. A fully-buffered replay (loaded mode)
        // delivers its first yield synchronously, which would close the
        // window mid-walk — the client would compute real-data structure
        // against placeholder markup. Defer it one microtask; the sync
        // delivery stays for windowless nodes, whose claim NEEDS the value.
        return deferFirst ? Promise.resolve(r) : syncThenable(r);
      }
      if (buffered) {
        const b = buffered;
        buffered = null;
        return b;
      }
      let latest = it.next();
      if (latest && typeof latest.then === "function") return latest;
      let result = latest;
      while (!latest.done) {
        const peek = it.next();
        if (peek && typeof peek.then === "function") {
          buffered = peek;
          break;
        }
        latest = peek;
        // Conflate the buffered backlog to its LATEST data yield — one visible
        // update, the same final state the store path's batched patch
        // application produces. The stream's done result must not clobber
        // that value (a completed-before-hydration stream buffers its done
        // result right behind the data): deliver the value from this pull and
        // hand the done result to the next one.
        if (!latest.done) result = latest;
        else if (result !== latest) buffered = Promise.resolve(latest);
      }
      return Promise.resolve(result);
    },
    return(value?: any) {
      buffered = null;
      return forwardIteratorReturn(it, value);
    }
  };
}

function hydrateSignalFromAsyncIterable(coreFn: Function, compute: any, options: any): any {
  const parent = getOwner()!;
  const expectedId = peekNextChildId(parent);
  if (!sharedConfig.has!(expectedId)) return null;
  const loaded = sharedConfig.load!(expectedId);
  if (!isAsyncIterable(loaded)) return null;

  const base = normalizeIterator(loaded[Symbol.asyncIterator](), hasLoadingWindow(options));
  // Terminal tracking for the live handover below. The wrapper thenable keeps
  // the base iterator's delivery timing: syncThenable runs its callback
  // synchronously, and windowless claims NEED that sync first value.
  let terminal = false;
  const it = {
    next() {
      const p = base.next();
      return {
        then(res: any, rej: any) {
          return p.then(
            (r: any) => {
              if (r.done) terminal = true;
              return res(r);
            },
            (e: any) => {
              terminal = true;
              if (rej) return rej(e);
              throw e;
            }
          );
        }
      };
    },
    return(value?: any) {
      return base.return(value);
    }
  };
  const iterable = {
    [Symbol.asyncIterator]() {
      return it;
    }
  };
  return (coreFn as any)((prev: any) => {
    // A run after the serialized stream reached its terminal state (done or
    // error) is a real invalidation — a dependency change or refresh() — and
    // the stream answers the OLD question (and is already consumed). Hand
    // over to the live compute (#3060). Runs BEFORE that are NotReady
    // retries of the same flight (e.g. the compute read a sibling async
    // source that was still pending) and must keep adopting the replay.
    if (terminal) return compute(prev);
    // Run the user compute up to its first await on the client so any reactive
    // dependencies read before the first suspension are tracked. subFetch mocks
    // fetch/Promise so the async generator cannot progress past that point —
    // the server iterator drives the actual values from here on.
    subFetch(compute, prev);
    return iterable;
  }, options);
}

function adoptSignal(coreFn: Function, fn: any, options?: any) {
  const aiResult = hydrateSignalFromAsyncIterable(coreFn, fn, options);
  if (aiResult !== null) return aiResult;
  return (coreFn as any)((prev: any) => readSerializedOrCompute(fn, prev, options), options);
}

function adoptEffect(coreFn: Function, compute: any, effectFn: any, options?: any) {
  (coreFn as any)((prev: any) => readSerializedOrCompute(compute, prev), effectFn, options);
}

/**
 * Capability installer: serialized async result adoption for memos, computed
 * signals/optimistics, and effects. Called by the universal
 * `enableHydration()` and by manifest-composed entries whose client graph has
 * signal-family computes the server may resolve asynchronously.
 *
 * @internal
 */
export function installAsyncResultHydration(): void {
  slots.signal = hydrateSignalLike;
  slots.effect = hydratedEffect;
  slots.adopt = adoptSignal;
  slots.adoptEffect = adoptEffect;
  markInstalled(CAP_ASYNC_RESULTS);
}
