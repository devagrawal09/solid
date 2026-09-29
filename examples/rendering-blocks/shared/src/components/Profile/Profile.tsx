import { $component, For, Loading, type Source, type TypedProps } from "@solidjs/blocks";

export interface User {
  firstName: string;
  lastName: string;
}

// What a `<Loading>` covers is its own component: the facts list.
const Facts = $component(function* Facts(
  props: TypedProps<{ info: Source<string[], true, never> }, "Facts">
) {
  return function* () {
    return (
      <ul>
        <For each={yield* props.info}>
          {function* (fact) {
            return function* () {
              return <li>{yield* fact}</li>;
            };
          }}
        </For>
      </ul>
    );
  };
});

const Profile = $component(function* Profile(
  props: TypedProps<
    { info: Source<string[], true, never>; user: Source<User, true, never> },
    "Profile"
  >
) {
  return function* () {
    return (
      <>
        <h1>{yield* props.user.firstName}'s Profile</h1>
        <p>This section could be about you.</p>
        <Loading fallback={<span class="loader">Loading Info...</span>}>
          {Facts({ info: props.info })}
        </Loading>
      </>
    );
  };
});

export default Profile;
