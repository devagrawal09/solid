import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
// The blocks type linker: keeps src/solid-props.gen.d.ts current in dev and
// fails `vite build` when the committed file is stale.
import solidLink from "@solidjs/blocks-linker/vite";

// examples/chat's setup: `start: {}` generates the entries (client hydrate,
// server render, document shell from src/Document.tsx), and
// `serverFunctions.components` makes a `"use server"` function that returns
// a component stream its markup over the server-function endpoint.
export default defineConfig({
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  server: { port: 3009 },
  plugins: [solidLink(), solid({ start: {}, ssr: true, serverFunctions: { components: true } })]
});
