import { $, createMemo, perform as _$perform } from "solid-js";
export const guarded = createMemo($(function() {
	try {
		return `value:${_$perform(failing)}`;
	} catch (error) {
		return `caught:${error.message}`;
	} finally {
		cleanup();
	}
}));
