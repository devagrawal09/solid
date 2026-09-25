import { $, createMemo, perform as _$perform, readPath as _$readPath, readProp as _$readProp } from "solid-js";
function Counter(props) {
	const name = createMemo(function() {
		return store.user.name;
	});
	const label = createMemo(function() {
		return props.count;
	});
	return [name, label];
}
