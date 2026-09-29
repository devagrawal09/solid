/**
 * @vitest-environment jsdom
 */
// Differential parity: the same script against examples/hackernews's App
// and this twin's (client-only, fixture data); the URL and the DOM must be
// identical after every step.
import { afterEach, describe, expect, it } from "vitest";
import Original from "../../hackernews/src/app";
import Twin from "../src/app";
import { install, mount, runScript, steps, uninstall } from "./script";

afterEach(uninstall);

describe("hackernews parity", () => {
  it("routes and renders like the original after every step", async () => {
    install("/");
    const a = mount(Original);
    const original = await runScript(a);
    a.dispose();
    uninstall();
    install("/");
    const b = mount(Twin);
    const twin = await runScript(b);
    b.dispose();
    const at = (name: string) => original[steps.findIndex(s => s[0] === name)];
    // The script reaches the states it is meant to compare.
    expect(at("mount / (loading, then the top feed)")).toContain("top story 1");
    expect(at("a job's story")).toMatch(/^\/stories\/job-3\n/);
    expect(at("a job's story")).toContain("A reply");
    expect(at("collapse the first thread")).toContain("[+] comments collapsed");
    expect(at("a commenter")).toContain("User : alice");
    expect(at("Show page 2 (last page)")).toContain("page 2");
    for (let i = 0; i < steps.length; i++) {
      expect(twin[i], `step ${i}: ${steps[i][0]}`).toBe(original[i]);
    }
  }, 60_000);
});
