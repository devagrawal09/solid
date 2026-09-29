/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
// The demo's NoteEditor.client.js. The forms post through the router's
// actions: `saveNote` / `deleteNote` answer with a redirect, and because the
// server registered a flight collector, that one response also carries the
// fresh sidebar list and (for save) the fresh note view — submit to settled
// UI in a single round trip. The live preview reuses the same NotePreview the
// note's server component renders — the shared-module half of the demo.
//
// v2 notes: the setup cannot read props, so the "seed once" read of the
// `initial*` props is a memo block, and the title/body are plain writable
// derived signals over it — they would re-seed if the slot args changed (the
// original ignores such a change by contract; nothing in the app pushes one
// while an editor is open).
import { $component, $event, $memo, createSignal, type TypedProps } from "solid-js";
import { deleteNote, saveNote } from "~/lib/api";
import NotePreview from "./NotePreview";

const NoteEditor = $component(function* (
  props: TypedProps<{
    noteId?: number;
    initialTitle: string;
    initialBody: string;
  }>
) {
  const initial = yield* $memo(function* () {
    return {
      noteId: yield* props.noteId,
      title: yield* props.initialTitle,
      body: yield* props.initialBody
    };
  });
  const [title, setTitle] = createSignal(() => initial().title);
  const [body, setBody] = createSignal(() => initial().body);

  const typeTitle = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    setTitle(e.currentTarget.value);
  });
  const typeBody = $event(function* (e: InputEvent & { currentTarget: HTMLTextAreaElement }) {
    setBody(e.currentTarget.value);
  });

  return function* () {
    const noteId = (yield* initial).noteId;
    return (
      <div class="note-editor">
        <form
          action={saveNote.with(noteId)}
          method="post"
          class="note-editor-form"
          id="note-editor"
          autocomplete="off"
        >
          <label class="offscreen" for="note-title-input">
            Enter a title for your note
          </label>
          <input
            id="note-title-input"
            type="text"
            name="title"
            placeholder="Title"
            required={true}
            value={yield* title}
            onInput={typeTitle}
          />
          <label class="offscreen" for="note-body-input">
            Enter the body for your note
          </label>
          <textarea name="body" id="note-body-input" textContent={yield* body} onInput={typeBody} />
        </form>
        <div class="note-editor-preview">
          <div class="note-editor-menu" role="menubar">
            <button class="note-editor-done" type="submit" form="note-editor" role="menuitem">
              <img src="/checkmark.svg" width="14px" height="10px" alt="" role="presentation" />
              Done
            </button>
            {noteId != null && (
              <form action={deleteNote.with(noteId)} method="post">
                <button name="noteId" class="note-editor-delete" type="submit" role="menuitem">
                  <img src="/cross.svg" width="10px" height="10px" alt="" role="presentation" />
                  Delete
                </button>
              </form>
            )}
          </div>
          <div class="label label--preview" role="status">
            Preview
          </div>
          <h1 class="note-title">{yield* title}</h1>
          <NotePreview body={yield* body} />
        </div>
      </div>
    );
  };
});

export default NoteEditor;
