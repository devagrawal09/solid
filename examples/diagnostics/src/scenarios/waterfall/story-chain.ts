/**
 * Scenario 3, file B (broken) — three memos, three serial round trips.
 *
 * Each memo is individually reasonable: it asks for the thing it needs with
 * the id it has. The chain is only visible when you line the three up — and
 * in a real app they are rarely in one file, which is why this costs 3× the
 * latency in production and nobody notices locally.
 *
 * The attribution engine proves the chain twice over before it says anything:
 * each flight's recompute must have been *caused* by the previous flight's
 * landing, and its origin must post-date that landing. Depth 3 escalates the
 * verdict from an advisory to a console `warn`.
 */
import { createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import { nodeName } from "../../diagnostics/channel";
import { fetchAuthor, fetchAvatar, fetchStory, type Author, type Story } from "./api";

export interface StoryView {
  story: Accessor<Story>;
  author: Accessor<Author>;
  avatar: Accessor<string>;
}

export function createStoryChain(id: Accessor<number>): StoryView {
  const story = createMemo<Story>(() => fetchStory(id()), {
    name: nodeName("waterfall", "story")
  });

  // Reads `story()` — so this request cannot even be described until the
  // first one has landed.
  const author = createMemo<Author>(() => fetchAuthor(story().authorId), {
    name: nodeName("waterfall", "author")
  });

  // …and this one waits for the second.
  const avatar = createMemo<string>(() => fetchAvatar(author().avatarId), {
    name: nodeName("waterfall", "avatar")
  });

  return { story, author, avatar };
}
