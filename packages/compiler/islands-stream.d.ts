// Streaming for compiled islands (see islands-stream.js).

/** The render context an islands server module threads (`App(props, $c)`). */
export type IslandsContext = Map<unknown, unknown>;

export interface IslandsChunk {
  /** `lN` (a `<Loading>` boundary's content) or `eN` (an `<Errored>` fallback). */
  id: string;
  html: string;
}

export interface IslandsStreamOptions {
  /** Every chunk, structured (also written by the async iterator as HTML). */
  onChunk?: (chunk: IslandsChunk) => void;
  /** A failure with no enclosing `<Errored>` (the fallback stays). */
  onError?: (error: unknown) => void;
}

export interface IslandsStreamResult extends AsyncIterable<string> {
  /** The shell: pending boundaries show their fallbacks between markers. */
  shell: Promise<string>;
  /** Resolves once every chunk (nested ones included) has been written. */
  done(): Promise<void>;
  context: IslandsContext;
}

/** Render a page (`render($c)` calls the page component) with out-of-order streaming. */
export function renderIslandsStream(
  render: (context: IslandsContext) => string | Promise<string>,
  options?: IslandsStreamOptions
): IslandsStreamResult;

/** The shell with every chunk appended, as one string. */
export function renderIslandsToString(
  render: (context: IslandsContext) => string | Promise<string>,
  options?: IslandsStreamOptions
): Promise<string>;

/** Swap a chunk into a document (or an element's subtree): what `$sl` does in the page. */
export function swap(id: string, html?: string | null, doc?: Document | Element): void;

/** A chunk as HTML: `<template id="s{id}">…</template><script>$sl(id)</script>`. */
export function chunkHtml(chunk: IslandsChunk): string;

/** The inline script defining `$sl`, written once before the first chunk. */
export const SWAP_SCRIPT: string;

export const STREAM: unique symbol;

export class IslandsStream {
  constructor(options?: IslandsStreamOptions);
  done(): Promise<void>;
}
