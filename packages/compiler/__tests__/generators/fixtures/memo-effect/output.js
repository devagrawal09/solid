import { $, createEffect, createMemo, createSignal, perform as _$perform } from "solid-js";
export function counter() {
	const [count, setCount] = createSignal(1);
	const [label, setLabel] = createSignal("items");
	// `prev` and multiple heterogeneous reads.
	const double = createMemo($(function(prev) {
		const c = _$perform(count);
		return c * 2 + (prev ?? 0);
	}));
	// A yield inside a template literal.
	createEffect($(function() {
		return `${_$perform(double)} ${_$perform(label)}`;
	}), (value) => console.log(value));
	// Conditional reads keep their control flow.
	const picked = createMemo($(function() {
		return _$perform(count) > 1 ? _$perform(label) : "none";
	}));
	return [
		double,
		picked,
		setCount,
		setLabel
	];
}
