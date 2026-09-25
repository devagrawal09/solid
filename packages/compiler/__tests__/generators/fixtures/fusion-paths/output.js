import { $, createMemo, createStore, perform as _$perform, readPath1 as _$readPath1, readPath2 as _$readPath2, readValue as _$readValue } from "solid-js";
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
		return `${_$readValue(store.items[0].name)} ${_$readValue(store.items[i])} ${_$readValue(store.items.length)} ${_$readValue(store["data-x"])}`;
	});
	return [
		name,
		label,
		summary
	];
}
