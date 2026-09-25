import { defineConfig } from "vitest/config";
// The native JSX compiler is the default, and its `generators` pass (on by
// default) lowers every `$` block in this app to call form ahead of JSX
// lowering — the app runs in transformed mode under `vite`, `vitest` and
// `vite build`. `solid-js/refresh` HMR runs in dev as in the source example.
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
  server: { port: 3012 },
  preview: { port: 3012 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
