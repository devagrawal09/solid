import { type RouteParams, type RoutePreloadFuncArgs, type RouteProps } from "@solidjs/router";
import { $component, $memo, Show, type TypedProps } from "solid-js";
import { getUser } from "~/lib/api";
import type { UserDefinition } from "~/types";

type Path = "/users/:id";

export const preload = ({ params }: RoutePreloadFuncArgs<RouteParams<Path>>) => {
  void getUser(params.id);
};

const User = $component(function* (props: TypedProps<RouteProps<Path>>) {
  const user = yield* $memo(function* () {
    // `!`: `TypedProps` maps the router's `Params` index signature, so the path
    // read types `id` as `string | undefined` (the route pattern guarantees it).
    const id = (yield* props.params.id)!;
    // The query's promise is returned as the memo's value, as the original
    // does, rather than `yield* attempt(() => …)`: a compiled async memo body
    // breaks under hydration (its `AsyncRun` builds its result promise while
    // hydration has swapped the global `Promise` for a mock whose executor
    // never runs; the run then throws `this.ok is not a function` when it is
    // superseded). `$memo` types its value as the body's return, so the
    // promise needs a cast, which hides the pending state from the types.
    return getUser(id) as unknown as UserDefinition;
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
