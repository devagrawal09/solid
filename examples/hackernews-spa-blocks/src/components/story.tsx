import { $component, Show, type TypedProps, view } from "@solidjs/blocks";
import type { StoryDefinition } from "../types";

const Story = $component(function* Story(props: TypedProps<{ story: StoryDefinition }, "Story">) {
  return view(function* () {
    return (
      <li class="news-item">
        <span class="score">{yield* props.story.points}</span>
        <span class="title">
          <Show
            when={yield* props.story.url}
            fallback={<a href={`/stories/${yield* props.story.id}`}>{yield* props.story.title}</a>}
          >
            <a href={yield* props.story.url} target="_blank" rel="noreferrer">
              {yield* props.story.title}
            </a>
            <span class="host"> ({yield* props.story.domain})</span>
          </Show>
        </span>
        <br />
        <span class="meta">
          <Show
            when={(yield* props.story.type) !== "job"}
            fallback={
              <a href={`/stories/${yield* props.story.id}`}>{yield* props.story.time_ago}</a>
            }
          >
            by <a href={`/users/${yield* props.story.user}`}>{yield* props.story.user}</a>{" "}
            {yield* props.story.time_ago} |{" "}
            <a href={`/stories/${yield* props.story.id}`}>
              {(yield* props.story.comments_count)
                ? `${yield* props.story.comments_count} comments`
                : "discuss"}
            </a>
          </Show>
        </span>
        <Show when={(yield* props.story.type) !== "link"}>
          {" "}
          <span class="label">{yield* props.story.type}</span>
        </Show>
      </li>
    );
  });
});

export default Story;
