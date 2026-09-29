/*
 * Generator blocks for Solid, as a library: strict generator syntax, its
 * types, and a runtime interpreter on Solid's public API. No blocks
 * compiler; the JSX transform's one block rule (`yield*` inside JSX becomes
 * `perform(…)`) makes JSX views fine-grained.
 *
 * See documentation/plans/blocks-library.md.
 */
export {
  $,
  $cleanup,
  $component,
  $effect,
  $event,
  $flush,
  $memo,
  $scope,
  $settled,
  $signal,
  $snapshot,
  $store,
  accessor,
  attempt,
  context,
  createContext,
  isComponent,
  isPendingOf,
  latestOf,
  paths,
  perform,
  raise,
  read,
  readStore,
  type BlockContext
} from "./runtime.js";
/** @internal shared with the `h` / `html` entries (one runtime per app). */
export {
  READ,
  BODY,
  ROW_MARK,
  VIEW_MARK,
  COMPONENT_MARK,
  isGeneratorFunction,
  isRowBlock,
  renderView,
  rowArg,
  runRow
} from "./runtime.js";
export { For, Show, Switch, Match, Repeat, Loading, Errored } from "./flow.js";
export { render, hydrate } from "./render.js";
export type { Element, ArrayElement, RenderedObject } from "./element.js";
export type {
  AnyOp,
  Block,
  BlockSetter,
  BlockStoreSetter,
  ChildView,
  Cleanup,
  Component,
  ContextRead,
  Create,
  EffectOp,
  ErrorClass,
  EventHandler,
  EventOp,
  FailsOf,
  Flush,
  HView,
  HViewOp,
  HoleOp,
  MemoOp,
  Path,
  PendingOf,
  PropColor,
  PropColors,
  PropColorsOpen,
  PropsInput,
  PropsOf,
  Raise,
  Read,
  ReadThrough,
  Receipt,
  RowBlock,
  SettledSource,
  SettledView,
  SetupOp,
  Snapshot,
  Source,
  TypedProps,
  TypedStore,
  View,
  ViewOp,
  Wait,
  Write,
  Yieldable
} from "./types.js";
