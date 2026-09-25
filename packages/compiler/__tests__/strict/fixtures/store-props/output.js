import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<p>`);
import { $, createMemo, createSignal, createStore } from "solid-js";
interface Item {
	id: number;
	name: string;
	done: boolean;
}
export function List(props: {
	filter: string;
	selected: Item;
}) {
	const [store] = createStore({
		user: { name: "Ada" },
		items: [] as Item[]
	});
	const [index] = createSignal(0);
	// A const alias of a store path is a path prefix.
	const user = store.user;
	// A const alias of a props path, the same.
	const selected = props.selected;
	const summary = createMemo(() => {
		const name = user.name;
		const current = store.items[index()];
		// A method call on a store path is a structural read; the callback it
		// receives captures only plain values (the prop is read first), so it
		// may be handed over.
		const filter = props.filter;
		const open = store.items.filter((item) => !item.done && item.name.includes(filter));
		return `${name}: ${current?.name ?? "none"} (${open.length} open, ${selected.id})`;
	});
	var _el$ = _tmpl$();
	_$insert(_el$, summary);
	return _el$;
}
