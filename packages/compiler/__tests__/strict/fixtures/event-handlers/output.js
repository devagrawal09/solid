import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { effect as _$effect } from "@solidjs/web";
import { delegateEvents as _$delegateEvents } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<form><input><button type=button></button><button type=button>again`);
import { $, createSignal, createStore } from "solid-js";
export function Form(props: {
	onSaved: (id: string) => void;
}) {
	const [count, setCount] = createSignal(0);
	const [store, setStore] = createStore({
		draft: "",
		saved: [] as string[]
	});
	// Event hosts are untracked: reads are recorded, never dependencies.
	// Writes and unknown helpers with plain arguments are fine.
	const increment = () => setCount((value) => value + 1);
	// An async handler: writes after `await` are ordinary handler behavior.
	const save = async (event: SubmitEvent & {
		currentTarget: HTMLFormElement;
	}) => {
		event.preventDefault();
		const draft = store.draft;
		const id = await persist(draft, count());
		setStore((state) => {
			state.saved.push(id);
		});
		props.onSaved(id);
	};
	var _el$ = _tmpl$();
	var _el$2 = _el$.firstChild;
	var _el$3 = _el$2.nextSibling;
	var _el$4 = _el$3.nextSibling;
	_el$.addEventListener("submit", save);
	_el$2.$$input = (e: InputEvent & {
		currentTarget: HTMLInputElement;
	}) => setStore((state) => {
		state.draft = e.currentTarget.value;
	});
	_el$3.addEventListener(":reset", () => setCount(0));
	_el$3.$$click = increment;
	_$insert(_el$3, count);
	_el$4.$$click = increment;
	_$effect(() => store.draft, (_v$) => {
		_el$2.value = _v$ ?? "";
	});
	return _el$;
}
declare function persist(draft: string, count: number): Promise<string>;
_$delegateEvents(["input", "click"]);
