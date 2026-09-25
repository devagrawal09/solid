import { $ } from "solid-js";

export const summary = $(function* () {
  return `${yield* props.count} ${yield* state["label"]} ${yield* this.total}`;
});
