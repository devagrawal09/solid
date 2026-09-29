/**
 * @vitest-environment jsdom
 */
// Differential parity: the same script against examples/rendering's shared
// App and this twin's, rendered client-side (the CSR variant); the DOM must be
// identical after every step (`createUniqueId` values normalized — see
// tests/browser.steps.mjs).
import { afterEach, describe, expect, it } from "vitest";
import Original from "../../rendering/shared/src/components/App";
import Twin from "../shared/src/components/App";
import { install, mount, runScript, steps, uninstall } from "./script";

afterEach(uninstall);

describe("rendering parity", () => {
  it("renders every route like the original after every step", async () => {
    install();
    const a = mount(Original);
    const original = await runScript(a);
    a.dispose();
    uninstall();
    install();
    const b = mount(Twin);
    const twin = await runScript(b);
    b.dispose();
    const at = (name: string) => original[steps.findIndex(s => s[0] === name)];
    // The script reaches the states it is meant to compare.
    expect(at("Home ticks")).toContain("<span>10</span>");
    expect(at("profile data")).toContain("Jon's Profile");
    expect(at("profile data")).toContain("Or maybe not");
    expect(at("type")).toContain("<p>Hello blocks</p>");
    expect(at("logical click inside the portal")).toContain("Portal logical clicks: 1");
    expect(at("all items")).toContain("5: Fifth item");
    expect(at("items settle / fail")).toContain("ItemError: Error: Item bad-item not found");
    expect(at("cards reveal (sequential)")).toContain("C resolved in 1700ms");
    expect(at("refetched")).toMatch(/Shipped release #\d/);
    for (let i = 0; i < steps.length; i++) {
      const a = original[i],
        b = twin[i];
      let at = 0;
      while (at < a.length && a[at] === b[at]) at++;
      // The differing region, so a failure names what differs.
      expect(b.slice(Math.max(0, at - 80), at + 160), `step ${i}: ${steps[i][0]}`).toBe(
        a.slice(Math.max(0, at - 80), at + 160)
      );
      expect(b, `step ${i}: ${steps[i][0]}`).toBe(a);
    }
  }, 60_000);
});
