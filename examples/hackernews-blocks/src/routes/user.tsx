import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, accessor, type TypedProps } from "@solidjs/blocks";
import { dynamic } from "@solidjs/web";
import { getUser } from "~/lib/api";

type Path = "/users/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getUser(params.id);
};

const User = $component(function* User(props: TypedProps<RouteProps<Path>, "User">) {
  const id = accessor(props.params.id);
  const View = dynamic(() => getUser(id()));
  return function* () {
    return <View />;
  };
});

export default User;
