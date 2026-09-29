// The HN story page of `story-single.tsx` with its per-comment state lifted
// into ONE `$store` map keyed by comment id: every row reads `closed[c.id]`
// and its own handler writes `closed[c.id]`. The key is the row's own
// parameter path, so the compiler splits the map by key (a cell per row):
// `compileIslands` gives each toggle its own island, as for `story.tsx`.
import { $component, $event, $memo, $store, attempt, For, Loading, Show } from "solid-js";
import type {
  CommentDefinition,
  StoryDefinition
} from "../../../../examples/hackernews-spa/src/types";

export const StoryPage = $component(function* () {
  const story = yield* $memo(function* () {
    return yield* attempt(() => (globalThis as any).__loadStory() as Promise<StoryDefinition>);
  });
  const [closed, setClosed] = yield* $store<Record<number, boolean>>({});
  function* comment(c: CommentDefinition) {
    const toggle = $event(function* () {
      setClosed(d => {
        d[c.id] = !d[c.id];
      });
    });
    return function* () {
      return (
        <li class="comment">
          <div class="by">
            <a href={`/users/${c.user}`}>{c.user}</a> {c.time_ago} ago
          </div>
          <div class="text" innerHTML={c.content} />
          <Show when={c.comments.length}>
            <div class={["toggle", { open: !(yield* closed[c.id]) }]}>
              <a onClick={toggle}>{(yield* closed[c.id]) ? "[+] comments collapsed" : "[-]"}</a>
            </div>
            <ul
              class="comment-children"
              style={{ display: (yield* closed[c.id]) ? "none" : "block" }}
            >
              <For each={c.comments}>{comment}</For>
            </ul>
          </Show>
        </li>
      );
    };
  }
  return function* () {
    return (
      <div class="item-view">
        <div class="item-view-header">
          <a href={(yield* story).url} target="_blank">
            <h1>{(yield* story).title}</h1>
          </a>
          <Show when={(yield* story).domain}>
            <span class="host">({(yield* story).domain})</span>
          </Show>
          <p class="meta">
            {(yield* story).points} points | by{" "}
            <a href={`/users/${(yield* story).user}`}>{(yield* story).user}</a>{" "}
            {(yield* story).time_ago} ago
          </p>
        </div>
        <div class="item-view-comments">
          <p class="item-view-comments-header">
            {(yield* story).comments_count
              ? (yield* story).comments_count + " comments"
              : "No comments yet."}
          </p>
          <ul class="comment-children">
            <For each={(yield* story).comments}>{comment}</For>
          </ul>
        </div>
      </div>
    );
  };
});

export const Page = $component(function* () {
  return function* () {
    return (
      <Loading fallback={<div class="news-list-nav">Loading...</div>}>
        <StoryPage />
      </Loading>
    );
  };
});
