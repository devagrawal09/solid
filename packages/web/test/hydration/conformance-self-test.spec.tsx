/**
 * @vitest-environment jsdom
 *
 * Harness self-test (hydrate environment): a client build whose owner tree
 * differs from the server's — one extra owner before the markup, so every
 * hydration key shifts — must be rejected by the comparator. The server
 * markup is the unmutated scenario's recorded server/compiled artifact.
 */
import { expect, test } from "vitest";
import * as solid from "solid-js";
import * as web from "@solidjs/web";
import { judge } from "../conformance/harness/compare.js";
import { mode } from "../conformance/harness/modes.js";
import { mutate } from "../conformance/harness/mutate.js";
import { observeHydrate } from "../conformance/harness/runner.js";
import { readArtifact } from "../conformance/harness/artifacts.js";
import { eventReadsWrites } from "../conformance/scenarios/events.js";

test("the comparator catches a hydration-ID mismatch", async () => {
  const runtime = { solid, web };
  const artifact = readArtifact(eventReadsWrites.name, "server/compiled");
  const reference = await observeHydrate(
    eventReadsWrites,
    mode("hydrate/reference"),
    runtime,
    readArtifact(eventReadsWrites.name, "server/reference")
  );
  const clean = await observeHydrate(eventReadsWrites, mode("hydrate/compiled"), runtime, artifact);
  expect(judge({ status: "equivalent" }, reference.trace, clean.trace).ok).toBe(true);

  // Client-only extra owner ahead of the markup: the client's keys no longer
  // line up with the server's.
  const mutant = mutate(eventReadsWrites, [
    ["  const [count, sc] = h.signal", "  createMemo(() => 0);\n  const [count, sc] = h.signal"],
    ["import { $, write }", "import { $, write, createMemo }"]
  ]);
  const observed = await observeHydrate(mutant, mode("hydrate/compiled"), runtime, artifact);
  const verdict = judge({ status: "equivalent" }, reference.trace, observed.trace);
  expect(verdict.ok).toBe(false);
  expect(verdict.comparison!.divergence!.step).toBe("hydrate");
  expect(verdict.comparison!.divergence!.actual).toMatch(
    /^console\.warn = Hydration key miss for "1"/
  );
  // and the page is dead: the click no longer updates the server markup
  expect(verdict.comparison!.missing).toContain(
    'html = <div _hk="0"><button class="inc">+</button><p class="count">1</p></div>'
  );
});
