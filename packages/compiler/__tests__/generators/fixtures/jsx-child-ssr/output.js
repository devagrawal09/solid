import { escape as _$escape } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
import { ssrClassName as _$ssrClassName } from "@solidjs/web";
var _tmpl$ = [
	"<div class=\"",
	"\">Count: ",
	"</div>"
];
import { $, createSignal, perform as _$perform } from "solid-js";
export function View(props) {
	const [count] = createSignal(1);
	// JSX yields are compiler-only: after lowering, `{_$perform(count)}` is a
	// fine-grained read owned by the JSX, not by the enclosing block.
	return $(function() {
		var _v$ = () => {
			return _$ssrClassName(_$perform(props.theme));
		}, _v$2 = () => {
			return _$escape(_$perform(count));
		};
		return _$ssr(_tmpl$, _v$, _v$2);
	});
}
