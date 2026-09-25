import { createSignal } from "solid-js";

export const [log, setLog] = createSignal<string[]>([]);
