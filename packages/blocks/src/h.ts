/*
 * `h` for blocks: Solid's hyperscript with typed holes.
 *
 *   h("p", { class: $(function* () { return (yield* n) > 3 ? "big" : "" }) },
 *     "Hello ", $(function* () { return (yield* user).name }))
 *
 * Tag and attribute names are checked against the DOM JSX types; an
 * attribute value is a static value or a source / block of it; a child is a
 * static element, a source, a block, a child view or an array of them.
 * The result's type carries the pending / failures of every hole, so a view
 * returning it is pending when any hole is.
 */
import solidH from "@solidjs/h";
import type { JSX } from "@solidjs/blocks/jsx-runtime";
import { toHole, toHoleProps, type Hole, type HViewOf } from "./holes.js";
import type { Component, EventHandler, HView, Source, View } from "./types.js";

type Intrinsic = JSX.IntrinsicElements;
/** An attribute: event handlers stay handlers; other values may be sources. */
type HAttr<K, V> = K extends `on${string}`
  ? V | EventHandler<any, any>
  : K extends "ref" | "children"
    ? V
    :
        | V
        | Source<Exclude<V, undefined>, boolean, any>
        | (() => Generator<any, Exclude<V, undefined>, any>);
export type HAttributes<Tag extends keyof Intrinsic> = {
  [K in keyof Intrinsic[Tag]]?: HAttr<K, Intrinsic[Tag][K]>;
};

type NotCallable = { readonly call?: never; readonly apply?: never };
type PropsOfComponent<C> = C extends (props: infer P) => any ? NonNullable<P> : never;

export interface BlocksH {
  <
    Tag extends keyof Intrinsic,
    const A extends HAttributes<Tag> & NotCallable,
    const C extends readonly Hole[]
  >(
    tag: Tag,
    attributes: A & { readonly [K in Exclude<keyof A, keyof HAttributes<Tag>>]: never },
    ...children: C
  ): HViewOf<A[keyof A] | C[number]>;
  <Tag extends keyof Intrinsic, const C extends readonly Hole[]>(
    tag: Tag,
    ...children: C
  ): HViewOf<C[number]>;
  /**
   * A component: its props, then children. The result carries the
   * component's pending / failures. Boundaries are simplest as calls
   * (`Loading({ fallback, children: Child() })`): a generic component
   * passed as a value loses its type arguments.
   */
  <Comp extends (props: any) => unknown, const C extends readonly Hole[]>(
    component: Comp,
    props: PropsOfComponent<Comp>,
    ...children: C
  ): ReturnType<Comp> extends View<infer P, infer E> | HView<infer P, infer E>
    ? HView<P, E>
    : HView<false, never>;
  Fragment: (props: { children: Hole }) => HView<false, never>;
}

/**
 * The brand Solid's `h` puts on its element thunks (so a thunk passed as a
 * child is materialized in place rather than wrapped in an effect).
 */
const ELEMENT: symbol | undefined = Object.getOwnPropertySymbols((solidH as any)("div"))[0];

function convert(args: any[]): any[] {
  const out = new Array(args.length);
  out[0] = args[0];
  for (let i = 1; i < args.length; i++) {
    const v = args[i];
    out[i] =
      i === 1 && v != null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Node)
        ? toHoleProps(v)
        : toHole(v);
  }
  return out;
}

/**
 * `h(tag | Component, props?, ...children)`: holes are converted for Solid's
 * `h` (a bare `function*` hole becomes a block, a generator render callback
 * runs a row block, paths become accessors). Each materialization converts
 * the arguments afresh: Solid's `h` turns function props into getters on the
 * props object it is given, so materializing one thunk twice (a `Loading`
 * re-rendering its content) failed on the second pass ("Cannot set property
 * children … which has only a getter"), with or without blocks.
 */
export const h: BlocksH = ((...args: any[]) => {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  const thunk: any = () => (solidH as any)(...convert(args))();
  if (ELEMENT) thunk[ELEMENT] = true;
  return thunk;
}) as any;
(h as any).Fragment = (solidH as any).Fragment;

export type { Hole, HViewOf };
export type { Component };
