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
        {
          yield* For({
            each: props.info,
            children: function* (fact) {
              return view(function* () {
                return <li>{yield* fact}</li>;
              });
            }
          })
        }
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
        {
          yield* Errored({
            fallback: err => <span class="error">{err().message}</span>,
            children: function* () {
              return (
                <>
                  {
                    yield* Loading({
                      fallback: <span class="loader">Loading Info...</span>,
                      children: function* () {
                        return <>{yield* Facts({ info: props.info })}</>;
                      }
                    })
                  }
                </>
              );
            }
          })
        }
      </>
    );
  });
});

export default Profile;
