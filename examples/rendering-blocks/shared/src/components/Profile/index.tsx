import { $component, $memo, lazy } from "solid-js";
import type { User } from "./Profile";

const Profile = lazy(() => import("./Profile"));

// this component lazy loads data and code in parallel
export default $component(function* () {
  // The memo blocks return their promise as the value, as the original's
  // plain memos do. `yield* attempt(() => …)` is the v2 form, but a compiled
  // async memo body breaks under hydration (hydration re-runs memo bodies with
  // the global `Promise` swapped for a mock, and the body's result promise
  // never gets its settle functions); `$memo` types its value as the body's
  // return, hence the casts.
  const user = yield* $memo(function* () {
    // simulate data loading
    console.log("LOAD USER");
    return new Promise<User>(resolve => {
      setTimeout(() => resolve({ firstName: "Jon", lastName: "Snow" }), 400);
    }) as unknown as User;
  });

  const info = yield* $memo(function* () {
    yield* user;
    // simulate cascading data loading
    console.log("LOAD INFO");
    return new Promise<string[]>(resolve => {
      setTimeout(
        () =>
          resolve(["Something Interesting", "Something else you might care about", "Or maybe not"]),
        400
      );
    }) as unknown as string[];
  });

  return function* () {
    return <Profile user={yield* user} info={yield* info} />;
  };
});
