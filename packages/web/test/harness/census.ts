/**
 * Hydration census for the Track D specs: counts the reactive nodes a
 * hydration pass creates, through the dev build's `DEV.hooks.onOwner` (fired
 * for every owner and computation), and the dependency links they hold once
 * the pass settles. Dev builds only — in a prod build `DEV` is undefined and
 * the census reports `available: false`.
 */
import { DEV } from "solid-js";

export type Census = {
  available: boolean;
  owners: number;
  computations: number;
  effects: number;
  links: number;
};

export function startCensus(): () => Census {
  const hooks = (DEV as any)?.hooks;
  if (!hooks) {
    return () => ({ available: false, owners: 0, computations: 0, effects: 0, links: 0 });
  }
  const created: any[] = [];
  const prev = hooks.onOwner;
  hooks.onOwner = (owner: any) => {
    created.push(owner);
    prev?.(owner);
  };
  return () => {
    hooks.onOwner = prev;
    let computations = 0;
    let effects = 0;
    let links = 0;
    for (const node of created) {
      if (node._fn === undefined) continue;
      computations++;
      if (node._effectFn !== undefined) effects++;
      for (let link = node._deps; link; link = link._nextDep) links++;
    }
    return { available: true, owners: created.length - computations, computations, effects, links };
  };
}
