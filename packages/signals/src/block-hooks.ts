/**
 * Install-on-use renderer entry points for `$` blocks
 * (documentation/plans/core-runtime-slicing.md, coupling 2).
 *
 * Renderers (`@solidjs/web`'s `insert` and event delegation, `flatten`, the
 * `solid-js` boundaries) interpret a block where it reaches them: a JSX
 * child renders under the JSX host, a DOM handler dispatches under the event
 * host, a boundary called inside a running block body is deferred. They reach
 * that code only after `isBlock(value)` (or `inBlock()`) is true, and a block
 * exists only once a block constructor ran. So these entry points are live
 * bindings the block runtime (`generator.ts`) assigns the first time a block
 * is built: an application that never builds a block ships neither the block
 * host machinery nor its diagnostics, and one that does calls the same
 * functions as before, with no forwarding frame once installed.
 *
 * Every block constructor must install the runtime before its first block
 * escapes (`$` does, in its one-time setup).
 */
import type { Owner } from "./core/index.js";
import type { AnyBlock, BlockInput, BlockValue } from "./generator.js";

// The installed implementations. The bindings below start as forwarders to
// them: a call like `renderBlock($(…))` reads the binding before its
// argument builds the first block, so the value it read must still reach
// the implementation installed meanwhile. After installation the bindings
// are the implementations themselves (no forwarding frame).
let installed: [typeof renderBlock, typeof dispatchBlock, typeof lazyView] | undefined;

/**
 * Render a block as a JSX child: reads only. Renderers call this at their
 * insertion sink (`insert`, `flatten`) so a block that waits, raises,
 * attempts or writes is refused there at runtime, matching the type-level
 * admission into `JSX.Element`.
 */
export let renderBlock: <B extends AnyBlock>(block: B) => BlockValue<B> = block =>
  installed![0](block);

/**
 * Dispatch a DOM event to a block: the event host. Admits every category,
 * runs like an ordinary handler (no owner context), and routes a failure —
 * synchronous, or the rejection of a block that waits — to the nearest error
 * boundary above the block's creation owner (or `owner` when given).
 */
export let dispatchBlock: <B extends AnyBlock>(
  block: B,
  event: BlockInput<B>,
  owner?: Owner | null
) => void = (block, event, owner) => installed![1](block, event, owner);

/**
 * @internal A component or boundary call made inside a running block body:
 * a view thunk the renderer or the enclosing boundary resolves where it
 * renders it (see `lazyView` in generator.ts). Only reachable while a block
 * runs (`inBlock()`), so the runtime is installed.
 */
export let lazyView: <T>(make: () => T) => () => T = make => installed![2](make);

/** @internal Called by the block runtime when the first block is built. */
export function installBlockRenderer(
  render: typeof renderBlock,
  dispatch: typeof dispatchBlock,
  view: typeof lazyView
): void {
  installed = [render, dispatch, view];
  renderBlock = render;
  dispatchBlock = dispatch;
  lazyView = view;
}
