import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<p> <!> <!>`);
import { $, createMemo, createSignal, readStore, perform as _$perform, readPath1 as _$readPath1, readPath2 as _$readPath2, readPath3 as _$readPath3 } from "solid-js";
// Direct property syntax: `yield* root.a[0][k]` lowers to one proxy-free
// handle read (`readPath1`–`readPath4` by key count, `readPathN` beyond);
// store and prop roots share the readers.
export function Counter(props: {
	count: number;
	user: {
		name: string;
	};
}) {
	const [index] = createSignal(0);
	const total = createMemo($(function() {
		const i = _$perform(index);
		return `${_$readPath2(store, "user", "name")} ${_$readPath3(store, "items", 0, "name")} ${_$readPath3(store, "items", i, "name")} ${_$readPath2(store, "items", "length")}`;
	}));
	return $(function() {
		var _el$ = _tmpl$();
		var _el$2 = _el$.firstChild;
		var _el$3 = _el$2.nextSibling;
		var _el$4 = _el$3.nextSibling;
		var _el$5 = _el$4.nextSibling;
		_$insert(_el$, () => {
			return _$readPath1(props, "count");
		}, _el$2);
		_$insert(_el$, () => {
			return _$readPath2(props, "user", "name");
		}, _el$3);
		_$insert(_el$, () => {
			return _$perform(total);
		}, _el$5);
		return _el$;
	});
}
// Unsupported operands leave the whole block to the runtime driver.
export const optional = $(function* () {
	return yield* store.user?.name;
});
export const computed = $(function() {
	return _$perform(store.items[i + 1]);
});
export const structural = $(function() {
	return _$perform(readStore(store, (s) => s.items.map((item) => item.name)));
});
