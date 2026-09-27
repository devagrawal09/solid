// Tier 0: the activation a compiler would emit for the Toggle island when
// its graph qualifies for no reactive runtime (documentation/plans/
// island-runtime-tiers.md; the classification is analyze.mjs's):
// - one cell, `open`, written only by the island's own handler;
// - three holes, each reading `open` unconditionally;
// - no memo, effect, cleanup, async or shared state.
// So `open` is a slot and each hole a (compute, apply) pair on it, seeded
// with the server-rendered value: activation reads, computes and writes
// nothing, and a click stages the write and updates the three holes on the
// microtask flush, in render-effect order (see t0.ts for the contract).
import { cell, hole, set } from "../../../../../packages/signals/src/kernel/t0";

export function activate(root: HTMLElement) {
  const a = root.firstChild as HTMLElement;
  const text = a.firstChild as Text;
  const list = root.nextSibling as HTMLElement;
  const open = cell(true);
  hole(
    [open],
    () => open.v,
    v => root.classList.toggle("open", v),
    true
  );
  hole(
    [open],
    () => (open.v ? "[-]" : "[+] comments collapsed"),
    v => (text.data = v),
    "[-]"
  );
  hole(
    [open],
    () => (open.v ? "block" : "none"),
    v => list.style.setProperty("display", v),
    "block"
  );
  a.addEventListener("click", () => set(open, o => !o));
}
