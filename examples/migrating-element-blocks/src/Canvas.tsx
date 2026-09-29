import { $cleanup, $component, $settled } from "solid-js";
import { CANVAS_H, CANVAS_W, createLogoCanvasPainter, REVEAL_MS } from "./logoCanvas";

export const Canvas = $component(function* () {
  let el!: HTMLCanvasElement;
  let painter!: ReturnType<typeof createLogoCanvasPainter>;

  let startedAt = 0;
  let rafId = 0;
  let splats = 0;

  // Imperative canvas work: no reactive reads or writes, so plain functions.
  const tick = () => {
    painter.drawUntil((performance.now() - startedAt) / REVEAL_MS);
    rafId = requestAnimationFrame(tick);
  };

  const onClick = (ev: MouseEvent) => {
    const rect = el.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * CANVAS_W;
    const y = ((ev.clientY - rect.top) / rect.height) * CANVAS_H;
    painter.splat(x, y, ++splats);
  };

  // `onSettled(() => { …; return cleanup })` → a run-once effect block; its
  // `$cleanup` runs when the component is disposed.
  yield* $settled(function* () {
    painter.reset();
    el.addEventListener("click", onClick);
    startedAt = performance.now();
    rafId = requestAnimationFrame(tick);
    yield* $cleanup(() => {
      el.removeEventListener("click", onClick);
      cancelAnimationFrame(rafId);
    });
  });

  return function* () {
    return (
      <canvas
        class="canvas"
        width={CANVAS_W}
        height={CANVAS_H}
        ref={nextEl => {
          el = nextEl;
          painter = createLogoCanvasPainter(nextEl.getContext("2d")!);
        }}
      />
    );
  };
});
