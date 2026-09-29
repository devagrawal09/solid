// Server entry: `App` compiles to a string-template function, so rendering
// the document is a call with the request URL in the render context. Every
// module's derived frames are registered as server functions when the
// module loads (declared GET reads); `handleServerFunctionRequest` serves
// them at `/_server/<id>?args=[…]`.
import { AsyncLocalStorage } from "node:async_hooks";
// @ts-ignore build glue
import { framesFlight } from "@solidjs/compiler/frames-server";
// @ts-ignore CommonJS build glue
import { renderIslandsToString } from "@solidjs/compiler/islands-stream";
import { configureServerFunctionsServer, getServerFunction } from "@solidjs/web/server-functions";
import { App } from "./app";

export { handleServerFunctionRequest } from "@solidjs/web/server-functions";

// The request-event scope server functions run in (the host's job; the
// vite plugin's `start` mode installs the same for ../hackernews), and the
// single-flight hook: a server call from island code that refreshes frames
// brings them back in its response.
const events = new AsyncLocalStorage();
configureServerFunctionsServer({
  provideEvent: (event, fn) => events.run(event, fn),
  collectFlightData: framesFlight(getServerFunction)
});

const URL_KEY = Symbol.for("solid.islands.url");

export function render(url: string): Promise<string> {
  return renderIslandsToString(($c: Map<unknown, unknown>) =>
    (App as any)({}, new Map($c).set(URL_KEY, url))
  );
}
