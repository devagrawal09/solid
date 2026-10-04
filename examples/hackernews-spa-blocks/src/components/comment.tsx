import { $component, For, Show, type Component, type TypedProps, view } from "@solidjs/blocks";
import type { CommentDefinition } from "~/types";
import Toggle from "./toggle";

// Recursive: the type is stated (a component's type is inferred from its
// view, which renders this component), and the setup is unnamed (a name
// would shadow the component inside it).
const Comment: Component<{ comment: CommentDefinition }, false, never> = $component(function* (
  props: TypedProps<{ comment: CommentDefinition }, "Comment">
) {
  return view(function* () {
    return (
      <li class="comment">
        <div class="by">
          <a href={`/users/${yield* props.comment.user}`}>{yield* props.comment.user}</a>{" "}
          {yield* props.comment.time_ago} ago
        </div>
        <div class="text" innerHTML={yield* props.comment.content} />
        <Show when={yield* props.comment.comments.length}>
          <Toggle>
            <For each={yield* props.comment.comments}>
              {comment => <Comment comment={comment} />}
            </For>
          </Toggle>
        </Show>
      </li>
    );
  });
});

export default Comment;
