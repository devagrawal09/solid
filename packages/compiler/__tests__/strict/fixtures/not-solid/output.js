import { template as _$template } from "@solidjs/web";
import { addEvent as _$addEvent } from "@solidjs/web";
import { delegateEvents as _$delegateEvents } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<button>`);
import { $ } from "jquery";
import { createMemo, createSignal } from "solid-js";
// `$` from another module is not the marker: nothing is analyzed or erased.
const [count] = createSignal(1);
export const m = createMemo($(() => helper(count)));
var _el$ = _tmpl$();
_$addEvent(_el$, "click", $(() => count()), true);
export const view = _el$;
_$delegateEvents(["click"]);
