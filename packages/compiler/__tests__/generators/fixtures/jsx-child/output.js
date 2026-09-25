import { template as _$template } from "@solidjs/web";
import { insert as _$insert } from "@solidjs/web";
import { readShallow as _$readShallow } from "@solidjs/web";
import { className as _$className } from "@solidjs/web";
import { effect as _$effect } from "@solidjs/web";
var _tmpl$ = /* @__PURE__ */ _$template(`<div>Count: `);
import { $, createSignal, perform as _$perform, readPath1 as _$readPath1 } from "solid-js";
export function View(props) {
	const [count] = createSignal(1);
	// JSX yields are compiler-only: after lowering, `{_$perform(count)}` is a
	// fine-grained read owned by the JSX, not by the enclosing block.
	return $(function() {
		var _el$ = _tmpl$();
		var _el$2 = _el$.firstChild;
		_$insert(_el$, () => {
			return _$perform(count);
		}, null);
		_$effect(() => _$readShallow(_$readPath1(props, "theme")), (_v$, _$p) => {
			_$className(_el$, _v$, _$p);
		});
		return _el$;
	});
}
