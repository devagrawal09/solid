/**
 * Fixture graphs for the capability-selected hydration runtime (optimization
 * slice 7). Like scenarios.tsx, the app modules are compiled by BOTH vitest
 * projects: test/server/capability-harness.spec.tsx renders each graph with
 * the ssr generate and writes artifacts; test/hydration/capability-matrix.spec.tsx
 * hydrates the dom-generate compilation of the same source with the universal
 * hydrate() and with the entry composed from each fixture manifest.
 *
 * Each graph lives in its own module (./capability-apps/) and is loaded on
 * demand, so a client registers exactly that graph's delegated event types —
 * the same property a real client graph has. Each graph has one positive
 * fixture manifest (test/hydration-capabilities/manifests/<name>.json); the
 * matrix also hydrates graphs with intentionally under-approximated
 * manifests and expects the development assertions to fire.
 */
// The server asset manifest answering lazy()'s moduleUrl (see
// capability-apps/shared.tsx). Kept here, not imported, so reading the
// matrix metadata never evaluates a runtime instance.
const lazyManifest = { "./lazy-page.tsx": { file: "assets/lazy-page.js" } };

export type CapabilityApp = {
  name: string;
  load: () => Promise<() => any>;
  /** How the server artifact is applied: all chunks before hydrate(), or shell then live chunks. */
  mode: "loaded" | "streamed";
  /** textContent once hydration settles. */
  expectedText: string;
  /** Click #inc before hydrate() (captured by the bootstrap, replayed after claim). */
  preHydrationClick?: boolean;
  /** textContent after the pre-hydration click has replayed. */
  expectedTextAfterReplay?: string;
  /** textContent after one live click on #inc post-hydration. */
  expectedTextAfterClick: string;
  /** renderToStream options (asset manifest for lazy()). */
  serverOptions?: Record<string, unknown>;
};

export const capabilityApps: CapabilityApp[] = [
  {
    name: "read-only",
    load: () => import("./capability-apps/read-only.jsx").then(m => m.default),
    mode: "loaded",
    expectedText: "catalogitems 3manyalphabetagamma",
    expectedTextAfterClick: "catalogitems 3manyalphabetagamma"
  },
  {
    name: "event-only",
    load: () => import("./capability-apps/event-only.jsx").then(m => m.default),
    mode: "loaded",
    expectedText: "pressidle",
    preHydrationClick: true,
    expectedTextAfterReplay: "pressclicked 1",
    expectedTextAfterClick: "pressclicked 2"
  },
  {
    name: "sync",
    load: () => import("./capability-apps/sync.jsx").then(m => m.default),
    mode: "loaded",
    expectedText: "inccount 1 double 2oddab",
    preHydrationClick: true,
    expectedTextAfterReplay: "inccount 2 double 4evenab",
    expectedTextAfterClick: "inccount 3 double 6oddab"
  },
  {
    name: "store",
    load: () => import("./capability-apps/store.jsx").then(m => m.default),
    mode: "loaded",
    expectedText: "addopen 1onetworemote",
    expectedTextAfterClick: "addopen 2onetwonewremote"
  },
  {
    name: "async",
    load: () => import("./capability-apps/async.jsx").then(m => m.default),
    mode: "loaded",
    expectedText: "inctotal 41caught boom",
    expectedTextAfterClick: "inctotal 42caught boom"
  },
  {
    name: "streaming",
    load: () => import("./capability-apps/streaming.jsx").then(m => m.default),
    mode: "streamed",
    expectedText: "inc 1value streamed n 1",
    expectedTextAfterClick: "inc 2value streamed n 2"
  },
  {
    name: "lazy",
    load: () => import("./capability-apps/lazy.jsx").then(m => m.default),
    mode: "loaded",
    expectedText: "inc 1lazy page",
    expectedTextAfterClick: "inc 2lazy page",
    serverOptions: { manifest: lazyManifest }
  },
  {
    name: "full",
    load: () => import("./capability-apps/full.jsx").then(m => m.default),
    mode: "streamed",
    expectedText:
      "inccount 1 text  total 40 client hybridremotecaught boomvalue streamed n 1lazy page",
    preHydrationClick: true,
    expectedTextAfterReplay:
      "inccount 2 text  total 40 client hybridremotecaught boomvalue streamed n 2lazy page",
    expectedTextAfterClick:
      "inccount 3 text  total 40 client hybridremotecaught boomvalue streamed n 3lazy page",
    serverOptions: { manifest: lazyManifest }
  }
];
