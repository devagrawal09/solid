// Local @solidjs/signals build (h5) — see heuristic-oracles jsrb notes.
import { ReactiveFramework } from "../util/reactiveFramework";
// @ts-ignore aliased at build time
import { statusFree, flush, createEffect, createMemo, createRoot, createSignal } from "sig-prod";

export const solidLocal_h5: ReactiveFramework = {
  name: "solid-next-h5",
  signal: initialValue => {
    const [getter, setter] = createSignal(initialValue as any);
    return { write: v => setter(v as any), read: () => getter() };
  },
  computed: fn => {
    const memo = createMemo(fn, statusFree);
    return { read: () => memo() };
  },
  effect: fn => createEffect(fn, () => {}),
  withBatch: fn => {
    fn();
    flush();
  },
  withBuild: fn =>
    createRoot(dispose => {
      solidLocal_h5.cleanup = dispose;
      return fn();
    }),
  cleanup: () => {}
};
