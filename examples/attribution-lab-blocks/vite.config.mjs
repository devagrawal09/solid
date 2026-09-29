import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

// Tier note — the whole point of this example is the dev/observe channels, so
// which build resolves matters:
//
//   `vite` (dev serve) and `vitest` both run with `command === "serve"`, so the
//   plugin injects the `development` export condition and `solid-js` resolves
//   to `dist/solid.dev.js` — `OBSERVE` is defined, the diagnostics channel is
//   live, and `solid-js/attribution` is the real engine. Vitest additionally
//   runs with `mode === "test"`, which adds the `browser` condition, so the
//   DOM build (not the server build) is what the jsdom tests exercise.
//
//   `vite build` / `vite preview` deliberately stay on the production tier:
//   `OBSERVE` is `undefined` and `solid-js/attribution` resolves to the inert
//   engine. That is the correct shipping posture, and `src/main.tsx` renders an
//   explicit banner instead of silently-empty panels. Do not "fix" this by
//   passing `dev: true` — a diagnostics demo that lies about the prod tier
//   would teach the wrong thing.
//
// `diagnostics: true` is dev-serve only: it installs the in-page bridge from
// this package's own `@solidjs/diagnostics` dev dependency and serves
// `/__solid/diagnostics`, so an agent can drive the same channels this UI
// renders. It is inert under `vite build` and `vite preview`.
export default defineConfig({
  plugins: [solid({ diagnostics: true })],
  server: { port: 3008 },
  preview: { port: 3008 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
    // Real timers and real microtask ordering: every async assertion in this
    // suite deadline-polls (`tests/helpers.ts`) rather than sleeping a fixed
    // interval, so a loaded runner cannot turn a latency race into a flake.
    pool: "threads"
  }
});
