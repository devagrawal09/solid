// A module-level event block exported and used in another module, through a
// barrel and two levels of prop forwarding.
import { $, write } from "solid-js";
import { log, setLog } from "./state";
import { describeSave } from "./utils/describe";

export const save = $(function* (e: MouseEvent) {
  const entries = yield* log;
  yield* write(setLog, [...entries, describeSave(entries.length, e.shiftKey)]);
});
