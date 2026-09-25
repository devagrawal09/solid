// @ts-check
/**
 * Event-domain runtime of the resumable-events prototype (experimental,
 * private). Loaded on first interaction together with the event module; it
 * is the only part that depends on `@solidjs/signals`.
 *
 * - `reconstruct` rebuilds one component instance's *scope* from the record
 *   the server serialized and the manifest's scope descriptor: a root owner,
 *   one signal per recorded signal value, and one render effect per exact
 *   text binding, wired to the text node the server already rendered. The
 *   component function never runs and the template is never re-created.
 * - `invoke` runs a handler exactly once for one dispatch, with the scope's
 *   captures rebound (the event module exports a factory per handler), and
 *   routes a synchronous throw or an async rejection to the recorded
 *   boundary coordinate when a receiver is registered for it, else surfaces
 *   it (reportError and a `solid:resume-failure` event).
 */
import {
  createRoot,
  createSignal,
  createRenderEffect,
  runWithOwner,
  flush
} from "@solidjs/signals";

/** Must match the bootstrap and the compiler. */
export const SCHEMA = 1;

export { flush };

/** @type {Map<string, (error: unknown, info: any) => void>} boundary coordinate → receiver */
const boundaries = new Map();

/**
 * Register the receiver of failures routed to a boundary coordinate (the
 * hydration id the server boundary recorded). A hydrated `Errored` could
 * install one for its own id; the prototype leaves that wiring to the
 * caller.
 */
export function registerBoundary(id, receiver) {
  boundaries.set(id, receiver);
  return () => {
    if (boundaries.get(id) === receiver) boundaries.delete(id);
  };
}

/** Text as `insert` renders a primitive: strings and numbers as text, nullish/boolean as empty. */
function formatText(value) {
  return value == null || typeof value === "boolean" ? "" : String(value);
}

/** The element at `path` (element-child indexes) under `root`. */
function walkPath(root, path) {
  let node = root;
  for (let i = 0; i < path.length; i++) {
    node = node && node.children[path[i]];
  }
  return node || null;
}

/**
 * The text node of a binding: after the `hole`-th `<!--$-->` comment among
 * the element's child nodes (created when the server rendered an empty
 * value), or the element's sole text child.
 */
function locateText(element, hole, doc) {
  if (hole === null) {
    const first = element.firstChild;
    if (first && first.nodeType === 3) return first;
    if (first) return null;
    const text = doc.createTextNode("");
    element.appendChild(text);
    return text;
  }
  let seen = -1;
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 8 && node.data === "$" && ++seen === hole) {
      const next = node.nextSibling;
      if (next && next.nodeType === 3) return next;
      if (next && next.nodeType === 8 && next.data === "/") {
        const text = doc.createTextNode("");
        element.insertBefore(text, next);
        return text;
      }
      return null;
    }
  }
  return null;
}

/**
 * Rebuild an instance's scope. Throws (and creates nothing) when the DOM
 * does not match the descriptor: a text binding without its node is a
 * stale page, never a guess.
 */
export function reconstruct({ key, scope, record, root, dev, report }) {
  const doc = root.ownerDocument;
  const values = record.v || {};
  const bindings = [];
  for (let i = 0; i < scope.bindings.length; i++) {
    const binding = scope.bindings[i];
    const element = walkPath(root, binding.path);
    const text = element && locateText(element, binding.hole, doc);
    if (!text) {
      throw new Error(
        "text binding of `" +
          binding.signal +
          "` at path [" +
          binding.path.join(",") +
          "] has no text node under root " +
          key
      );
    }
    bindings.push({ binding, text });
  }
  const signals = {};
  let dispose = () => {};
  let owner = null;
  createRoot(d => {
    dispose = d;
    for (let i = 0; i < scope.signals.length; i++) {
      const name = scope.signals[i];
      if (!(name in values))
        throw new Error("no serialized value for signal `" + name + "` of " + key);
      const [get, set] = createSignal(values[name]);
      signals[name] = { get, set };
    }
    for (let i = 0; i < bindings.length; i++) {
      const { binding, text } = bindings[i];
      const read = signals[binding.signal].get;
      // Runtime tracking, not a static subscription: the effect reads the
      // signal itself, so what it depends on is decided by the read.
      createRenderEffect(
        () => read(),
        value => {
          const next = formatText(value);
          if (text.data !== next) text.data = next;
        },
        { sync: true }
      );
    }
  });
  const instance = {
    key,
    scope,
    record,
    root,
    signals,
    owner,
    dev,
    report,
    handlers: new Map(),
    disposed: false,
    dispose() {
      instance.disposed = true;
      dispose();
    }
  };
  return instance;
}

/** The captures object a handler factory receives for this instance. */
function scopeObject(instance, handler) {
  const object = {};
  const values = instance.record.v || {};
  for (let i = 0; i < handler.captures.length; i++) {
    const capture = handler.captures[i];
    switch (capture.kind) {
      case "value":
        object[capture.name] = values[capture.name];
        break;
      case "constant":
        object[capture.name] = capture.value;
        break;
      case "signal-setter":
        object[capture.name] = instance.signals[capture.signal].set;
        break;
      case "signal-accessor":
        object[capture.name] = instance.signals[capture.signal].get;
        break;
      case "import":
        break;
      default:
        throw new Error("unknown capture kind " + capture.kind);
    }
  }
  return object;
}

/**
 * Run `handler` once for one dispatch. `event` is the live event (warm) or
 * the snapshot (cold). Failures route to the recorded boundary.
 */
export function invoke(instance, handler, factory, event, live) {
  if (instance.disposed) return;
  let fn = instance.handlers.get(handler.id);
  if (!fn) {
    fn = factory(scopeObject(instance, handler));
    instance.handlers.set(handler.id, fn);
  }
  let result;
  try {
    // Event-time code runs with no owner, like an ordinary handler; the
    // instance owner exists for the scope's effects and disposal.
    result = runWithOwner(null, () => fn(event));
  } catch (error) {
    route(instance, handler, error, event);
    return;
  }
  if (instance.dev && !live && event && event.calls) {
    // The body's own prelude calls landed on the inert snapshot; the
    // bootstrap already applied the same calls to the live event. Anything
    // else the body called on the snapshot had no effect: report it.
    const declared = handler.prelude.filter(op => op.op !== "guard").map(op => op.op);
    for (const call of event.calls) {
      if (declared.indexOf(call) < 0) {
        instance.report({
          kind: "invariant",
          message:
            "handler " +
            handler.id +
            " called " +
            call +
            "() outside its compiled prelude; the call had no effect on the original event",
          node: instance.root,
          key: instance.key,
          handler: handler.id
        });
      }
    }
  }
  if (result && typeof result.then === "function") {
    result.then(undefined, error => route(instance, handler, error, event));
  }
}

function route(instance, handler, error, event) {
  const info = {
    kind: "handler-error",
    message:
      "handler " +
      handler.id +
      " failed: " +
      (error instanceof Error ? error.message : String(error)),
    node: instance.root,
    key: instance.key,
    handler: handler.id,
    boundary: instance.record.b,
    live: !!(event && event.live !== false),
    error
  };
  const receiver = instance.record.b != null ? boundaries.get(instance.record.b) : undefined;
  if (receiver) {
    receiver(error, info);
    return;
  }
  instance.report(info);
}
