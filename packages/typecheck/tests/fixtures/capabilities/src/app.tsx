import { $, createMemo, createSignal, For, Show } from "solid-js";

interface Row {
  id: number;
  label: string;
}

const [rows] = createSignal<Row[]>([]);
const [flag] = createSignal(false);
const loose: any = null;

export const count = createMemo(() => rows().length);
export const labels = createMemo(() => rows().map(r => r.label));
export const pending = createMemo(async () => rows().length);
export const untyped = createMemo(() => loose);
export const block = createMemo(
  $(function* () {
    return (yield* rows).length > 0;
  })
);

export const view = (
  <Show when={flag()}>
    <For each={rows()}>{row => <span>{row.label}</span>}</For>
  </Show>
);
