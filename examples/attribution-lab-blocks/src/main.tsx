import { render } from "@solidjs/web";
import { OBSERVABLE, arm } from "./lab/engine";
import { CLAMP_WATCH } from "./scenarios/clamp/Pager";
import { App } from "./app";

const root = document.getElementById("root")!;

if (!OBSERVABLE) {
  // Production tier: `OBSERVE` is undefined, the diagnostics channel does not
  // exist, and `solid-js/attribution` resolved to the inert engine. Say so
  // rather than rendering panels that can never fill.
  root.innerHTML =
    '<p class="prod-banner">This build has no observability tier. ' +
    "Run <code>pnpm --filter attribution-lab-example dev</code> " +
    "(or <code>vitest</code>) — both resolve Solid's development build.</p>";
} else {
  // Arm before the first render so the opening card's creation runs are
  // attributed too; every later switch re-arms from `App`'s `select()`.
  arm({ watch: CLAMP_WATCH });
  render(() => <App />, root);
}
