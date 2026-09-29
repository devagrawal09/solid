/**
 * @vitest-environment jsdom
 */
// Differential parity: the same script against examples/chat's App and this
// twin's (client-only, server components resolved in-process); the DOM must
// be identical after every step.
import { afterEach, describe, expect, it } from "vitest";
import Original from "../../chat/src/app";
import Twin from "../src/app";
import { install, mount, runScript, steps, uninstall } from "./script";

afterEach(uninstall);

describe("chat parity", () => {
  it("renders the same transcript as the original after every step", async () => {
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
    expect(at("mount (typing cursor)")).toContain("▍");
    expect(at("welcome: done")).toContain('class="done"');
    expect(at("reply: done")).toContain("how do signals work?");
    expect(at("copy the last code block")).toContain("Copied!");
    for (let i = 0; i < steps.length; i++) {
      expect(twin[i], `step ${i}: ${steps[i][0]}`).toBe(original[i]);
    }
  }, 60_000);
});
