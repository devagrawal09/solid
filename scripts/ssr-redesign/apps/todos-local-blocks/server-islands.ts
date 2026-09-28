// todos-local (v2 blocks), server for compiled islands: `app.tsx` compiled by
// `compileIslands` — `App` is its string-template function. The island's
// cells need no serialization: both initializers are client-evaluable
// (`localStorage`, `location.hash`), re-evaluated on activation exactly as
// hydration re-evaluates them.
import { App } from "./app";

export function render(seed: unknown[]): Promise<string> {
  const json = JSON.stringify(seed);
  (globalThis as any).localStorage = { getItem: () => json, setItem() {} };
  (globalThis as any).location = { hash: "" };
  return Promise.resolve((App as any)());
}
export const hydrationScript = () => "";
