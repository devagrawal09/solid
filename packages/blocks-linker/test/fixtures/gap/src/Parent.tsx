import { $component, $memo, attempt, Loading } from "@solidjs/blocks";
import { UserCard } from "./UserCard";

declare function fetchUser(): Promise<{ name: string }>;

export const Parent = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser());
  });
  return function* () {
    return (
      <div>
        <UserCard user={user} />
      </div>
    );
  };
});

export const Handled = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser());
  });
  return function* () {
    return <Loading fallback="…">{UserCard({ user })}</Loading>;
  };
});

export const CallForm = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser());
  });
  return function* () {
    return <section>{yield* UserCard({ user })}</section>;
  };
});

export const App = $component(function* () {
  return function* () {
    return (
      <main>
        <CallForm />
      </main>
    );
  };
});
