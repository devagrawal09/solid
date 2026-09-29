import { renderBlock, type BlockComponent } from "solid-js";
import type { JSX } from "@solidjs/web";

/**
 * The default export of a `lazy()`-loaded module whose component is a
 * `$component`: renders the view right where `lazy()` calls the component.
 *
 * A `$component` call returns its view, which renders where it is inserted.
 * On the server, `lazy()` returns the component's value from its render memo;
 * when the module was not loaded yet (the first request that reaches it), that
 * memo resolves after the module loads and the view is rendered later, while
 * the SSR string is serialized, outside the render's hydration context — and
 * throws "getNextContextId cannot be used under non-hydrating context" (the
 * stream then ends after `<!DOCTYPE html>`). Rendering the view inside the
 * memo keeps it in the render pass. (The CSR build works either way.)
 */
export function eager<P extends object>(
  component: BlockComponent<P, boolean, unknown>
): (props: P) => JSX.Element {
  return props => renderBlock(component(props) as never) as JSX.Element;
}
