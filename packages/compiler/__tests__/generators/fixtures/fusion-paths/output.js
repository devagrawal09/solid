import { $, createMemo, perform as _$perform, readPath1 as _$readPath1, readPath2 as _$readPath2 } from "solid-js";
function Counter(props) {
	const name = createMemo(function() {
		return _$readPath2(store, "user", "name");
	});
	const label = createMemo(function() {
		return _$readPath1(props, "count");
	});
	return [name, label];
}
