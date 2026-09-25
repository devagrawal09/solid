/**
 * `@solidjs/signals/sync` — the async-free reactive core (Track A, stage 2).
 *
 * Built from the same sources with `__ASYNC__ = false`: Promise and
 * AsyncIterable handling (`handleAsync`, flights, their cancellation),
 * pending status and its propagation (pending sources, settle walks, loading
 * windows), NotReadyError production, async transitions (transaction
 * adoption, completion accounting, queue stashing) and optimistic lanes fold
 * out of the retained modules. Errors, error boundaries, ownership,
 * disposal, stores, projections and effects are unchanged.
 *
 * Nobody imports this entry by hand. The capability linker
 * (`@solidjs/compiler/capabilities`) aliases `@solidjs/signals` to it for a
 * client or server graph only after proving the whole graph async-free:
 * every reactive compute is proven synchronous (compiler block proofs, or
 * the `solid-tsc --capabilities` typed summary), no module imports an async
 * capability below, every module has a summary or a trusted manifest, and
 * no dynamic import is left unclassified.
 *
 * The surface is the full entry's: every name exists, so library code that
 * references an async API on a path the graph never takes still links. The
 * async capabilities are stubs that throw `[ASYNC_CAPABILITY_EXCLUDED]` —
 * reaching one means the linker's proof was wrong. This list IS the runtime
 * half of the async capability manifest (packages/signals/capabilities.json
 * mirrors it for the linker; tests/sync-entry.test.ts keeps them equal).
 */
import type * as Full from "./index.js";

export * from "./index.js";

function excluded<F>(name: string): F {
  return (() => {
    throw new Error(
      __DEV__
        ? `[ASYNC_CAPABILITY_EXCLUDED] \`${name}\` is not part of the async-free runtime ` +
            `(@solidjs/signals/sync). The capability linker selected that runtime because it ` +
            `proved this application graph async-free; reaching \`${name}\` means a module ` +
            `summary or manifest was wrong. Build without the capability linker to restore ` +
            `the full runtime, and report the summary that claimed async-freedom.`
        : `[ASYNC_CAPABILITY_EXCLUDED] ${name}`
    );
  }) as F;
}

// Transactions and async verdicts.
export const action: typeof Full.action = excluded("action");
export const isPending: typeof Full.isPending = excluded("isPending");
export const latest: typeof Full.latest = excluded("latest");
export const resolve: typeof Full.resolve = excluded("resolve");
export const until: typeof Full.until = excluded("until");
export const refresh: typeof Full.refresh = excluded("refresh");
export const affects: typeof Full.affects = excluded("affects");
// Optimistic state lives on transaction lanes.
export const createOptimistic: typeof Full.createOptimistic = excluded("createOptimistic");
export const createOptimisticStore: typeof Full.createOptimisticStore =
  excluded("createOptimisticStore");
// Pending boundaries.
export const createLoadingBoundary: typeof Full.createLoadingBoundary =
  excluded("createLoadingBoundary");
export const createRevealOrder: typeof Full.createRevealOrder = excluded("createRevealOrder");
/** A dev diagnostic switch (report async outside a Loading boundary), not an
 * async capability: with no async in the graph there is nothing to report,
 * and renderers toggle it on every dev mount — so it is a no-op here. */
export const enforceLoadingBoundary: typeof Full.enforceLoadingBoundary = () => {};
// Block suspension (`yield* wait(...)`) and the block loading boundary.
export const wait: typeof Full.wait = excluded("wait");
export const loading: typeof Full.loading = excluded("loading");

/** The async capabilities this entry excludes (kept equal to the manifest). */
export const ASYNC_CAPABILITIES = [
  "action",
  "isPending",
  "latest",
  "resolve",
  "until",
  "refresh",
  "affects",
  "createOptimistic",
  "createOptimisticStore",
  "createLoadingBoundary",
  "createRevealOrder",
  "wait",
  "loading"
] as const;
