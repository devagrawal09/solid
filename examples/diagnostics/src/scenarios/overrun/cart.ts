/**
 * Scenario 2, file A — cart state and its summary.
 *
 * `summarizeCart` is the kind of helper that gets written once and reused
 * everywhere: it takes the cart record and returns a summary object. Both
 * halves of the defect are invisible here:
 *
 * - it *reads* `cart.note`, so it re-runs on every keystroke in a field that
 *   cannot change a count or a total;
 * - it *returns a fresh object*, so the memo's equality gate never closes and
 *   every subscriber re-runs even when nothing it cares about moved.
 *
 * The cost only exists once something subscribes — see `CheckoutSummary.tsx`.
 */
import { createMemo, createStore } from "solid-js";
import type { Accessor } from "solid-js";
import { nodeName } from "../../diagnostics/channel";

export interface Line {
  sku: string;
  label: string;
  qty: number;
  price: number;
}

export interface Cart {
  lines: Line[];
  /** Gift note: free text the buyer types. Cannot change count or total. */
  note: string;
}

/** What the checkout line needs: quantities and money. */
export interface Summary {
  count: number;
  total: number;
}

export const INITIAL_LINES: Line[] = [
  { sku: "BR-100", label: "Brake caliper", qty: 1, price: 128 },
  { sku: "CL-140", label: "Coolant hose", qty: 2, price: 24 },
  { sku: "FL-020", label: "Fuel line", qty: 1, price: 41 }
];

/**
 * BROKEN — one helper for everything the checkout header shows, taking the
 * whole record. It reads `cart.note` for the gift flag, so it re-runs on every
 * keystroke, and it hands back a fresh object each time: the count and total
 * ride along on the note's invalidation.
 */
export function summarizeCart(cart: Cart): Summary & { gift: boolean } {
  let count = 0;
  let total = 0;
  for (const line of cart.lines) {
    count += line.qty;
    total += line.qty * line.price;
  }
  return { count, total, gift: cart.note.trim().length > 0 };
}

/** FIXED — depends on exactly the state the summary is a function of. */
export function summarizeLines(lines: readonly Line[]): Summary {
  let count = 0;
  let total = 0;
  for (const line of lines) {
    count += line.qty;
    total += line.qty * line.price;
  }
  return { count, total };
}

export interface CartModel {
  cart: Cart;
  setNote: (next: string) => void;
  addLine: () => void;
  summary: Accessor<Summary>;
  /** Same feature in both modes — only the dependency it costs differs. */
  gift: Accessor<boolean>;
}

function createCartStore() {
  const [cart, setCart] = createStore<Cart>(
    { lines: INITIAL_LINES.map(line => ({ ...line })), note: "" },
    { name: nodeName("overrun", "cart") }
  );
  let next = 0;
  const spares = [
    { sku: "BT-310", label: "Battery tray", price: 76 },
    { sku: "CL-090", label: "Clutch plate", price: 210 }
  ];
  return {
    cart,
    setNote: (value: string) =>
      setCart(state => {
        state.note = value;
      }),
    addLine: () =>
      setCart(state => {
        const spare = spares[next++ % spares.length];
        state.lines.push({ ...spare, qty: 1 });
      })
  };
}

/** BROKEN — one memo over the whole cart: re-runs per keystroke, new object each time. */
export function createWideSummaryCart(): CartModel {
  const store = createCartStore();
  const summary = createMemo(() => summarizeCart(store.cart), {
    name: nodeName("overrun", "summary")
  });
  return { ...store, summary, gift: () => summary().gift };
}

/**
 * FIXED — two memos instead of one, split by what they depend on: the summary
 * over the lines, the gift flag over the note. The feature survives the repair;
 * what disappears is the note's reach into the checkout total.
 */
export function createNarrowSummaryCart(): CartModel {
  const store = createCartStore();
  const summary = createMemo(() => summarizeLines(store.cart.lines), {
    name: nodeName("overrun", "summary")
  });
  const gift = createMemo(() => store.cart.note.trim().length > 0, {
    name: nodeName("overrun", "gift")
  });
  return { ...store, summary, gift };
}
