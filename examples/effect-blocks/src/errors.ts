/** A package search failed: the color of its failure. */
export class SearchError extends Error {
  readonly kind = "search" as const;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
