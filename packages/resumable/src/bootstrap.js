// @ts-check
/**
 * The inline bootstrap of the resumable-events prototype (experimental,
 * private). Zero imports: this file is built to a classic IIFE script
 * (`dist/bootstrap.iife.js`, global `solidResume`) that the server inlines
 * before the body, so it is live for the first interaction.
 *
 * What it does, exactly once per event:
 *
 * 1. Delegates every event type the manifest names at `document` (bubble
 *    phase, where ordinary Solid delegation also listens).
 * 2. Walks from the target to the nearest ancestor-or-self carrying a
 *    `data-sr="<key>/<n>"` coordinate whose element binds this event type,
 *    resolves the instance record the server serialized (`_$HY.r["sr:<key>"]`)
 *    and the handler descriptor in the manifest. Anything missing or stale
 *    is a *visible* failure, never a silent drop.
 * 3. Cold (the handler's event module is not loaded): runs the handler's
 *    synchronous prelude on the live event — `preventDefault()` /
 *    `stopPropagation()` and the `if (…) return;` guards the compiler proved
 *    lead the body — takes a snapshot of exactly the event fields the body
 *    reads, queues the snapshot in dispatch order, and starts loading the
 *    event module and the runtime (dynamic `import()`, CSP-safe). When both
 *    arrive and verify (schema, module id, per-handler source hash, action
 *    ids), the queue drains in order: each item whose scope is still live
 *    reconstructs the scope once and invokes the handler once with its own
 *    snapshot.
 * 4. Warm (loaded): the handler runs synchronously inside the live dispatch
 *    with the live event, like an ordinary delegated handler.
 */

/** Manifest schema this bootstrap understands. */
export const SCHEMA = 1;

/**
 * @typedef {{ schema: number; build: string; runtime: string; modules: Record<string, { url: string; file: string }>;
 *   scopes: any[]; handlers: any[] }} Manifest
 */

/**
 * Install the bootstrap. `options.load` overrides dynamic import (tests),
 * `options.report` receives every failure (default: console.error plus a
 * `solid:resume-failure` event on the element and `reportError`).
 */
export function install(manifest, options) {
  options = options || {};
  const doc = options.document || document;
  const win = options.window || window;
  const hy = (win._$HY = win._$HY || { r: {} });
  hy.r = hy.r || {};
  const report =
    options.report ||
    function (failure) {
      console.error("[solid resumable] " + failure.kind + ": " + failure.message, failure);
      if (failure.node && failure.node.dispatchEvent) {
        failure.node.dispatchEvent(
          new win.CustomEvent("solid:resume-failure", { bubbles: true, detail: failure })
        );
      }
      if (failure.error !== undefined && win.reportError) win.reportError(failure.error);
    };
  const stats = { cold: 0, warm: 0, dropped: 0, guarded: 0, failed: 0, loads: 0 };
  const state = {
    manifest,
    hy,
    doc,
    win,
    load: options.load || (url => import(/* @vite-ignore */ url)),
    report,
    stats,
    /** @type {Map<string, any>} module id → entry */
    modules: new Map(),
    runtime: null,
    /** @type {Map<string, any>} hydration key → reconstructed instance */
    instances: new Map(),
    /** @type {Set<string>} disposed hydration keys */
    disposed: new Set(),
    seq: 0,
    dev: options.dev === undefined ? false : !!options.dev
  };
  if (!manifest || manifest.schema !== SCHEMA) {
    report({
      kind: "stale-manifest",
      message:
        "manifest schema " +
        (manifest && manifest.schema) +
        " is not " +
        SCHEMA +
        "; nothing resumes",
      node: null
    });
    return null;
  }
  const byId = {};
  for (let i = 0; i < manifest.handlers.length; i++)
    byId[manifest.handlers[i].id] = manifest.handlers[i];
  const scopes = {};
  for (let i = 0; i < manifest.scopes.length; i++)
    scopes[manifest.scopes[i].id] = manifest.scopes[i];
  state.handlerById = byId;
  state.scopeById = scopes;
  const types = [];
  for (const id in byId) if (types.indexOf(byId[id].event) < 0) types.push(byId[id].event);
  const listeners = [];
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    const listener = e => dispatch(state, e);
    doc.addEventListener(type, listener);
    listeners.push([type, listener]);
  }
  return {
    stats,
    /** Drop every pending and future event of an instance (its DOM is gone or replaced). */
    dispose(key) {
      state.disposed.add(key);
      const instance = state.instances.get(key);
      if (instance && instance.dispose) instance.dispose();
      state.instances.delete(key);
    },
    /** Load a handler's module (and the runtime) ahead of interaction. */
    prefetch(handlerId) {
      const handler = byId[handlerId];
      if (!handler) return Promise.reject(new Error("unknown handler " + handlerId));
      return ensureLoaded(state, moduleOf(handler)).then(() => undefined);
    },
    /** Settle every in-flight load (tests). */
    settled() {
      const pending = [];
      state.modules.forEach(entry => {
        if (entry.promise) pending.push(entry.promise.catch(() => {}));
      });
      return Promise.all(pending).then(() => undefined);
    },
    uninstall() {
      for (let i = 0; i < listeners.length; i++)
        doc.removeEventListener(listeners[i][0], listeners[i][1]);
    }
  };
}

function moduleOf(handler) {
  return handler.id.slice(0, handler.id.indexOf("."));
}

function dispatch(state, e) {
  let node = e.composedPath ? e.composedPath()[0] : e.target;
  while (node && node !== state.doc) {
    if (node.getAttribute) {
      const coordinate = node.getAttribute("data-sr");
      if (coordinate) {
        const slash = coordinate.indexOf("/");
        const key = coordinate.slice(0, slash);
        const index = +coordinate.slice(slash + 1);
        const bound = resolve(state, e, node, key, index);
        if (bound) {
          handle(state, e, node, bound);
          if (e.cancelBubble) return;
        }
      }
    }
    node = node.parentNode;
  }
}

/** The instance record, scope and handler a coordinate binds for `e.type`, or null. */
function resolve(state, e, node, key, index) {
  if (state.disposed.has(key)) return null;
  const record = state.hy.r["sr:" + key];
  if (!record) {
    fail(state, {
      kind: "missing-record",
      message: "no serialized instance record for key " + key,
      node,
      key
    });
    return null;
  }
  const scope = state.scopeById[record.s];
  if (!scope) {
    fail(state, {
      kind: "stale-record",
      message: "instance record names scope " + record.s + " the manifest does not have",
      node,
      key
    });
    return null;
  }
  const element = scope.elements[index];
  if (!element) {
    fail(state, {
      kind: "stale-record",
      message: "element " + index + " is not in scope " + record.s,
      node,
      key
    });
    return null;
  }
  const handlerId = element.on[e.type];
  if (!handlerId) return null;
  const handler = state.handlerById[handlerId];
  if (!handler) {
    fail(state, {
      kind: "stale-record",
      message: "handler " + handlerId + " is not in the manifest",
      node,
      key
    });
    return null;
  }
  return { record, scope, handler, key };
}

function handle(state, e, node, bound) {
  const handler = bound.handler;
  const entry = ensureEntry(state, moduleOf(handler));
  if (entry.status === "ready" && state.runtime) {
    state.stats.warm++;
    const instance = getInstance(state, node, bound);
    if (!instance) return;
    const factory = entry.module[handler.export];
    Object.defineProperty(e, "currentTarget", { configurable: true, get: () => node });
    state.runtime.invoke(instance, handler, factory, e, true);
    return;
  }
  if (entry.status === "stale") {
    fail(state, {
      kind: "stale-module",
      message: entry.reason,
      node,
      key: bound.key,
      handler: handler.id
    });
    return;
  }
  // Cold: synchronous prelude on the live event, snapshot, queue.
  for (let i = 0; i < handler.prelude.length; i++) {
    const op = handler.prelude[i];
    if (op.op === "guard") {
      if (guardHolds(op, readPath(e, node, op.path))) {
        state.stats.guarded++;
        return;
      }
    } else e[op.op]();
  }
  state.stats.cold++;
  const snapshot = takeSnapshot(e, node, handler.snapshot);
  entry.queue.push({ seq: state.seq++, node, bound, snapshot });
  ensureLoaded(state, moduleOf(handler)).then(
    () => drain(state, entry),
    error => {
      const queued = entry.queue.splice(0);
      for (let i = 0; i < queued.length; i++) {
        state.stats.failed++;
        fail(state, {
          kind: "chunk-failed",
          message: "the event module could not be loaded: " + (error && error.message),
          node: queued[i].node,
          key: queued[i].bound.key,
          handler: queued[i].bound.handler.id,
          error
        });
      }
    }
  );
}

function guardHolds(op, value) {
  switch (op.test) {
    case "truthy":
      return !!value;
    case "falsy":
      return !value;
    case "eq":
      return value == op.value;
    case "neq":
      return value != op.value;
    default:
      return false;
  }
}

function readPath(e, node, path) {
  let value = e;
  for (let i = 0; i < path.length; i++) {
    if (value == null) return undefined;
    // The handler's own currentTarget is the element that carries the
    // coordinate, as it would be for a delegated handler.
    value = i === 0 && path[0] === "currentTarget" ? node : value[path[i]];
  }
  return value;
}

/** The event as the deferred body will see it: approved fields only, inert methods. */
function takeSnapshot(e, node, paths) {
  const snapshot = {
    type: e.type,
    defaultPrevented: e.defaultPrevented,
    live: false,
    calls: [],
    preventDefault() {
      this.calls.push("preventDefault");
    },
    stopPropagation() {
      this.calls.push("stopPropagation");
    },
    stopImmediatePropagation() {
      this.calls.push("stopImmediatePropagation");
    }
  };
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (path.length === 1) snapshot[path[0]] = e[path[0]];
    else {
      const root = path[0] === "currentTarget" ? node : e[path[0]];
      const holder = snapshot[path[0]] || (snapshot[path[0]] = {});
      holder[path[1]] = root == null ? undefined : root[path[1]];
    }
  }
  return snapshot;
}

function ensureEntry(state, id) {
  let entry = state.modules.get(id);
  if (!entry) {
    entry = { id, status: "idle", module: null, promise: null, queue: [], reason: "" };
    state.modules.set(id, entry);
  }
  return entry;
}

function ensureLoaded(state, id) {
  const entry = ensureEntry(state, id);
  if (entry.status === "ready") return Promise.resolve(entry);
  if (entry.status === "stale") return Promise.reject(new Error(entry.reason));
  if (entry.promise) return entry.promise;
  const manifest = state.manifest;
  const info = manifest.modules[id];
  state.stats.loads++;
  entry.status = "loading";
  const runtime = state.runtime
    ? Promise.resolve(state.runtime)
    : Promise.resolve()
        .then(() => state.load(manifest.runtime))
        .then(mod => {
          if (!mod || mod.SCHEMA !== SCHEMA) throw new Error("runtime schema mismatch");
          state.runtime = mod;
          return mod;
        });
  const module = info
    ? Promise.resolve().then(() => state.load(info.url))
    : Promise.reject(new Error("module " + id + " is not in the manifest"));
  entry.promise = Promise.all([runtime, module]).then(
    parts => {
      const mod = parts[1];
      const reason = verify(state, id, mod);
      entry.promise = null;
      if (reason) {
        entry.status = "stale";
        entry.reason = reason;
        throw new Error(reason);
      }
      entry.module = mod;
      entry.status = "ready";
      return entry;
    },
    error => {
      entry.promise = null;
      // A load failure is retried by the next event; a stale module is not.
      if (entry.status !== "stale") entry.status = "idle";
      throw error;
    }
  );
  return entry.promise;
}

/** Identity check of a loaded event module against the manifest; a reason when stale. */
function verify(state, id, mod) {
  const record = mod && mod.__sr;
  if (!record) return "event module " + id + " carries no __sr identity record";
  if (record.schema !== SCHEMA) return "event module schema " + record.schema + " is not " + SCHEMA;
  if (record.module !== id) return "event module identity " + record.module + " is not " + id;
  const handlers = state.manifest.handlers;
  for (let i = 0; i < handlers.length; i++) {
    const handler = handlers[i];
    if (moduleOf(handler) !== id) continue;
    if (record.handlers[handler.export] !== handler.source) {
      return (
        "handler " +
        handler.id +
        " source hash " +
        record.handlers[handler.export] +
        " is not " +
        handler.source +
        " (stale build)"
      );
    }
    if (typeof mod[handler.export] !== "function")
      return "handler " + handler.id + " export is missing";
    for (let j = 0; j < handler.captures.length; j++) {
      const capture = handler.captures[j];
      if (
        capture.kind === "import" &&
        capture.import === "action" &&
        record.actions[capture.name] !== capture.id
      ) {
        return (
          "action " +
          capture.name +
          " has id " +
          record.actions[capture.name] +
          ", the manifest expects " +
          capture.id
        );
      }
    }
  }
  return "";
}

function getInstance(state, node, bound) {
  const key = bound.key;
  let instance = state.instances.get(key);
  if (instance) return instance;
  const root = node.closest ? node.closest("[_hk]") : null;
  if (!root || root.getAttribute("_hk") !== key) {
    fail(state, {
      kind: "root-mismatch",
      message: "the nearest hydration root of the element is not " + key,
      node,
      key
    });
    return null;
  }
  try {
    instance = state.runtime.reconstruct({
      key,
      scope: bound.scope,
      record: bound.record,
      root,
      dev: state.dev,
      report: failure => fail(state, failure)
    });
  } catch (error) {
    fail(state, {
      kind: "reconstruct-failed",
      message: String(error && error.message),
      node,
      key,
      error
    });
    return null;
  }
  state.instances.set(key, instance);
  return instance;
}

function drain(state, entry) {
  const queued = entry.queue.splice(0).sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < queued.length; i++) {
    const item = queued[i];
    const key = item.bound.key;
    if (state.disposed.has(key) || !item.node.isConnected) {
      state.stats.dropped++;
      continue;
    }
    const instance = getInstance(state, item.node, item.bound);
    if (!instance) continue;
    const handler = item.bound.handler;
    state.runtime.invoke(instance, handler, entry.module[handler.export], item.snapshot, false);
    // Each queued event was its own native task: settle its writes before
    // the next one reads, as the browser would have between two dispatches.
    state.runtime.flush();
  }
}

function fail(state, failure) {
  state.report(failure);
}
