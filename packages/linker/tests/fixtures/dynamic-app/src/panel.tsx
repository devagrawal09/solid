import { $, createSignal, write } from "solid-js";
import { shout } from "./text";

export const exportedPing = $(function* (_e: MouseEvent) {
  shout("ping");
});

export function Panel() {
  const [count, setCount] = createSignal(0);
  const local = $(function* () {
    yield* write(setCount, (yield* count) + 1);
  });
  return (
    <div>
      <button onClick={local} />
      <button onClick={exportedPing} />
    </div>
  );
}
