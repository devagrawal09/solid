// Capability: lazyAssets — lazy asset maps. The server files a module map for
// every lazy() it rendered (`<id>_assets` per boundary, `_assets` per root);
// the client preloads those modules before claiming the boundary and lazy()
// resolves its component synchronously from the preloaded module. A client
// graph with no lazy() component omits it.
import { getOwner, peekNextChildId } from "@solidjs/signals";
import { sharedConfig, slots, markInstalled, CAP_LAZY_ASSETS } from "./state.js";
import { IS_DEV } from "../core.js";

// The server keys the module mapping by the hydration id of lazy()'s render
// memo; compute the same id positionally (peek — the memo consumes the slot).
// This keeps module identity fully server-side: glob/dynamically composed
// lazy modules hydrate without a moduleUrl.
function lazyHydrationLookup<T>(
  comp: (() => T | undefined) | undefined,
  moduleUrl?: string,
  exportName?: string
): (() => T) | undefined {
  const o = getOwner();
  const key = o && o.id != null ? peekNextChildId(o) : undefined;
  const cached = key != null ? (globalThis as any)._$HY?.modules?.[key] : undefined;
  // Hydration resolves the component synchronously from the preloaded module
  // — its default export, or the call-site `export` option (a literal present
  // in both bundles, so the sync claim is preserved). A wrapper that selects
  // an export at runtime inside the import thunk cannot work here: the thunk
  // hasn't run, and rendering the raw namespace's default would silently
  // orphan the server DOM (#3011). Fail loudly in dev instead — there is no
  // supported async fallback during hydration.
  if (cached) {
    const component = exportName ? cached[exportName] : cached.default;
    if (IS_DEV && typeof component !== "function")
      throw new Error(
        `lazy() (hydration id "${key}") preloaded a module whose "${exportName ?? "default"}" ` +
          "export is not a component. lazy() hydrates synchronously from the preloaded " +
          "module; select a named export with the { export } option, or re-export the " +
          "component as the module's default. Wrappers that pick an export at runtime " +
          "inside the import thunk are not supported."
      );
    return () => component as T;
  }
  if (!comp && moduleUrl) {
    // moduleUrl present means the bundler transform ran, so the server
    // must have registered this position. A miss is a broken preload — the
    // server never filed a client entry under this id, or filed it under a
    // different one. It is NOT a missing Loading boundary: root-level lazy()
    // preloads through the root module map (#3338 was misdiagnosed from the
    // previous wording of this message). The throw is unconditional; only the
    // diagnosis is dev-only — prose in a prod string is paid for by every
    // hydrating app (size gate, #2883).
    throw new Error(
      `lazy() module "${moduleUrl}" (hydration id "${key}") was not preloaded before hydration` +
        (IS_DEV
          ? ": the server serialized no client entry for it. Check the server log for " +
            '"Asset manifest returned no client assets for module" — the manifest passed to ' +
            "renderToStream/renderToString did not answer for this moduleUrl (a key that does not " +
            "match the client manifest, or a manifest built for different output). If the server " +
            "did register it, the server and client hydration id namespaces are misaligned."
          : ".")
    );
  }
  return comp as (() => T) | undefined;
}

function boundaryAssets(id: string): Promise<void> | undefined {
  if (!sharedConfig.has!(id + "_assets")) return;
  const mapping = sharedConfig.load!(id + "_assets");
  if (mapping && typeof mapping === "object") return sharedConfig.loadModuleAssets?.(mapping);
}

/**
 * Capability installer: lazy asset maps (boundary module preloads and lazy()'s
 * synchronous preloaded-module lookup). The DOM runtime pairs it with the root
 * module-map preload and the module loader.
 *
 * @internal
 */
export function installLazyAssetHydration(): void {
  slots.lazy = lazyHydrationLookup;
  slots.assets = boundaryAssets;
  markInstalled(CAP_LAZY_ASSETS);
}
