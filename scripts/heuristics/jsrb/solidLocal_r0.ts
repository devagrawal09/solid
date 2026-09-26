// Local @solidjs/signals build (r0) — see heuristic-oracles jsrb notes.
import { ReactiveFramework } from "../util/reactiveFramework";
// @ts-ignore aliased at build time
import { flush, createEffect, createMemo, createRoot, createSignal } from "sig-r0";

export const solidLocal_r0: ReactiveFramework = {
  name: "solid-next-r0",
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
      solidLocal_r0.cleanup = dispose;
      return fn();
    }),
  cleanup: () => {}
};
