// The hackernews-spa story route (examples/hackernews-spa/src/routes/story.tsx),
// without the router: the same markup, the same Comment and Toggle
// components, and an async memo over the story loader — what the route's
// query does. The loader is injected (`globalThis.__loadStory`): the server
// returns the captured 1,406-comment thread, the client would fetch JSON.
import { For, Loading, Show, createMemo } from "solid-js";
import Comment from "../../../../examples/hackernews-spa/src/components/comment";
import type { StoryDefinition } from "../../../../examples/hackernews-spa/src/types";

export function StoryPage() {
  const story = createMemo(() => (globalThis as any).__loadStory() as Promise<StoryDefinition>);
  return (
    <div class="item-view">
      <div class="item-view-header">
        <a href={story().url} target="_blank">
          <h1>{story().title}</h1>
        </a>
        <Show when={story().domain}>
          <span class="host">({story().domain})</span>
        </Show>
        <p class="meta">
          {story().points} points | by <a href={`/users/${story().user}`}>{story().user}</a>{" "}
          {story().time_ago} ago
        </p>
      </div>
      <div class="item-view-comments">
        <p class="item-view-comments-header">
          {story().comments_count ? story().comments_count + " comments" : "No comments yet."}
        </p>
        <ul class="comment-children">
          <For each={story().comments}>{comment => <Comment comment={comment} />}</For>
        </ul>
      </div>
    </div>
  );
}

export function Page() {
  return (
    <Loading fallback={<div class="news-list-nav">Loading...</div>}>
      <StoryPage />
    </Loading>
  );
}
