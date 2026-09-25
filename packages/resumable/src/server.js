// @ts-check
/**
 * Server half of the resumable-events prototype (experimental, private).
 *
 * The SSR compile (`resumableEvents` option of `@solidjs/compiler`) emits
 * three helpers into a component whose scope is resumable:
 *
 *   const _sr$0 = _$srScope("<scope id>", () => ({ sku, count: count() }));
 *   _$ssr(_tmpl$, _$srRoot(_sr$0), _$srEl(_sr$0, 0), ...)
 *
 * `srRoot` stands where the hydration-key hole was: it allocates the same
 * key the ordinary render would, evaluates the per-instance values at that
 * point of the render, checks that every value is data the client can
 * receive, records the instance (`{ s: scope, v: values, b: boundary }`)
 * through the render's own hydration serializer under `sr:<key>` — the
 * existing seroval substrate, which keeps shared identity and cycles and
 * escapes `<` and the line terminators — and returns ` _hk=<key>`. `srEl`
 * renders ` data-sr="<key>/<element index>"`, the coordinate the bootstrap
 * dispatches on.
 *
 * Failing closed: a value that is not data, a render without hydration keys,
 * a serializer that refuses — the instance is *refused*: no `data-sr` is
 * emitted (the element is inert rather than wrong), a
 * ` data-sr-refused="<reason>"` attribute names why, the reason is reported
 * (console.error and the `onRefuse` hook), and nothing else about the render
 * changes.
 */
import * as web from "@solidjs/web";
import { getOwner } from "solid-js";

// Server-only exports of `@solidjs/web` (the client types omit them).
const { getHydrationKey, escape } = web;
const sharedConfig = /** @type {any} */ (web).sharedConfig;

/** Manifest / record schema. Must match the compiler, bootstrap and runtime. */
export const SCHEMA = 1;
/** Serializer key prefix of an instance record: `sr:<hydration key>`. */
export const RECORD_PREFIX = "sr:";

/** @typedef {{ kind: string; scope: string; key?: string; reason: string; error?: unknown }} Refusal */

/** @type {{ onRefuse: ((refusal: Refusal) => void) | null; log: boolean }} */
let config = { onRefuse: null, log: true };

/** Configure refusal reporting (process-wide; the prototype has no per-request options). */
export function configureResumable(options) {
  config = { ...config, ...options };
}

/**
 * @typedef {{ id: string; values: () => Record<string, unknown>; key: string | undefined; refused: string | null }} Instance
 */

/** One component instance's scope (created before the template renders). */
export function srScope(id, values) {
  return /** @type {Instance} */ ({ id, values, key: undefined, refused: null });
}

/**
 * The hydration-key hole of a resumable template root: allocates the key,
 * evaluates and records the instance values, returns ` _hk=<key>`.
 */
export function srRoot(instance) {
  const key = getHydrationKey();
  const ctx = /** @type {any} */ (sharedConfig).context;
  if (key === undefined || !ctx || typeof ctx.serialize !== "function" || ctx.noHydrate) {
    refuse(instance, key, "no-hydration-context");
    return key === undefined ? "" : ` _hk=${key}`;
  }
  instance.key = key;
  let values;
  try {
    values = instance.values();
  } catch (error) {
    refuse(instance, key, "values-threw", error);
    return ` _hk=${key}`;
  }
  const problem = checkData(values, "values");
  if (problem) {
    refuse(instance, key, problem);
    return ` _hk=${key}`;
  }
  const record = { s: instance.id, v: values, b: nearestBoundary() };
  try {
    ctx.serialize(RECORD_PREFIX + key, record);
  } catch (error) {
    refuse(instance, key, "serialize-failed", error);
  }
  return ` _hk=${key}`;
}

/** The element marker hole: ` data-sr="<key>/<n>"`, or the refusal marker. */
export function srEl(instance, index) {
  if (instance.refused) return ` data-sr-refused="${escape(instance.refused, true)}"`;
  if (instance.key === undefined) return "";
  return ` data-sr="${instance.key}/${index}"`;
}

/**
 * The nearest error boundary above the current owner, as the hydration id
 * the server boundary stamps on its owner (`_boundary`); `null` when none.
 */
export function nearestBoundary() {
  let owner = /** @type {any} */ (getOwner());
  while (owner) {
    if (typeof owner._boundary === "string") return owner._boundary;
    owner = owner._parent;
  }
  return null;
}

function refuse(instance, key, reason, error) {
  instance.refused = reason;
  const refusal = { kind: "refused", scope: instance.id, key, reason, error };
  if (config.log) {
    console.error(
      `[solid resumable] scope ${instance.id}${key === undefined ? "" : ` (key ${key})`} refused: ${reason}` +
        (error ? ` — ${error instanceof Error ? error.message : String(error)}` : "") +
        "; its handlers will not run on the client (no data-sr emitted)."
    );
  }
  if (config.onRefuse) config.onRefuse(refusal);
}

/**
 * Is `value` data the client can receive through the hydration serializer
 * and rebuild a scope from? Primitives, Date, plain objects/arrays, Map and
 * Set, recursively; shared references and cycles are fine (seroval keeps
 * identity). Everything else — functions, symbols, promises, DOM nodes, class
 * instances, typed arrays — is refused with a path. Returns `null` when ok.
 */
export function checkData(value, path, seen = new Set()) {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "number":
    case "string":
    case "bigint":
      return null;
    case "function":
      return `unserializable:${path}:function`;
    case "symbol":
      return `unserializable:${path}:symbol`;
    default:
      break;
  }
  if (value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (typeof value.then === "function") return `unserializable:${path}:promise`;
  if (typeof value.nodeType === "number" && typeof value.nodeName === "string") {
    return `unserializable:${path}:dom-node`;
  }
  if (value instanceof Date) return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const problem = checkData(value[i], `${path}[${i}]`, seen);
      if (problem) return problem;
    }
    return null;
  }
  if (value instanceof Map) {
    for (const [k, v] of value) {
      const problem = checkData(k, `${path}[key]`, seen) || checkData(v, `${path}.get(...)`, seen);
      if (problem) return problem;
    }
    return null;
  }
  if (value instanceof Set) {
    for (const v of value) {
      const problem = checkData(v, `${path}[set]`, seen);
      if (problem) return problem;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return `unserializable:${path}:${proto.constructor?.name || "instance"}`;
  }
  for (const key of Object.keys(value)) {
    const problem = checkData(value[key], `${path}.${key}`, seen);
    if (problem) return problem;
  }
  return null;
}

/**
 * JSON for an inline script: `<` and the line terminators escaped so the
 * text can never close the script element or break a JS string.
 */
export function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The inline bootstrap script: the built bootstrap (`dist/bootstrap.iife.js`,
 * a classic script that defines `solidResume.install`) followed by the
 * install call with the embedded manifest. Classic and inline so it is live
 * before the body parses: no event is lost between first paint and the
 * module graph. `nonce` supports a CSP; the bootstrap itself never evaluates
 * strings and loads the event modules with dynamic `import()`.
 */
export function generateResumeBootstrap({ manifest, nonce, code, options }) {
  const source = code ?? readBuiltBootstrap();
  const attr = nonce ? ` nonce="${escape(String(nonce), true)}"` : "";
  const install = `solidResume.install(${jsonForScript(manifest)}${options ? `,${jsonForScript(options)}` : ""});`;
  return `<script${attr}>${source}\n${install}</script>`;
}

let builtBootstrap = null;
function readBuiltBootstrap() {
  if (builtBootstrap) return builtBootstrap;
  // Node only (server render); read lazily so browsers never touch `fs`.
  const { readFileSync } =
    /** @type {any} */ (globalThis.process?.getBuiltinModule?.("node:fs")) ?? {};
  if (!readFileSync) throw new Error("generateResumeBootstrap needs `code` outside Node");
  const url = new URL("../dist/bootstrap.iife.js", import.meta.url);
  builtBootstrap = readFileSync(url, "utf8");
  return builtBootstrap;
}
