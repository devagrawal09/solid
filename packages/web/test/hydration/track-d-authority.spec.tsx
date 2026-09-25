/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 *
 * Track D slice 5 — server-authoritative replay elimination, client half.
 *
 * Replays the harness artifacts of the `authority-*` scenarios (written by
 * test/server/hydration-harness.spec.tsx with the same `serverAuthority`
 * setting) and asserts what the generic parity harness cannot:
 *
 *  - with sealing ON, the client never re-runs a sealed compute: zero calls
 *    of the fetcher, the sort comparator and the formatter (the
 *    ./harness/track-d-api counters); with it OFF (`SOLID_SERVER_AUTHORITY=0`)
 *    the same page replays them — the baseline this slice removes;
 *  - independently live descendants survive: a row's button still writes the
 *    client signal, and the rejected (escaped-setter) memo still updates;
 *  - a census of the reactive nodes / links hydration created
 *    (`TRACK_D_REPORT=1` prints it as JSON for the measurement log).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flush } from "solid-js";
import { hydrate } from "@solidjs/web";
import { scenarios } from "../harness/scenarios.jsx";
import { authorityStats } from "../harness/track-d-api.js";
import { startCensus, type Census } from "../harness/census.js";

const enabled = process.env.SOLID_SERVER_AUTHORITY !== "0";
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
  authorityStats.reset();
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
  return { scenario, container, census, warnings };
}

function report(name: string, census: Census) {
  if (process.env.TRACK_D_REPORT)
    console.log(
      "[track-d census] " +
        JSON.stringify({
          scenario: name,
          serverAuthority: enabled,
          ...census,
          ...authorityCounts()
        })
    );
}

function authorityCounts() {
  const { fetches, sorts, formats } = authorityStats;
  return { fetches, sorts, formats };
}

describe("Track D slice 5 — server-authoritative replay elimination", () => {
  for (const name of ["authority-catalog", "authority-bulk"]) {
    test(`${name}: sealed computes do not re-run; live rows still work`, async () => {
      const { scenario, container, census, warnings } = await hydrateScenario(name);
      expect(warnings).toBe(0);
      expect(container.textContent).toBe(scenario.expectedText);
      const counts = authorityCounts();
      report(name, census);
      if (enabled) {
        expect(counts).toEqual({ fetches: 0, sorts: 0, formats: 0 });
      } else {
        // Baseline: the dependency trace re-runs the fetcher (mocked
        // network), and the sync memos re-sort and re-format.
        expect(counts.fetches).toBeGreaterThan(0);
        expect(counts.sorts).toBeGreaterThan(0);
        expect(counts.formats).toBeGreaterThan(0);
      }
      // An independently live descendant inside an adopted row.
      const buttons = container.querySelectorAll("button");
      (buttons[0] as HTMLButtonElement).click();
      flush();
      expect(container.querySelector("section > p")!.textContent).toMatch(/^cart: [1-9]\d*$/);
      // Nothing re-ran after the interaction either.
      if (enabled) expect(authorityCounts()).toEqual({ fetches: 0, sorts: 0, formats: 0 });
    });
  }

  test("authority-sync: synchronous sealed values adopt for text and attribute", async () => {
    const { container, census, warnings } = await hydrateScenario("authority-sync");
    expect(warnings).toBe(0);
    const p = container.querySelector("p")!;
    expect(p.textContent).toBe("b=1,c=2,a=3");
    expect(p.getAttribute("title")).toBe("b=1,c=2,a=3");
    report("authority-sync", census);
  });

  test("authority-rejected-live: a rejected memo keeps the live path and updates", async () => {
    const { scenario, container, warnings } = await hydrateScenario("authority-rejected-live");
    expect(warnings).toBe(0);
    scenario.update!();
    flush();
    expect(container.textContent).toBe("page 2");
  });
});
