import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, $memo, type TypedProps } from "solid-js";
import { dynamic } from "@solidjs/web";
import { getUser } from "~/lib/api";

type Path = "/users/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getUser(params.id);
};

const User = $component(function* (props: TypedProps<RouteProps<Path>>) {
  // See ./story.tsx: `dynamic`'s plain source thunk reads the id via a memo.
  const id = yield* $memo(function* () {
    return (yield* props.params.id)!;
  });
  const View = dynamic(() => getUser(id()));
  // Created in the setup, not in the view: see ./stories.tsx.
  const rendered = <View />;
  return function* () {
    return rendered;
  };
});

export default User;
