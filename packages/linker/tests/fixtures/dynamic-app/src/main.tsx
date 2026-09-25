import { render } from "@solidjs/web";
import { Panel } from "./panel";

// A non-literal dynamic import: any module could be loaded and any export
// used, so no exported binding may move and no exported block is provably
// event-only.
export function loadPlugin(name: string) {
  return import(`./plugins/${name}.ts`);
}

render(() => <Panel />, document.body);
