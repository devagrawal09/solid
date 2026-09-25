import { escape as _$escape } from "@solidjs/web";
import { ssr as _$ssr } from "@solidjs/web";
var _tmpl$ = [
	"<a",
	" href=\"/buy\" class=\"link\"",
	">Buy <!--$-->",
	"<!--/--></a>"
];
import { srScope as _$srScope, srRoot as _$srRoot, srEl as _$srEl } from "@solidjs/resumable/server";
import { $ } from "solid-js";
import { track } from "./actions";
const STEP = 5;
// Fixture 1: event-only handlers whose captures are a props-derived const, a
// module literal constant and a link-verified server action; a prelude
// (preventDefault + guard) and a snapshot of the event fields the body reads.
export function Buy(props: {
	sku: string;
}) {
	const sku = props.sku;
	const _sr$0 = _$srScope("45814130.s0", () => ({ sku }));
	var _v$ = _$srRoot(_sr$0), _v$2 = _$srEl(_sr$0, 0), _v$3 = _$escape(sku);
	return _$ssr(_tmpl$, _v$, _v$2, _v$3);
}
