/** A server component call failed: the color of its failure. */
export class ServerError extends Error {
  readonly kind = "server" as const;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** The model's generation failed: the color of its failure. */
export class GenerationError extends Error {
  readonly kind = "generation" as const;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}
