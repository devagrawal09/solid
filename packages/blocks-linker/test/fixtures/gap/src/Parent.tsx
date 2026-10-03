import { $component, $memo, attempt, Errored, Loading } from "@solidjs/blocks";
import { UserCard } from "./UserCard";

declare function fetchUser(): Promise<{ name: string }>;

export class FetchError extends Error {
  readonly kind = "fetch" as const;
}

export const Parent = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(
      () => fetchUser(),
      () => new FetchError()
    );
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
    return yield* attempt(
      () => fetchUser(),
      () => new FetchError()
    );
  });
  return function* () {
    return (
      <Errored fallback="!">
        {Loading({ fallback: "…", children: () => UserCard({ user }) })}
      </Errored>
    );
  };
});

export const CallForm = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(
      () => fetchUser(),
      () => new FetchError()
    );
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
