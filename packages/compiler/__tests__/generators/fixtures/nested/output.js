import { $, perform as _$perform } from "solid-js";
export const outer = $(function() {
	// A nested generator owns its yields: untouched.
	function* inner() {
		return yield* count;
	}
	// A nested `$` is lowered on its own.
	const nested = $(function() {
		return _$perform(other);
	});
	// Arrow bodies cannot yield for the outer generator; their calls are plain.
	const read = () => count();
	return _$perform(count) + nested() + read() + inner().next().value;
});
