import { $ } from "jquery";
import { createMemo, createSignal } from "solid-js";

// `$` from another module is not the marker: nothing is analyzed or erased.
const [count] = createSignal(1);
export const m = createMemo($(() => helper(count)));
export const view = <button onClick={$(() => count())} />;
