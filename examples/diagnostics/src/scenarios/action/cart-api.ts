/**
 * Scenario 4, file A — the server.
 *
 * Two endpoints, and the difference between them is the whole bug:
 *
 * - `putQuantity(next)` overwrites with an absolute number. Correct only if
 *   the caller's number was computed from the current truth — which is
 *   exactly what an interleaved second click cannot guarantee.
 * - `addQuantity(delta)` applies a delta server-side, so two overlapping
 *   calls compose instead of clobbering.
 */
let stored = 0;
let latencyMs = 700;

export function setLatency(ms: number): void {
  latencyMs = ms;
}

export function latency(): number {
  return latencyMs;
}

export function reset(): void {
  stored = 0;
}

export function serverQuantity(): number {
  return stored;
}

function roundTrip<T>(compute: () => T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(compute()), latencyMs));
}

/** Last writer wins. */
export const putQuantity = (next: number): Promise<number> =>
  roundTrip(() => {
    stored = next;
    return stored;
  });

/** Writers compose. */
export const addQuantity = (delta: number): Promise<number> =>
  roundTrip(() => {
    stored += delta;
    return stored;
  });
