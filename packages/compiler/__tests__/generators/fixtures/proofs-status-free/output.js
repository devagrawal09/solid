import { $, createEffect, createMemo, createSignal, perform as _$perform, statusFree as _$statusFree, syncOnly as _$syncOnly } from "solid-js";
export function counter() {
	const [count, setCount] = createSignal(1);
	const [label] = createSignal("items");
	const [anything] = createSignal<unknown>(null);
	// Typed primitive reads: total arithmetic and templates — status-free.
	const double = createMemo($(function() {
		return _$perform(count) * 2;
	}, 3), _$statusFree);
	const text = createMemo($(function() {
		return `${_$perform(double)} ${_$perform(label)}`;
	}, 3), _$statusFree);
	// `===` never throws; a read of an untyped signal is total — status-free.
	const isNull = createMemo($(function() {
		return _$perform(anything) === null;
	}, 3), _$statusFree);
	// A bare read of an untyped value may be a Promise: NOTHROW only.
	const raw = createMemo($(function() {
		return _$perform(anything);
	}, 2));
	// An unknown call: refused (no metadata).
	const formatted = createMemo($(function() {
		return format(_$perform(count));
	}));
	// A member access can throw (SYNC only); the effect gets `syncOnly`.
	createEffect($(function() {
		return _$perform(text).length === 0 ? "empty" : "full";
	}, 1), (value) => console.log(value), _$syncOnly);
	return [
		double,
		text,
		isNull,
		raw,
		formatted,
		setCount
	];
}
declare function format(value: number): string;
