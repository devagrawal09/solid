/*
 * Generator blocks for Solid, as a library: strict generator syntax, its
 * types, and a runtime interpreter on Solid's public API. No blocks
 * compiler; the JSX transform's one block rule (`yield*` inside JSX becomes
 * `perform(…)`) makes JSX views fine-grained.
 *
 * See documentation/plans/blocks-library.md.
 */
export {
  $cleanup,
  $component,
  $effect,
  $event,
  $memo,
  $optimistic,
  $optimisticStore,
  $projection,
  $settled,
  $signal,
  $snapshot,
  $store,
  attempt,
  context,
  createContext,
  isComponent,
  isPendingOf,
  latestOf,
  perform,
  raise,
  readStore,
  refresh,
  start,
  until,
  type BlockContext
} from "./runtime.js";
/** @internal shared with the `h` entry (one runtime per app). */
export {
  READ,
  VIEW_MARK,
  COMPONENT_MARK,
  blockName,
  holeOf,
  isGeneratorFunction,
  isRowBlock,
  renderView,
  rowArg,
  runRow
} from "./runtime.js";
export { For, Show, Switch, Match, Repeat, Loading, Errored } from "./flow.js";
export { render, hydrate } from "./render.js";
export { $dynamic } from "./dynamic.js";
export { lazy } from "./lazy.js";
export type { Element, ArrayElement, RenderedObject } from "./element.js";
export type {
  AnyOp,
  BlockSetter,
  BlockStoreSetter,
  ChildView,
  Cleanup,
  Component,
  ContextRead,
  Create,
  EffectOp,
  ErrorClass,
  EventCall,
  EventCallOp,
  EventHandler,
  ReadsPendingOf,
  WaitsOf,
  EventOp,
  FailsOf,
  Failure,
  KindCheck,
  NeedsKind,
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
