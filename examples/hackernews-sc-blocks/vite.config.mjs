import { defineConfig } from "vite";
// Compiled islands with compiler-derived server components: in the SSR
// build every module compiles to string templates (and each derived frame
// to a generated, registered server function); in the client build the
// page entry is the islands loader plus the navigation interceptor, and the
// frames applier and route table load on the first client navigation.
import { solidIslands } from "@solidjs/compiler/islands-build";

export default defineConfig({
  plugins: [solidIslands({ root: "src/app.tsx", prefetch: "intent" })],
  build: { modulePreload: false, outDir: "dist/client", manifest: true }
});
