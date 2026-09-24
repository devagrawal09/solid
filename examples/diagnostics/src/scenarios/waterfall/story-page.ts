/**
 * Scenario 3, file B (fixed) — one page, one round trip's worth of waiting.
 *
 * The repair is composition, not cleverness: the three requests are keyed by
 * the id the caller already has, so they leave together, and the page they
 * make up is assembled in one memo that lives next to the component that
 * renders it. Dependent data is still dependent — it just stops being
 * *sequential*.
 *
 * The same `StoryView` surface as `story-chain.ts`, so the component does not
 * change shape when the data layer gets fixed.
 */
import { createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import { nodeName } from "../../diagnostics/channel";
import { fetchAvatarOfStory, fetchAuthorOfStory, fetchStory, type Author, type Story } from "./api";
import type { StoryView } from "./story-chain";

interface Page {
  story: Story;
  author: Author;
  avatar: string;
}

export function createStoryPage(id: Accessor<number>): StoryView {
  const page = createMemo<Page>(
    async () => {
      const storyId = id();
      const [story, author, avatar] = await Promise.all([
        fetchStory(storyId),
        fetchAuthorOfStory(storyId),
        fetchAvatarOfStory(storyId)
      ]);
      return { story, author, avatar };
    },
    {
      name: nodeName("waterfall", "page")
    }
  );

  return {
    story: () => page().story,
    author: () => page().author,
    avatar: () => page().avatar
  };
}
