// A user page: a frame over the route's `id` (compare `userView(id)` in
// ../../../hackernews/src/lib/views.tsx).
import type { RouteParams, RoutePreloadFuncArgs, RouteProps } from "@solidjs/router";
import { $component, $memo, attempt } from "solid-js";
import { getUser } from "../lib/hn";

type Path = "/users/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getUser(params.id);
};

const User = $component(function* (props: RouteProps<Path>) {
  const user = yield* $memo(function* () {
    const id = yield* props.params.id;
    return yield* attempt(() => getUser(id));
  });
  return function* () {
    const profile = yield* user;
    return (
      <div class="user-view">
        <h1>User : {profile.id}</h1>
        <ul class="meta">
          <li>
            <span class="label">Created:</span> {profile.created}
          </li>
          <li>
            <span class="label">Karma:</span> {profile.karma}
          </li>
          {profile.about ? <li innerHTML={profile.about} class="about" /> : null}
        </ul>
        <p class="links">
          <a href={`https://news.ycombinator.com/submitted?id=${profile.id}`}>submissions</a> |{" "}
          <a href={`https://news.ycombinator.com/threads?id=${profile.id}`}>comments</a>
        </p>
      </div>
    );
  };
});

export default User;
