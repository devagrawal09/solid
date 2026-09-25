# @solidjs/resumable (experimental, private)

The resumable-events prototype: strict `$(fn)` DOM event handlers that run on
the client from serialized captures without hydrating (or loading) the
component that created them. Design, semantics, measurements and verdict:
[`documentation/plans/resumable-events.md`](../../documentation/plans/resumable-events.md).

Not published. Everything here is behind the off-by-default `resumableEvents`
option of `@solidjs/compiler`.

## Pieces

| entry | runs | role |
| --- | --- | --- |
| `@solidjs/resumable/server` | server render | `srScope` / `srRoot` / `srEl` the SSR compile emits; `generateResumeBootstrap`; `checkData`; `configureResumable` |
| `@solidjs/resumable/bootstrap` | inline, before the body | delegation, prelude, snapshot, queue, load, verify, drain (built to `dist/bootstrap.iife.js`, no imports) |
| `@solidjs/resumable/runtime` | first interaction | scope reconstruction (`@solidjs/signals`), `invoke`, `registerBoundary`, `flush` |
| `@solidjs/resumable/build` | build | `buildResumable` driver (link facts from `"use server"` modules, SSR compile, esbuild chunks, route manifest), `buildBootstrap` |
| `@solidjs/resumable/rollup` | build | `solidResumable()` plugin: event modules and the runtime as their own chunks plus `solid-resume-manifest.json` |

## Use (prototype)

```js
import { buildResumable } from "@solidjs/resumable/build";
const build = await buildResumable({ root, entries: ["src/counter.tsx"], outDir: "dist/resume" });
// build.manifest, build.serverFiles, build.diagnostics (resumable | hydrated + reason)
```

```js
import { renderToString } from "@solidjs/web";
import { generateResumeBootstrap } from "@solidjs/resumable/server";
const page = generateResumeBootstrap({ manifest, nonce }) + renderToString(() => <App />);
```

The page needs the bootstrap before the body, the server's records after it
(the ordinary hydration serializer emits them), and the manifest URLs
reachable by dynamic `import()`.

## Scripts

```sh
pnpm --filter @solidjs/resumable test       # builds the bootstrap, runs the server (node) then client (jsdom) suites
pnpm --filter @solidjs/resumable typecheck  # tsc over the JS sources
pnpm --filter @solidjs/resumable measure    # sizes, latencies, baseline → measurements/results.json
```

## Credits

The resumability model (serialize reasons, registered factories, scope
reconstruction over existing DOM, readiness ordering) follows ideas from
[Marko](https://github.com/marko-js/marko) (MIT, Copyright 2024 eBay Inc. and
contributors), inspected as a read-only reference at `4bdd83c18f`. No Marko
code is included here; the document above lists what was adopted and what
was deliberately not.
