/**
 * @vitest-environment jsdom
 */
// Differential parity: the same script against examples/notes's App and this
// twin's (client-only; server components and actions in-process, each app
// with its own in-memory store); the URL and the DOM must be identical after
// every step (clock times normalized).
import { afterEach, describe, expect, it } from "vitest";
import Original from "../../notes/src/app";
import Twin from "../src/app";
import { install, mount, runScript, steps, uninstall } from "./script";

afterEach(uninstall);

describe("notes parity", () => {
  it("routes, renders and mutates like the original after every step", async () => {
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
    expect(at("mount / (shell, list, empty state)")).toContain("Click a note on the left");
    expect(at("expand the second note")).toContain("note-expanded");
    expect(at("search 'thing'")).toMatch(/^\/notes\/0\?searchText=thing\n/);
    expect(at("search with no match")).toContain(`Couldn't find any notes titled "zzz".`);
    expect(at("type a body")).toContain("<h1>Heading</h1>");
    expect(at("save (redirect to the note)")).toContain("<strong>Meeting Notes (edited)</strong>");
    expect(at("create (redirect to it)")).toMatch(/^\/notes\/3\n/);
    expect(at("delete it (redirect home)")).not.toContain('href="/notes/3"');
    for (let i = 0; i < steps.length; i++) {
      const x = original[i],
        y = twin[i];
      let d = 0;
      while (d < x.length && x[d] === y[d]) d++;
      // The differing region, so a failure names what differs.
      expect(y.slice(Math.max(0, d - 160), d + 240), `step ${i}: ${steps[i][0]}`).toBe(
        x.slice(Math.max(0, d - 160), d + 240)
      );
    }
  }, 60_000);
});
