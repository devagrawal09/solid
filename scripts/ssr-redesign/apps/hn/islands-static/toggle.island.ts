// P1-static: the activation module a compiler would emit for the Toggle
// island (hand-written stand-in; the derivation is in analyze.mjs and the
// design doc). Compared with hydration it:
// - claims nothing: nodes are reached by static paths from the anchor
//   (`div.toggle` → `a` is its first child, the list is its next sibling);
// - re-runs no component: the setup's only creation is `createSignal(true)`,
//   rebuilt from its constant initializer (nothing serialized);
// - binds the three view reads of `open` as render effects whose first run
//   writes nothing (the server DOM already shows the initial value);
// - attaches the one handler, which writes only `open`.
// The reply list is a pass-through slot and is never touched.
import { createRenderEffect, createRoot, createSignal } from "@solidjs/signals";

export function activate(root: HTMLElement) {
  const a = root.firstChild as HTMLElement;
  const text = a.firstChild as Text;
  const list = root.nextSibling as HTMLElement;
  createRoot(() => {
    const [open, setOpen] = createSignal(true);
    createRenderEffect(open, (v: boolean, p?: boolean) => {
      if (p !== undefined) root.classList.toggle("open", v);
    });
    createRenderEffect(
      () => (open() ? "[-]" : "[+] comments collapsed"),
      (v: string, p?: string) => {
        if (p !== undefined) text.data = v;
      }
    );
    createRenderEffect(
      () => (open() ? "block" : "none"),
      (v: string, p?: string) => {
        if (p !== undefined) list.style.setProperty("display", v);
      }
    );
    a.addEventListener("click", () => setOpen(o => !o));
  });
}
