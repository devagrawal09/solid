// Draft helpers shared by the store adapters, the "hybrid" ssrSource policy,
// and container-trace materialization. Installs nothing.
import { forwardIteratorReturn } from "./serialized.js";

export function applyPatches(target: any, patches: any[]) {
  for (const patch of patches) {
    const path = patch[0];
    let current = target;
    for (let i = 0; i < path.length - 1; i++) current = current[path[i]];
    const key = path[path.length - 1];
    if (patch.length === 1) {
      Array.isArray(current) ? current.splice(key as number, 1) : delete current[key];
    } else if (patch.length === 3) {
      (current as any[]).splice(key as number, 0, patch[1]);
    } else {
      current[key] = patch[1];
    }
  }
}

export function createShadowDraft(realDraft: any) {
  const shadow = JSON.parse(JSON.stringify(realDraft));
  let useShadow = true;
  return {
    proxy: new Proxy(shadow, {
      get(_, prop) {
        return useShadow ? shadow[prop] : realDraft[prop];
      },
      set(_, prop, value) {
        if (useShadow) {
          shadow[prop] = value;
          return true;
        }
        return Reflect.set(realDraft, prop, value);
      },
      deleteProperty(_, prop) {
        if (useShadow) {
          delete shadow[prop];
          return true;
        }
        return Reflect.deleteProperty(realDraft, prop);
      },
      has(_, prop) {
        return prop in (useShadow ? shadow : realDraft);
      },
      ownKeys() {
        return Reflect.ownKeys(useShadow ? shadow : realDraft);
      },
      getOwnPropertyDescriptor(_, prop) {
        return Object.getOwnPropertyDescriptor(useShadow ? shadow : realDraft, prop);
      }
    }),
    activate() {
      useShadow = false;
    }
  };
}

export function wrapFirstYield(iterable: any, activate: () => void) {
  const srcIt = iterable[Symbol.asyncIterator]();
  let first = true;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          const p = srcIt.next();
          if (first) {
            first = false;
            return p.then((r: any) => {
              activate();
              return r.done ? r : { done: false, value: undefined };
            });
          }
          return p;
        },
        return(value?: any) {
          return forwardIteratorReturn(srcIt, value);
        }
      };
    }
  };
}
