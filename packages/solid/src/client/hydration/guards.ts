// Development assertions for violated client hydration manifests.
//
// A manifest-composed entry installs only the capabilities its manifest
// lists. In development builds, every OMITTED capability's slot is filled
// with a guard that runs where the real adapter would have run and throws
// when the page actually delivers what the capability exists to adopt — a
// serialized record, a fragment declaration, a module map, a declared
// ssrSource policy. The production build strips this module (every call site
// is behind IS_DEV): there, an omitted capability is simply absent and the
// compiler's claim is trusted.
import {
  getOwner,
  peekNextChildId,
  createErrorBoundary as coreErrorBoundary,
  createLoadingBoundary as coreLoadingBoundary
} from "@solidjs/signals";
import {
  sharedConfig,
  slots,
  installedCapabilities,
  CAP_SNAPSHOTS,
  CAP_ASYNC_RESULTS,
  CAP_SSR_CLIENT,
  CAP_SSR_HYBRID,
  CAP_STORES,
  CAP_ERROR_MARKERS,
  CAP_LOADING_MARKERS,
  CAP_STREAM_LEDGER,
  CAP_LAZY_ASSETS,
  type SsrSourcePolicy
} from "./state.js";
import { hydrateSignalLike, hydratedEffect } from "./dispatch.js";

/** Manifest capability names, as the manifest schema spells them. */
export type HydrationCapabilityName =
  | "streamLedger"
  | "loadingMarkers"
  | "errorMarkers"
  | "asyncResults"
  | "storeAdapters"
  | "lazyAssets"
  | "delegatedEvents"
  | "ssrSources"
  | "snapshots"
  | "resumableEvents";

/**
 * Report a manifest violation: the client hydration manifest omitted
 * `capability`, but the page delivered something only that capability can
 * hydrate. Always throws (development builds only reach it).
 *
 * @internal — shared with the DOM runtime's own manifest checks.
 */
export function hydrationManifestViolation(
  capability: HydrationCapabilityName,
  detail: string
): never {
  throw new Error(
    `[HYDRATION_MANIFEST] The client hydration manifest omits "${capability}", but ${detail}. ` +
      `The manifest must be produced from the complete client and server graphs; regenerate ` +
      `it (or include "${capability}") rather than hydrating with a runtime that cannot adopt ` +
      `what the server sent.`
  );
}

function assertNoRecord(capability: HydrationCapabilityName, id: string, what: string) {
  if (sharedConfig.has!(id))
    hydrationManifestViolation(
      capability,
      `the server serialized ${what} under hydration id "${id}"`
    );
}

function peekId(): string | undefined {
  const o = getOwner();
  return o && o.id != null ? peekNextChildId(o) : undefined;
}

function policyGuard(policy: "client" | "hybrid"): SsrSourcePolicy {
  const fail = (): never =>
    hydrationManifestViolation(
      "ssrSources",
      `a primitive declared ssrSource: "${policy}" while hydrating`
    );
  return { signal: fail, store: fail, effect: fail };
}

/**
 * Fill every slot whose capability was not installed with an asserting
 * guard. Called once per enableHydrationWith() in development builds.
 */
export function installManifestGuards(): void {
  const has = (bit: number) => (installedCapabilities & bit) !== 0;

  const needsSnapshots =
    CAP_ASYNC_RESULTS | CAP_SSR_CLIENT | CAP_SSR_HYBRID | CAP_STORES | CAP_LOADING_MARKERS;
  if (!has(CAP_SNAPSHOTS) && installedCapabilities & needsSnapshots)
    hydrationManifestViolation(
      "snapshots",
      "the manifest selects a capability whose values can change during a hydration pass " +
        "(asyncResults, storeAdapters, ssrSources or loadingMarkers)"
    );

  if (!has(CAP_ASYNC_RESULTS)) {
    slots.signal ||= hydrateSignalLike;
    slots.effect ||= hydratedEffect;
    slots.adopt = (coreFn, fn, options) => {
      const id = peekId();
      if (id != null) assertNoRecord("asyncResults", id, "an async result");
      return coreFn(fn, options);
    };
    slots.adoptEffect = (coreFn, compute, effectFn, options) => {
      const id = peekId();
      if (id != null) assertNoRecord("asyncResults", id, "an effect value");
      coreFn(compute, effectFn, options);
    };
  }
  if (!has(CAP_SSR_CLIENT)) {
    slots.signal ||= hydrateSignalLike;
    slots.effect ||= hydratedEffect;
    slots.client = policyGuard("client");
  }
  if (!has(CAP_SSR_HYBRID)) {
    slots.signal ||= hydrateSignalLike;
    slots.hybrid = policyGuard("hybrid");
  }
  if (!has(CAP_STORES)) {
    slots.store = (coreFn, fn, initialValue, options) => {
      const src = options?.ssrSource;
      if (src === "client" || src === "hybrid")
        hydrationManifestViolation(
          "storeAdapters",
          `a derived store declared ssrSource: "${src}" while hydrating`
        );
      const id = peekId();
      if (id != null) assertNoRecord("storeAdapters", id, "a derived store value");
      return coreFn(fn, initialValue, options);
    };
  }
  if (!has(CAP_ERROR_MARKERS)) {
    slots.error = (fn, fallback) => {
      const id = peekId();
      if (id != null && sharedConfig.has!(id) && sharedConfig.load!(id) !== undefined)
        hydrationManifestViolation(
          "errorMarkers",
          `the server serialized a boundary error under hydration id "${id}"`
        );
      return coreErrorBoundary(fn, fallback);
    };
  }
  if (!has(CAP_LOADING_MARKERS)) {
    slots.loading = (fn, fallback, options) => {
      const id = peekId();
      if (id != null) {
        assertNoRecord("loadingMarkers", id, "a loading-boundary marker");
        assertNoRecord("loadingMarkers", id + "_fr", "a streamed-fragment declaration");
        assertNoRecord("loadingMarkers", id + "_assets", "a boundary module map");
      }
      return coreLoadingBoundary(fn, fallback, options);
    };
  }
  if (!has(CAP_STREAM_LEDGER)) {
    slots.stream = (_o, id) =>
      hydrationManifestViolation(
        "streamLedger",
        `the server streamed a boundary fragment ("${id}_fr")`
      );
  }
  if (!has(CAP_LAZY_ASSETS)) {
    slots.assets = id => {
      assertNoRecord("lazyAssets", id + "_assets", "a boundary module map");
      return undefined;
    };
    slots.lazy = (comp, moduleUrl) => {
      if (!comp)
        hydrationManifestViolation(
          "lazyAssets",
          `lazy()${moduleUrl ? ` "${moduleUrl}"` : ""} rendered while hydrating`
        );
      return comp as any;
    };
  }
}
