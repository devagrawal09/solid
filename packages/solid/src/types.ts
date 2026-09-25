import type { JsxBlockShape } from "@solidjs/signals";

/**
 * Renderer-owned object value returned from Solid component trees.
 *
 * The concrete rendered value belongs to the active renderer or JSX factory
 * (`@solidjs/web`, `@solidjs/h`, custom renderers, etc.), so core does not
 * model DOM nodes or any other platform object here.
 */
export type RenderedElement = object & {
  readonly call?: never;
  readonly apply?: never;
  readonly bind?: never;
};

/**
 * A `$` block admissible as JSX: its direct effects are reads only (no
 * tasks, no explicit failures, no writes). It may still be pending or
 * error-typed through the signals it reads. Renderers run it through
 * `renderBlock` at their insertion sink, which enforces the same rule at
 * runtime. Admitted by shape (metadata + iterator), not by call signature,
 * so function-valued props keep their contextual typing.
 */
export type JsxBlock = JsxBlockShape<Element>;

export type Element =
  | RenderedElement
  | ArrayElement
  | JsxBlock
  | (string & {})
  | number
  | boolean
  | null
  | undefined;

export interface ArrayElement extends Array<Element> {}
