// todos-local, server (today's pipeline): the real app, hydratable.
import { renderToStream, generateHydrationScript } from "@solidjs/web";
import { App } from "./app";

export function render(seed: unknown[]): Promise<string> {
  const json = JSON.stringify(seed);
  (globalThis as any).localStorage = { getItem: () => json, setItem() {} };
  (globalThis as any).location = { hash: "" };
  return renderToStream(() => <App />, {
    onError: (e: any) => console.error("[ssr]", e && e.stack)
  }).then(html => html);
}
export const hydrationScript = () => generateHydrationScript();
