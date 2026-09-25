/**
 * @vitest-environment jsdom
 *
 * Harness self-tests: the oracle must catch real semantic regressions. Each
 * mutant is a real scenario with one planted bug in its `$` source, compiled
 * by the native compiler and run through the ordinary client runner; the
 * comparator must reject it and point at the right event. Also pins the
 * judge's expectation rules (a known defect that stops reproducing, or a
 * declared difference that is not a difference, fails).
 */
import { describe, expect, test } from "vitest";
import * as solid from "solid-js";
import * as web from "@solidjs/web";
import { judge } from "./harness/compare.js";
import { mode } from "./harness/modes.js";
import { mutate } from "./harness/mutate.js";
import { expectationFor } from "./harness/register.js";
import { observeClient } from "./harness/runner.js";
import type { Scenario } from "./harness/types.js";
import { asyncFlights } from "./scenarios/boundaries.js";
import { eventReadsWrites } from "./scenarios/events.js";
import { dynamicSubscriptions, ownedChildren, ownerRouting } from "./scenarios/reactive.js";

const runtime = { solid, web };

/** Judge a mutant under the original scenario's declared expectation. */
async function verdictFor(original: Scenario, mutant: Scenario, modeId = "client/compiled") {
  const candidate = mode(modeId);
  const expectation = expectationFor(original, candidate);
  const reference = await observeClient(original, mode("client/reference"), runtime);
  // the unmutated source passes, so the planted bug is what gets caught
  const clean = await observeClient(original, candidate, runtime);
  expect(judge(expectation, reference.trace, clean.trace).ok).toBe(true);
  const observed = await observeClient(mutant, candidate, runtime);
  return judge(expectation, reference.trace, observed.trace);
}

describe("the comparator catches planted regressions", () => {
  test("missing cleanup", async () => {
    const mutant = mutate(ownedChildren, [
      ['      h.cleanup("child(" + o + "," + i + ")");\n', ""]
    ]);
    const verdict = await verdictFor(ownedChildren, mutant);
    expect(verdict.ok).toBe(false);
    expect(verdict.comparison!.divergence!.expected).toBe("cleanup child(1,1)");
    expect(verdict.comparison!.missing.every(line => line.startsWith("cleanup child("))).toBe(true);
    expect(verdict.comparison!.kinds).toEqual(["cleanup"]);
  });

  test("wrong conditional subscription (branch read made unconditional)", async () => {
    const mutant = mutate(dynamicSubscriptions, [
      [
        "return (yield* flag) ? yield* a : yield* b;",
        "const eager = yield* b;\n      return (yield* flag) ? yield* a : eager;"
      ]
    ]);
    const verdict = await verdictFor(dynamicSubscriptions, mutant);
    expect(verdict.ok).toBe(false);
    // first visible at mount (an extra read of b), and it resubscribes pick
    // to b while flag is on:
    expect(verdict.comparison!.extra).toContain("run pick");
    expect(verdict.comparison!.kinds).toEqual(expect.arrayContaining(["read", "run"]));
  });

  test("duplicate event write", async () => {
    const mutant = mutate(eventReadsWrites, [
      ["yield* write(sc, c + 1);", "yield* write(sc, c + 1);\n    yield* write(sc, c + 1);"]
    ]);
    const verdict = await verdictFor(eventReadsWrites, mutant);
    expect(verdict.ok).toBe(false);
    expect(verdict.comparison!.divergence!.step).toBe("click");
    expect(verdict.comparison!.divergence!.actual).toBe("write count = 1");
    expect(verdict.comparison!.extra).toEqual([
      "write count = 1",
      "write count = 11",
      "write count = 11"
    ]);
  });

  test("stale async commit (a superseded flight's result reaches the DOM)", async () => {
    // Commit every flight's result as it lands, without asking whether the
    // run is still current — the classic stale-response bug.
    const mutant = mutate(asyncFlights, [
      [
        "export function App() {",
        "export function App() {\n  const [shown, setShown] = createSignal();"
      ],
      [
        'const v = yield* wait(h.task("load", i), NotFound);',
        'const v = yield* wait(h.task("load", i).then(r => (setShown(() => r), r)), NotFound);'
      ],
      ['<p class="user">{user()}</p>', '<p class="user">{(user(), shown())}</p>'],
      ["import { $, createMemo,", "import { $, createSignal, createMemo,"]
    ]);
    const verdict = await verdictFor(asyncFlights, mutant, "client/runtime");
    expect(verdict.ok).toBe(false);
    const d = verdict.comparison!.divergence!;
    expect(d.step).toBe("resolve stale load#2 (must not commit)");
    expect(d.expected).toBe('html = <p class="user">grace</p>');
    expect(d.actual).toBe('html = <p class="user">stale</p>');
  });

  test("owner mismatch", async () => {
    const mutant = mutate(ownerRouting, [
      ['      h.where("memo body");', '      runWithOwner(null, () => h.where("memo body"));'],
      ["import { $, createMemo,", "import { $, runWithOwner, createMemo,"]
    ]);
    const verdict = await verdictFor(ownerRouting, mutant);
    expect(verdict.ok).toBe(false);
    expect(verdict.comparison!.divergence!.expected).toBe("owner memo body = memo");
    expect(verdict.comparison!.divergence!.actual).toBe("owner memo body = none");
    expect(verdict.comparison!.kinds).toEqual(["owner"]);
  });
});

describe("expectation rules", () => {
  const reference = ["## mount", "run a", "value a = 1"];

  test("a known defect that no longer reproduces fails (flip it)", () => {
    const verdict = judge({ status: "known-defect", reason: "x" }, reference, reference);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/no longer reproduces/);
  });

  test("a known defect pinned elsewhere fails", () => {
    const actual = ["## mount", "run a", "value a = 2"];
    expect(
      judge(
        { status: "known-defect", reason: "x", firstDivergence: "value a = 2" },
        reference,
        actual
      ).ok
    ).toBe(true);
    expect(
      judge({ status: "known-defect", reason: "x", firstDivergence: "run b" }, reference, actual).ok
    ).toBe(false);
  });

  test("a declared difference must actually differ and be reproduced exactly", () => {
    expect(
      judge({ status: "differs", reason: "x", trace: reference }, reference, reference).ok
    ).toBe(false);
    const declared = { status: "differs" as const, reason: "x", remove: ["value a = 1"] };
    expect(judge(declared, reference, ["## mount", "run a"]).ok).toBe(true);
    expect(judge(declared, reference, ["## mount", "run a", "run a"]).ok).toBe(false);
    expect(
      judge({ status: "differs", reason: "x", remove: ["nope"] }, reference, reference).ok
    ).toBe(false);
  });

  test("equivalence is exact: order and multiplicity matter", () => {
    expect(
      judge({ status: "equivalent" }, reference, ["## mount", "value a = 1", "run a"]).ok
    ).toBe(false);
    expect(judge({ status: "equivalent" }, reference, [...reference, "run a"]).ok).toBe(false);
  });
});
