import { scope as _$scope } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
var _tmpl$ = [
	"<button",
	" type=\"button\" class=\"counter\"",
	">",
	"</button>"
];
var _tmpl$2 = [
	"<div",
	" class=\"labeled\"><button type=\"button\"",
	">+</button><button type=\"button\"",
	">-</button><p class=\"count\">Count: <!--$-->",
	"<!--/--></p></div>"
];
import { srScope as _$srScope, srRoot as _$srRoot, srEl as _$srEl } from "@solidjs/resumable/server";
import { $, createSignal } from "solid-js";
// Fixture 2 of the resumable-events prototype: the smallest resume scope —
// one signal, one exact text binding, one handler.
export function Counter() {
	const [count, setCount] = createSignal(0);
	const _sr$0 = _$srScope("a3ac9868.s0", () => ({ count: count() }));
	var _v$ = _$srRoot(_sr$0), _v$2 = _$srEl(_sr$0, 0), _v$3 = _$scope(() => {
		return _$escape(count());
	});
	return _$ssr(_tmpl$, _v$, _v$2, _v$3);
}
// A marked text hole (`<!--$-->` inside a sibling element) and two handlers.
export function Labeled(props: {
	start: number;
}) {
	const [count, setCount] = createSignal(props.start);
	const inc = () => setCount(count() + 1);
	const _sr$1 = _$srScope("a3ac9868.s1", () => ({ count: count() }));
	var _v$4 = _$srRoot(_sr$1), _v$5 = _$srEl(_sr$1, 0), _v$6 = _$srEl(_sr$1, 1), _v$7 = _$scope(() => {
		return _$escape(count());
	});
	return _$ssr(_tmpl$2, _v$4, _v$5, _v$6, _v$7);
}
