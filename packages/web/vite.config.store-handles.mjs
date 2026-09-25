/// <reference types="vitest" />
// Store handles (optimization Track B, slice 2, stage 2): specs under
// test/store-handles compiled with the native compiler's `storeHandles`
// option, client (DOM) side. The server side is
// vite.config.store-handles-server.mjs.
import { defineConfig } from "vitest/config";
import solidPlugin from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solidPlugin({ compiler: "native", hot: false, solid: { storeHandles: true } })],
  test: {
    environment: "jsdom",
    pool: "threads",
    globals: true,
    include: ["test/store-handles/**/*.client.spec.tsx"]
  },
  resolve: {
    conditions: ["development", "browser"]
  }
});
