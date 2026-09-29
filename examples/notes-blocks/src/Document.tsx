import { HydrationScript } from "@solidjs/web";
import { $component, type Element, type TypedProps } from "@solidjs/blocks";

// The document shell `start` renders the app into (a block like the rest).
const Document = $component(function* Document(
  props: TypedProps<{ children?: Element }, "Document">
) {
  return function* () {
    return (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <meta name="description" content="Solid Notes — a server components demo" />
          <title>Solid Notes</title>
          <link rel="icon" href="/favicon.ico" />
          <HydrationScript />
        </head>
        <body>{yield* props.children}</body>
      </html>
    );
  };
});

export default Document;
