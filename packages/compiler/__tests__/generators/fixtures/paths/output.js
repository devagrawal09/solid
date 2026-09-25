import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<p> <!> <!>`);
import { $, createMemo, createSignal, readStore, perform as _$perform, readPath as _$readPath, readProp as _$readProp } from "solid-js";
// Direct property syntax: `yield* root.a[0][k]` lowers to a path read
// (`readPath`; `readProp` when the root is a component's props parameter).
export function Counter(props: {
	count: number;
	user: {
		name: string;
	};
}) {
	const [index] = createSignal(0);
	const total = createMemo($(function() {
		const i = _$perform(index);
		return `${_$perform(_$readPath(store, ["user", "name"]))} ${_$perform(_$readPath(store, [
			"items",
			0,
			"name"
		]))} ${_$perform(_$readPath(store, [
			"items",
			i,
			"name"
		]))} ${_$perform(_$readPath(store, ["items", "length"]))}`;
	}));
	return $(function() {
		var _el$ = _tmpl$();
		var _el$2 = _el$.firstChild;
		var _el$3 = _el$2.nextSibling;
		var _el$4 = _el$3.nextSibling;
		var _el$5 = _el$4.nextSibling;
		_$insert(_el$, () => {
			return _$perform(_$readProp(props, ["count"]));
		}, _el$2);
		_$insert(_el$, () => {
			return _$perform(_$readProp(props, ["user", "name"]));
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
