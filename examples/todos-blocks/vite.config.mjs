import { defineConfig } from "vitest/config";
// The native JSX compiler is the default, and its `generators` pass (on by
// default) lowers every `$` block in this app to call form ahead of JSX
// lowering — the app runs in transformed mode under `vite`, `vitest` and
// `vite build`. `solid-js/refresh` HMR runs in dev as in the source example.
import solid from "@solidjs/vite-plugin";

// The default build uses the compiler's default generator-blocks-v2 fusion and
// client lowering. `SOLID_HOST_FUSION=1` also fuses plain `$` blocks
// (`createMemo($(fn))` → `createMemo(fn)`); `SOLID_HOST_FUSION=0` opts out of
// all fusion (the plain lowering) — the A/B the measurements use.
const hostFusion =
  process.env.SOLID_HOST_FUSION === "1"
    ? true
    : process.env.SOLID_HOST_FUSION === "0"
      ? false
      : undefined;
// `SOLID_BLOCK_PROOFS=1` turns on the Track A stage-1 block proofs
// (status-free fast paths): proven blocks carry `$(fn, flags)` metadata and
// their reactive hosts receive `statusFree` / `syncOnly` options.
const blockProofs = process.env.SOLID_BLOCK_PROOFS === "1";

export default defineConfig({
  // `.ts` modules go through the compiler too: `filter.ts` holds a block
  // (`onSettled(function* …)`). Compiled, every block in the app is lowered
  // and the bundle ships no generator driver; left to the runtime, that one
  // body would need it (the driver is installed only by the uncompiled
  // block constructor).
  plugins: [solid({ solid: { hostFusion, blockProofs }, extensions: [[".ts", { typescript: true }]] })],
  server: { port: 3012 },
  preview: { port: 3012 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
