// A minimal stand-in for `@solidjs/web`'s compiled-output primitives, so the
// blocks-v2 benchmarks run the REAL compiler output (JSX holes, component
// calls, event bindings) against the signals runtime without jsdom (whose
// cost would drown the reactive work being measured).
//
// It mirrors the parts of `@solidjs/web` the measured paths depend on:
// `insert` wraps a function child in a render effect and renders a `$` block
// child through `renderBlock` (the same sink check `@solidjs/web` does), an
// event handler that is a block is dispatched through `dispatchBlock`, and
// `createComponent` is `untrack(() => Comp(props))`. Nodes are plain objects:
// `template(html)` builds one root with a child per `<!>` marker.
import {
  blockFlags,
  createMemo,
  createRenderEffect,
  dispatchBlock,
  isBlock,
  renderBlock,
  untrack
} from "@solidjs/signals";

class Node {
  constructor() {
    this.firstChild = null;
    this.nextSibling = null;
    this.v = undefined;
    this.ev = null;
  }
  // Delegated handlers are assigned as `el.$$click = handler`.
  set $$click(handler) {
    this.ev = handler;
    listeners.push(handler);
  }
}
function node() {
  return new Node();
}

export function template(html) {
  const markers = html.split("<!>").length - 1;
  return () => {
    const root = node();
    let prev = null;
    for (let i = 0; i < markers; i++) {
      const child = node();
      if (prev) prev.nextSibling = child;
      else root.firstChild = child;
      prev = child;
    }
    return root;
  };
}

/** Resolve a child value the way `insert` normalizes it: functions are read. */
function resolve(value) {
  while (typeof value === "function") value = isBlock(value) ? renderBlock(value) : value();
  return value;
}

export function insert(parent, accessor, marker) {
  const slot = marker ?? parent;
  if (Array.isArray(accessor)) {
    const slots = (slot.v = accessor.map(() => node()));
    for (let i = 0; i < accessor.length; i++) insert(slots[i], accessor[i]);
    return;
  }
  if (typeof accessor !== "function") {
    slot.v = accessor;
    return;
  }
  // BLOCK_STATIC (4): a view that reads only in its holes renders once,
  // untracked, as @solidjs/web's insert does outside hydration.
  if (blockFlags(accessor) & 4) return insert(parent, untrack(() => renderBlock(accessor)), marker);
  const read = isBlock(accessor) ? () => renderBlock(accessor) : accessor;
  createRenderEffect(
    () => resolve(read()),
    value => {
      slot.v = value;
    }
  );
}

export function createComponent(Comp, props) {
  return untrack(() => Comp(props || {}));
}

/** Every bound handler, in binding order (`dispatchAll` fires them). */
let listeners = [];
export function addEvent(el, name, handler) {
  el.$$click = handler;
}
const syncOptions = { sync: true };
export function memo(fn) {
  return createMemo(() => fn(), syncOptions);
}
export function delegateEvents() {}
/** An attribute hole: the compute tracks, the apply sets (as `@solidjs/web`'s `effect`). */
export function effect(compute, apply) {
  createRenderEffect(compute, apply);
}
export function setAttribute(el, name, value) {
  el.a = value;
}
export function resetListeners() {
  listeners = [];
}
const EVENT = { type: "click" };
export function dispatchAll() {
  for (let i = 0; i < listeners.length; i++) {
    const handler = listeners[i];
    if (isBlock(handler)) dispatchBlock(handler, EVENT);
    else handler(EVENT);
  }
}

/** A deterministic dump of a rendered tree (equivalence checks). */
export function snapshot(value) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(snapshot).join(",");
  if (typeof value !== "object") return String(value);
  let out = "<" + (value.a !== undefined ? "@" + snapshot(value.a) : "") + snapshot(value.v);
  for (let c = value.firstChild; c; c = c.nextSibling) out += "|" + snapshot(c.v);
  return out + ">";
}
