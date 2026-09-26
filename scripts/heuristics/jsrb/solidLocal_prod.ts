// Local @solidjs/signals build (prod) — see heuristic-oracles jsrb notes.
import { ReactiveFramework } from "../util/reactiveFramework";
// @ts-ignore aliased at build time
import { flush, createEffect, createMemo, createRoot, createSignal } from "sig-prod";

export const solidLocal_prod: ReactiveFramework = {
  name: "solid-next-prod",
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
      solidLocal_prod.cleanup = dispose;
      return fn();
    }),
  cleanup: () => {}
};
