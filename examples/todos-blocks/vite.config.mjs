import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
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
