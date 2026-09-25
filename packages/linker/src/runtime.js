// Runtime for cold event-domain extraction (slice 3).
//
// A hot shell stands where an event-only `$` block was created, so it has
// the same owner (and error boundary) the original block had. The body lives
// in a domain chunk:
//
// - Loaded (prefetched): the shell runs the replayable prelude, then
//   dispatches the cold block synchronously under the event host with the
//   captured owner — writes, errors and async rejections route exactly as the
//   inline block's did, within the same event dispatch.
// - Cold miss: the prelude still runs synchronously (so `preventDefault()` /
//   `stopPropagation()` and early-return guards keep their effect on the
//   live event); the rest runs when the chunk arrives, against a snapshot of
//   the event members the body reads (`currentTarget` is null after
//   dispatch). A handler whose propagation control is not a prelude is
//   never extracted. If the owner is disposed before the chunk arrives, the
//   deferred run is dropped; a load failure routes to the owner's error
//   boundary.
//
// Prefetch policies (per domain): "load" (right after the entry
// evaluates), "idle" (first idle period after a shell exists; also on first
// user intent), "intent" (first pointer/focus/key/touch intent anywhere),
// "none" (only on a miss).
import { $, dispatchBlock, getOwner, onCleanup, runWithOwner } from "solid-js";

const domains = new Map();
const pendingIntent = new Set();
let intentInstalled = false;
const stats = { hits: 0, misses: 0, loads: 0, loadFailures: 0, dropped: 0 };
// Counters reachable from outside a bundle (tests, measurements).
globalThis[Symbol.for("solid.cold.stats")] = stats;

/** Counters for tests and measurements. */
export function coldStats() {
  return {
    ...stats,
    domains: domains.size,
    loaded: [...domains.values()].filter(d => d.module).length
  };
}

/** Register (once) a domain chunk. `load` is the bundler's dynamic import. */
export function coldDomain(id, load, options = {}) {
  let domain = domains.get(id);
  if (domain) return domain;
  domain = {
    id,
    load,
    module: null,
    promise: null,
    prefetch: options.prefetch ?? "idle",
    scheduled: false
  };
  domains.set(id, domain);
  if (domain.prefetch === "load") queueMicrotask(() => loadDomain(domain));
  return domain;
}

/** Load a domain chunk (deduplicated; retried after a failure). */
export function loadDomain(domain) {
  if (domain.module) return Promise.resolve(domain.module);
  if (!domain.promise) {
    stats.loads++;
    domain.promise = Promise.resolve()
      .then(() => domain.load())
      .then(
        module => (domain.module = module),
        error => {
          stats.loadFailures++;
          domain.promise = null;
          throw error;
        }
      );
  }
  return domain.promise;
}

/** Prefetch every registered domain (e.g. on route load), or those named. */
export function prefetchColdDomains(ids) {
  const list = ids ? ids.map(id => domains.get(id)).filter(Boolean) : [...domains.values()];
  return Promise.all(list.map(loadDomain));
}

function schedule(domain) {
  if (domain.scheduled || domain.module) return;
  domain.scheduled = true;
  if (domain.prefetch === "idle") {
    const idle = globalThis.requestIdleCallback;
    if (idle) idle(() => loadDomain(domain).catch(() => {}), { timeout: 2000 });
    else setTimeout(() => loadDomain(domain).catch(() => {}), 200);
    watchIntent(domain);
  } else if (domain.prefetch === "intent") {
    watchIntent(domain);
  }
}

function watchIntent(domain) {
  pendingIntent.add(domain);
  if (intentInstalled || typeof document === "undefined") return;
  intentInstalled = true;
  const onIntent = () => {
    for (const pending of pendingIntent) loadDomain(pending).catch(() => {});
    pendingIntent.clear();
  };
  for (const type of ["pointerover", "pointerdown", "focusin", "keydown", "touchstart"]) {
    document.addEventListener(type, onIntent, { capture: true, passive: true });
  }
}

function snapshotEvent(event, members) {
  const snapshot = {};
  for (const member of members) snapshot[member] = event[member];
  return snapshot;
}

/**
 * Create the hot shell for an extracted block. `env` returns the captured
 * bindings (read at event time, as the inline body read them); `prelude`
 * replays the leading guards/propagation calls and returns `false` to stop;
 * `snapshot` lists the event members the deferred body reads.
 */
export function coldEvent(domain, key, env, prelude, snapshot) {
  const owner = getOwner();
  let instance;
  const run = (module, event) => {
    instance ??= module[key](env);
    dispatchBlock(instance, event, owner);
  };
  schedule(domain);
  return $(function (event) {
    if (prelude && prelude(event) === false) return;
    if (domain.module) {
      stats.hits++;
      run(domain.module, event);
      return;
    }
    stats.misses++;
    const deferred = snapshot ? snapshotEvent(event, snapshot) : event;
    let disposed = false;
    if (owner) runWithOwner(owner, () => onCleanup(() => (disposed = true)));
    loadDomain(domain).then(
      module => {
        if (disposed) {
          stats.dropped++;
          return;
        }
        run(module, deferred);
      },
      error => {
        dispatchBlock(
          $(function () {
            throw error;
          }),
          deferred,
          owner
        );
      }
    );
  });
}

/**
 * Keep a module the linker retained hot (a small cold dependency shared by
 * several domains) in the entry chunk: the entry passes its namespace here,
 * a reference no bundler can tree-shake.
 */
const retained = (globalThis[Symbol.for("solid.cold.retained")] ??= []);
export function coldRetain(namespace) {
  retained.push(namespace);
}

/** Test helper: forget registered domains. */
export function resetColdRuntime() {
  domains.clear();
  pendingIntent.clear();
  Object.assign(stats, { hits: 0, misses: 0, loads: 0, loadFailures: 0, dropped: 0 });
}
