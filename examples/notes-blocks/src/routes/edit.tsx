import type { RouteProps } from "@solidjs/router";
import { $component, $dynamic, attempt, type TypedProps } from "@solidjs/blocks";
import NoteEditor from "~/components/NoteEditor";
import { getNoteEdit } from "~/lib/api";
import { ServerError } from "~/lib/errors";

const EditNote = $component(function* EditNote(
  props: TypedProps<RouteProps<"/notes/:id/edit">, "EditNote">
) {
  const View = yield* $dynamic(function* () {
    const id2 = yield* props.params.id;
    return yield* attempt(
      () => getNoteEdit(+id2),
      cause => new ServerError(cause)
    );
  });
  return function* () {
    return <View editor={p => <NoteEditor {...p} />} />;
  };
});

export default EditNote;
