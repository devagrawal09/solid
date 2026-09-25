import { action, createSignal } from "solid-js";

export const [log, setLog] = createSignal<string[]>([]);

// A registered action used only by an extracted handler: its identity is
// created by module evaluation, so it is never moved (one instance, in the
// hot graph), and the cold handler imports it.
export const persisted: number[] = [];
export const persist = action(function* (count: number) {
  persisted.push(count);
});
