// Differential parity: the same script against examples/migrating-element
// (its main.tsx renders into document.body on import) and against this
// twin's main.tsx; the DOM, the canvas identities and the paint logs must
// match after every step.
import { firstDifference } from "blocks-example-harness";
import { installCanvas, runScript, steps, uninstallCanvas } from "./script";

beforeEach(() => {
  document.body.innerHTML = "";
  installCanvas();
});
afterEach(() => {
  uninstallCanvas();
  document.body.innerHTML = "";
});

it("renders, migrates and paints like the original after every step", async () => {
  const originalMain = new URL("../../migrating-element/src/main.tsx", import.meta.url).pathname;
  await import(/* @vite-ignore */ originalMain);
  const original = await runScript();
  uninstallCanvas();
  document.body.innerHTML = "";
  installCanvas();
  await import("../src/main");
  const twin = await runScript();
  // the script reaches the states it compares
  expect(original[0]).toContain('<div class="slot-hero"><canvas');
  expect(original[4]).toContain('<div class="slot-pip"><canvas');
  expect(original[4]).toMatch(/canvas#0 .*\ncanvas#2 /);
  expect(firstDifference(steps, original, twin)).toBe(null);
});
