/// <reference types="vitest" />
// Store handles (optimization Track B, slice 2, stage 2): specs under
// test/store-handles compiled with `storeHandles` for SSR.
import { defineConfig } from "vitest/config";
import solidPlugin from "@solidjs/vite-plugin";
import { resolve } from "path";

const rootDir = resolve(import.meta.dirname);

export default defineConfig({
  plugins: [
    solidPlugin({
      compiler: "native",
      hot: false,
      solid: { generate: "ssr", hydratable: true, storeHandles: true }
    })
  ],
  test: {
    environment: "node",
    include: ["test/store-handles/**/*.server.spec.tsx"],
    globals: true,
    pool: "threads"
  },
  resolve: {
    conditions: ["node"],
    alias: {
      "@solidjs/web": resolve(rootDir, "src/index.server.ts"),
      "solid-js": resolve(rootDir, "../solid/src/server/index.ts")
    }
  }
});
