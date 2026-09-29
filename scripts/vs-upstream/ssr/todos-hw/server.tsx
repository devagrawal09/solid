// Server entry for examples/todos (handwritten): the real app, rendered with
// renderToStream (awaited in full, so the page carries the resolved list and
// its serialized data — what a streamed page converges to).
import { renderToStream, generateHydrationScript } from "@solidjs/web";
import { App } from "../../../../examples/todos/src/app";

export function render(seed: unknown[]): Promise<string> {
  const json = JSON.stringify(seed);
  (globalThis as any).localStorage = { getItem: () => json, setItem() {} };
  (globalThis as any).location = { hash: "" };
  return renderToStream(() => <App />, {
    onError: (e: any) => console.error("[ssr]", e && e.stack)
  }).then(html => html);
}
export const hydrationScript = () => generateHydrationScript();
