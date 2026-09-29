import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, $memo, For, Show, type TypedProps } from "solid-js";
import Comment from "~/components/comment";
import { getStory } from "~/lib/api";
import type { StoryDefinition as StoryDefinitionT } from "~/types";

// The route lives in app.tsx, so the component and preload here name the
// pattern they belong to; `params.id` is then `string`, not `string | undefined`.
type Path = "/stories/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getStory(params.id);
};

const Story = $component(function* (props: TypedProps<RouteProps<Path>>) {
  const story = yield* $memo(function* () {
    // `!`: `TypedProps` maps the router's `Params` index signature, so the path
    // read types `id` as `string | undefined` (the route pattern guarantees it).
    const id = (yield* props.params.id)!;
    // The query's promise is returned as the memo's value, as the original
    // does, rather than `yield* attempt(() => …)`: a compiled async memo body
    // breaks under hydration (its `AsyncRun` builds its result promise while
    // hydration has swapped the global `Promise` for a mock whose executor
    // never runs; the run then throws `this.ok is not a function` when it is
    // superseded). `$memo` types its value as the body's return, so the
    // promise needs a cast, which hides the pending state from the types.
    return getStory(id) as unknown as StoryDefinitionT;
  });
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
            <For each={(yield* story).comments}>{comment => <Comment comment={comment} />}</For>
          </ul>
        </div>
      </div>
    );
  };
});

export default Story;
