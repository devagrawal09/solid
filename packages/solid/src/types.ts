import type {
  JsxBlockShape,
  NonView,
  SettledView,
  SetupOp,
  ViewOf,
  ViewOp
} from "@solidjs/signals";

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
  // Not an iterator: a render callback that returns a generator is a block
  // (generator blocks v2), typed by the flow controls' block overloads.
  readonly next?: never;
  readonly throw?: never;
} & NonView;

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
  // A `$component`'s view with nothing left to handle (generator blocks v2):
  // a view that can still be pending or fail is not an element until a
  // `Loading` / `Errored` handles it.
  | SettledView
  | (string & {})
  | number
  | boolean
  | null
  | undefined;

export interface ArrayElement extends Array<Element> {}

/**
 * A render callback written as a block (generator blocks v2, "Render callbacks
 * as blocks"): a `function*` taking the flow control's render arguments (a
 * `<For>` row's item and index, a `<Show>` / `<Match>` branch's value, a
 * `<Repeat>` index) whose setup creates state and returns its view, like a
 * `$component` body. A flow control renders its rows like a JSX tag renders a
 * component: the view must be settled, so a row that can be pending or fail
 * handles that inside its own view (`Loading({ … })` / `Errored({ … })`), and
 * a creation outside the setup is a type error.
 */
export type RowBlock<A extends readonly unknown[], Y extends SetupOp, VY> = ((
  ...args: A
) => Generator<Y, () => Generator<VY, unknown, any>, any>) &
  SettledRow<VY>;
/**
 * The view of a row must only read (`VY` is left unconstrained and checked
 * here, so overload resolution never instantiates a view's effects at their
 * constraint) and be settled.
 */
export type SettledRow<VY> = [VY] extends [ViewOp]
  ? ViewOf<VY> extends SettledView
    ? unknown
    : {
        readonly "[UNSETTLED_ROW] this render-callback block's view may be pending or fail: handle it inside the row with Loading / Errored": never;
      }
  : {
      readonly "[ROW_VIEW_OP] a render-callback block's view only reads: create state in its setup": never;
    };
