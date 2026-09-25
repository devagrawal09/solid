import { $, createEffect, createMemo, createSignal, perform as _$perform } from "solid-js";
export function counter() {
	const [count, setCount] = createSignal(1);
	const [label, setLabel] = createSignal("items");
	// `prev` and multiple heterogeneous reads.
	const double = createMemo(function(prev) {
		const c = count();
		return c * 2 + (prev ?? 0);
	});
	// A yield inside a template literal.
	createEffect(function() {
		return `${double()} ${label()}`;
	}, (value) => console.log(value));
	// Conditional reads keep their control flow.
	const picked = createMemo(function() {
		return count() > 1 ? label() : "none";
	});
	return [
		double,
		picked,
		setCount,
		setLabel
	];
}
