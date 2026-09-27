// todos-local, server for compiled islands (every tier): the page in a
// NoHydration zone (no keys, no serialized records). The analyzer puts
// Header, MainSection, TodoItem, Footer and App in one connected group
// (every handler writes `todos`, which the views read). Its cells need no
// serialization: both initializers are client-evaluable (`todos` from
// localStorage, `filter` from `location.hash`), exactly as hydration (A)
// re-evaluates them, so the islands rebuild them the same way.
import { renderToStream, NoHydration } from "@solidjs/web";
import { App } from "./app";

export function render(seed: unknown[]): Promise<string> {
  const json = JSON.stringify(seed);
  (globalThis as any).localStorage = { getItem: () => json, setItem() {} };
  (globalThis as any).location = { hash: "" };
  return renderToStream(
    () => (
      <NoHydration>
        <App />
      </NoHydration>
    ),
    { noScripts: true, onError: (e: any) => console.error("[ssr]", e && e.stack) }
  ).then(html => html);
}
export const hydrationScript = () => "";
