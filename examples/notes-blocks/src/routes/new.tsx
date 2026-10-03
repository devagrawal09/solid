import { $component } from "@solidjs/blocks";
import NoteEditor from "~/components/NoteEditor";

const NewNote = $component(function* NewNote() {
  return function* () {
    return <NoteEditor initialTitle="" initialBody="" />;
  };
});

export default NewNote;
