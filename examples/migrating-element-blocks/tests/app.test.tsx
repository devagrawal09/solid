// The migrating-element twin driven through jsdom, compiled by the native
// compiler with the block rule: slot buttons, the hoisted canvas migrating (same node, same
// paint), the inline canvas being re-created, splats, the reveal loop and
// disposal.
import { render } from "@solidjs/blocks";
import { flush } from "solid-js";
import { App } from "../src/app";
import { canvases, frames, installCanvas, paintOf, uninstallCanvas } from "./script";

let dispose: () => void;

beforeEach(() => {
  document.body.innerHTML = "";
  installCanvas();
  dispose = render(App, document.body);
  flush();
});
afterEach(() => {
  dispose();
  uninstallCanvas();
});

const left = () => document.body.querySelector<HTMLCanvasElement>(".panel-good canvas")!;
const right = () => document.body.querySelector<HTMLCanvasElement>(".panel-bad canvas")!;
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>(".controls button")];
const choose = (label: string) => {
  buttons()
    .find(b => b.textContent === label)!
    .click();
  flush();
};
const slotOf = (panel: string) =>
  document.body.querySelector(`${panel} .stage > div`)!.className.replace("slot-", "");
const splat = (c: HTMLCanvasElement, x = 10, y = 10) =>
  c.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
const splats = (c: HTMLCanvasElement) => paintOf(c).filter(e => e.startsWith("arc(")).length;

describe("migrating-element with @solidjs/blocks", () => {
  it("renders the controls with Hero active and both canvases in the hero slot", () => {
    expect(buttons().map(b => b.textContent)).toEqual(["Hero", "PIP (corner)", "Dock"]);
    expect(buttons().map(b => b.className)).toEqual(["active", "", ""]);
    expect(slotOf(".panel-good")).toBe("hero");
    expect(slotOf(".panel-bad")).toBe("hero");
    expect(canvases()).toHaveLength(2);
    expect(left().width).toBe(800);
    expect(left().height).toBe(450);
    // The settled effect reset each canvas (background fill).
    expect(paintOf(left()).slice(0, 2)).toEqual([
      "fillStyle=#f4f7fb",
      "fillRect(0.00,0.00,800.00,450.00)"
    ]);
  });

  it("switches the active button and slot on click", () => {
    choose("PIP (corner)");
    expect(buttons().map(b => b.className)).toEqual(["", "active", ""]);
    expect(slotOf(".panel-good")).toBe("pip");
    expect(slotOf(".panel-bad")).toBe("pip");
    choose("Dock");
    expect(buttons().map(b => b.className)).toEqual(["", "", "active"]);
    expect(slotOf(".panel-good")).toBe("dock");
    expect(document.body.querySelectorAll(".stage > div")).toHaveLength(2);
  });

  it("migrates the hoisted canvas: same node, same paint, listener kept", async () => {
    const hoisted = left();
    await frames(1000);
    splat(hoisted);
    expect(splats(hoisted)).toBe(1);
    const painted = paintOf(hoisted).length;
    choose("PIP (corner)");
    expect(left()).toBe(hoisted);
    // Not reset on the move: the log only grows.
    expect(paintOf(hoisted).length).toBe(painted);
    splat(hoisted);
    expect(splats(hoisted)).toBe(2);
    choose("Dock");
    choose("Hero");
    expect(left()).toBe(hoisted);
    await frames(100);
    expect(paintOf(hoisted).filter(e => e === "fillRect(0.00,0.00,800.00,450.00)")).toHaveLength(1);
  });

  it("re-creates the inline canvas on every move", () => {
    const first = right();
    splat(first);
    expect(splats(first)).toBe(1);
    choose("PIP (corner)");
    const second = right();
    expect(second).not.toBe(first);
    expect(splats(second)).toBe(0);
    expect(paintOf(second).slice(0, 1)).toEqual(["fillStyle=#f4f7fb"]);
    // The old canvas's listener was removed on dispose.
    splat(first);
    expect(splats(first)).toBe(1);
  });

  it("draws the logo progressively over the reveal", async () => {
    const c = left();
    const strokes = () => paintOf(c).filter(e => e.startsWith("stroke(")).length;
    expect(strokes()).toBe(0);
    await frames(2000);
    const early = strokes();
    expect(early).toBeGreaterThan(0);
    await frames(16000);
    const done = strokes();
    expect(done).toBeGreaterThan(early);
    await frames(2000);
    // Past the reveal nothing more is drawn.
    expect(strokes()).toBe(done);
  });

  it("maps the click position into canvas space", () => {
    splat(left(), 400, 225);
    expect(paintOf(left())).toContain("arc(400.00,225.00,32.00,0.00,6.28)");
  });

  it("stops the frame loop and detaches the listener on dispose", async () => {
    const c = left();
    dispose();
    dispose = () => {};
    expect(document.body.innerHTML).toBe("");
    const n = paintOf(c).length;
    await frames(1000);
    splat(c);
    expect(paintOf(c).length).toBe(n);
  });
});
