import { eager } from "../eager";
import { $cleanup, $component, $event, $settled, $signal } from "solid-js";

const Home = $component(function* () {
  const [s, set] = yield* $signal(0);

  const tick = $event(function* () {
    yield* set((yield* s) + 1);
  });
  // `onSettled(() => { …; return teardown })` → a run-once effect block.
  yield* $settled(function* () {
    const t = setInterval(tick, 100);
    yield* $cleanup(() => {
      clearInterval(t);
    });
  });

  return function* () {
    return (
      <>
        <h1>Welcome to this Simple Routing Example</h1>
        <p>Click the links in the Navigation above to load different routes.</p>
        <span>{yield* s}</span>
      </>
    );
  };
});

// Loaded with lazy(): see ../eager.ts.
export default eager(Home);
