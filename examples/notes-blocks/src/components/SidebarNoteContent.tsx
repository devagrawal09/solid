/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// The React demo's SidebarNoteContent.client.js: the per-note client shell.
// `children` (the header) and `expandedChildren` (the excerpt) arrive as
// server markup through the slot; `id`, `title`, and the note-open `href`
// (search filter already baked in by the server) ride as slot args. The
// flash animation fires when the title arg CHANGES on the same occurrence —
// entity identity across single-flight morphs, courtesy of the `$key` the
// server names each occurrence with.
//
// What the library's rules change: the expanded state is a `$signal`, the
// handlers `$event`s; the router's location arrives as a prop
// from the shell (`pathname`, the route's location path); the flash is an `$effect` that keeps the
// previous title itself (an effect block has no `prev`).
import {
  $,
  $component,
  $effect,
  $event,
  $signal,
  Show,
  type Element,
  type TypedProps
} from "@solidjs/blocks";

const SidebarNoteContent = $component(function* SidebarNoteContent(
  props: TypedProps<
    {
      id: number;
      title: string;
      href: string;
      pathname: string;
      children: Element;
      expandedChildren: Element;
    },
    "SidebarNoteContent"
  >
) {
  const [isExpanded, setIsExpanded] = yield* $signal(false);
  const isActive = $(function* () {
    return (yield* props.pathname).startsWith(`/notes/${yield* props.id}`);
  });
  let itemRef!: HTMLDivElement;

  let prev: string | undefined;
  yield* $effect(function* () {
    const title = yield* props.title;
    if (prev !== undefined && title !== prev) itemRef.classList.add("flash");
    prev = title;
  });
  const animationEnd = $event(function* () {
    itemRef.classList.remove("flash");
  });
  const toggle = $event(function* (e: MouseEvent) {
    e.stopPropagation();
    yield* setIsExpanded(expanded => !expanded);
  });

  return function* () {
    return (
      <div
        ref={el => (itemRef = el)}
        onAnimationEnd={animationEnd}
        style={{ color: "black" }}
        class={["sidebar-note-list-item", (yield* isExpanded) ? "note-expanded" : ""].join(" ")}
      >
        {yield* props.children}
        <a
          href={yield* props.href}
          class="sidebar-note-open"
          style={{
            "background-color": (yield* isActive) ? "var(--tertiary-blue)" : "",
            border: (yield* isActive) ? "1px solid var(--primary-border)" : "1px solid transparent"
          }}
        >
          Open note for preview
        </a>
        <button class="sidebar-note-toggle-expand" onClick={toggle}>
          <Show
            when={yield* isExpanded}
            fallback={<img src="/chevron-down.svg" width="10px" height="10px" alt="Collapse" />}
          >
            <img src="/chevron-up.svg" width="10px" height="10px" alt="Expand" />
          </Show>
        </button>
        <div style={{ display: (yield* isExpanded) ? "block" : "none" }}>
          {yield* props.expandedChildren}
        </div>
      </div>
    );
  };
});

export default SidebarNoteContent;
