/**
 * Helpers for declaring per-mode expectations in scenarios.
 */
import { modes } from "./modes.js";
import type { Environment, ModeExpectation, SourceKind } from "./types.js";

/**
 * The same expectation for every mode that consumes `source` in the given
 * environments (default: every environment). Use it when a difference is a
 * property of the source form itself (e.g. all `$` modes share the runtime
 * driver's cancellation of superseded runs), not of one lowering.
 */
export function forModes(
  expectation: ModeExpectation,
  options: { source?: SourceKind; environments?: Environment[]; only?: string[] } = {}
): Record<string, ModeExpectation> {
  const source = options.source ?? "generator";
  return Object.fromEntries(
    modes
      .filter(
        mode =>
          mode.source === source &&
          (!options.environments || options.environments.includes(mode.environment)) &&
          (!options.only || options.only.some(suffix => mode.id.endsWith(`/${suffix}`)))
      )
      .map(mode => [mode.id, expectation])
  );
}
