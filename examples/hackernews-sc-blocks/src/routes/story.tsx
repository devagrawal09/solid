// A story and its thread. Compare ../../../hackernews/src/lib/views.tsx
// (`storyView`, a hand-written `"use server"` component) and
// ../../../hackernews/src/routes/story.tsx (`dynamic(() => getStory(id))`
// with a `toggle` slot): here there is neither. The page reads its data in
// a memo over the route's `id`; the compiler proves every reader inert, so
// the view is a frame whose argument is `id` — rendered in the document on
// first load, fetched as HTML on navigation. The toggles are islands inside
// it (their anchors are in the frame's HTML), keyed by comment.
import type { RouteParams, RoutePreloadFuncArgs, RouteProps } from "@solidjs/router";
import { $component, $memo, attempt, For, type TypedProps } from "solid-js";
import Toggle from "../components/toggle";
import { getStory } from "../lib/hn";
import type { CommentDefinition } from "../types";

type Path = "/stories/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getStory(params.id);
};

const Comment = $component(function* (props: TypedProps<{ comment: CommentDefinition }>) {
  return function* () {
    return (
      <li class="comment">
        <div class="by">
          <a href={`/users/${yield* props.comment.user}`}>{yield* props.comment.user}</a>{" "}
          {yield* props.comment.time_ago} ago
        </div>
        <div class="text" innerHTML={yield* props.comment.content} />
        {(yield* props.comment.comments).length ? (
          <Toggle>
            <For each={yield* props.comment.comments}>{c => <Comment comment={c} />}</For>
          </Toggle>
        ) : null}
      </li>
    );
  };
});

const Story = $component(function* (props: RouteProps<Path>) {
  const story = yield* $memo(function* () {
    const id = yield* props.params.id;
    return yield* attempt(() => getStory(id));
  });
  return function* () {
    const item = yield* story;
    return (
      <div class="item-view">
        <div class="item-view-header">
          <a href={item.url} target="_blank">
            <h1>{item.title}</h1>
          </a>
          {item.domain ? <span class="host">({item.domain})</span> : null}
          <p class="meta">
            {item.points} points | by <a href={`/users/${item.user}`}>{item.user}</a>{" "}
            {item.time_ago} ago
          </p>
        </div>
        <div class="item-view-comments">
          <p class="item-view-comments-header">
            {item.comments_count ? item.comments_count + " comments" : "No comments yet."}
          </p>
          <ul class="comment-children">
            <For each={item.comments}>{c => <Comment comment={c} />}</For>
          </ul>
        </div>
      </div>
    );
  };
});

export default Story;
