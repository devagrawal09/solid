// Server entry: the server graph is analyzed independently. `server-only`
// exists only here; event bodies never run during SSR.
import { renderToString } from "@solidjs/web";
import { App } from "./App";
import { audit } from "./server-only";

export function handle() {
  audit("render");
  return renderToString(() => <App />);
}
