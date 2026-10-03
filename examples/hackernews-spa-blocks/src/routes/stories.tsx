import { type RoutePreloadFuncArgs, type RouteSectionProps } from "@solidjs/router";
import { $, $component, $memo, attempt, For, Show, type TypedProps } from "@solidjs/blocks";
import Story from "~/components/story";
import { getStories } from "~/lib/api";
import type { StoryTypes } from "~/types";
import { ApiError } from "~/lib/errors";

/** `/` and the four named feeds all render this; the path names the feed. */
export const storyType = (pathname: string): StoryTypes =>
  (pathname.split("/")[1] || "top") as StoryTypes;

// The feed routes take no params, so the open `RouteSectionProps` is honest here.
export const preload = ({ location }: RoutePreloadFuncArgs) => {
  void getStories(storyType(location.pathname), Number(location.query.page) || 1);
};

// The page and the feed are hole blocks over the location (derived reads,
// not memoized, as the original's plain functions); the stories are a
// `$memo` over the query — pending until it lands, and it may fail.
const Stories = $component(function* Stories(props: TypedProps<RouteSectionProps, "Stories">) {
  const page = $(function* () {
    return Number(yield* props.location.query.page) || 1;
  });
  const type = $(function* () {
    return storyType(yield* props.location.pathname);
  });
  const stories = yield* $memo(function* () {
    const type2 = yield* type;
    const page2 = yield* page;
    return yield* attempt(
      () => getStories(type2, page2),
      cause => new ApiError(cause)
    );
  });

  return function* () {
    return (
      <div class="news-view">
        <div class="news-list-nav">
          <Show
            when={(yield* page) > 1}
            fallback={
              <span class="page-link disabled" aria-disabled="true">
                {"<"} prev
              </span>
            }
          >
            <a
              class="page-link"
              href={`/${yield* type}?page=${(yield* page) - 1}`}
              aria-label="Previous Page"
            >
              {"<"} prev
            </a>
          </Show>
          <span>page {yield* page}</span>
          <Show
            when={(yield* stories) && (yield* stories).length >= 29}
            fallback={
              <span class="page-link disabled" aria-disabled="true">
                more {">"}
              </span>
            }
          >
            <a
              class="page-link"
              href={`/${yield* type}?page=${(yield* page) + 1}`}
              aria-label="Next Page"
            >
              more {">"}
            </a>
          </Show>
        </div>
        <main class="news-list">
          <For each={yield* stories}>{story => <Story story={story} />}</For>
        </main>
      </div>
    );
  };
});

export default Stories;
