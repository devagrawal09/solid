import { type RoutePreloadFuncArgs, type RouteSectionProps } from "@solidjs/router";
import { $component, $dynamic, attempt, type TypedProps } from "@solidjs/blocks";
import { getStories } from "~/lib/api";
import type { StoryTypes } from "~/types";
import { ServerError } from "~/lib/errors";

/** `/` and the four named feeds all render this; the path names the feed. */
export const storyType = (pathname: string): StoryTypes =>
  (pathname.split("/")[1] || "top") as StoryTypes;

// The feed routes take no params, so the open `RoutePreloadFuncArgs` is honest here.
export const preload = ({ location }: RoutePreloadFuncArgs) => {
  void getStories(storyType(location.pathname), Number(location.query.page) || 1);
};

// `$dynamic` over the query-wrapped server component is the whole client
// surface, created in the SETUP (a dynamic created in a view would be
// re-created whenever the view re-rendered). Its body reads the location
// with `yield*`, tracked, so changing feed or page re-calls it and the
// response morphs this boundary in place.
const Stories = $component(function* Stories(props: TypedProps<RouteSectionProps, "Stories">) {
  const View = yield* $dynamic(function* () {
    const pathname = yield* props.location.pathname;
    const page = yield* props.location.query.page;
    return yield* attempt(
      () => getStories(storyType(pathname), Number(page) || 1),
      cause => new ServerError(cause)
    );
  });
  return function* () {
    return <View />;
  };
});

export default Stories;
