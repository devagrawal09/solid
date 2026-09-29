// v2 twin note: kept a plain component. As a `$component` (the document shell
// both entries render and the client hydrates), the streamed page fails to
// hydrate: `lazy() module "…/Home.tsx" (hydration id "011000c0") was not
// preloaded before hydration` and REACTIVITY_HALTED — the shell's view adds a
// hydration-id level on one side of the lazy module registration. See the README.
import type { ParentProps } from "solid-js";
import { HydrationScript } from "@solidjs/web";

/**
 * SSR-only shell. Wraps the shared `<App />` content in an `<html>` document
 * with hydration script, stylesheet, and the client entry module. The CSR
 * variant serves its own static `index.html` and does not use this.
 *
 * `clientEntry` is the dev module path of the mode's client entry (e.g.
 * `/client.tsx`); in production builds the server harness rewrites it to the
 * hashed asset from the Vite client manifest.
 */
export default function Shell(props: ParentProps<{ clientEntry: string }>) {
  return (
    <html lang="en">
      <head>
        <title>🔥 Solid Rendering 🔥</title>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" href="/styles.css" />
        <HydrationScript />
      </head>
      <body>
        <div id="app">{props.children}</div>
      </body>
      <script type="module" src={props.clientEntry} async></script>
    </html>
  );
}
