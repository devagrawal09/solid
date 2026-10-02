// The Sierpinski triangle stress test from examples/sierpinski, written with
// @solidjs/blocks (JSX flavor). Same markup, same timing, same behavior.
//
// What the library's rules change in the source (see the README):
// - A setup does not read, so the structure a triangle chooses from its
//   position props (`let { x, y, s } = props` in the original) is taken with
//   `$snapshot` — the value at creation, untracked, exactly the original's
//   destructuring — and the setup returns the leaf view or the branch view.
// - `<Loading><div class="container">…<Triangle/></div></Loading>`: a view
//   that reads a pending child is pending itself, so the container moves
//   into its own component and the boundary receives it as a pending view.
// - Timer and frame callbacks are `$event`s.
import {
  $cleanup,
  $component,
  $event,
  $memo,
  $signal,
  $snapshot,
  attempt,
  Loading,
  type Component,
  type TypedProps
} from "@solidjs/blocks";
import { onCleanup } from "solid-js";

type TriangleProps = {
  x: number;
  y: number;
  s: number;
  children: number;
};

const TARGET = 25;

export const TriangleDemo = $component(function* TriangleDemo() {
  const [elapsed, setElapsed] = yield* $signal(0);
  const [seconds, setSeconds] = yield* $signal(0);
  const scale = yield* $memo(function* () {
    const e = ((yield* elapsed) / 1000) % 10;
    return 1 + (e > 5 ? 10 - e : e) / 10;
  });
  const start = Date.now();
  const tick = $event(function* () {
    yield* setSeconds(s => (s % 10) + 1);
  });
  const t = setInterval(tick, 1000);

  let f: number;
  const update = $event(function* (_time: number) {
    yield* setElapsed(Date.now() - start);
    f = requestAnimationFrame(update);
  });
  f = requestAnimationFrame(update);

  yield* $cleanup(() => {
    clearInterval(t);
    cancelAnimationFrame(f);
  });

  return function* () {
    return <Loading fallback={"Loading..."}>{Container({ scale, seconds })}</Loading>;
  };
});

const Container = $component(function* Container(
  props: TypedProps<{ scale: number; seconds: number }, "Container">
) {
  return function* () {
    return (
      <div
        class="container"
        style={{
          transform: "scaleX(" + (yield* props.scale) / 2.1 + ") scaleY(0.7) translateZ(0.1px)"
        }}
      >
        {yield* Triangle({ x: 0, y: 0, s: 1000, children: props.seconds })}
      </div>
    );
  };
});

// A recursive component needs its type spelled out (TypeScript cannot infer
// a const its own initializer references): a triangle may be pending — its
// branches read an async memo. Its setup is left unnamed: a named setup
// (`function* Triangle`) would shadow the component inside its own body.
const Triangle: Component<TriangleProps, true, never> = $component(function* (
  props: TypedProps<TriangleProps, "Triangle">
) {
  const x = yield* $snapshot(props.x);
  const y = yield* $snapshot(props.y);
  let s = yield* $snapshot(props.s);
  if (s <= TARGET) {
    // The dot reads the (possibly pending) seconds passed down: its view
    // propagates into this one.
    return function* () {
      return (
        <>
          {
            yield* Dot({
              x: x - TARGET / 2,
              y: y - TARGET / 2,
              s: TARGET,
              children: props.children
            })
          }
        </>
      );
    };
  }
  s = s / 2;

  const slowChildren = yield* $memo(function* () {
    const seconds = yield* props.children;
    return yield* attempt(
      () =>
        new Promise<number>(res => {
          const t = requestIdleCallback(() => {
            const e = performance.now() + 0.8;
            while (performance.now() < e) {}
            res(seconds);
          });
          onCleanup(() => cancelIdleCallback(t));
        })
    );
  });

  return function* () {
    return (
      <>
        {yield* Triangle({ x, y: y - s / 2, s, children: slowChildren })}
        {yield* Triangle({ x: x - s, y: y + s / 2, s, children: slowChildren })}
        {yield* Triangle({ x: x + s, y: y + s / 2, s, children: slowChildren })}
      </>
    );
  };
});

const Dot = $component(function* Dot(props: TypedProps<TriangleProps, "Dot">) {
  const x = yield* $snapshot(props.x);
  const y = yield* $snapshot(props.y);
  const s = yield* $snapshot(props.s);
  const [hover, setHover] = yield* $signal(false);
  const onEnter = $event(function* () {
    yield* setHover(true);
  });
  const onExit = $event(function* () {
    yield* setHover(false);
  });

  return function* () {
    return (
      <div
        class="dot"
        style={{
          width: s + "px",
          height: s + "px",
          left: x + "px",
          top: y + "px",
          "border-radius": s / 2 + "px",
          "line-height": s + "px",
          background: (yield* hover) ? "#ff0" : "#61dafb"
        }}
        onMouseEnter={onEnter}
        onMouseLeave={onExit}
      >
        {(yield* hover) ? "**" + (yield* props.children) + "**" : yield* props.children}
      </div>
    );
  };
});
