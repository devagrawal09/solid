/**
 * Track A stage 2 — the async-free entry's contract (src/index.sync.ts).
 *
 * Behavioural equivalence of the async-free runtime is covered by the
 * differential (scripts/track-a/sync-differential.mjs: every test of this
 * suite that never touches an async capability passes compiled with
 * `__ASYNC__ = false`). This file pins the surface: same exports as the full
 * entry, async capabilities stubbed and listed in the manifest.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as full from "../src/index.js";
import * as sync from "../src/index.sync.js";

const manifest = JSON.parse(
  readFileSync(new URL("../capabilities.json", import.meta.url), "utf8")
) as { asyncExports: string[]; asyncFreeEntry: string; hosts: string[] };

describe("@solidjs/signals/sync", () => {
  it("exports every name the full entry exports", () => {
    const missing = Object.keys(full).filter(name => !(name in sync));
    expect(missing).toEqual([]);
  });

  it("stubs exactly the manifest's async capabilities", () => {
    expect([...sync.ASYNC_CAPABILITIES].sort()).toEqual([...manifest.asyncExports].sort());
    expect(manifest.asyncFreeEntry).toBe("@solidjs/signals/sync");
    for (const name of manifest.asyncExports) {
      const stub = (sync as any)[name];
      expect(stub).not.toBe((full as any)[name]);
      expect(() => stub()).toThrow(/\[ASYNC_CAPABILITY_EXCLUDED\]/);
    }
  });

  it("keeps every other export identical", () => {
    const stubbed = new Set([...manifest.asyncExports, "enforceLoadingBoundary"]);
    for (const name of Object.keys(full)) {
      if (stubbed.has(name)) continue;
      expect({ name, same: (sync as any)[name] === (full as any)[name] }).toEqual({
        name,
        same: true
      });
    }
  });

  it("makes the dev diagnostic switch a no-op instead of a stub", () => {
    expect(() => sync.enforceLoadingBoundary(true)).not.toThrow();
    sync.enforceLoadingBoundary(false);
  });

  it("lists every reactive host the compiler summarizes", () => {
    expect(manifest.hosts.sort()).toEqual(
      [
        "createEffect",
        "createMemo",
        "createProjection",
        "createRenderEffect",
        "createSignal",
        "createStore"
      ].sort()
    );
  });
});
