/**
 * Bundle guard (core runtime slicing, documentation/plans/core-runtime-slicing.md):
 * an app that never creates a store must not ship one.
 *
 * dist/solid.js is one flat file, so a module-scope statement in it can never
 * be shaken out of an app bundle. Registering the hydration-aware block
 * primitives at module scope (`setBlockPrimitives({ …, createStore, … })`)
 * named `createStore` — and the block API's primitive table names the core
 * one — so every solid-js app carried the whole store: +24 kB min / +8 kB gz
 * on the reactive floor, 45% of a small signals-only app. Registration is now
 * lazy (client/blocks.ts); this pins it.
 *
 * Bundles fixtures against the BUILT artifacts (dist/solid.js and the
 * @solidjs/signals prod tree it imports); skipped until `pnpm build` has run.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";
import { afterAll, describe, expect, it } from "vitest";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/solid.js");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Rendered (pre-minify) bytes of @solidjs/signals store modules in the bundle. */
async function storeBytes(code: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "solid-store-pfu-"));
  dirs.push(dir);
  const entry = join(dir, "entry.js");
  writeFileSync(entry, code.replace("SOLID", DIST));
  // An app bundler's view: @solidjs/signals resolves through its package
  // exports (default condition: the prod tree), sideEffects: false applies.
  const bundle = await rollup({ input: entry, plugins: [nodeResolve()], logLevel: "silent" });
  const { output } = await bundle.generate({ format: "es" });
  await bundle.close();
  let bytes = 0;
  for (const [id, mod] of Object.entries(output[0].modules))
    if (/[\\/]store[\\/]/.test(id)) bytes += mod.renderedLength;
  return bytes;
}

// mapArray (For) reads the store's `$TRACK` symbol: one constant, ~40 bytes.
// The store itself is ~60,000 rendered bytes.
const CONSTANTS_ONLY = 200;

describe.skipIf(!existsSync(DIST))("store pay-for-use (dist/solid.js)", () => {
  it("an app without stores or block constructors ships no store", async () => {
    const bytes = await storeBytes(
      `export { createSignal, createMemo, createEffect, createRoot, For, Show, Loading, Errored, createContext, useContext } from "SOLID";`
    );
    expect(bytes).toBeLessThan(CONSTANTS_ONLY);
  });

  it("block constructors that create no store ship no store either", async () => {
    expect(await storeBytes(`export { $component, $event } from "SOLID";`)).toBeLessThan(
      CONSTANTS_ONLY
    );
  });

  it("$store retains the store (positive control)", async () => {
    expect(await storeBytes(`export { $store } from "SOLID";`)).toBeGreaterThan(10_000);
  });
});
