// P1-static, server: the story page in a NoHydration zone (no keys, nothing
// serialized); Toggle is swapped for the anchored island (toggle.server.tsx).
import { renderToStream, NoHydration } from "@solidjs/web";
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
    // A resumed page has no hydration runtime to read records.
    { noScripts: true, onError: (e: any) => console.error("[ssr]", e && e.stack) }
  ).then(html => html);
}
// Resumed pages need no hydration bootstrap (`_$HY`).
export const hydrationScript = () => "";
