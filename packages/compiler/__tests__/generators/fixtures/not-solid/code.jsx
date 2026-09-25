import { $ } from "jquery";

export const value = $(function* () {
  return yield* count;
});
