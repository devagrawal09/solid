import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import { solidCapabilities } from "@solidjs/compiler/capabilities";

// Strict-style pipeline for an async-free app (Track A):
// - the native compiler lowers every `$` block, fuses blocks into their
//   reactive hosts and emits the stage-1 block proofs;
// - the capability linker proves the client graph async-free from the
//   compiler summaries, the typed summary (`pnpm summary`: solid-tsc
//   --capabilities) and the library manifests, and then — only then —
//   resolves `@solidjs/signals` to the async-free runtime.
// `SOLID_CAPABILITIES=0` leaves the linker out (the full-runtime baseline the
// stage-2 measurements compare against).
const linker = process.env.SOLID_CAPABILITIES !== "0";

export default defineConfig({
  plugins: [
    // Refresh is off: its HMR component proxy reads a signal when a local
    // component is created inside a `$` JSX block body (a pre-existing
    // interaction with the dev block guard, unrelated to Track A).
    solid({ solid: { hostFusion: true, blockProofs: true }, refresh: { disabled: true } }),
    linker &&
      solidCapabilities({
        entries: ["src/main.tsx"],
        typedSummary: ".solid-capabilities.json",
        report: "capabilities-report.json"
      })
  ].filter(Boolean),
  server: { port: 3013 },
  preview: { port: 3013 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
