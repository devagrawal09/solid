import { defineConfig } from "vitest/config";
// The native JSX compiler is the default, and its `generators` pass (on by
// default) lowers every `$` block in this app to call form ahead of JSX
// lowering — the app runs in transformed mode under `vite`, `vitest` and
// `vite build`. `solid-js/refresh` HMR runs in dev as in the source example.
import solid from "@solidjs/vite-plugin";

// `SOLID_HOST_FUSION=1` also turns on the compiler's experimental host
// fusion (`createMemo($(fn))` → `createMemo(fn)`) for `vite build` and
// `vitest` — the A/B the host-fusion prototype's measurements and end-to-end
// runs use; the default build is the plain lowering.
const hostFusion = process.env.SOLID_HOST_FUSION === "1";
// `SOLID_BLOCK_PROOFS=1` turns on the Track A stage-1 block proofs
// (status-free fast paths): proven blocks carry `$(fn, flags)` metadata and
// their reactive hosts receive `statusFree` / `syncOnly` options.
const blockProofs = process.env.SOLID_BLOCK_PROOFS === "1";

export default defineConfig({
  plugins: [solid({ solid: { hostFusion, blockProofs } })],
  server: { port: 3012 },
  preview: { port: 3012 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
