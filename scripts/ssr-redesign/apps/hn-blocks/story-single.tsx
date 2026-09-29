// The HN story page of `story.tsx` written as ONE component: the comment
// thread is a named, recursive row block (`comment`) declared in the page's
// setup, holding each comment's `open` signal — no Toggle, no Comment
// component. Component boundaries must not matter: `compileIslands` gives
// this module the same partition as `story.tsx` (story and comment markup
// inert, one tier-0 island per toggle instance, nothing serialized), and the
// same markup.
import { $component, $event, $memo, $signal, attempt, For, Loading, Show } from "solid-js";
import type {
  CommentDefinition,
  StoryDefinition
} from "../../../../examples/hackernews-spa/src/types";

export const StoryPage = $component(function* () {
  const story = yield* $memo(function* () {
    return yield* attempt(() => (globalThis as any).__loadStory() as Promise<StoryDefinition>);
  });
  function* comment(c: CommentDefinition) {
    const [open, setOpen] = yield* $signal(true);
    const toggle = $event(function* () {
      setOpen(o => !o);
    });
    return function* () {
      return (
        <li class="comment">
          <div class="by">
            <a href={`/users/${c.user}`}>{c.user}</a> {c.time_ago} ago
          </div>
          <div class="text" innerHTML={c.content} />
          <Show when={c.comments.length}>
            <div class={["toggle", { open: yield* open }]}>
              <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
            </div>
            <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
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
