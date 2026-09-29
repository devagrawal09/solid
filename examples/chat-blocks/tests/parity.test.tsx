// Differential parity: the same script against examples/chat's App and this
// twin's (client-only, server components resolved in process); the DOM must
// be identical after every step.
import { firstDifference } from "blocks-example-harness";
import Twin from "../src/app";
import { install, mount, runScript, steps, uninstall } from "./script";

afterEach(uninstall);

it("renders the same transcript as the original after every step", async () => {
  // A runtime specifier: the original is compiled for the test but is not
  // part of this project's type check (it is typed for @solidjs/web's JSX).
  const originalApp = new URL("../../chat/src/app.tsx", import.meta.url).pathname;
  const Original: (props: {}) => unknown = (await import(/* @vite-ignore */ originalApp)).default;
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
  // the script reaches the states it compares
  expect(at("mount (typing cursor)")).toContain("▍");
  expect(at("welcome: done")).toContain('class="done"');
  expect(at("reply: done")).toContain("how do signals work?");
  expect(at("streaming the code block")).toContain("copy-code");
  expect(at("copy the last code block")).toContain("Copied!");
  expect(at("fallback answer")).toContain("Good question");
  const names: [string, () => void][] = steps.map(([name]) => [name, () => {}]);
  expect(firstDifference(names, original, twin)).toBe(null);
}, 120_000);
