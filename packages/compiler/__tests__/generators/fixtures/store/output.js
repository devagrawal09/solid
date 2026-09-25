import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<div><p></p><ul>`);
var _tmpl$2 = /* @__PURE__ */ _$template(`<li>`);
import { $, createMemo, readStore, perform as _$perform } from "solid-js";
// `yield* readStore(store, selector)` lowers to one selector invocation
// through `perform` — no generator is involved in compiled output.
export function View() {
	const name = createMemo($(function() {
		return _$perform(readStore(store, (state) => state.user.name));
	}));
	return $(function() {
		var _el$ = _tmpl$();
		var _el$2 = _el$.firstChild;
		var _el$3 = _el$2.nextSibling;
		_$insert(_el$2, () => {
			return _$perform(readStore(store, (state) => state.user.name));
		});
		_$insert(_el$3, () => {
			return _$perform(readStore(store, (state) => state.items.map((item) => (() => {
				var _el$4 = _tmpl$2();
				_$insert(_el$4, () => {
					return item.name;
				});
				return _el$4;
			})())));
		});
		return _el$;
	});
}
