import {
  $component,
  Errored,
  For,
  Loading,
  type Source,
  type TypedProps,
  view
} from "@solidjs/blocks";
import type { ProfileError } from "./errors";

export interface User {
  firstName: string;
  lastName: string;
}

// What a `<Loading>` covers is its own component: the facts list.
const Facts = $component(function* Facts(
  props: TypedProps<{ info: Source<string[], true, ProfileError> }, "Facts">
) {
  return view(function* () {
    return (
      <ul>
        <For each={yield* props.info}>
          {function* (fact) {
            return view(function* () {
              return <li>{yield* fact}</li>;
            });
          }}
        </For>
      </ul>
    );
  });
});

const Profile = $component(function* Profile(
  props: TypedProps<
    { info: Source<string[], true, ProfileError>; user: Source<User, true, ProfileError> },
    "Profile"
  >
) {
  return view(function* () {
    return (
      <>
        <h1>{yield* props.user.firstName}'s Profile</h1>
        <p>This section could be about you.</p>
        <Errored fallback={err => <span class="error">{err().message}</span>}>
          {Loading({
            fallback: <span class="loader">Loading Info...</span>,
            children: () => Facts({ info: props.info })
          })}
        </Errored>
      </>
    );
  });
});

export default Profile;
