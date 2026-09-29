/**
 * Link-time feature switches (src/core/features.ts;
 * documentation/plans/core-runtime-slicing.md).
 *
 * The published default keeps every switch on and must stay byte-identical
 * to the unswitched core (tests/treeshake.test.ts's floor ceiling holds it);
 * this file checks the other direction: turning a switch off — what the
 * capability linker does for a graph it proved never uses the feature —
 * actually removes the feature's seams, and the published trees keep the
 * switches substitutable. Behaviour under the switches is covered by the
 * census differential (scripts/slices-differential.mjs).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_NAMES, FIXTURES, measure } from "../scripts/slices.mjs";

const floor = FIXTURES.floor.replace("SIG", "sigsrc");
const floorSync = FIXTURES.floor.replace("SIG", "sigsrc-sync");

describe("link-time feature switches", () => {
  // Source-level markers each switch must remove from the floor bundle
  // (unminified: property names are intact).
  // (Hook-slot DECLARATIONS on GlobalQueue and the ext() field list stay:
  // markers are the uses — calls, bit tests, the store child-chain slots.)
  const MARKERS: Record<string, string[]> = {
    OPTIMISTIC: [
      "CONFIG_OVERRIDE_SUPERSEDED",
      "unwrapOverride(",
      "_resolveOptimistic(",
      "_cleanupLanes(",
      "_supersedeOverride("
    ],
    VERDICTS: ["_updatePendingSignal(", "_syncCompanions(", "_latestRead("],
    STORES: [
      "CONFIG_FW_CHILDREN",
      "CONFIG_SLOT_NODE",
      "transientStoreNodes",
      "slotUnobservedHook(",
      "_prevChild"
    ],
    SNAPSHOTS: ["CONFIG_IN_SNAPSHOT_SCOPE", "CONFIG_HAS_SNAPSHOT"],
    ITERABLE: ["accessorIterator"],
    COMPILED_SEAMS: ["CONFIG_STATUS_FREE", "_recomputeStatusFree(", "CONFIG_NOTHROW"]
  };

  it("the switch list matches src/core/features.ts", () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/core/features.ts"),
      "utf8"
    );
    const declared = [...src.matchAll(/^export const (\w+) = /gm)].map(m => m[1]);
    expect(declared.sort()).toEqual([...FEATURE_NAMES].sort());
    expect(Object.keys(MARKERS).sort()).toEqual([...FEATURE_NAMES].sort());
  });

  it("all on: every marker is present in the full floor", async () => {
    const { code } = await measure(floor);
    for (const [feature, markers] of Object.entries(MARKERS))
      for (const marker of markers)
        expect({ feature, marker, present: code.includes(marker) }).toEqual({
          feature,
          marker,
          present: true
        });
  });

  for (const feature of FEATURE_NAMES) {
    it(`${feature} off removes its seams and shrinks the floor`, async () => {
      const on = await measure(floor);
      const off = await measure(floor, { off: [feature] });
      expect(off.esm).toBeLessThan(on.esm);
      for (const marker of MARKERS[feature])
        expect({ marker, present: off.code.includes(marker) }).toEqual({ marker, present: false });
    });
  }

  it("STORES off: plain signals lose the firewall slots (smaller, uniform node shape)", async () => {
    const { code } = await measure(floor, { off: ["STORES"] });
    // The signal() literal no longer carries _firewall/_nextChild/_prevChild.
    expect(code).not.toMatch(/_firewall:/);
    expect(code).not.toMatch(/_prevChild:/);
  });

  it("all off on the async-free runtime: the smallest floor", async () => {
    const sync = await measure(floorSync, { asyncCapability: false });
    const sliced = await measure(floorSync, { asyncCapability: false, off: FEATURE_NAMES });
    expect(sliced.esm).toBeLessThan(sync.esm);
    // Measured at 12,440 (ESM minify; sync floor 13,138) when this landed.
    // MERGE (upstream `next` 0bf57589, 2026-09-29): 13,749. Upstream's sync
    // semantics that no switch owns stay (A28 visibility at flush, A30
    // dependency tails, unwind-order disposal, void mid-pass disposal; see
    // treeshake.test.ts's async-free floor note).
    expect(sliced.esm).toBeLessThan(13_800);
  });

  // ---- published trees ----
  const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  describe.skipIf(!existsSync(resolve(DIST, "prod/core/features.js")))("dist trees", () => {
    const read = (f: string) => readFileSync(resolve(DIST, f), "utf8");
    const values = (f: string) =>
      Object.fromEntries(
        [...read(f).matchAll(/export const (\w+) = (true|false);/g)].map(m => [m[1], m[2]])
      );

    it("each tree ships its features module with the tier defaults", () => {
      const all = Object.fromEntries(FEATURE_NAMES.map(n => [n, "true"]));
      expect(values("prod/core/features.js")).toEqual(all);
      expect(values("observe/core/features.js")).toEqual(all);
      expect(values("sync/core/features.js")).toEqual({
        ...all,
        OPTIMISTIC: "false",
        VERDICTS: "false"
      });
    });

    // scripts/inline-features.mjs: the switch tests are marked literals (the
    // capability linker rewrites the ones it turns off), never folded at
    // library build time and never an imported binding (a module-cell load
    // per test when the tree is loaded unbundled).
    it("the trees carry the switches as marked literals, not folded or imported", () => {
      for (const tier of ["prod", "observe", "sync"]) {
        const core = read(`${tier}/core/core.js`);
        const signals = read(`${tier}/signals.js`);
        expect(core).toMatch(/import "\.\/features\.js";/);
        expect(signals).toMatch(/import "\.\/core\/features\.js";/);
        expect(core).not.toMatch(/import \{[^}]*\} from "\.\/features\.js"/);
        expect(signals).not.toMatch(/import \{[^}]*\} from "\.\/core\/features\.js"/);
        expect(core).toMatch(/\/\* @solid-feature [A-Z_]+ \*\/ (true|false)/);
      }
      expect(read("prod/signals.js")).toMatch(/\/\* @solid-feature ITERABLE \*\/ true/);
    });
  });
});
