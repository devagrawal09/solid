import { $, createMemo, createSignal, onCleanup, untrack } from "solid-js";
const [source] = createSignal(1);
const [other] = createSignal(2);
// Owned creation inside a memo: the inner marked memo has its own summary;
// `untrack` runs its body synchronously without tracking; a local helper
// defined in the callback is walked where it is defined.
export const outer = createMemo(() => {
	const [local, setLocal] = createSignal(source());
	const inner = createMemo(() => local() + 1);
	const peeked = untrack(() => other());
	onCleanup(() => console.log("disposed"));
	function describe(value: number) {
		return `${value}/${inner()}`;
	}
	// A closure handed to an unsummarized helper may only capture plain
	// values; a closure handed to a summarized factory (`onCleanup`) may
	// capture the setter.
	const timer = setInterval(() => console.log("tick"), 1e3);
	onCleanup(() => {
		clearInterval(timer);
		setLocal(0);
	});
	return describe(peeked);
});
