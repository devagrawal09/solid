/**
 * @vitest-environment jsdom
 */
// Differential parity: the same script against examples/migrating-element
// (its `main.tsx` renders into `document.body` on import) and against this
// twin's `main.tsx`; the DOM, the canvas identities and the paint logs must
// match after every step.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCanvas, runScript, steps, uninstallCanvas } from "./script";

beforeEach(() => {
  document.body.innerHTML = "";
  installCanvas();
});
afterEach(() => {
  uninstallCanvas();
  document.body.innerHTML = "";
});

describe("migrating-element parity", () => {
  it("renders, migrates and paints like the original after every step", async () => {
    await import("../../migrating-element/src/main");
    const original = await runScript();
    uninstallCanvas();
    document.body.innerHTML = "";
    installCanvas();
    await import("../src/main");
    const twin = await runScript();
    // The script reaches the states it is meant to compare.
    expect(original[0]).toContain('<div class="slot-hero"><canvas');
    expect(original[4]).toContain('<div class="slot-pip"><canvas');
    expect(original[4]).toMatch(/canvas#0 .*\ncanvas#2 /);
    for (let i = 0; i < steps.length; i++) {
      expect(twin[i], `step ${i}: ${steps[i][0]}`).toBe(original[i]);
    }
  });
});
