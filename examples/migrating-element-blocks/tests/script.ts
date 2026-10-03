// The interaction script shared by the behavior tests and the differential
// parity test. It drives whichever app is mounted in `document.body`
// (examples/migrating-element or this twin) and records, after every step,
// the DOM plus what the DOM alone does not show: which canvas elements are
// the ones seen before (identity), and what each canvas painted (the 2D
// context calls, recorded by a stub — jsdom has no canvas).
import { flush } from "solid-js";

export type Paint = string[];
const paints = new WeakMap<HTMLCanvasElement, Paint>();

/** A recording 2D context: every method call and property write, in order. */
function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const log: Paint = [];
  paints.set(canvas, log);
  const gradient = {
    addColorStop: (o: number, c: string) => log.push(`stop ${o} ${c}`)
  };
  return new Proxy({} as any, {
    get(_, key: string) {
      if (key === "createRadialGradient")
        return (...a: number[]) => (log.push(`gradient ${a.join(",")}`), gradient);
      return (...args: unknown[]) =>
        log.push(`${key}(${args.map(a => (typeof a === "number" ? a.toFixed(2) : a)).join(",")})`);
    },
    set(_, key: string, value) {
      log.push(`${key}=${typeof value === "object" ? "gradient" : value}`);
      return true;
    }
  });
}

export function installCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement
  ) {
    return recordingContext(this) as any;
  } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 }) as DOMRect
  );
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"]
  });
}

export function uninstallCanvas() {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
}

export const canvases = () => [...document.body.querySelectorAll<HTMLCanvasElement>("canvas")];
export const paintOf = (c: HTMLCanvasElement) => paints.get(c) ?? [];

function button(label: string) {
  return [...document.body.querySelectorAll<HTMLButtonElement>(".controls button")].find(
    b => b.textContent === label
  )!;
}

export async function frames(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

function clickCanvas(which: "left" | "right", x: number, y: number) {
  const panel = which === "left" ? ".panel-good" : ".panel-bad";
  const canvas = document.body.querySelector<HTMLCanvasElement>(`${panel} canvas`)!;
  canvas.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
}

export const steps: [name: string, run: () => Promise<void> | void][] = [
  ["mount", () => flush()],
  ["draw for a second", () => frames(1000)],
  ["splat the left canvas", () => clickCanvas("left", 100, 100)],
  ["splat the right canvas", () => clickCanvas("right", 200, 50)],
  ["move to PIP", () => (button("PIP (corner)").click(), flush())],
  ["draw", () => frames(500)],
  ["splat both again", () => (clickCanvas("left", 400, 225), clickCanvas("right", 10, 10))],
  ["move to Dock", () => (button("Dock").click(), flush())],
  ["same slot again (no-op)", () => (button("Dock").click(), flush())],
  ["back to Hero", () => (button("Hero").click(), flush())],
  ["draw to the end of the reveal", () => frames(16000)]
];

/**
 * Snapshot: the DOM, each canvas's identity (index of first appearance) and
 * the size of its paint log plus the log's last entries.
 */
export async function runScript(): Promise<string[]> {
  const seen: HTMLCanvasElement[] = [];
  const out: string[] = [];
  for (const [, run] of steps) {
    await run();
    const ids = canvases().map(c => {
      if (!seen.includes(c)) seen.push(c);
      const log = paintOf(c);
      return `canvas#${seen.indexOf(c)} paints=${log.length} last=${log.slice(-3).join(";")}`;
    });
    out.push([document.body.innerHTML, ...ids].join("\n"));
  }
  return out;
}
