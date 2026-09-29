/**
 * @vitest-environment jsdom
 */
// Differential parity: the same script against examples/sierpinski (its
// `main.tsx` renders into `document.body` on import) and against this twin's
// `main.tsx`; the DOM after every step must be identical.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installClocks, runScript, steps, uninstallClocks } from "./script";

beforeEach(() => {
  document.body.innerHTML = "";
  installClocks();
});
afterEach(() => {
  uninstallClocks();
  document.body.innerHTML = "";
});

async function record(load: () => Promise<unknown>) {
  await load();
  return runScript();
}

describe("sierpinski parity", () => {
  it("renders the same DOM as the original after every step", async () => {
    const original = await record(() => import("../../sierpinski/src/main"));
    uninstallClocks();
    document.body.innerHTML = "";
    installClocks();
    const twin = await record(() => import("../src/main"));
    expect(twin.length).toBe(steps.length);
    // The script reaches the states it is meant to compare.
    expect(original[0]).toBe("Loading...");
    expect(original[1]).toContain(">0</div>");
    expect(original[4]).toContain("**1**");
    expect(original[7]).toContain(">5</div>");
    expect(original[10]).toContain(">3</div>");
    for (let i = 0; i < steps.length; i++) {
      expect(twin[i], `step ${i}: ${steps[i][0]}`).toBe(original[i]);
    }
  }, 60_000);
});
