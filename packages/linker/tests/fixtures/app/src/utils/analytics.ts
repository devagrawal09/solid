// Plain module state, no evaluation effects.
export const events: string[] = [];
export function track(name: string, detail?: unknown) {
  events.push(detail === undefined ? name : `${name}:${typeof detail}`);
}
