import { $, perform as _$perform, readPath as _$readPath, readProp as _$readProp } from "solid-js";
export const summary = $(function() {
	return `${_$perform(_$readPath(props, ["count"]))} ${_$perform(_$readPath(state, ["label"]))} ${_$perform(this.total)}`;
});
