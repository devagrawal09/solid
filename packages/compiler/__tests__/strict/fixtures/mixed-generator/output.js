import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { addEvent as _$addEvent } from "@solidjs/web";
import { delegateEvents as _$delegateEvents } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<div><button>block</button><button>strict`);
var _tmpl$2 = /* @__PURE__ */ _$template(`<p>`);
import { $, createMemo, createSignal, readStore, write, perform as _$perform } from "solid-js";
const [count, setCount] = createSignal(1);
// A generator block keeps the existing lowering (`$` stays, reads become
// `perform`); the strict marker next to it is erased for its host.
export const viaGenerator = createMemo($(function() {
	return _$perform(count) * 2;
}));
export const viaStrict = createMemo(() => count() * 2);
// An event block (generator) and a strict event handler side by side.
export const eventBlock = $(function(event: MouseEvent) {
	const c = _$perform(count);
	_$perform(write(setCount, c + event.button));
});
export function View(props: {
	store: {
		items: string[];
	};
}) {
	var _el$ = _tmpl$();
	var _el$2 = _el$.firstChild;
	var _el$3 = _el$2.nextSibling;
	_$addEvent(_el$2, "click", eventBlock, true);
	_el$3.$$click = () => setCount(0);
	_$insert(_el$, () => {
		return $(function() {
			var _el$4 = _tmpl$2();
			_$insert(_el$4, () => {
				return _$perform(readStore(props.store, (s) => s.items.join(",")));
			});
			return _el$4;
		});
	}, null);
	return _el$;
}
_$delegateEvents(["click"]);
