/**
 * The agent path: the same page the demo serves, captured from outside.
 *
 * `installDiagnosticsBridge()` (wired in `src/main.tsx`) exposes a capture
 * session on a well-known global; `captureBrowserArtifact` drives it through
 * anything with a Playwright-shaped `evaluate`. This test stands in for the
 * browser with an in-process page that forces every value through JSON — the
 * same constraint a real page boundary imposes — so the demo is proven
 * capturable without adding a browser to the test run.
 *
 * Swap `fakePage` for a real `page` from `@playwright/test` and this is the
 * production recipe.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { BRIDGE_GLOBAL, installDiagnosticsBridge } from "@solidjs/diagnostics/browser";
import { captureBrowserArtifact, type EvaluatingPage } from "@solidjs/diagnostics/playwright";
import { expectDiagnostic } from "@solidjs/diagnostics";
import { ResultsPanel } from "../src/scenarios/tear/ResultsPanel";
import { $, attributionOptions, mountPoint, typeInto } from "./helpers";

function fakePage(realm: Record<string, unknown>): EvaluatingPage {
  const roundTrip = <V,>(value: V): V =>
    value === undefined ? value : JSON.parse(JSON.stringify(value));
  return {
    async evaluate(pageFunction: (arg?: unknown) => unknown, arg?: unknown) {
      const previous = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL];
      (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] = realm[BRIDGE_GLOBAL];
      try {
        return roundTrip(await pageFunction(roundTrip(arg)));
      } finally {
        (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] = previous;
      }
    }
  } as EvaluatingPage;
}

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the browser bridge", () => {
  it("captures a scripted page session into the same artifact format", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const realm: Record<string, unknown> = {};
    installDiagnosticsBridge(realm);
    const page = fakePage(realm);

    const host = mountPoint();
    dispose = render(() => <ResultsPanel broken={true} />, host);
    flush();

    const { artifact } = await captureBrowserArtifact(
      page,
      () => {
        typeInto($<HTMLInputElement>(host, "#tear-query"), "br");
      },
      { scenario: "tear/broken (page session)", attribution: attributionOptions }
    );

    expect(artifact.formatVersion).toBe(4);
    expect(artifact.scenario).toBe("tear/broken (page session)");
    // A real finding, produced by the app's own runtime, carried across the
    // page boundary as plain JSON.
    expectDiagnostic(artifact, "EFFECT_RELAY_TEAR");
    expect(artifact.attribution!.reruns.some(rerun => rerun.nodeName === "tear:summary")).toBe(
      true
    );
  });
});
