import { defineConfig } from "vite";
// Compiled islands (packages/compiler/islands-build.js): in the SSR build
// every page module compiles to string templates with island anchors; in the
// client build `virtual:solid-islands` is the page entry (the loader and the
// eager activations) and each island group is a lazy chunk bound to its
// runtime tier (t0 helper, kernel, or core).
import { solidIslands } from "@solidjs/compiler/islands-build";

export default defineConfig({
  plugins: [
    solidIslands({
      root: "src/app.tsx",
      // App default, then per island (by root component) — see the loader's
      // prefetch policies; saveData / 2G connections prefetch nothing.
      prefetch: "visible",
      overrides: { Toggle: "intent" },
      budget: 64 * 1024
    })
  ],
  build: { modulePreload: false }
});
