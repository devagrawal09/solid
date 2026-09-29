import type { RouteProps } from "@solidjs/router";
import { $component, $memo, type TypedProps } from "solid-js";
import { dynamic } from "@solidjs/web";
import NoteEditor from "~/components/NoteEditor";
import { getNoteEdit } from "~/lib/api";

const EditNote = $component(function* (props: TypedProps<RouteProps<"/notes/:id/edit">>) {
  // The id through a memo block, the instance created in the setup: see
  // ./note.tsx.
  const id = yield* $memo(function* () {
    return +(yield* props.params.id)!;
  });
  const View = dynamic(() => getNoteEdit(id()));
  const rendered = <View editor={p => <NoteEditor {...p} />} />;
  return function* () {
    return rendered;
  };
});

export default EditNote;
