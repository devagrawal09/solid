/**
 * Island activation stand-ins for the tier scenarios (scenarios/tiers.ts):
 * what the compiler would emit to activate each scenario's server-rendered
 * DOM at tier 0 (no reactive runtime; the t0 batch helper) and at tier 1
 * (the kernel's API). Hand-written — the one place the harness accepts that
 * (see tiers.spec.ts) — and instrumented exactly like the scenario sources:
 * `h.signal` for cells (tier 1), and the same `read` / `write` events logged
 * by hand around tier-0 cells, since a tier-0 cell is a plain slot.
 *
 * A tier-1 stand-in takes the runtime as a parameter, so the same code also
 * runs on the full core: the tier-2 control.
 */
import type { Probe } from "../harness/trace.js";

export interface Kernelish {
  createSignal: any;
  createMemo: any;
  createRenderEffect: any;
  createEffect: any;
  createRoot: any;
  onCleanup: any;
  untrack: any;
  flush(): void;
}
export interface T0 {
  cell<T>(v: T): { v: T };
  set<T>(c: { v: T }, v: T | ((p: T) => T)): T;
  get<T>(c: { v: T }): T;
  hole<T>(cells: { v: any }[], compute: () => T, apply: (v: T, p: T) => void, initial: T): void;
  flush(): void;
}
export interface Activated {
  dispose(): void;
}
export type Tier0 = (root: HTMLElement, h: Probe, t0: T0) => Activated;
export type Tier1 = (root: HTMLElement, h: Probe, rt: Kernelish) => Activated;

/** A tier-0 cell with the trace grammar of `h.signal`. */
function traced<T>(h: Probe, t0: T0, label: string, init: T) {
  const c = t0.cell(init);
  const read = () => (h.log("read", label, c.v), c.v);
  const write = (next: T | ((p: T) => T)) =>
    t0.set(c, (prev: T) => {
      const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      h.log("write", label, v);
      return v;
    });
  return { c, read, write };
}

// --- tier-toggle -------------------------------------------------------------------
// <div><div class="toggle open"><a>[-]</a></div><ul class="comment-children" …>
const toggleNodes = (root: HTMLElement) => {
  const toggle = root.firstChild!.firstChild as HTMLElement;
  const a = toggle.firstChild as HTMLElement;
  return { toggle, a, text: a.firstChild as Text, list: toggle.nextSibling as HTMLElement };
};
export const tierToggle: { tier0: Tier0; tier1: Tier1 } = {
  tier0(root, h, t0) {
    const { toggle, a, text, list } = toggleNodes(root);
    const open = traced(h, t0, "open", true);
    // Hole order = the compiled template's: the text insert, then the
    // attribute effect (class, then style).
    t0.hole(
      [open.c],
      () => (open.read() ? "[-]" : "[+] comments collapsed"),
      v => (text.data = v),
      "[-]"
    );
    t0.hole(
      [open.c],
      () => ({ c: open.read(), s: open.read() ? "block" : "none" }),
      (v, p) => {
        if (v.c !== p.c) toggle.classList.toggle("open", v.c);
        if (v.s !== p.s) list.style.setProperty("display", v.s);
      },
      { c: true, s: "block" }
    );
    a.addEventListener("click", () => open.write(o => !o));
    return { dispose() {} };
  },
  tier1(root, h, rt) {
    const { toggle, a, text, list } = toggleNodes(root);
    return rt.createRoot((dispose: () => void) => {
      const [open, setOpen] = h.signal("open", true);
      rt.createRenderEffect(
        () => (open() ? "[-]" : "[+] comments collapsed"),
        (v: string, p?: string) => void (p !== undefined && (text.data = v))
      );
      rt.createRenderEffect(
        () => ({ c: open(), s: open() ? "block" : "none" }),
        (v: { c: boolean; s: string }, p?: { c: boolean; s: string }) => {
          if (p === undefined) return;
          if (v.c !== p.c) toggle.classList.toggle("open", v.c);
          if (v.s !== p.s) list.style.setProperty("display", v.s);
        }
      );
      a.addEventListener("click", () => setOpen((o: boolean) => !o));
      return { dispose };
    });
  }
};

// --- tier-two-cells ----------------------------------------------------------------
// <p><span class="h1">10</span><span class="h2">1</span><span class="h3">11</span><button …>×4</p>
const twoCellNodes = (root: HTMLElement) => {
  const p = root.firstChild as HTMLElement;
  const [h1, h2, h3, ab, ba, same, peek] = Array.from(p.children) as HTMLElement[];
  const text = (el: HTMLElement) => el.firstChild as Text;
  return { t1: text(h1), t2: text(h2), t3: text(h3), ab, ba, same, peek };
};
export const tierTwoCells: { tier0: Tier0; tier1: Tier1 } = {
  tier0(root, h, t0) {
    const n = twoCellNodes(root);
    const a = traced(h, t0, "a", 1);
    const b = traced(h, t0, "b", 10);
    t0.hole(
      [b.c],
      () => b.read(),
      v => (n.t1.data = String(v)),
      10
    );
    t0.hole(
      [a.c],
      () => a.read(),
      v => (n.t2.data = String(v)),
      1
    );
    t0.hole(
      [a.c, b.c],
      () => a.read() + b.read(),
      v => (n.t3.data = String(v)),
      11
    );
    n.ab.addEventListener("click", () => {
      a.write(x => x + 1);
      b.write(x => x + 10);
    });
    n.ba.addEventListener("click", () => {
      b.write(x => x + 10);
      a.write(x => x + 1);
    });
    n.same.addEventListener("click", () => a.write(a.read()));
    n.peek.addEventListener("click", () => {
      a.write(x => x + 1);
      h.value("a in handler", a.read());
    });
    return { dispose() {} };
  },
  tier1(root, h, rt) {
    const n = twoCellNodes(root);
    return rt.createRoot((dispose: () => void) => {
      const [a, setA] = h.signal("a", 1);
      const [b, setB] = h.signal("b", 10);
      const hole = (compute: () => number, text: Text) =>
        rt.createRenderEffect(
          compute,
          (v: number, p?: number) => void (p !== undefined && (text.data = String(v)))
        );
      hole(b, n.t1);
      hole(a, n.t2);
      hole(() => a() + b(), n.t3);
      n.ab.addEventListener("click", () => {
        setA((x: number) => x + 1);
        setB((x: number) => x + 10);
      });
      n.ba.addEventListener("click", () => {
        setB((x: number) => x + 10);
        setA((x: number) => x + 1);
      });
      n.same.addEventListener("click", () => setA(a()));
      n.peek.addEventListener("click", () => {
        setA((x: number) => x + 1);
        h.value("a in handler", a());
      });
      return { dispose };
    });
  }
};

// --- tier-shared (tier 1 only: a memo, a branch, a cell shared by two islands) --------
// <div><p class="counter"><button class="inc"><button class="reset"></p><!---->
//      <p class="display"><span class="count">1</span><span class="doubled">2</span>[<b>big</b>]</p><!----></div>
export const tierShared: { tier1: Tier1 } = {
  tier1(root, h, rt) {
    const div = root.firstChild as HTMLElement;
    const counter = div.firstChild as HTMLElement;
    const display = counter.nextSibling!.nextSibling as HTMLElement;
    const countText = display.firstChild!.firstChild as Text;
    const doubledText = display.firstChild!.nextSibling!.firstChild as Text;
    const big = document.createElement("template");
    big.innerHTML = "<b>big</b>";
    return rt.createRoot((dispose: () => void) => {
      // App: the shared cell
      const [count, setCount] = h.signal("count", 1);
      // Counter island: handlers only
      (counter.firstChild as HTMLElement).addEventListener("click", () =>
        setCount((c: number) => c + 1)
      );
      (counter.lastChild as HTMLElement).addEventListener("click", () => setCount(0));
      // Display island: the memo, two holes, the branch — the compiled
      // structure of the view (Show = condition value, condition, value memos
      // and an insert effect)
      const doubled = rt.createMemo(() => {
        h.run("doubled");
        return count() * 2;
      });
      const text = (compute: () => number, node: Text) =>
        rt.createRenderEffect(
          compute,
          (v: number, p?: number) => void (p !== undefined && (node.data = String(v)))
        );
      text(() => count(), countText);
      text(doubled, doubledText);
      const conditionValue = rt.createMemo(() => doubled() > 4);
      const condition = rt.createMemo(conditionValue, {
        equals: (x: boolean, y: boolean) => !x === !y
      });
      const value = rt.createMemo(() => {
        if (!condition()) return undefined;
        h.run("big");
        h.cleanup("big");
        return big.content.firstChild!.cloneNode(true);
      });
      rt.createRenderEffect(value, (node?: Node, prev?: Node) => {
        if (prev) prev.parentNode?.removeChild(prev);
        if (node) display.appendChild(node);
      });
      return { dispose };
    });
  }
};

export const activations: Record<string, { tier0?: Tier0; tier1?: Tier1 }> = {
  "tier-toggle": tierToggle,
  "tier-two-cells": tierTwoCells,
  "tier-shared": tierShared
};
