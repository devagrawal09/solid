/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import { $component, type Element, type TypedProps } from "@solidjs/blocks";

// Rendered by the server components (a plain anchor: the router intercepts
// it). Whether it edits a note is structure, fixed at creation: `in` on the
// props is not a read.
const EditButton = $component(function* EditButton(
  props: TypedProps<{ noteId?: number; children: Element }, "EditButton">
) {
  const isDraft = !("noteId" in props);
  return function* () {
    return (
      <a
        href={!isDraft ? `/notes/${yield* props.noteId}/edit` : `/new`}
        class={["edit-button", isDraft ? "edit-button--solid" : "edit-button--outline"].join(" ")}
        role="menuitem"
      >
        {yield* props.children}
      </a>
    );
  };
});

export default EditButton;
