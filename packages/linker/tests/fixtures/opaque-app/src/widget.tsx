// `eval` can reach every binding in this module by name: the module is
// unknown, nothing in it is extracted, and everything it imports is retained.
import { $ } from "solid-js";
import { helper } from "./helper";

export function Widget() {
  const click = $(function* () {
    helper();
  });
  return <button onClick={click} onDblClick={() => eval("helper()")} />;
}
