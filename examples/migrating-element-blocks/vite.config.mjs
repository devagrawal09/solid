import { defineConfig } from "vitest/config";
// Exercises the current @solidjs/vite-plugin pipeline: native JSX compiler by
// default (its generator-blocks v2 lowering on), native lazy/refresh passes,
// solid-js/refresh HMR runtime.
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
  server: { port: 3003 },
  preview: { port: 3003 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
