import { $, createMemo } from "solid-js";

export const guarded = createMemo(
  $(function* () {
    try {
      return `value:${yield* failing}`;
    } catch (error) {
      return `caught:${error.message}`;
    } finally {
      cleanup();
    }
  })
);
