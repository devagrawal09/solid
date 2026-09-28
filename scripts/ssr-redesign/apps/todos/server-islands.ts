// Server entry for examples/todos-blocks compiled to islands: `app.tsx` is
// compiled by `compileIslands` with its imported factories inlined
// (`createTodos` from ./todos, `createHashFilter` from ./filter), so `App` is
// its string-template function. The optimistic store's settled value is
// serialized on the island's anchor (the client adopts it, P2).
import { App } from "../../../../examples/todos-blocks/src/app";

export function render(seed: unknown[]): Promise<string> {
  const json = JSON.stringify(seed);
  (globalThis as any).localStorage = { getItem: () => json, setItem() {} };
  (globalThis as any).location = { hash: "" };
  return Promise.resolve((App as any)());
}
export const hydrationScript = () => "";
