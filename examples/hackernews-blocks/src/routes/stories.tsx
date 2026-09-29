import { type RoutePreloadFuncArgs, type RouteSectionProps } from "@solidjs/router";
import { $component, $memo, type TypedProps } from "solid-js";
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

const Stories = $component(function* (props: TypedProps<RouteSectionProps>) {
  // `dynamic` over the query-wrapped server component is the whole client
  // surface. Its source is a plain thunk, which cannot `yield*` a prop, so
  // the feed and page are read by a memo block and the thunk calls it; the
  // source is still tracked, so changing feed or page re-calls the server
  // component and the response morphs this boundary in place.
  const feed = yield* $memo(function* () {
    return {
      type: storyType(yield* props.location.pathname),
      page: Number(yield* props.location.query.page) || 1
    };
  });
  const View = dynamic(() => getStories(feed().type, feed().page));
  // The server-component instance is created here, in the setup, and the view
  // returns it. Written in the view (`return <View />`) it works when the
  // route is hydrated, but a route mounted by client navigation never
  // appears: the navigation stays pending and the old route stays on screen.
  // (A plain route component creating `<View />` in its body works.)
  const rendered = <View />;
  return function* () {
    return rendered;
  };
});

export default Stories;
