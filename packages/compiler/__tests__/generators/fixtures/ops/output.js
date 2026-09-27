import { $, attempt, createMemo, raise, perform as _$perform } from "solid-js";
class NotFound extends Error {}
// Sync operations lower to call form: reads and a raise.
export const page = createMemo($(function() {
	const text = _$perform(raw);
	const parsed = JSON.parse(text);
	if (!parsed.id) _$perform(raise(new NotFound()));
	return parsed;
}));
// Event blocks write with a direct setter call.
export const onClick = $(function(event) {
	const c = _$perform(count);
	setCount(c + event.detail);
});
// A block that attempts may suspend, so only the generator driver can run
// it: untouched.
export const profile = createMemo($(function* () {
	const id = yield* userId;
	const user = yield* attempt(() => fetchUser(id), NotFound);
	return user.name;
}));
