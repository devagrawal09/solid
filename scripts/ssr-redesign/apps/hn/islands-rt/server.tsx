// P1-rt, server: the story page in a NoHydration zone; Toggle is swapped for
// the island wrapper (toggle.server.tsx) by the build.
import { renderToStream, generateHydrationScript, NoHydration } from "@solidjs/web";
import story from "../../../../../examples/hackernews-spa/src/lib/story-30186326.json";
import { Page } from "../story";

(globalThis as any).__loadStory = async () => story;
export function render(): Promise<string> {
  return renderToStream(
    () => (
      <NoHydration>
        <Page />
      </NoHydration>
    ),
    { onError: (e: any) => console.error("[ssr]", e && e.stack) }
  ).then(html => html);
}
export const hydrationScript = () => generateHydrationScript();
