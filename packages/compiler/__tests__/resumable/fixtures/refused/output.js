import { scope as _$scope } from "@solidjs/web";
import { escape as _$escape } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
import { ssrHydrationKey as _$ssrHydrationKey } from "@solidjs/web";
var _tmpl$ = [
	"<div",
	"><button class=\"mutable\">a</button><button class=\"escape\">b</button><button class=\"fn\">c</button><button class=\"memo\">d</button><button class=\"import\">e</button><button class=\"field\">f</button><button class=\"late\">g</button><button class=\"store\">h</button><button class=\"ok\">",
	"</button></div>"
];
var _tmpl$2 = [
	"<div",
	">",
	"</div>"
];
var _tmpl$3 = [
	"<button",
	">",
	"</button>"
];
import { $, createSignal, createMemo, createStore, createEffect } from "solid-js";
import { helper } from "./helper";
function local() {
	return 1;
}
// Every handler here stays hydrated, each for one reason code; the sound
// handler at the end is refused with its scope.
export function Refused(props: {
	onDone: () => void;
}) {
	let clicks = 0;
	const [count, setCount] = createSignal(0);
	const [store, setStore] = createStore({ n: 1 });
	const double = createMemo(() => count() * 2);
	var _v$ = _$ssrHydrationKey(), _v$2 = _$scope(() => {
		return _$escape(count());
	});
	return _$ssr(_tmpl$, _v$, _v$2);
}
// A scope refused for its template: a component child.
export function Dynamic() {
	const [count, setCount] = createSignal(0);
	var _v$3 = _$ssrHydrationKey(), _v$4 = _$escape(Refused({ onDone: () => {} }));
	return _$ssr(_tmpl$2, _v$3, _v$4);
}
// A scope refused because the signal escapes into an effect the client
// never runs.
export function Escapes() {
	const [count, setCount] = createSignal(0);
	createEffect(() => count(), () => {});
	var _v$5 = _$ssrHydrationKey(), _v$6 = _$scope(() => {
		return _$escape(count());
	});
	return _$ssr(_tmpl$3, _v$5, _v$6);
}
