/** A stream of items failed: the color of its failure. */
export class StreamError extends Error {
  readonly kind = "stream" as const;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
