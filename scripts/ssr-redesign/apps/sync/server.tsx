// Server entry for examples/sync-blocks (async-free, generator blocks v2).
import { renderToStream, generateHydrationScript } from "@solidjs/web";
import { App } from "../../../../examples/sync-blocks/src/app";

export function render(): Promise<string> {
  return renderToStream(() => <App />, {
    onError: (e: any) => console.error("[ssr]", e && e.stack)
  }).then(html => html);
}
export const hydrationScript = () => generateHydrationScript();
