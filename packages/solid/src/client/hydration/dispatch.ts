// The signal-family and effect dispatchers: route a hydrating primitive to the
// ssrSource policy it declares, else to serialized-result adoption, else to
// the plain core primitive. Installed by any capability that hydrates the
// signal family (asyncResults, ssrSources); a client graph with neither never
// retains them and its memos/signals/effects stay on the core path.
import { getOwner, peekNextChildId } from "@solidjs/signals";
import { sharedConfig, slots } from "./state.js";

// One signal-shaped hydration body for memo/signal/optimistic — the families
// only ever differed in which core primitive committed the result, so the
// core function is a parameter. createOptimistic reaches this through the
// signal slot precisely so the wrapper does not statically couple the
// optimistic engine to this body (which would drag it into CSR bundles).
export function hydrateSignalLike(coreFn: Function, fn: any, options?: any) {
  slots.snap?.markTop();

  const ssrSource = options?.ssrSource;

  if (ssrSource === "client") {
    if (slots.client) return slots.client.signal(coreFn as any, fn, options);
  } else if (ssrSource === "hybrid" && sharedConfig.has!(peekNextChildId(getOwner()!))) {
    // Hybrid takeover only when the server serialized a value for this node
    // (see ssr-sources.ts); otherwise hybrid behaves like the default policy.
    if (slots.hybrid) return slots.hybrid.signal(coreFn as any, fn, options);
  }

  // "server", "hybrid" without a record, or undefined — use the serialized
  // value from the server when this graph adopts serialized async results.
  return slots.adopt ? slots.adopt(coreFn as any, fn, options) : (coreFn as any)(fn, options);
}

export function hydratedEffect(coreFn: Function, compute: any, effectFn: any, options?: any) {
  if (options?.ssrSource === "client" && slots.client) {
    slots.client.effect!(coreFn as any, compute, effectFn, options);
    return;
  }
  // "server", "hybrid", or undefined — use serialized value from server
  slots.snap?.markTop();
  if (slots.adoptEffect) slots.adoptEffect(coreFn as any, compute, effectFn, options);
  else (coreFn as any)(compute, effectFn, options);
}
