import { eager } from "../../eager";
import { $component, For, Loading, type TypedProps } from "solid-js";

export interface User {
  firstName: string;
  lastName: string;
}

const Profile = $component(function* (props: TypedProps<{ info: string[]; user: User }>) {
  return function* () {
    return (
      <>
        <h1>{yield* props.user.firstName}'s Profile</h1>
        <p>This section could be about you.</p>
        <Loading fallback={<span class="loader">Loading Info...</span>}>
          <ul>
            <For each={yield* props.info}>{fact => <li>{fact}</li>}</For>
          </ul>
        </Loading>
      </>
    );
  };
});

// Loaded with lazy(): see ../../eager.ts.
export default eager(Profile);
