import { $, createSignal, perform as _$perform } from "solid-js";
const [count] = createSignal(1);
// Standalone block: not consumed by a known host — fusion must NOT apply.
const block = $(function() {
	return _$perform(count);
});
