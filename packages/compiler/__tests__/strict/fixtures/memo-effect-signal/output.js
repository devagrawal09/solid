import { $, createEffect, createMemo, createRenderEffect, createSignal } from "solid-js";
export function counter() {
	const [count, setCount] = createSignal(1);
	const [label, setLabel] = createSignal("items");
	// A memo host: `count()` is a graph read; `prev` is a plain input.
	const double = createMemo((prev?: number) => count() * 2 + (prev ?? 0));
	// A computed signal host.
	const [triple] = createSignal(() => count() * 3);
	// An effect compute host (the effect phase stays an ordinary callback).
	createEffect(() => `${double()} ${label()}`, (value) => console.log(value));
	createRenderEffect(() => triple(), (value) => document.title = String(value));
	// Conditional reads are bounded; the runtime still tracks them.
	const picked = createMemo(() => count() > 1 ? label() : "none");
	// A const-bound marker consumed by two memos of the same host kind.
	const shared = () => label().length;
	const a = createMemo(shared);
	const b = createMemo(shared);
	return [
		double,
		picked,
		a,
		b,
		setCount,
		setLabel
	];
}
