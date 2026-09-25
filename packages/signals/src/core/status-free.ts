/**
 * Status-free recomputation — Track A, stage 1 (typed-generator strict mode).
 *
 * A computation whose compute is proven
 *
 *   - synchronous (CONFIG_SYNC: its result is never a Promise, thenable or
 *     AsyncIterable), and, separately,
 *   - non-throwing (CONFIG_NOTHROW: it never throws and never reads a source
 *     that can be pending or errored),
 *
 * carries only the value channel. Its runs need none of the pending / error
 * machinery `recompute` threads through every pass: no async-shape probe, no
 * outgoing-status capture, no status clear, no settle sweeps, no lane /
 * override / transition arms.
 *
 * Pay-for-use: this module installs `GlobalQueue._recomputeStatusFree` when
 * it is evaluated, which happens only when a bundle imports `statusFree` —
 * the options object the compiler passes to a reactive host for a proven `$`
 * block. Apps without proven blocks never load it, and the core floor pays
 * one masked config test per recompute.
 *
 * Soundness:
 *
 * - The path runs only in the *plain world* (`eligible`), where the full
 *   path would have reduced to exactly these steps: no live transition or
 *   lane, no extension (no override, no in-flight, no error / pending
 *   state, no companions), no loading window, no snapshot capture, no staged
 *   disposal. Anything else declines and `recompute` runs in full, so the
 *   world never has to match the proof.
 * - The proof itself is verified, not trusted blindly. A throw that reaches
 *   this path is routed through the ordinary status channel exactly as the
 *   full path's catch would route it in the plain world, and CONFIG_NOTHROW
 *   is cleared: the node deoptimizes to the full path for good. Dev builds
 *   also report `[NOTHROW_NODE_THREW]`, and re-probe every result for async
 *   shape (`[SYNC_NODE_RECEIVED_ASYNC]`), exactly as `handleAsync` does for
 *   a `sync: true` node. A wrong proof therefore costs performance, never
 *   behavior (except that a wrong *sync* proof stores a Promise as a value,
 *   which is the documented contract of `sync: true` and is loud in dev).
 */
import { clearStatus, notifyStatus } from "./async.js";
import { attrHooks } from "./attribution-hooks.js";
import {
  CONFIG_NOTHROW,
  EFFECT_TRACKED,
  EFFECT_USER,
  NOT_PENDING,
  REACTIVE_MISSED_WAKE,
  REACTIVE_NONE,
  REACTIVE_OPTIMISTIC_DIRTY,
  REACTIVE_REASK,
  REACTIVE_RECOMPUTING_DEPS,
  REACTIVE_SNAPSHOT_STALE,
  STATUS_ERROR,
  STATUS_PENDING,
  STATUS_UNINITIALIZED
} from "./constants.js";
import {
  blockGuard,
  context,
  currentOptimisticLane,
  ext,
  latestReadActive,
  setBlockGuard,
  setContextInternal,
  setLatestReadActive,
  setStrictRead,
  snapshotCaptureActive,
  swapStale,
  swapTracking,
  untrack
} from "./core.js";
import {
  clearSignals,
  emitDiagnostic,
  GRAPH_SIZE_WARN_AT,
  noteFanIn,
  reportDiagnostic
} from "./dev.js";
import { NotReadyError } from "./error.js";
import { trimStaleDeps } from "./graph.js";
import { deleteFromHeap, enqueueSub, insertIntoHeapHeight, queueFor } from "./heap.js";
import { devTrackHeldPending } from "./invariants.js";
import {
  activeTransition,
  bumpNotifyEpoch,
  clock,
  currentTransition,
  GlobalQueue,
  insertSubs,
  queuePendingNode,
  schedule,
  type Transition
} from "./scheduler.js";
import type { Computed } from "./types.js";

export const NOTHROW_NODE_THREW_MESSAGE =
  "[NOTHROW_NODE_THREW] A computation created with `noThrow: true` threw (or read a pending / " +
  "errored source). The proof was wrong: the error is routed normally and the node runs the " +
  "full status-aware path from now on. Remove `noThrow` (or fix the compiler proof) so " +
  "production builds do not pay the deoptimization.";

/** The plain world: every condition under which the full path's arms for
 * transitions, lanes, overrides, loading windows, snapshots, staged
 * disposal and existing status are all inert. */
function eligible(el: Computed<any>, create: boolean): boolean {
  return (
    el._x === null &&
    el._transition === null &&
    activeTransition === null &&
    currentOptimisticLane === null &&
    !snapshotCaptureActive &&
    !el._loading &&
    (el as any)._type !== EFFECT_TRACKED &&
    (el._flags & (REACTIVE_OPTIMISTIC_DIRTY | REACTIVE_REASK)) === 0 &&
    // A re-run with children or registered cleanups stages their disposal in
    // the extension (zombie deferral to the commit) — the full path's job.
    (create || (el._firstChild === null && el._disposal === null))
  );
}

/** Dev verification of CONFIG_SYNC on this path (`handleAsync`, which
 * performs it for the full path, is never reached here). */
function devVerifySync(el: Computed<any>, result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  let thenable = false;
  let iterator = false;
  untrack(() => {
    iterator = (result as any)[Symbol.asyncIterator] !== undefined;
    thenable = !iterator && typeof (result as any).then === "function";
  });
  if (!thenable && !iterator) return;
  const message =
    `[SYNC_NODE_RECEIVED_ASYNC] A computed/effect created with \`sync: true\` returned ` +
    `${thenable ? "a Promise" : "an AsyncIterable"}. The value would be stored as-is and ` +
    `never awaited in production; remove \`sync: true\` to use async-aware behavior, or ` +
    `unwrap the value before returning.`;
  emitDiagnostic({
    code: "SYNC_NODE_RECEIVED_ASYNC",
    kind: "lifecycle",
    severity: "error",
    message,
    ownerId: el.id,
    ownerName: (el as any)._name
  });
  throw new Error(message);
}

/** A throw reached the status-free path: the proof was wrong. Route it as
 * the full path's catch does in the plain world, and deoptimize. */
function threw(el: Computed<any>, e: unknown): void {
  el._config &= ~CONFIG_NOTHROW;
  if (__DEV__) {
    reportDiagnostic(
      emitDiagnostic(
        {
          code: "NOTHROW_NODE_THREW",
          kind: "lifecycle",
          severity: "error",
          message: NOTHROW_NODE_THREW_MESSAGE,
          ownerId: el.id,
          ownerName: (el as any)._name
        },
        el
      )
    );
  }
  const notReady = e instanceof NotReadyError;
  let reaskChanged = false;
  if (notReady) {
    ext(el)._blocked = true;
    if (GlobalQueue._applyReask !== null) reaskChanged = GlobalQueue._applyReask(el, false);
  }
  notifyStatus(el, notReady ? STATUS_PENDING : STATUS_ERROR, e);
  if (reaskChanged) GlobalQueue._repollVerdicts!(el);
}

/**
 * One status-free run. Returns false (having done nothing) outside the plain
 * world, so the caller runs the full path.
 */
export function recomputeStatusFree(el: Computed<any>, create: boolean): boolean {
  if (!eligible(el, create)) return false;
  bumpNotifyEpoch();
  const isEffect = (el as any)._type;
  let devChanged = false;
  if (__OBSERVE__ && attrHooks !== null) attrHooks.recomputeStart(el, create);
  if (!create) {
    deleteFromHeap(el, queueFor(el));
    if (__DEV__) clearSignals(el);
  }
  const wasUninitialized = (el._statusFlags & STATUS_UNINITIALIZED) !== 0;
  const oldcontext = context;
  setContextInternal(el);
  el._depsTail = null;
  el._depGen++;
  el._flags = REACTIVE_RECOMPUTING_DEPS;
  el._time = clock;
  let value = el._pendingValue === NOT_PENDING ? el._value : el._pendingValue;
  const oldHeight = el._height;
  let missedWake = false;
  let prevStrictRead: string | false = false;
  let prevBlockGuard = false;
  if (__DEV__) {
    // A computation's run is its own read scope (see recompute).
    prevStrictRead = setStrictRead(false);
    prevBlockGuard = setBlockGuard(false);
  }
  const prevTracking = swapTracking(true);
  const prevLatestRead = latestReadActive;
  setLatestReadActive(false);
  const isStaleEffect = isEffect && isEffect !== EFFECT_USER;
  const prevStale = isStaleEffect ? swapStale(true) : false;
  let failed = false;
  try {
    value = el._fn(value);
    if (__DEV__) devVerifySync(el, value);
    // First run: UNINITIALIZED → committed, plus the effect notifier's
    // settled call. On an extension-less node that is all clearStatus does.
    if (wasUninitialized) clearStatus(el, create);
  } catch (e) {
    failed = true;
    threw(el, e);
  } finally {
    swapTracking(prevTracking);
    setLatestReadActive(prevLatestRead);
    if (__DEV__) {
      setStrictRead(prevStrictRead);
      setBlockGuard(prevBlockGuard);
    }
    if (isStaleEffect) swapStale(prevStale);
    missedWake = (el._flags & REACTIVE_MISSED_WAKE) !== 0;
    el._flags = REACTIVE_NONE | (create ? el._flags & REACTIVE_SNAPSHOT_STALE : 0);
    setContextInternal(oldcontext);
  }

  if (!failed) {
    trimStaleDeps(el);
    if (__OBSERVE__) {
      let fanIn = 0;
      for (let d = el._deps; d !== null; d = d._nextDep) fanIn++;
      if (fanIn >= GRAPH_SIZE_WARN_AT) noteFanIn(el, fanIn);
    }
    const compareValue = el._pendingValue === NOT_PENDING ? el._value : el._pendingValue;
    let valueChanged = false;
    let comparatorThrew = false;
    try {
      valueChanged =
        (!isEffect && wasUninitialized) || !el._equals || !el._equals(compareValue, value);
    } catch (e) {
      // A throwing comparator is an error of this node's computation (see
      // recompute) — and it disproves `noThrow`.
      comparatorThrew = true;
      threw(el, e);
    }
    if (__OBSERVE__ && attrHooks !== null) {
      devChanged = valueChanged && !comparatorThrew;
      if (devChanged && !isEffect && !create) attrHooks.derivedChanged(el);
    }
    if (isEffect && valueChanged) {
      (el as any)._modified = !comparatorThrew;
      if (!create) {
        el._queue.enqueue(
          isEffect,
          ((el as any)._boundRunEffect ??= GlobalQueue._runEffect.bind(null, el))
        );
        // Contested effect (#3322), mainline commit — recompute's arm with
        // `activeTransition === null`.
        let prev: Transition | null = (el as any)._valueTransition;
        if (prev !== null) {
          (el as any)._valueTransition = null;
          if ((prev = currentTransition(prev)) !== null && !prev._done)
            (prev._contested ??= []).push(el);
        }
      }
    }
    if (comparatorThrew) {
      // Errored by the comparator: the status propagation owns notification.
    } else if (valueChanged) {
      // Plain world: first runs and effects commit directly; a memo re-run
      // stages (the pending round-trip is load-bearing for mid-batch pulls —
      // see the stage-3 note in recompute).
      if (create || isEffect) el._value = value;
      else {
        el._pendingValue = value;
        if (__DEV__) devTrackHeldPending(el);
      }
      if (el._subs !== null) insertSubs(el);
    } else if (el._height != oldHeight) {
      for (let s = el._subs; s !== null; s = s._nextSub) {
        insertIntoHeapHeight(s._sub, queueFor(s._sub));
      }
    }
  }
  if (__OBSERVE__ && attrHooks !== null)
    attrHooks.recomputeEnd(el, create, devChanged, false, false, el._pendingValue !== NOT_PENDING);
  // recompute's tail: a staged value — or a status the deopt route set —
  // rides the pending-node commit.
  const needsPendingCommit =
    el._pendingValue !== NOT_PENDING ||
    (el._statusFlags & (STATUS_PENDING | STATUS_UNINITIALIZED)) !== 0;
  needsPendingCommit && (!create || el._statusFlags & STATUS_PENDING) && queuePendingNode(el);
  if (missedWake) {
    enqueueSub(el);
    schedule();
  }
  return true;
}

GlobalQueue._recomputeStatusFree = recomputeStatusFree;

/**
 * Host options for a `$` block the compiler proved synchronous AND
 * non-throwing (`createMemo(fn, statusFree)`). One shared frozen object:
 * compiled output allocates nothing per call site. Importing it installs the
 * status-free path.
 */
export const statusFree: { readonly sync: true; readonly noThrow: true } = Object.freeze({
  sync: true,
  noThrow: true
} as const);
