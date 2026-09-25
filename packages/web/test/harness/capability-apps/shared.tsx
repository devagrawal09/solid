/**
 * @jsxImportSource @solidjs/web
 *
 * Shared pieces of the capability-selected hydration matrix (see
 * ../capability-apps.ts). Each graph is its own module so the delegated
 * event types a client registers are exactly that graph's.
 */
import { createMemo, lazy } from "solid-js";

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const LazyPage = lazy(() => import("./lazy-page.jsx"), undefined, "./lazy-page.tsx");

export function Thrower(): any {
  throw new Error("boom");
}

// Streamed content that stays live after hydration: `n` follows the page's
// counter, so a streamed region the client failed to claim (inert server
// markup) is visible as a stale `n` after the live click.
export function Slow(props: { n: number }) {
  const value = createMemo(async () => {
    await sleep(15);
    return "streamed";
  });
  return (
    <p>
      value {value()} n {props.n}
    </p>
  );
}
