/**
 * Link-time feature switches of the frames client
 * (documentation/plans/core-runtime-slicing.md, "Frames client switches";
 * the same mechanism as `@solidjs/signals`' `core/features.ts`).
 *
 * Every switch is `true` in the published build, so this module changes no
 * behavior on its own. The capability linker (`@solidjs/compiler/capabilities`,
 * `proveFramesFeatures`) may substitute it with some switches `false` for an
 * application whose COMPILED SERVER OUTPUT it has proven never produces the
 * feature; the client gates the feature's seams on these constants and an app
 * bundler folds an imported `false` constant, so the seams leave the bundle.
 *
 * Rules (as for the signals switches): a switch only removes code; a graph
 * that does not use the feature behaves the same with it off; a feature
 * reached with its switch off throws `[FEATURE_EXCLUDED]` (the proof was
 * wrong) instead of misbehaving silently.
 */

/** Streamed fragments inside frames: segment reveal (`<Loading>` inside a
 * server component), fallback materialization, late document boundaries and
 * the hydration fragment ledger's claims. Off: no async boundary inside any
 * frame. */
export const FRAGMENTS = true;
/** Server-side CSS / modules: streamed stylesheet gates, module preloads and
 * preload links. Off: no frame carries assets. */
export const ASSETS = true;
/** Slot args beyond primitives and markup: `{$ref}` data records resolved
 * from the response's data table. Off: every slot arg is a primitive or a
 * server-content region. */
export const SLOT_DATA = true;
/** `asyncArg`: async values passed whole to a slot (the value tier). */
export const ASYNC_ARGS = true;
/** Container traces: server projections / stores crossing the border and
 * materializing as live local containers. */
export const CONTAINERS = true;
/** Live slot props (`ctx.onUpdate`): a re-sent record's changed args pushed
 * into the live occurrence. Off: occurrences re-call on changed args. */
export const LIVE_PROPS = true;
/** Single-flight responses: a mutation's response carrying the frames it
 * invalidated. */
export const SINGLE_FLIGHT = true;
/** The server-functions codec for frame data (the lazily loaded decode
 * chunk and its response-scoped tables). Off: every arg and record is plain
 * JSON. */
export const FULL_CODEC = true;
/** Hydration claims: slot fills rendered by hydrated (non-island) client
 * components claim their server-rendered nodes under the producer's keys.
 * Off: every client piece inside frames is a compiled island. */
export const HYDRATION_CLAIMS = true;

/** A switched-off feature was reached: the linker's proof was wrong. */
export function featureExcluded(name: string): never {
  throw new Error(
    `[FEATURE_EXCLUDED] the frames client was linked without ${name}, but this page uses it ` +
      `(the capability linker's proof missed a use: report the construct).`
  );
}

/**
 * The census (tests only): which features a test touches. The published
 * build replaces this with a no-op the app bundler removes.
 */
export function markFeature(name: string): void {
  const census = (globalThis as any).__FRAMES_CENSUS__;
  if (census) census.add(name);
}
