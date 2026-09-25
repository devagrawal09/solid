import { $, perform as _$perform, readPath1 as _$readPath1 } from "solid-js";
export const summary = $(function() {
	return `${_$readPath1(props, "count")} ${_$readPath1(state, "label")} ${_$perform(this.total)}`;
});
