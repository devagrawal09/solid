/*
 * Mounting: the root must be settled — every pending and every failure
 * handled by a `Loading` / `Errored` above it. Both forms work:
 * `render(App, root)` and `render(() => <App />, root)`.
 */
import { render as webRender, hydrate as webHydrate } from "@solidjs/web";
import type { Element } from "./element.js";
import type { SettledView } from "./types.js";

type Root = (() => SettledView) | (() => Element);
type MountableElement = Element & globalThis.Element;

/** Mount a settled root. */
export function render(
  code: Root,
  element: MountableElement | Document | ShadowRoot | DocumentFragment | HTMLElement,
  init?: Element,
  options?: Parameters<typeof webRender>[3]
): () => void {
  return webRender(code as any, element as any, init as any, options);
}

/** Hydrate a settled root rendered on the server. */
export function hydrate(
  code: Root,
  element: MountableElement | Document | HTMLElement,
  options?: Parameters<typeof webHydrate>[2]
): () => void {
  return webHydrate(code as any, element as any, options as any);
}
