import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
// The blocks type linker: keeps src/solid-props.gen.d.ts current in dev and
// fails `vite build` when the committed file is stale.
import solidLink from "@solidjs/blocks-linker/vite";

// examples/hackernews's turnkey SSR: `start: {}` (with `ssr: true`)
// generates the entries and the serving layer around src/app.tsx;
// `serverFunctions` serves the `/_server` endpoint the `"use server"`
// modules dispatch through; `serverFunctions.components` makes a `"use
// server"` function that returns a component stream its markup.
export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  server: { port: 3004 },
  plugins: [solidLink(), solid({ start: {}, ssr: true, serverFunctions: { components: true } })]
});
