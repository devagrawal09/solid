import type { RouteProps } from "@solidjs/router";
import { $component, $memo, type TypedProps } from "solid-js";
import { dynamic } from "@solidjs/web";
import { getNote } from "~/lib/api";

const Note = $component(function* (props: TypedProps<RouteProps<"/notes/:id">>) {
  // `dynamic`'s source is a plain thunk, which cannot `yield*` a prop: the id
  // is read by a memo block (`!`: `TypedProps` maps the router's `Params`
  // index signature, so the read is typed `string | undefined`).
  const id = yield* $memo(function* () {
    return +(yield* props.params.id)!;
  });
  // The note view is pure server markup — even its Edit button is a plain
  // server-rendered anchor (the router intercepts anchor clicks), so there
  // are no client slots to fill here. (Created in the setup, as in
  // ../hackernews-blocks: created in the view, client-navigated routes never
  // appear.)
  const View = dynamic(() => getNote(id()));
  const rendered = <View />;
  return function* () {
    return rendered;
  };
});

export default Note;
