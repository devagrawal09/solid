# @solidjs/linker (experimental, private)

The bundler/linker phase of Solid's strict multi-module pipeline (Track C), and its first consumer: cold event-domain extraction (optimization slice 3). Design, schemas and measurements: [`documentation/plans/strict-linker-summaries.md`](../../documentation/plans/strict-linker-summaries.md).

## Use

```bash
# 1. Typed module summaries (solid-tsc joins the compiler's behavioral summaries with checker facts)
solid-tsc -p tsconfig.json --noEmit --solidSummaries .solid/summaries
```

```js
// 2. Build (Vite or Rollup). Place before the Solid plugin: it rewrites authored source.
import { solidColdEvents } from "@solidjs/linker/rollup";
import solid from "@solidjs/vite-plugin";

export default {
  plugins: [solidColdEvents({ typedSummaries: ".solid/summaries", prefetch: "idle" }), solid()]
};
```

Options: `typedSummaries` (directory; required in `strict` mode, default `true`), `prefetch` (`"idle"` default — first idle period after a shell exists, plus first user intent; `"intent"`, `"load"`, `"none"`), `maxDomainBytes` (48 KiB), `environment` (`"client"`; `"server"` analyzes without extracting), `manifest` (asset name, default `solid-link-manifest.json`), `runtimeModule`.

Programmatic analysis of any environment graph:

```js
import { link, buildManifest } from "@solidjs/linker";
const analysis = await link({
  root,
  entries: [serverEntry],
  environment: "server",
  typedSummaries
});
console.log(buildManifest(analysis));
```

Libraries participate by shipping `solid-summary.json` (`summarizePackage(dir)`) and `"solidSummary": "solid-summary.json"` in `package.json`; without it (or with a stale one) their modules are `unknown` and retained, and any handler that captures one of their imports stays inline.

## What it does

- Proves `$` event blocks event-only across modules (DOM sinks, prop forwarding with the typed `EventBlock` brand, exported handlers) and classifies modules/bindings `hot | cold | shared | unknown` to a fixed point, independently per environment.
- Replaces each proven block with a hot shell (same owner/boundary), moves its body and cold-only dependencies into one chunk per interaction domain, replays `preventDefault()`/`stopPropagation()`/guard preludes synchronously, and prefetches domains.
- Keeps everything it cannot prove hot, with the reason in the manifest.

Runtime (`@solidjs/linker/runtime`): `coldEvent`, `coldDomain`, `prefetchColdDomains(ids?)`, `coldStats()`.

## Tests and benchmarks

```bash
pnpm --filter @solidjs/linker test      # fixtures, jsdom equivalence, source maps
pnpm --filter @solidjs/linker bench     # generated 500 KB / 2 MB / 10 MB apps
node bench/todomvc.mjs                  # examples/todos-blocks through Vite
```
