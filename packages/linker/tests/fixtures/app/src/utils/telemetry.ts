// Evaluation has an effect: moving this module out of the hot graph would
// delay it, so its import stays in the hot module (as a bare import).
export const beacons: string[] = [];
(globalThis as any).__telemetryLoaded = ((globalThis as any).__telemetryLoaded ?? 0) + 1;
export function beacon(name: string) {
  beacons.push(name);
}
