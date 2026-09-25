import { $, perform as _$perform } from "solid-js";
export const summary = $(function() {
	return `${_$perform(props.count)} ${_$perform(state["label"])} ${_$perform(this.total)}`;
});
