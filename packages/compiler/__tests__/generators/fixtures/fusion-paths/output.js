import { $, createMemo, createStore, readPath1 as _$readPath1, readPath2 as _$readPath2, readPath3 as _$readPath3 } from "solid-js";
function Counter(props) {
	const [store] = createStore({
		user: { name: "Ada" },
		items: [{ name: "one" }],
		"data-x": 1
	});
	const i = 0;
	// A store path and a prop path: the member chain is the tracked walk;
	// `readValue` reads through an accessor or block found at the path.
	const name = createMemo(function() {
		return _$readPath2(store, "user", "name");
	});
	const label = createMemo(function() {
		return _$readPath1(props, "count");
	});
	// An index, a dynamic key, `length`, and a key that is not an identifier.
	const summary = createMemo(function() {
		return `${_$readPath3(store, "items", 0, "name")} ${_$readPath2(store, "items", i)} ${_$readPath2(store, "items", "length")} ${_$readPath1(store, "data-x")}`;
	});
	return [
		name,
		label,
		summary
	];
}
