import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
// The blocks type linker: keeps src/solid-props.gen.d.ts current in dev and
// fails `vite build` when the committed file is stale.
import solidLink from "@solidjs/blocks-linker/vite";

export default defineConfig({
  plugins: [solidLink(), solid()],
  server: { port: 3012 },
  preview: { port: 3012 },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.tsx"]
  },
  // tests run the development builds (dev warnings, dev checks); `vite build` keeps its defaults
  resolve: process.env.VITEST ? { conditions: ["development", "browser"] } : undefined
});
