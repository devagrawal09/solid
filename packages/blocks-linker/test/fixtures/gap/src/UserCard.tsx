import { $component, type TypedProps } from "@solidjs/blocks";

export const UserCard = $component(function* (
  props: TypedProps<{ user: { name: string } }, "UserCard">
) {
  return function* () {
    return <p>{(yield* props.user).name}</p>;
  };
});
