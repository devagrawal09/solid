import { $, createEffect, createMemo, createSignal, statusFree as _$statusFree, syncOnly as _$syncOnly } from "solid-js";
export function counter() {
	const [count, setCount] = createSignal(1);
	const [label] = createSignal("items");
	const [anything] = createSignal<unknown>(null);
	// Typed primitive reads: total arithmetic and templates — status-free.
	const double = createMemo(function() {
		return count() * 2;
	}, _$statusFree);
	const text = createMemo(function() {
		return `${double()} ${label()}`;
	}, _$statusFree);
	// `===` never throws; a read of an untyped signal is total — status-free.
	const isNull = createMemo(function() {
		return anything() === null;
	}, _$statusFree);
	// A bare read of an untyped value may be a Promise: NOTHROW only.
	const raw = createMemo(function() {
		return anything();
	});
	// An unknown call: refused (no metadata).
	const formatted = createMemo(function() {
		return format(count());
	});
	// A member access can throw (SYNC only); the effect gets `syncOnly`.
	createEffect(function() {
		return text().length === 0 ? "empty" : "full";
	}, (value) => console.log(value), _$syncOnly);
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
