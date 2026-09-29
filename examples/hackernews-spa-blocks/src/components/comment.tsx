import { $component, For, Show, type BlockComponent, type TypedProps } from "solid-js";
import type { CommentDefinition } from "~/types";
import Toggle from "./toggle";

// Recursive: TypeScript cannot infer a `const` its own initializer references,
// so the component type is spelled out (settled: a comment reads only props).
const Comment: BlockComponent<{ comment: CommentDefinition }, false, never> = $component(function* (
  props: TypedProps<{ comment: CommentDefinition }>
) {
  return function* () {
    return (
      <li class="comment">
        <div class="by">
          <a href={`/users/${yield* props.comment.user}`}>{yield* props.comment.user}</a>{" "}
          {yield* props.comment.time_ago} ago
        </div>
        <div class="text" innerHTML={yield* props.comment.content} />
        <Show when={(yield* props.comment.comments).length}>
          <Toggle>
            <For each={yield* props.comment.comments}>
              {comment => <Comment comment={comment} />}
            </For>
          </Toggle>
        </Show>
      </li>
    );
  };
});

export default Comment;
