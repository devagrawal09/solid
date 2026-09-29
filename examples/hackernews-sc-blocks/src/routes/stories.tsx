// `/` and the four named feeds. Compare ../../../hackernews/src/lib/views.tsx
// (`storiesView(type, page)`): the arguments of that hand-written server
// component are exactly the arguments of `getStories` below, and that is
// what the compiler derives — the view is a frame over (type, page), and a
// navigation between feeds or pages fetches it with the new arguments.
import type { RoutePreloadFuncArgs, RouteSectionProps } from "@solidjs/router";
import { $component, $memo, attempt, For } from "solid-js";
import { getStories } from "../lib/hn";
import type { StoryTypes } from "../types";

/** `/` and the four named feeds all render this; the path names the feed. */
export const storyType = (pathname: string): StoryTypes =>
  (pathname.split("/")[1] || "top") as StoryTypes;

export const preload = ({ location }: RoutePreloadFuncArgs) => {
  void getStories(storyType(location.pathname), Number(location.query.page) || 1);
};

const Stories = $component(function* (props: RouteSectionProps) {
  const feed = yield* $memo(function* () {
    const type = storyType(yield* props.location.pathname);
    const page = Number(yield* props.location.query.page) || 1;
    return { type, page, stories: yield* attempt(() => getStories(type, page)) };
  });
  return function* () {
    const listing = yield* feed;
    return (
      <div class="news-view">
        <div class="news-list-nav">
          {listing.page > 1 ? (
            <a
              class="page-link"
              href={`/${listing.type}?page=${listing.page - 1}`}
              aria-label="Previous Page"
            >
              {"<"} prev
            </a>
          ) : (
            <span class="page-link disabled" aria-disabled="true">
              {"<"} prev
            </span>
          )}
          <span>page {listing.page}</span>
          {listing.stories.length >= 29 ? (
            <a
              class="page-link"
              href={`/${listing.type}?page=${listing.page + 1}`}
              aria-label="Next Page"
            >
              more {">"}
            </a>
          ) : (
            <span class="page-link disabled" aria-disabled="true">
              more {">"}
            </span>
          )}
        </div>
        <main class="news-list">
          <For each={listing.stories}>
            {story => (
              <li class="news-item">
                <span class="score">{story.points}</span>
                <span class="title">
                  {story.url ? (
                    <>
                      <a href={story.url} target="_blank" rel="noreferrer">
                        {story.title}
                      </a>
                      <span class="host"> ({story.domain})</span>
                    </>
                  ) : (
                    <a href={`/stories/${story.id}`}>{story.title}</a>
                  )}
                </span>
                <br />
                <span class="meta">
                  {story.type !== "job" ? (
                    <>
                      by <a href={`/users/${story.user}`}>{story.user}</a> {story.time_ago} |{" "}
                      <a href={`/stories/${story.id}`}>
                        {story.comments_count ? `${story.comments_count} comments` : "discuss"}
                      </a>
                    </>
                  ) : (
                    <a href={`/stories/${story.id}`}>{story.time_ago}</a>
                  )}
                </span>
                {story.type !== "link" ? (
                  <>
                    {" "}
                    <span class="label">{story.type}</span>
                  </>
                ) : null}
              </li>
            )}
          </For>
        </main>
      </div>
    );
  };
});

export default Stories;
