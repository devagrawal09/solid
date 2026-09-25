import { $ as reactive, createMemo, perform as _$perform } from "@solidjs/signals";
export const double = createMemo(reactive(function() {
	return _$perform(count) * 2;
}));
