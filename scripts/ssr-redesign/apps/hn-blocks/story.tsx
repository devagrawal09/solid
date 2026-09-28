// The HN story page (examples/hackernews-spa's Story, Comment and Toggle
// markup) written with generator blocks v2, for the compiled-islands
// emission (documentation/plans/ssr-hydration-redesign.md, "Compiler
// emission"). The same module runs through today's pipeline (variant A:
// hydrate) and through `compileIslands` (the C-* variants): the compiler
// partitions it into inert HTML (Page, StoryPage, Comment) and one tier-0
// island per Toggle instance.
import {
  $component,
  $event,
  $memo,
  $signal,
  attempt,
  For,
  Loading,
  Show,
  type JSX,
  type TypedProps
} from "solid-js";
import type {
  CommentDefinition,
  StoryDefinition
} from "../../../../examples/hackernews-spa/src/types";

export const Toggle = $component(function* (props: TypedProps<{ children: JSX.Element }>) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () {
    setOpen(o => !o);
  });
  return function* () {
    return (
      <>
        <div class={["toggle", { open: yield* open }]}>
          <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
        </div>
        <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
          {props.children}
        </ul>
      </>
    );
  };
});

export const Comment = $component(function* (props: TypedProps<{ comment: CommentDefinition }>) {
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

export const StoryPage = $component(function* () {
  const story = yield* $memo(function* () {
    return yield* attempt(() => (globalThis as any).__loadStory() as Promise<StoryDefinition>);
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

export const Page = $component(function* () {
  return function* () {
    return (
      <Loading fallback={<div class="news-list-nav">Loading...</div>}>
        <StoryPage />
      </Loading>
    );
  };
});
