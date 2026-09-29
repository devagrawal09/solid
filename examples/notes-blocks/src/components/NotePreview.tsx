// The shared markdown renderer — the direct analogue of the React demo's
// NotePreview.js. The server component (server/Note.tsx) renders it on the
// server, where its output is plain HTML in the frame stream; the editor
// (NoteEditor.tsx) renders it in the browser for the live preview. `marked`
// ships to the client only because the editor imports it — a note that is
// never edited never pays for it.
import { marked } from "marked";
import { $component, type TypedProps } from "@solidjs/blocks";

const NotePreview = $component(function* NotePreview(
  props: TypedProps<{ body: string }, "NotePreview">
) {
  return function* () {
    return (
      <div class="note-preview">
        <div
          class="text-with-markdown"
          innerHTML={(yield* props.body) ? (marked(yield* props.body) as string) : ""}
        />
      </div>
    );
  };
});

export default NotePreview;
