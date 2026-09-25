import { $, attempt, call, createMemo, raise, wait, write, perform as _$perform } from "solid-js";
class NotFound extends Error {}
// Sync operations lower to call form: reads, an attempt, a raise.
export const page = createMemo($(function() {
	const text = _$perform(raw);
	const parsed = _$perform(attempt(() => JSON.parse(text), SyntaxError));
	if (!parsed.id) _$perform(raise(new NotFound()));
	return parsed;
}));
// Event blocks: a write and a delegation with the event are sync too.
export const onClick = $(function(event) {
	const c = _$perform(count);
	_$perform(write(setCount, c + 1));
	return _$perform(call(props.onClick, event));
});
// A block that waits can only be run by the generator driver: untouched.
export const profile = createMemo($(function* () {
	const id = yield* userId;
	const user = yield* wait(fetchUser(id), NotFound);
	return user.name;
}));
