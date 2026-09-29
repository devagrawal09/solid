/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// Kept plain. It only renders inside server components (server/App.tsx,
// server/Note.tsx), and as a `$component` its server-rendered anchor loses
// the `data-lha` attribute-hole address, so the router never marks it
// `aria-current="page"` (on /new). See the README.
import type { JSX } from "@solidjs/web";

export default function EditButton(props: { noteId?: number; children: JSX.Element }) {
  const isDraft = !("noteId" in props);
  return (
    <a
      href={!isDraft ? `/notes/${props.noteId}/edit` : `/new`}
      class={["edit-button", isDraft ? "edit-button--solid" : "edit-button--outline"].join(" ")}
      role="menuitem"
    >
      {props.children}
    </a>
  );
}
