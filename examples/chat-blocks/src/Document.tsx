// v2 twin note: kept a plain component. As a `$component` the document shell
// adds a hydration-key level (its view renders under its own scope), the
// server ids no longer match what the client hydration root expects, and the
// welcome reply never renders on the client. See the README.
import { HydrationScript, type JSX } from "@solidjs/web";

export default function Document(props: { children?: JSX.Element }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content="Solid Chat — a server components streaming demo" />
        <title>Solid Chat</title>
        <link rel="icon" href="/favicon.ico" />
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
