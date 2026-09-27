// Server entry: the story page with the captured thread, awaited in full.
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
