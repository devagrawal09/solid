import type { RouteProps } from "@solidjs/router";
import { $component, $dynamic, attempt, type TypedProps } from "@solidjs/blocks";
import { getNote } from "~/lib/api";
import { ServerError } from "~/lib/errors";

const Note = $component(function* Note(props: TypedProps<RouteProps<"/notes/:id">, "Note">) {
  // The note view is pure server markup — even its Edit button is a plain
  // server-rendered anchor (the router intercepts anchor clicks), so there
  // are no client slots to fill here. The `dynamic` is created in the setup,
  // its source reading the id through an accessor (tracked: a new id re-calls
  // it and the response morphs in place).
  const View = yield* $dynamic(function* () {
    const id2 = yield* props.params.id;
    return yield* attempt(
      () => getNote(+id2),
      cause => new ServerError(cause)
    );
  });
  return function* () {
    return <View />;
  };
});

export default Note;
