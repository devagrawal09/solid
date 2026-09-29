/*
 * Shared by the no-JSX renderers: what a hole may hold, and how a value is
 * handed to Solid's `h` / `html`.
 *
 * A hole is a source (`$signal` / `$memo` accessor, store or prop path, a
 * `readStore` selection), a hole block (`$(function* …)` or a bare
 * `function*`), an `$event` handler, a child view, or a static value. A
 * plain thunk is not a hole (it would be a hidden read) and is rejected by
 * the types.
 */
import { $, accessor, READ, BODY, ROW_MARK, isGeneratorFunction, runRow } from "@solidjs/blocks";
import type {
  ChildView,
  COMPONENT,
  EventHandler,
  FailsOf,
  HView,
  PendingOf,
  Read,
  Source,
  View
} from "./types.js";

/**
 * A child `h` / `html` accept: a static node or value, a source, a block
 * (or a bare `function*`), a child view, or an array of them. Not a plain
 * object (that is an attributes object) and not a plain thunk (a hidden read).
 */
export type Hole =
  | Node
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Source<any, boolean, any>
  | HView<boolean, any>
  | View<boolean, any>
  | readonly Hole[]
  | ((...args: any[]) => Generator<any, any, any>);

/**
 * A component `html` accepts in a tag position (`<${For} …>`): a
 * `$component` or one of this library's flow controls. Other components go
 * through `html.define({ … })`.
 */
export type ComponentHole = { readonly [COMPONENT]: true };

/**
 * A value in an `html` template: a hole, an `$event` handler, a component,
 * or a static attribute value (a class / style object). Still no plain thunk.
 */
export type HtmlValue =
  | Hole
  | EventHandler<any, any>
  | ComponentHole
  | { readonly [key: string]: unknown; readonly call?: never; readonly apply?: never };

type OpsOfHole<V> =
  V extends Source<any, infer P, infer E>
    ? Read<P, E>
    : V extends HView<infer P, infer E>
      ? ChildView<P, E>
      : V extends View<infer P, infer E>
        ? ChildView<P, E>
        : V extends (...args: any[]) => Generator<infer Y, infer R, any>
          ? GeneratorOps<Y, R>
          : V extends readonly (infer U)[]
            ? OpsOfHole<U>
            : never;
type GeneratorOps<Y, R> = R extends () => Generator<infer VY, infer VR, any>
  ? VY | OpsOfHole<VR>
  : Y | OpsOfHole<R>;

/** The no-JSX output of holes `V`: its pending / failures are theirs. */
export type HViewOf<V> = HView<PendingOf<OpsOfHole<V>>, FailsOf<OpsOfHole<V>>>;

/**
 * Convert a hole value for Solid's renderer: a zero-arity generator is a
 * hole block; a generator with parameters is a render callback running a row
 * block; a path or a selection becomes an accessor; everything else passes.
 */
export function toHole(value: any): any {
  if (value == null) return value;
  if (typeof value === "function") {
    if (value[READ] !== undefined || value[BODY] !== undefined) return value;
    if (value[ROW_MARK] === true || isGeneratorFunction(value)) {
      if (value.length === 0) return $(value);
      if (value.length === 1) return (a: unknown) => runRow(value, [a]);
      return (a: unknown, b: unknown) => runRow(value, [a, b]);
    }
    return value;
  }
  if (typeof value === "object") {
    if (value[READ] !== undefined) return accessor(value);
    if (Array.isArray(value)) return value.map(toHole);
  }
  return value;
}

/** Convert every value of a props object (a copy; getters are kept lazy). */
export function toHoleProps(props: any): any {
  if (props == null || typeof props !== "object" || Array.isArray(props)) return props;
  if (props instanceof Node) return props;
  if (props[READ] !== undefined) return props;
  const out: any = {};
  const descriptors = Object.getOwnPropertyDescriptors(props);
  for (const key in descriptors) {
    const d = descriptors[key];
    if (d.get) Object.defineProperty(out, key, { get: () => toHole(props[key]), enumerable: true });
    else out[key] = toHole(d.value);
  }
  return out;
}
