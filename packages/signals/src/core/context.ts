import { ContextNotFoundError, NoOwnerError } from "./error.js";
import { getOwner } from "./owner.js";
import type { Owner } from "./types.js";
import type { ContextOp } from "../generator.js";

export interface Context<T> {
  readonly id: symbol;
  readonly defaultValue: T | undefined;
}
/** `yield* Ctx` in a `$component`'s setup reads the context (generator blocks v2). */
export interface ContextIterable<T> {
  [Symbol.iterator](): Generator<ContextOp<T, Context<T>>, T, any>;
}

/** Installed by the block API: the iterator behind `yield* Ctx`. */
let contextIterator: ((context: Context<any>) => Generator<any, any, any>) | null = null;
/** @internal */
export function setContextIterator(fn: (context: Context<any>) => Generator<any, any, any>): void {
  contextIterator = fn;
}
/** @internal `yield* Ctx` for any context object (signals' and solid-js' providers). */
export function iterateContext(this: Context<any>): Generator<any, any, any> {
  if (!contextIterator)
    throw new TypeError("[CONTEXT_NOT_ITERABLE] `yield* Ctx` requires the block API");
  return contextIterator(this);
}

export type ContextRecord = Record<string | symbol, unknown>;

/**
 * Context provides a form of dependency injection. It is used to save from needing to pass
 * data as props through intermediate components. This function creates a new context object
 * that can be used with `getContext` and `setContext`.
 *
 * A default value can be provided here which will be used when a specific value is not provided
 * via a `setContext` call.
 */
export function createContext<T>(
  defaultValue?: T,
  description?: string
): Context<T> & ContextIterable<T> {
  return {
    id: Symbol(description),
    defaultValue,
    [Symbol.iterator]: iterateContext
  } as Context<T> & ContextIterable<T>;
}

/**
 * Low-level owner-targeted context read. The user-facing read API is
 * `useContext` (in `solid-js`), which wraps this primitive. Exposed here for
 * cross-package wiring (e.g. hydration-aware context plumbing).
 *
 * @throws `NoOwnerError` if there's no owner at the time of call.
 * @throws `ContextNotFoundError` if a context value has not been set yet.
 *
 * @internal
 */
export function getContext<T>(context: Context<T>, owner: Owner | null = getOwner()): T {
  if (!owner) {
    throw new NoOwnerError();
  }

  // `undefined` alone means unset — a provided `null` is a value (no `??`).
  let value = owner._context[context.id] as T | undefined;
  if (value === undefined) value = context.defaultValue;

  if (value === undefined) {
    throw new ContextNotFoundError();
  }

  return value;
}

/**
 * Low-level owner-targeted context write. The user-facing API is
 * `createContext` (in `solid-js`); its provider component wraps this
 * primitive. Exposed here for cross-package wiring.
 *
 * @throws `NoOwnerError` if there's no owner at the time of call.
 *
 * @internal
 */
export function setContext<T>(context: Context<T>, value?: T, owner: Owner | null = getOwner()) {
  if (!owner) {
    throw new NoOwnerError();
  }

  // We're creating a new object to avoid child context values being exposed to parent owners. If
  // we don't do this, everything will be a singleton and all hell will break lose.
  owner._context = {
    ...owner._context,
    [context.id]: value === undefined ? context.defaultValue : value
  };
}
