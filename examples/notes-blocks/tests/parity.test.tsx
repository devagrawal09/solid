// Differential parity: the same script against examples/notes's App and this
// twin's (client-only: server components and actions in process, each app
// against its own in-memory store); the URL and the DOM must be identical
// after every step (clock times normalized).
import { firstDifference } from "blocks-example-harness";
import Twin from "../src/app";
import { install, mount, runScript, steps, uninstall } from "./script";

afterEach(uninstall);

it("routes, renders and mutates like the original after every step", async () => {
  // A runtime specifier: the original is compiled for the test but is not
  // part of this project's type check (it is typed for @solidjs/web's JSX).
  const originalApp = new URL("../../notes/src/app.tsx", import.meta.url).pathname;
  const Original: (props: {}) => unknown = (await import(/* @vite-ignore */ originalApp)).default;
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
  // the script reaches the states it compares
  expect(at("open a note")).toMatch(/^\/notes\/0\n/);
  expect(at("search with no match")).toContain("Couldn't find any notes titled");
  expect(at("type a body")).toContain("<h1>Heading</h1>");
  expect(at("save (redirect to the note)")).toContain("Meeting Notes (edited)");
  expect(at("create (redirect to it)")).toMatch(/^\/notes\/3\n/);
  expect(at("delete it (redirect home)")).not.toContain('href="/notes/3"');
  const names: [string, () => void][] = steps.map(([name]) => [name, () => {}]);
  expect(firstDifference(names, original, twin)).toBe(null);
}, 120_000);
