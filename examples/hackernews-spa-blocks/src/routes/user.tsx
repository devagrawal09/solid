import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, $memo, Show, type TypedProps } from "@solidjs/blocks";
import { getUser } from "~/lib/api";

type Path = "/users/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getUser(params.id);
};

const User = $component(function* User(props: TypedProps<RouteProps<Path>, "User">) {
  const user = yield* $memo(function* () {
    return getUser(yield* props.params.id);
  });
  return function* () {
    return (
      <div class="user-view">
        <h1>User : {(yield* user).id}</h1>
        <ul class="meta">
          <li>
            <span class="label">Created:</span> {(yield* user).created}
          </li>
          <li>
            <span class="label">Karma:</span> {(yield* user).karma}
          </li>
          <Show when={(yield* user).about}>
            <li innerHTML={(yield* user).about} class="about" />
          </Show>
        </ul>
        <p class="links">
          <a href={`https://news.ycombinator.com/submitted?id=${(yield* user).id}`}>submissions</a>{" "}
          | <a href={`https://news.ycombinator.com/threads?id=${(yield* user).id}`}>comments</a>
        </p>
      </div>
    );
  };
});

export default User;
