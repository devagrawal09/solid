/** A route: its paths, its frame's server function id (null: no frame), its arguments. */
export type FrameRoute = [
  paths: string[],
  id: string | null,
  args: ((props: { params: Record<string, string>; location: FrameLocation }) => unknown[]) | null
];

export interface FrameLocation {
  pathname: string;
  search: string;
  hash: string;
  query: Record<string, string>;
}

/** Where frames are served (default `/_server`). */
export function configure(options?: { endpoint?: string }): void;
/** A frame request's URL (the generated server function's declared-GET address). */
export function frameUrl(id: string, args: unknown[] | string): string;
/** Drop cached frame responses (all, or one frame's). */
export function invalidate(id?: string): void;
/** An island frame's driver: refetch the region `el` (`data-f`) with new arguments. */
export function frame(el: Element, args: unknown[] | string): Promise<void>;
/** The keyed morph of a frame's region with its new HTML. */
export function morph(el: Element, html: string): Element;
/** `/stories/:id` against a pathname. */
export function match(pattern: string, path: string): Record<string, string> | null;
/** A client navigation into the outlet (`<!--o-->` … `<!--/o-->`). */
export function navigate(
  routes: FrameRoute[],
  href: string | null,
  options?: { push?: boolean }
): Promise<void> | undefined;
/** Load a route's frame ahead of a navigation. */
export function prefetch(routes: FrameRoute[], href: string): void;
