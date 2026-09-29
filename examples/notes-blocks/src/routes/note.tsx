import type { RouteProps } from "@solidjs/router";
import { $component, accessor, type TypedProps } from "@solidjs/blocks";
import { dynamic } from "@solidjs/web";
import { getNote } from "~/lib/api";

const Note = $component(function* Note(props: TypedProps<RouteProps<"/notes/:id">, "Note">) {
  // The note view is pure server markup — even its Edit button is a plain
  // server-rendered anchor (the router intercepts anchor clicks), so there
  // are no client slots to fill here. The `dynamic` is created in the setup,
  // its source reading the id through an accessor (tracked: a new id re-calls
  // it and the response morphs in place).
  const id = accessor(props.params.id);
  const View = dynamic(() => getNote(+id()));
  return function* () {
    return <View />;
  };
});

export default Note;
