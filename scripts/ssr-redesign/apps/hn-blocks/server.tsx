// Server entry (A on the v2 source): today's pipeline, the whole page
// hydratable, awaited in full.
import { renderToStream, generateHydrationScript } from "@solidjs/web";
import story from "../../../../examples/hackernews-spa/src/lib/story-30186326.json";
import { Page } from "./story";

(globalThis as any).__loadStory = async () => story;
export function render(): Promise<string> {
  return renderToStream(() => <Page />, {
    onError: (e: any) => console.error("[ssr]", e && e.stack)
  }).then(html => html);
}
export const hydrationScript = () => generateHydrationScript();
