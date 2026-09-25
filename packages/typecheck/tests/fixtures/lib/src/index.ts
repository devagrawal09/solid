// A library compiled with solid-tsc: its emitted `.d.ts` carries the block's
// reads as ordinary `StoreRead<...>` types, so consumers need no projection.
import { $, createStore } from "solid-js";

export const [settings, setSettings] = createStore({ theme: "dark", size: 12 });

export const theme = $(function* () {
  return `${yield* settings.theme}/${yield* settings.size}`;
});
