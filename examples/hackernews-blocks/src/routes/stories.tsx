import { type RoutePreloadFuncArgs, type RouteSectionProps } from "@solidjs/router";
import { $component, accessor, type TypedProps } from "@solidjs/blocks";
import { dynamic } from "@solidjs/web";
import { getStories } from "~/lib/api";
import type { StoryTypes } from "~/types";

/** `/` and the four named feeds all render this; the path names the feed. */
export const storyType = (pathname: string): StoryTypes =>
  (pathname.split("/")[1] || "top") as StoryTypes;

// The feed routes take no params, so the open `RoutePreloadFuncArgs` is honest here.
export const preload = ({ location }: RoutePreloadFuncArgs) => {
  void getStories(storyType(location.pathname), Number(location.query.page) || 1);
};

// `dynamic` over the query-wrapped server component is the whole client
// surface, created in the SETUP (a `dynamic` created in a view would be
// re-created whenever the view re-rendered). It is a plain Solid
// computation: its source reads the location through `accessor`s, tracked,
// so changing feed or page re-calls it and the response morphs this
// boundary in place.
const Stories = $component(function* Stories(props: TypedProps<RouteSectionProps, "Stories">) {
  const pathname = accessor(props.location.pathname);
  const page = accessor(props.location.query.page);
  const View = dynamic(() => getStories(storyType(pathname()), Number(page()) || 1));
  return function* () {
    return <View />;
  };
});

export default Stories;
