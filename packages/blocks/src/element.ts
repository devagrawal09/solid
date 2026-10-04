/*
 * What a block app may render. Only *settled* things are elements: a view
 * that may still be pending or fail is not, until a `Loading` / `Errored`
 * handles it (or `yield*` moves it into the enclosing view). Plain thunks
 * are not elements either (a thunk in a hole is a hidden read): a hole is a
 * `yield*` in JSX, or a source / a bare `function*` in `h`. A bare
 * `function*` is not a JSX child: the JSX transform hands a child to the
 * web renderer as it is, and the renderer does not drive generators; in
 * JSX the hole is the `yield*`.
 */
import type { HView, PENDING, SettledView, VIEW, HVIEW } from "./types.js";

type NotCallable = {
  readonly call?: never;
  readonly apply?: never;
  readonly bind?: never;
};
/** A renderer-owned object (a DOM node, an SSR string template, …). */
export type RenderedObject = object &
  NotCallable & {
    readonly [Symbol.iterator]?: never;
    readonly [PENDING]?: never;
    readonly [VIEW]?: never;
    readonly [HVIEW]?: never;
    readonly next?: never;
  };

export interface ArrayElement extends Array<Element> {}

export type Element =
  | Node
  | RenderedObject
  | ArrayElement
  | SettledView
  | HView<false, never>
  | (string & {})
  | number
  | boolean
  | null
  | undefined;
