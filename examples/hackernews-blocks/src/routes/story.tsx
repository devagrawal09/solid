import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, accessor, type TypedProps } from "@solidjs/blocks";
import { dynamic } from "@solidjs/web";
import Toggle from "~/components/toggle";
import { getStory } from "~/lib/api";

// The pattern witness types `params.id` as `string` — this component is
// declared away from its route, so it names the pattern it belongs to.
type Path = "/stories/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getStory(params.id);
};

const Story = $component(function* Story(props: TypedProps<RouteProps<Path>, "StoryPage">) {
  const id = accessor(props.params.id);
  const View = dynamic(() => getStory(id()));
  // The one client-owned piece of a thread: the server fills this slot per
  // comment that has replies, and the replies themselves arrive as server
  // markup inside the Toggle's list. Collapse state is client state — it
  // never appears in a request.
  return function* () {
    return <View toggle={p => <Toggle>{p.children}</Toggle>} />;
  };
});

export default Story;
