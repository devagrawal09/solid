// Server entry for compiled islands with streaming: the page's `<Loading>`
// over the story memo streams (islands-stream.js). The shell carries the
// fallback between `<!--l0-->` markers; the story follows as one
// out-of-order chunk (a template and its `$sl` swap), written after the shell
// as a streaming server would. Toggle islands arrive with the chunk and the
// loader finds their anchors once it has landed.
import story from "../../../../examples/hackernews-spa/src/lib/story-30186326.json";
// @ts-ignore CommonJS build glue
import { renderIslandsToString } from "../../../../packages/compiler/islands-stream.js";
import { Page } from "./story";

(globalThis as any).__loadStory = async () => story;
export const render = (): Promise<string> =>
  renderIslandsToString(($c: unknown) => (Page as any)({}, $c));
export const hydrationScript = () => "";
