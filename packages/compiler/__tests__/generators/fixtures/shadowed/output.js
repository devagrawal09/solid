import { $ } from "solid-js";
export function local(count) {
	const $ = (fn) => fn;
	return $(function* () {
		return yield* count;
	});
}
