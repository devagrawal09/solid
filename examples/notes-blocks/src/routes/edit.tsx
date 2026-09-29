import type { RouteProps } from "@solidjs/router";
import { $component, accessor, type TypedProps } from "@solidjs/blocks";
import { dynamic } from "@solidjs/web";
import NoteEditor from "~/components/NoteEditor";
import { getNoteEdit } from "~/lib/api";

const EditNote = $component(function* EditNote(
  props: TypedProps<RouteProps<"/notes/:id/edit">, "EditNote">
) {
  const id = accessor(props.params.id);
  const View = dynamic(() => getNoteEdit(+id()));
  return function* () {
    return <View editor={p => <NoteEditor {...p} />} />;
  };
});

export default EditNote;
