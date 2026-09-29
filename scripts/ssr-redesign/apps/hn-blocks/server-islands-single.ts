// Server entry for compiled islands of `story-single.tsx` (the page as one
// component with a recursive row block), compiled by
// `compileIslands`, so `Page` is its string-template function (no runtime,
// no keys, nothing serialized; Toggle instances carry their anchors).
import story from "../../../../examples/hackernews-spa/src/lib/story-30186326.json";
import { Page } from "./story-single";

(globalThis as any).__loadStory = async () => story;
export const render = (): Promise<string> => (Page as any)();
export const hydrationScript = () => "";
