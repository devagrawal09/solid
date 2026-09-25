// Capability: streamLedger — the document fragment ledger and the streamed
// (`<id>_fr`) branch of a loading boundary. Requires loadingMarkers (the
// branch reuses its resume machinery). A client graph whose server graph
// never streams a boundary fragment omits it: the inline `$df` then keeps its
// raw swap (`$dfr`), which is exactly the pre-boot behavior.
import { createLoadingBoundary as coreLoadingBoundary, type Owner } from "@solidjs/signals";
import { sharedConfig, slots, markInstalled, isHydrationDone, CAP_STREAM_LEDGER } from "./state.js";
import {
  initBoundaryResume,
  waitAndResume,
  scheduleResumeAfterAssets,
  afterAssets
} from "./boundaries.js";

// === The document fragment ledger (one reveal owner) ===
//
// The streaming layer's inline script owns only the parse-time swap
// MECHANICS ($dfr: replace the `pl-*` range with the template payload, then
// record the reveal as `_$HY.v[id] = 1`); this module owns the reveal
// POLICY, and it answers every "what may the document still deliver?"
// question from records rather than DOM scans. The ledger's states:
//
// - DECLARED: the serializer writes `<id>_fr` into `_$HY.r` the moment a
//   boundary registers a pending fragment, so a declaration always reaches
//   the client before the content it promises.
// - SETTLED: seroval marks the `_fr` ref (`.s`) when the resolving chunk
//   executes — the same task batch that carries the fragment's content.
// - REVEALED: `_$HY.v[id]`, marked by $dfr itself — valid across the
//   pre-boot window (swaps that ran before this module loaded are on
//   record too).
// - CLAIMED / HELD: this module's post-boot policy state below.
//
// installStreamLedgerHydration() installs `_$HY.f` — from that moment every
// `$df(id)` the stream emits routes here (the same one-owner handoff the
// head-patch runtime uses via `_$HY.h`) — and publishes the ledger as
// `_$HY.fr` ({ pending, subscribe, claim, release }) so integrations (the
// frames client's document adoption) share this one answer instead of
// scanning for `pl-*` templates or patching `_$HY.fe` themselves.
//
// Policy: while global hydration is still in progress, swaps proceed —
// boundaries are coming to claim them. Once hydration completes, a swap only
// proceeds when a claimant is on record for the id: a boundary inside a
// deferred claim scope (a frames slot fill, a lazy route module) can still
// be waiting on the fragment after global hydration reads as done, and its
// markup IS the boundary's content — swapping it with no claimant would
// leave inert nodes in a range the client may re-render (#2964). Unclaimed
// late swaps are HELD (placeholder, fallback, and template all stay in
// place) and replayed when their claimant registers.
const _fragments = new Map<string, { claimed?: boolean; held?: boolean }>();
const _truncated = new Set<string>();
const _revealSubs = new Set<(id: string, parent?: ParentNode) => void>();
const _truncationRejectors = new Map<string, (err: Error) => void>();

function fragmentState(id: string) {
  let f = _fragments.get(id);
  if (!f) _fragments.set(id, (f = {}));
  return f;
}

function fragmentPolicy(id: string) {
  const f = fragmentState(id);
  if (!isHydrationDone() || f.claimed) return (globalThis as any).$dfr(id);
  f.held = true;
  return 0;
}

// A held swap replays the moment its boundary shows up — BEFORE any of the
// boundary's paths walk the DOM. This covers the settled path too: a held
// swap arrives in the same chunk that resolves the `<id>_fr` ref, so a
// boundary rendering later sees a settled ref and hydrates straight through
// assuming the content is in the DOM. It is, once this runs.
function replayHeldFragment(id: string) {
  const f = _fragments.get(id);
  if (f && f.held) {
    f.held = false;
    (globalThis as any).$dfr(id);
  }
}

// A boundary registering against a still-pending `<id>_fr` goes on record as
// the fragment's claimant, so a late swap lands for its resume to claim. The
// claim is cleared by release() when the boundary resumes or is disposed.
function claimFragment(id: string) {
  fragmentState(id).claimed = true;
  replayHeldFragment(id);
}

// Retire a claim (the disposal half of the ledger's claim/release seam):
// after the claimant is gone, a late swap must be held rather than landing
// in a range nobody will claim.
function releaseFragment(id: string) {
  const f = _fragments.get(id);
  if (f) f.claimed = false;
}

/**
 * May the document still deliver fragment `id`'s content? An unsettled
 * declaration is in flight; a settled one stays pending until its swap runs
 * — `_$HY.v` records completed swaps, and the content template still being
 * in the document covers every deferred-swap state at once (style-gated,
 * retry-queued, reveal-grouped, policy-held) without tracking each. A
 * settled declaration with neither was inlined into the shell — it never
 * streamed, nothing is coming. (getElementById is an id-table lookup, not
 * the tree scan this ledger replaces.)
 *
 * Content whose `pl-*` placeholder range is GONE can never swap either
 * (#2978, secondary defect): a frame refetch that morphs over the region
 * removes the placeholder, and the swap has nowhere to land — the stale
 * content template alone must not keep the ledger reading "in flight" for
 * the rest of the page's life. The placeholder always parses before its
 * content, so with the template present its absence can only mean removal.
 */
function fragmentPending(hy: any, id: string): boolean {
  if (_truncated.has(id)) return false;
  const ref = hy.r[id + "_fr"];
  if (!ref || typeof ref !== "object") return false;
  if (!ref.s) return true;
  if (hy.v && hy.v[id]) return false;
  if (!document.getElementById(id)) return false;
  return !!document.getElementById("pl-" + id);
}

/**
 * A settled declaration whose swap can no longer land: the `pl-*` placeholder
 * is still in the document (so $df never ran and the content wasn't inlined)
 * but no content template exists and none is coming (`.s` is set — the
 * resolving chunk already executed). This is the SUPERSEDED fragment shape:
 * an outer boundary settled first and shipped the converged branch, retiring
 * this fragment's markup before it streamed. Its DOM truth is the fallback.
 */
function fragmentSuperseded(id: string): boolean {
  const hy = (globalThis as any)._$HY;
  if (hy && hy.v && hy.v[id]) return false;
  if (document.getElementById(id)) return false;
  return !!document.getElementById("pl-" + id);
}

function anyFragmentPending(): boolean {
  const hy = (globalThis as any)._$HY;
  if (!hy || !hy.r) return false;
  for (const key in hy.r) {
    if (key.length > 3 && key.endsWith("_fr") && fragmentPending(hy, key.slice(0, -3))) {
      return true;
    }
  }
  return false;
}

function subscribeFragments(cb: (id: string, parent?: ParentNode) => void): () => void {
  _revealSubs.add(cb);
  return () => _revealSubs.delete(cb);
}

// Truncation (#2958): a stream that ends without settling its declarations
// would otherwise leave boundaries waiting forever. The parser finishing
// (DOMContentLoaded) is the document transport's close — any `_fr` still
// unsettled then can never settle, because the script that would resolve it
// executes during parse. Each one becomes a rejected fragment: an
// error-class write, distinguishable from a server-sent rejection by its
// error, surfaced through the boundary's normal rejection path. The sweep
// only arms when the runtime booted while the document was still streaming;
// a runtime loaded after parse can't tell a completed page from a truncated
// one and stays out of it.
function watchTruncation(hy: any) {
  if (typeof document === "undefined" || document.readyState !== "loading") return;
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      if (!hy.r) return;
      for (const key in hy.r) {
        if (key.length <= 3 || !key.endsWith("_fr")) continue;
        const ref = hy.r[key];
        if (ref && typeof ref === "object" && !ref.s) markTruncated(hy, key.slice(0, -3));
      }
      // A macrotask later, on purpose: the fragment rejections above release
      // their boundaries through microtask chains (abort race -> resume ->
      // fresh render), and that teardown disposes the computations that
      // adopted pending owner-id refs while hydrating. Rejecting those refs
      // synchronously would race the disposal and land an unhandled error in
      // a still-live computation, halting the reactive system. After the
      // boundaries have released, whoever still holds a pending ref (keyed
      // consumers like the router's query channel, boundaries waiting on a
      // sync-serialized data ref) is exactly who needs the rejection.
      setTimeout(() => rejectTruncatedRefs(hy));
    },
    { once: true }
  );
}

// The fragment pass above releases BOUNDARIES, but the registry also carries
// plain serialized promises — owner-id computation values and library-keyed
// data refs (e.g. @solidjs/router's query channel). A truncated stream
// leaves those forever-pending too. The settle scripts execute during parse,
// so at DOMContentLoaded every still-pending seroval resolver ({p, s, f},
// kept in the cross-reference scope `self.$R` — indexed values on the
// global for the wire the hydration serializer emits, or inside per-scope
// arrays for scoped renders) is dead. What each one needs depends on who is
// left holding its promise:
//
// - A ref GONE from the registry was consumed one-shot by a keyed consumer
//   (the router deletes `_$HY.r[key]` on load) — that consumer holds the
//   bare promise and hangs permanently unless it actually rejects, and its
//   `.then` chain is built for rejections. Reject through the resolver.
//   Walking the resolvers rather than the registry keys is what reaches
//   these at all.
// - A ref STILL in the registry either was adopted by a live reactive
//   computation (owner-id channel — never deleted) or awaits a late reader.
//   Rejecting those promises raw lands an unhandled error inside live
//   computations (no boundary routes it — the fragment pass already
//   released the boundaries) and halts the reactive system. Deleting the
//   entry instead makes every future presence check (`sharedConfig.has`)
//   fall through to a fresh compute/fetch — recovery, not failure — while
//   already-adopted computations keep their pre-existing stall until their
//   sources re-run.
//
// Settled promises carry the status stamp (`.s`) the settle helpers write,
// and the fragment pass stamps rejected `_fr` declarations before this
// runs, so both are skipped.
function rejectTruncatedRefs(hy: any) {
  const R = (globalThis as any).$R;
  if (!R || typeof R !== "object") return;
  let registryKeys: Map<any, string> | undefined;
  const sweep = (entry: any) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.f !== "function" ||
      !entry.p ||
      typeof entry.p.then !== "function" ||
      entry.p.s
    )
      return;
    if (!registryKeys) {
      registryKeys = new Map();
      for (const key in hy.r) registryKeys.set(hy.r[key], key);
    }
    const key = registryKeys.get(entry.p);
    if (key !== undefined) {
      delete hy.r[key];
      return;
    }
    const err = new Error("Hydration value was truncated: the stream ended before it settled.");
    // Mirror seroval's failure helper: reject through the resolver and stamp
    // the promise's status for status-based readers.
    entry.f(err);
    entry.p.s = 2;
    entry.p.v = err;
    // Guard the harness itself against an unhandled-rejection report; the
    // consumer observes the rejection through its own chain.
    entry.p.then(undefined, () => {});
  };
  for (const key in R) {
    const value = R[key];
    if (Array.isArray(value)) for (const entry of value) sweep(entry);
    else sweep(value);
  }
}

function markTruncated(hy: any, id: string) {
  if (_truncated.has(id)) return;
  _truncated.add(id);
  const err = new Error(
    `Hydration fragment "${id}" was truncated: the stream ended before its content arrived.`
  );
  const ref = hy.r[id + "_fr"];
  if (ref && typeof ref === "object") {
    ref.s = 2;
    ref.v = err;
  }
  const reject = _truncationRejectors.get(id);
  if (reject) {
    _truncationRejectors.delete(id);
    reject(err);
  }
  // No parent argument distinguishes this from a reveal: subscribers
  // re-evaluate pending state rather than adopting new content.
  for (const sub of _revealSubs) sub(id);
}

// A boundary already waiting on `<id>_fr` when truncation is detected needs
// its wait to reject — the ref's promise itself can never settle. The abort
// promise loses the race to every normally-delivered fragment.
function fragmentAbort(id: string): Promise<never> {
  return new Promise<never>((_, reject) => _truncationRejectors.set(id, reject));
}

// The `<id>_fr` branch of a hydrating loading boundary (see boundaries.ts,
// which reaches it through `slots.stream` once the boundary found a fragment
// declaration and has no resume queued).
function streamBoundary(
  o: Owner,
  id: string,
  fn: () => any,
  fallback: () => any,
  options: { on?: () => any } | undefined,
  assetPromise: Promise<void> | undefined,
  state: { q: boolean }
) {
  const fr = sharedConfig.load!(id + "_fr");
  // A swap held for this boundary (arrived post-done, pre-claim) must
  // land before any branch below reads the DOM — the settled branches
  // all assume $df already ran.
  replayHeldFragment(id);

  if (fr && typeof fr === "object" && fr.s === 1 && !assetPromise && !fragmentSuperseded(id)) {
    // Fragment already settled and swapped in ($df ran before hydration):
    // the content is in the DOM, so hydrate straight through. The fallback
    // only hydrates when it is actually showing — rendering it here would
    // create phantom client DOM and poison insert's node bookkeeping
    // (#2801 bug 1).
    sharedConfig.gather?.(id);
    return coreLoadingBoundary(fn, fallback, options);
  }

  state.q = true;
  const [, resume] = initBoundaryResume(o, id);

  if (fr && typeof fr === "object" && fr.s === 1 && fragmentSuperseded(id)) {
    // SUPERSEDED (#2801's inverse): the declaration settled but its markup
    // was retired before it shipped — an outer boundary settled first and
    // its fragment carries the final branch instead, so this placeholder
    // will never swap. The DOM shows this boundary's fallback: hydrate
    // that (it IS showing), then resume WITHOUT claiming — the children
    // must render as fresh client DOM off the settled records, because
    // there is no server-rendered content branch to adopt. Hydrating
    // straight through here claims keys the document never emitted (the
    // welcome/status mid-stream ticker miss).
    afterAssets(assetPromise, () => resume(false));
    return fallback();
  }

  if (fr && typeof fr === "object" && (fr.s === 1 || fr.s === 2)) {
    if (fr.s === 2) {
      // Rejected stream fragments swap to an empty template; any outer error fallback
      // has to be created as fresh client DOM, not claimed from server markup.
      // Nothing else consumes the settled-rejected `_fr` promise once this
      // branch takes over — swallow it so a rejected fragment (error
      // finalize or a client-hole handoff) doesn't surface as an
      // unhandled rejection.
      (fr as Promise<never>).catch?.(() => {});
      afterAssets(assetPromise, () => resume(false));
      return undefined;
    }
    scheduleResumeAfterAssets(id, resume, assetPromise);
    return undefined;
  }

  // The fragment is still streaming, and global hydration may already
  // read as "done" — this boundary can be rendering inside a deferred
  // claim scope (a frames slot fill, behind a lazy route module) that
  // runs after the root sync pass (#2964). Go on record as the
  // fragment's claimant so the reveal policy swaps the late content in
  // for this resume to claim instead of holding it; if the swap already
  // arrived and was held awaiting a claimant, replay it now.
  claimFragment(id);
  waitAndResume(fr, resume, assetPromise, false, fragmentAbort(id));
  return fallback();
}

/**
 * Capability installer: the streamed-fragment ledger. Takes ownership of
 * streamed-fragment reveals: the header script creates `_$HY` before any
 * module runs, so the hook is in place before the first `$df` the stream can
 * emit under hydration — and installing here (not module load) keeps
 * bundles that never hydrate a stream free of it.
 *
 * @internal
 */
export function installStreamLedgerHydration(): void {
  slots.stream = streamBoundary;
  slots.releaseFragment = releaseFragment;
  markInstalled(CAP_STREAM_LEDGER);
  const hy = (globalThis as any)._$HY;
  if (hy && !hy.fr) {
    if (!hy.f) hy.f = fragmentPolicy;
    // claim/release: the same claimant contract Loading boundaries use, for
    // integrations that own server-rendered markup wholesale (#2978 — the
    // frames document adoption claims the placeholders inside its region,
    // whose <Loading> producers ran on the server and have no client
    // boundary to ever register).
    hy.fr = {
      pending: anyFragmentPending,
      subscribe: subscribeFragments,
      claim: claimFragment,
      release: releaseFragment
    };
    // Every $dfr announces its swap through `_$HY.fe`; fanning it out here
    // gives ledger subscribers one channel for "content just landed".
    const prevFe = hy.fe;
    hy.fe = (id: string, parent?: ParentNode) => {
      prevFe && prevFe(id, parent);
      for (const sub of _revealSubs) sub(id, parent);
    };
    watchTruncation(hy);
  }
}
