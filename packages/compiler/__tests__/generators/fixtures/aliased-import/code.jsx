import { $ as reactive, createMemo } from "@solidjs/signals";

export const double = createMemo(
  reactive(function* () {
    return (yield* count) * 2;
  })
);
