import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, $memo, attempt, For, Show, type TypedProps, view } from "@solidjs/blocks";
import Comment from "~/components/comment";
import { getStory } from "~/lib/api";
import { ApiError } from "~/lib/errors";

// The route lives in app.tsx, so the component and preload here name the
// pattern they belong to; `params.id` is then `string`, not `string | undefined`.
type Path = "/stories/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getStory(params.id);
};

const Story = $component(function* Story(props: TypedProps<RouteProps<Path>, "StoryPage">) {
  const story = yield* $memo(function* () {
    const id2 = yield* props.params.id;
    return yield* attempt(
      () => getStory(id2),
      cause => new ApiError(cause)
    );
  });
  return view(function* () {
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
  });
});

export default Story;
