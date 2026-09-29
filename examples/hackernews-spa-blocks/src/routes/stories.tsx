import { type RoutePreloadFuncArgs, type RouteSectionProps } from "@solidjs/router";
import { $component, $memo, For, Show, type TypedProps } from "solid-js";
import Story from "~/components/story";
import { getStories } from "~/lib/api";
import type { StoryDefinition, StoryTypes } from "~/types";

/** `/` and the four named feeds all render this; the path names the feed. */
export const storyType = (pathname: string): StoryTypes =>
  (pathname.split("/")[1] || "top") as StoryTypes;

// The feed routes take no params, so the open `RouteSectionProps` is honest here.
export const preload = ({ location }: RoutePreloadFuncArgs) => {
  void getStories(storyType(location.pathname), Number(location.query.page) || 1);
};

const Stories = $component(function* (props: TypedProps<RouteSectionProps>) {
  const page = yield* $memo(function* () {
    return Number(yield* props.location.query.page) || 1;
  });
  const type = yield* $memo(function* () {
    return storyType(yield* props.location.pathname);
  });
  const stories = yield* $memo(function* () {
    const t = yield* type;
    const p = yield* page;
    // The query's promise is returned as the memo's value, as the original
    // does, rather than `yield* attempt(() => …)`: a compiled async memo body
    // breaks under hydration (its `AsyncRun` builds its result promise while
    // hydration has swapped the global `Promise` for a mock whose executor
    // never runs; the run then throws `this.ok is not a function` when it is
    // superseded). `$memo` types its value as the body's return, so the
    // promise needs a cast, which hides the pending state from the types.
    return getStories(t, p) as unknown as StoryDefinition[];
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
            when={(yield* stories) && (yield* stories)!.length >= 29}
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
