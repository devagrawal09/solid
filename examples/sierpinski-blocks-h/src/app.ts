// The Sierpinski triangle stress test from examples/sierpinski, written with
// @solidjs/blocks, no-JSX flavor: views are built with `h`. Same markup,
// same timing, same behavior as the original and the JSX twin
// (examples/sierpinski-blocks).
//
// In `h` a view never reads: every dynamic value is a hole (a source, or a
// `$(function* () { … })` block), so each view runs once and each hole is
// its own computation. Components are given to `h` (`h(Triangle, { … })`)
// and created where the output is materialized; `h([a, b, c])` is a
// fragment. The setup rules are the JSX twin's: position props are taken
// with `$snapshot` (the original destructures them), timer and frame
// callbacks are `$event`s.
import {
  $,
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
import { h } from "@solidjs/blocks/h";
import { onCleanup } from "solid-js";

type TriangleProps = {
  x: number;
  y: number;
  s: number;
  children: number;
};

const TARGET = 25;

export const TriangleDemo = $component(function* () {
  const [elapsed, setElapsed] = yield* $signal(0);
  const [seconds, setSeconds] = yield* $signal(0);
  const scale = yield* $memo(function* () {
    const e = ((yield* elapsed) / 1000) % 10;
    return 1 + (e > 5 ? 10 - e : e) / 10;
  });
  const start = Date.now();
  const tick = $event(function* () {
    setSeconds(s => (s % 10) + 1);
  });
  const t = setInterval(tick, 1000);

  let f: number;
  const update = $event(function* (_time: number) {
    setElapsed(Date.now() - start);
    f = requestAnimationFrame(update);
  });
  f = requestAnimationFrame(update);

  yield* $cleanup(() => {
    clearInterval(t);
    cancelAnimationFrame(f);
  });

  return function* () {
    return h(Loading, { fallback: "Loading..." }, h(Container, { scale, seconds }));
  };
});

const Container = $component(function* (
  props: TypedProps<{ scale: number; seconds: number }, "Container">
) {
  return function* () {
    return h(
      "div",
      {
        class: "container",
        style: $(function* () {
          return {
            transform: "scaleX(" + (yield* props.scale) / 2.1 + ") scaleY(0.7) translateZ(0.1px)"
          };
        })
      },
      h(Triangle, { x: 0, y: 0, s: 1000, children: props.seconds })
    );
  };
});

// A recursive component needs its type spelled out (TypeScript cannot infer
// a const its own initializer references): a triangle may be pending — its
// branches read an async memo.
const Triangle: Component<TriangleProps, true, never> = $component(function* (
  props: TypedProps<TriangleProps, "Triangle">
) {
  const x = yield* $snapshot(props.x);
  const y = yield* $snapshot(props.y);
  let s = yield* $snapshot(props.s);
  if (s <= TARGET) {
    return function* () {
      return h(Dot, {
        x: x - TARGET / 2,
        y: y - TARGET / 2,
        s: TARGET,
        children: props.children
      });
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
    return h([
      h(Triangle, { x, y: y - s / 2, s, children: slowChildren }),
      h(Triangle, { x: x - s, y: y + s / 2, s, children: slowChildren }),
      h(Triangle, { x: x + s, y: y + s / 2, s, children: slowChildren })
    ]);
  };
});

const Dot = $component(function* (props: TypedProps<TriangleProps, "Dot">) {
  const x = yield* $snapshot(props.x);
  const y = yield* $snapshot(props.y);
  const s = yield* $snapshot(props.s);
  const [hover, setHover] = yield* $signal(false);
  const onEnter = $event(function* () {
    setHover(true);
  });
  const onExit = $event(function* () {
    setHover(false);
  });

  return function* () {
    return h(
      "div",
      {
        class: "dot",
        style: $(function* () {
          return {
            width: s + "px",
            height: s + "px",
            left: x + "px",
            top: y + "px",
            "border-radius": s / 2 + "px",
            "line-height": s + "px",
            background: (yield* hover) ? "#ff0" : "#61dafb"
          };
        }),
        onMouseEnter: onEnter,
        onMouseLeave: onExit
      },
      $(function* () {
        return (yield* hover) ? "**" + (yield* props.children) + "**" : yield* props.children;
      })
    );
  };
});
