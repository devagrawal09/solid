import { $ } from "solid-js";
import { log } from "../state";

export function LogView() {
  return $(function* () {
    return <ol id="log">{(yield* log).join("|")}</ol>;
  });
}
