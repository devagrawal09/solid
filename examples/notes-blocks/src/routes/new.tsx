import { $component } from "solid-js";
import NoteEditor from "~/components/NoteEditor";

const NewNote = $component(function* () {
  return function* () {
    return <NoteEditor initialTitle="" initialBody="" />;
  };
});

export default NewNote;
