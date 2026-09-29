// The Sierpinski triangle stress test from `examples/sierpinski`, written with
// generator blocks v2 (documentation/plans/generator-blocks-v2.md).
//
// Differences from the original that v2 forces (see the README):
// - `Triangle` chose its structure in setup from destructured props (`let {
//   x, y, s } = props`). A v2 setup does not read, so the choice moves into
//   the view, and the branch half (the one that owns the `slowChildren` memo)
//   becomes its own component, `Branch`: a memo can only be created in a
//   setup, and a leaf must not create it.
// - The memo's `onCleanup(() => cancelIdleCallback(t))` has no block form
//   (`$cleanup` is setup / effect only), so it stays a plain `onCleanup`
//   inside the `attempt` thunk, which runs synchronously under the memo.
// - The timer and frame callbacks are `$event`s writing through the block
//   setters.
import {
  $cleanup,
  $component,
  $event,
  $memo,
  $signal,
  attempt,
  Loading,
  onCleanup,
  type BlockComponent,
  type TypedProps
} from "solid-js";

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
    yield* setSeconds(s => (s % 10) + 1);
  });
  const t = setInterval(tick, 1000);

  let f: number;
  const update = $event(function* () {
    yield* setElapsed(Date.now() - start);
    f = requestAnimationFrame(update);
  });
  f = requestAnimationFrame(update);

  yield* $cleanup(() => {
    clearInterval(t);
    cancelAnimationFrame(f);
  });

  return function* () {
    // `<Loading><div>…<Triangle/></div></Loading>` in the original: a
    // boundary admits a pending child only in call form, and only as a
    // component call, so the markup between the boundary and the pending
    // triangle moves into `Container`.
    return Loading({ fallback: "Loading...", children: Container({ scale, seconds }) });
  };
});

const Container = $component(function* (props: TypedProps<{ scale: number; seconds: number }>) {
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

// Recursive components need an explicit type: TypeScript cannot infer a
// `const` that its own initializer references. `true`: the branch reads the
// async `slowChildren` memo, so a triangle can be pending.
const Triangle: BlockComponent<TriangleProps, true, never> = $component(function* (
  props: TypedProps<TriangleProps>
) {
  return function* () {
    if ((yield* props.s) <= TARGET) {
      return (
        <Dot x={(yield* props.x) - TARGET / 2} y={(yield* props.y) - TARGET / 2} s={TARGET}>
          {yield* props.children}
        </Dot>
      );
    }
    return yield* Branch({ x: props.x, y: props.y, s: props.s, children: props.children });
  };
});

const Branch = $component(function* (props: TypedProps<TriangleProps>) {
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
    const x = yield* props.x;
    const y = yield* props.y;
    const s = (yield* props.s) / 2;
    return (
      <>
        {yield* Triangle({ x, y: y - s / 2, s, children: slowChildren })}
        {yield* Triangle({ x: x - s, y: y + s / 2, s, children: slowChildren })}
        {yield* Triangle({ x: x + s, y: y + s / 2, s, children: slowChildren })}
      </>
    );
  };
});

const Dot = $component(function* (props: TypedProps<TriangleProps>) {
  const [hover, setHover] = yield* $signal(false);
  const onEnter = $event(function* () {
    yield* setHover(true);
  });
  const onExit = $event(function* () {
    yield* setHover(false);
  });

  return function* () {
    // Read once, like the original's `const { x, y, s } = props`: the
    // position never changes, and reading inside the style object would make
    // `left` / `top` dynamic (applied after the static properties, so the
    // style attribute's order differs from the original's).
    const x = yield* props.x;
    const y = yield* props.y;
    const s = yield* props.s;
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
