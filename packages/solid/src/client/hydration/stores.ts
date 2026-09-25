// Capability: storeAdapters — hydration for the derived store family
// (createStore(fn), createProjection, createOptimisticStore(fn)): serialized
// snapshot/patch replay, sync serialized adoption, and dispatch to the
// ssrSource policies.
//
// Installed from the entry that brings stores, not from the universal
// hydration switch: the generic adapter is parameterized by the core
// primitive (each wrapper passes coreStore / coreProjection /
// coreOptimisticStore), so it never retains the store engine itself, and a
// manifest-composed entry installs it only when the client graph contains a
// derived store that can adopt a server record or declares an ssrSource
// policy. Plain `createStore(value)` never reaches it. The universal
// `enableHydration()` still installs it, because a hydrate() with no manifest
// cannot know whether the page will deliver store records.
import { getOwner, peekNextChildId } from "@solidjs/signals";
import {
  sharedConfig,
  slots,
  markInstalled,
  onHydrationEnd,
  pauseSnapshots,
  CAP_STORES
} from "./state.js";
import {
  subFetch,
  syncThenable,
  hasLoadingWindow,
  forwardIteratorReturn,
  isAsyncIterable,
  readSerializedOrCompute
} from "./serialized.js";
import { applyPatches, createShadowDraft } from "./drafts.js";

function hydrateStoreFromAsyncIterable(
  coreFn: Function,
  fn: any,
  initialValue: any,
  options: any
): any {
  const parent = getOwner()!;
  const expectedId = peekNextChildId(parent);
  if (!sharedConfig.has!(expectedId)) return null;
  const loaded = sharedConfig.load!(expectedId);
  if (!isAsyncIterable(loaded)) return null;

  const srcIt = loaded[Symbol.asyncIterator]();
  const loading = hasLoadingWindow(options);
  let isFirst = true;
  let buffered: any = null;
  let terminal = false;
  const fail = (e: any) => {
    terminal = true;
    throw e;
  };
  return (coreFn as any)(
    (draft: any) => {
      // A run after the serialized stream reached its terminal state (done
      // or error) is a real invalidation — a dependency change or refresh()
      // — and the stream answers the OLD question (and is already consumed).
      // Re-running the adoption body would orphan another subFetch generator
      // and hand back the dead replay, freezing the store at its SSR value
      // forever; hand over to the live fn instead (#3060). Runs BEFORE the
      // terminal are NotReady retries of the same flight — the derive
      // re-runs each time a pending pull lands — and must keep adopting the
      // shared replay (going live there re-fetches data the document is
      // still delivering).
      if (terminal) return fn(draft);
      // Run the user fn up to its first await on the client so any reactive
      // dependencies read before the first suspension are tracked. Writes go
      // to a shadow of the draft and are discarded — the server iterator is
      // authoritative and drives the real draft via the iterable below.
      const { proxy } = createShadowDraft(draft);
      subFetch(fn, proxy);
      const process = (res: any) => {
        if (res.done) {
          terminal = true;
          return { done: true, value: undefined };
        }
        if (isFirst) {
          isFirst = false;
          // The initial full value IS the snapshot state the SSR DOM reflects.
          // Disable snapshot capture while applying it so prepareStoreWrite doesn't
          // record the pre-write (empty) base as the snapshot — otherwise reads
          // during hydration (e.g. Repeat reading length) see the stale pre-value
          // and fail to match the server-rendered DOM.
          pauseSnapshots(() => {
            if (Array.isArray(res.value)) {
              for (let i = 0; i < res.value.length; i++) draft[i] = res.value[i];
              draft.length = res.value.length;
            } else {
              // Replace, not merge: the snapshot is the full authoritative
              // state, so seed keys absent from it were removed on the server
              // and must not survive on the client either (#2948).
              for (const key of Object.keys(draft)) {
                if (!(key in res.value)) delete draft[key];
              }
              Object.assign(draft, res.value);
            }
          });
        } else {
          applyPatches(draft, res.value);
        }
        return { done: false, value: undefined };
      };
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (isFirst) {
                const r = srcIt.next();
                if (r && typeof r.then === "function")
                  return {
                    then(fn: any, rej: any) {
                      r.then(
                        (v: any) => {
                          // process() can throw (a store-trap NotReadyError,
                          // a reconcile failure). A throw inside this
                          // onFulfilled would reject a derived promise
                          // nobody observes — silently killing the drain and
                          // wedging the projection forever. Route it to the
                          // flight's rejection instead.
                          let out;
                          try {
                            out = process(v);
                          } catch (e) {
                            terminal = true;
                            rej(e);
                            return;
                          }
                          fn(out);
                        },
                        (e: any) => {
                          terminal = true;
                          rej(e);
                        }
                      );
                    }
                  };
                if (loading) {
                  // Seed window (seedLoadingValue): the SSR DOM reflects the
                  // SEED (commit #0), not the first-yield snapshot — the sync
                  // application below exists precisely because for windowless
                  // stores the snapshot IS what the DOM shows. Here applying
                  // it mid-claim would hydrate real-data structure against
                  // seed markup, so the snapshot parks until hydration
                  // completes, exactly like the patch backlog.
                  return new Promise(resolvePull => {
                    onHydrationEnd(() => resolvePull(process(r)));
                  });
                }
                return syncThenable(process(r));
              }
              if (buffered) {
                const b = buffered;
                buffered = null;
                return b.then(process, fail);
              }
              let r = srcIt.next();
              if (r && typeof r.then === "function") {
                return r.then(process, fail);
              }
              // A synchronously-available result is buffered backlog — the
              // stream ran ahead of hydration (delayed client script). It
              // must NOT apply while hydration is still claiming server DOM:
              // this pull runs inside the claim pass that first reads the
              // store (Repeat reading `length` drives it), or — for a late
              // streamed boundary — on a microtask racing that boundary's
              // resume. Projection draft writes stage in the override layer
              // until the firewall commits, so write-time snapshot capture
              // records the still-uncommitted SEED as the pre-write base
              // (not the first-yield state the SSR DOM shows), and any claim
              // pass after the batch hydrates against pre-stream state —
              // orphaning every server-rendered row. Park the batch until
              // hydration completes (a plain microtask when it already has):
              // snapshots are cleared by then, exactly where a live stream's
              // yields land. Conflated single-update semantics are kept —
              // every sync-available patch list still applies in one pull,
              // in order.
              return new Promise(resolvePull => {
                onHydrationEnd(() => {
                  let result = process(r);
                  while (!r.done) {
                    const peek = srcIt.next();
                    if (peek && typeof peek.then === "function") {
                      buffered = peek;
                      break;
                    }
                    r = peek;
                    if (!r.done) result = process(r);
                  }
                  resolvePull(result);
                });
              });
            },
            return(value?: any) {
              buffered = null;
              return forwardIteratorReturn(srcIt, value);
            }
          };
        }
      };
    },
    initialValue,
    options
  );
}

function wrapStoreFn(fn: any, options?: any) {
  return (draft: any) => readSerializedOrCompute(() => fn(draft), draft, options);
}

// The store-shaped counterpart to the signal-family dispatcher: one body for
// store/optimistic-store/projection, reached through the store slot with the
// core implementation passed in by the wrapper. The buffered backlog parking
// in hydrateStoreFromAsyncIterable (and the onHydrationEnd it defers
// through) is unchanged — only how the code is reached moved.
function hydrateStoreLike(coreFn: Function, fn: any, initialValue: any, options?: any) {
  slots.snap?.markTop();
  const ssrSource = options?.ssrSource;
  if (ssrSource === "client") {
    if (slots.client) return slots.client.store(coreFn as any, fn, initialValue, options);
  } else if (ssrSource === "hybrid") {
    if (slots.hybrid) return slots.hybrid.store(coreFn as any, fn, initialValue, options);
  }
  const aiResult = hydrateStoreFromAsyncIterable(coreFn, fn, initialValue, options);
  if (aiResult !== null) return aiResult;
  return (coreFn as any)(wrapStoreFn(fn, options), initialValue, options);
}

/**
 * Capability installer: derived store / projection / optimistic-store
 * hydration adapters.
 *
 * @internal
 */
export function installStoreHydration(): void {
  slots.store = hydrateStoreLike;
  markInstalled(CAP_STORES);
}
