import { render } from "@solidjs/web";
import { TriangleDemo } from "./app";

// `render(TriangleDemo, …)` as in the original does not typecheck: a
// `$component` takes its props argument (`(props: PropsInput<{}>) => View`),
// and `render` wants `() => JSX.Element`.
render(() => <TriangleDemo />, document.body);
