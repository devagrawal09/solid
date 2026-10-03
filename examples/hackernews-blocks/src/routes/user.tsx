import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, $dynamic, attempt, type TypedProps } from "@solidjs/blocks";
import { getUser } from "~/lib/api";
import { ServerError } from "~/lib/errors";

type Path = "/users/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getUser(params.id);
};

const User = $component(function* User(props: TypedProps<RouteProps<Path>, "User">) {
  const View = yield* $dynamic(function* () {
    const id2 = yield* props.params.id;
    return yield* attempt(
      () => getUser(id2),
      cause => new ServerError(cause)
    );
  });
  return function* () {
    return <View />;
  };
});

export default User;
