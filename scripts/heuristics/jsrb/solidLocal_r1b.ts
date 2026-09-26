// Local @solidjs/signals build (r1b) — see heuristic-oracles jsrb notes.
import { ReactiveFramework } from "../util/reactiveFramework";
// @ts-ignore aliased at build time
import { flush, createEffect, createMemo, createRoot, createSignal } from "sig-r1b";

export const solidLocal_r1b: ReactiveFramework = {
  name: "solid-next-r1b",
  signal: initialValue => {
    const [getter, setter] = createSignal(initialValue as any);
    return { write: v => setter(v as any), read: () => getter() };
  },
  computed: fn => {
    const memo = createMemo(fn);
    return { read: () => memo() };
  },
  effect: fn => createEffect(fn, () => {}),
  withBatch: fn => {
    fn();
    flush();
  },
  withBuild: fn =>
    createRoot(dispose => {
      solidLocal_r1b.cleanup = dispose;
      return fn();
    }),
  cleanup: () => {}
};
