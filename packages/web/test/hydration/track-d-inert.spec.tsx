/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 *
 * Track D slice 6 — inert-region hydration elimination, client half.
 *
 * Replays the `inert-*` harness artifacts (written by the server harness with
 * the same `inertRegions` setting) and asserts, beyond the parity harness:
 *
 *  - inert regions are server-rendered without hydration keys, and the
 *    client adopts their nodes in place (same objects before and after);
 *  - live siblings, live ancestors (a component containing inert children)
 *    and live list rows around inert regions keep working;
 *  - the refused (event-handling) component keeps hydration: its handler fires;
 *  - outside hydration (client-only render) inert regions render normally;
 *  - a census (`TRACK_D_REPORT=1`): hydration keys, owners, computations.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flush } from "solid-js";
import { hydrate, render } from "@solidjs/web";
import { scenarios } from "../harness/scenarios.jsx";
import { inertRefusedClicks } from "../harness/track-d-inert-scenarios.jsx";
import { startCensus } from "../harness/census.js";

const enabled = process.env.SOLID_INERT_REGIONS === "1";
const artifactsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../harness/__artifacts__");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function applyChunk(container: HTMLElement, chunk: string, first: boolean) {
  const scriptRe = /<script(?:[^>]*)>([\s\S]*?)<\/script>/g;
  const scripts = [...chunk.matchAll(scriptRe)].map(m => m[1]);
  const stripped = chunk.replace(scriptRe, "");
  if (first) container.innerHTML = stripped;
  else container.insertAdjacentHTML("beforeend", stripped);
  for (const s of scripts) (0, eval)(s);
}

const mounted: (() => void)[] = [];
afterEach(async () => {
  for (const d of mounted.splice(0)) d();
  await sleep(0);
});

async function hydrateScenario(name: string) {
  const scenario = scenarios.find(s => s.name === name)!;
  const file = resolve(artifactsDir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`Run the server harness first (missing ${name}.json)`);
  const { shell, rest } = JSON.parse(readFileSync(file, "utf-8"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
  applyChunk(container, shell, true);
  if (rest) applyChunk(container, rest, false);
  const keys = container.querySelectorAll("[_hk]").length;
  // Every server node of the static regions, captured before hydration.
  const before = [
    ...container.querySelectorAll(
      ".banner, .banner *, .legal, .legal *, .card, .card *, svg, svg *"
    )
  ];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const finish = startCensus();
  const dispose = hydrate(() => <scenario.App />, container);
  flush();
  await sleep(30);
  flush();
  const census = finish();
  const warnings = warn.mock.calls.length;
  warn.mockRestore();
  mounted.push(() => {
    dispose();
    container.remove();
  });
  if (process.env.TRACK_D_REPORT)
    console.log(
      "[track-d inert census] " +
        JSON.stringify({ scenario: name, inertRegions: enabled, hydrationKeys: keys, ...census })
    );
  return { scenario, container, before, warnings, keys };
}

describe("Track D slice 6 — inert-region hydration elimination", () => {
  for (const name of ["inert-footer", "inert-nested-live", "inert-bulk", "inert-in-loading"]) {
    test(`${name}: inert nodes are adopted in place; live parts work`, async () => {
      const { scenario, container, before, warnings } = await hydrateScenario(name);
      expect(warnings).toBe(0);
      expect(container.textContent).toBe(scenario.expectedText);
      if (enabled) {
        // No hydration keys inside inert regions.
        for (const el of container.querySelectorAll(".banner, .legal, .card, svg"))
          expect(el.hasAttribute("_hk"), `<${el.localName}> kept a key`).toBe(false);
      }
      scenario.update!();
      flush();
      if (scenario.async) {
        await sleep(40);
        flush();
      }
      expect(container.textContent).toBe(scenario.expectedTextAfterUpdate);
      const after = [
        ...container.querySelectorAll(
          ".banner, .banner *, .legal, .legal *, .card, .card *, svg, svg *"
        )
      ];
      expect(after.length).toBe(before.length);
      after.forEach((node, i) => expect(node).toBe(before[i]));
    });
  }

  test("inert-in-for: inert icons in live rows; a new row renders its icon", async () => {
    const { scenario, container, warnings } = await hydrateScenario("inert-in-for");
    expect(warnings).toBe(0);
    scenario.update!();
    flush();
    expect(container.textContent).toBe("abc");
    // The client-rendered row (outside hydration) renders the inert icon itself.
    expect(container.querySelectorAll("li svg").length).toBe(3);
  });

  test("inert-refused: a component with an event handler keeps hydration", async () => {
    const { container, warnings } = await hydrateScenario("inert-refused");
    expect(warnings).toBe(0);
    const clicks = inertRefusedClicks();
    (container.querySelector("b") as HTMLElement).click();
    expect(inertRefusedClicks()).toBe(clicks + 1);
    expect(container.querySelector("b")!.hasAttribute("_hk")).toBe(true);
  });

  test("client-only rendering renders inert regions normally", () => {
    const scenario = scenarios.find(s => s.name === "inert-footer")!;
    const container = document.createElement("div");
    const dispose = render(() => <scenario.App />, container);
    flush();
    expect(container.textContent).toBe(scenario.expectedText);
    expect(container.querySelector("footer.legal svg")).not.toBeNull();
    dispose();
  });
});
