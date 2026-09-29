// Action path: a cancellable checkout saga — examples/effect's checkout with
// @solidjs/blocks.
//
// `placeOrder` is unchanged: a Solid action whose steps are Effect programs
// (its `yield*` delegates Effects to the saga driver; it is not a block).
// The optimistic phase and the optimistic orders store are Solid primitives
// created in the setup and read through `read` / `paths`; the cart, the
// notice and the decline toggle are block state.
import {
  $,
  $component,
  $event,
  $memo,
  $signal,
  $store,
  For,
  Loading,
  paths,
  read,
  readStore,
  Show,
  type Source,
  type TypedProps
} from "@solidjs/blocks";
import { createOptimistic, createOptimisticStore, refresh } from "solid-js";
import {
  CardDeclinedError,
  chargeCard,
  createOrder,
  fetchOrders,
  refundCharge,
  releaseReservation,
  reserveInventory,
  type CartItem,
  type Charge,
  type Order,
  type Reservation
} from "./api";
import { ActionInterruptedError, effectAction } from "./solid-effect";

type Phase = "idle" | "reserving" | "charging" | "finalizing";

interface Notice {
  kind: "success" | "error" | "info";
  text: string;
}

const STEPS: { phase: Phase; label: string }[] = [
  { phase: "reserving", label: "Reserve inventory" },
  { phase: "charging", label: "Charge card" },
  { phase: "finalizing", label: "Create order" }
];

const INITIAL_CART: CartItem[] = [
  { id: "sku_signal", name: "Signal (fine-grained)", price: 19.99, quantity: 1 },
  { id: "sku_fiber", name: "Fiber (interruptible)", price: 24.5, quantity: 2 },
  { id: "sku_boundary", name: "Boundary (loading)", price: 9.75, quantity: 1 }
];

/**
 * The orders list. In the original it sits inside the checkout's
 * `<Loading>`; a view that reads a pending source is pending itself, so the
 * list is its own component and the boundary receives it.
 */
const Orders = $component(function* (
  props: TypedProps<{ orders: Source<Order[], true, never> }, "Orders">
) {
  return function* () {
    return (
      <Show when={(yield* props.orders.length) > 0} fallback={<p class="empty">No orders yet.</p>}>
        <ul class="orders">
          <For each={yield* props.orders}>
            {function* (order) {
              return function* () {
                return (
                  <li>
                    <span class="pkg-name">{yield* order.id}</span>
                    <span class="pkg-desc">
                      {yield* order.items.length} line
                      {(yield* order.items.length) === 1 ? "" : "s"} · placed{" "}
                      {yield* order.placedAt}
                    </span>
                    <span class="cart-price">${(yield* order.total).toFixed(2)}</span>
                  </li>
                );
              };
            }}
          </For>
        </ul>
      </Show>
    );
  };
});

export const Checkout = $component(function* () {
  const [cart, setCart] = yield* $store<CartItem[]>(INITIAL_CART.map(i => ({ ...i })));
  // The optimistic orders store fetches asynchronously: read through
  // `paths`, stated pending (the fetch is not expected to fail here).
  const [ordersStore] = createOptimisticStore<Order[]>(async () => fetchOrders(), []);
  const orders = paths<Order[], true>(ordersStore);

  // Transition-scoped: writes inside the action revert automatically when it
  // settles — success, failure, or cancellation.
  const [phaseAccessor, setPhase] = createOptimistic<Phase>("idle");
  const phase = read(phaseAccessor);
  // Plain signal: survives the optimistic revert, carries the outcome.
  const [notice, setNotice] = yield* $signal<Notice | null>(null);
  const [declineCard, setDeclineCard] = yield* $signal(false);

  const total = yield* $memo(function* () {
    return yield* readStore(cart, c =>
      c.reduce((sum, item) => sum + item.price * item.quantity, 0)
    );
  });

  const placeOrder = effectAction(function* (items: CartItem[], decline: boolean) {
    let reservation: Reservation | undefined;
    let charge: Charge | undefined;
    setNotice(null);
    try {
      setPhase("reserving");
      reservation = yield* reserveInventory(items);
      setPhase("charging");
      charge = yield* chargeCard(
        items.reduce((sum, item) => sum + item.price * item.quantity, 0),
        decline
      );
      setPhase("finalizing");
      const order = yield* createOrder(items, reservation, charge);
      setNotice({
        kind: "success",
        text: `Order ${order.id} confirmed — $${order.total.toFixed(2)}`
      });
      refresh(ordersStore);
      return order;
    } catch (e) {
      // Saga compensation, in reverse order of what committed. Mid-step
      // cleanup (voiding a half-done authorization) already ran via the
      // interrupted step's own finalizers.
      if (charge) yield* refundCharge(charge);
      if (reservation) yield* releaseReservation(reservation);
      if (e instanceof CardDeclinedError) {
        setNotice({
          kind: "error",
          text: `Card declined for $${e.amount.toFixed(2)} — refunds/releases applied, cart untouched`
        });
      } else if (e instanceof ActionInterruptedError) {
        setNotice({ kind: "info", text: "Checkout cancelled — compensations ran, cart untouched" });
      }
      throw e; // reject the action → optimistic phase reverts to "idle"
    }
  });

  const inFlight = $(function* () {
    return (yield* phase) !== "idle";
  });
  const place = $event(function* () {
    const items = yield* readStore(cart, c => c.map(item => ({ ...item })));
    placeOrder(items, yield* declineCard).catch(() => {});
  });
  const cancel = $event(function* () {
    placeOrder.interrupt();
  });
  const toggleDecline = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    setDeclineCard(e.currentTarget.checked);
  });

  return function* () {
    return (
      <section class="panel">
        <header>
          <h2>Checkout saga</h2>
          <p>
            Three Effect steps inside one Solid action transaction. Cancel mid-charge (it takes
            ~2.6s) or toggle the decline: the fiber is interrupted, compensations run server-side,
            and the optimistic UI reverts — automatically on both sides.
          </p>
        </header>

        <div class="cart">
          <For each={yield* cart}>
            {function* (item, i) {
              const decrement = $event(function* () {
                const index = yield* i;
                setCart(c => {
                  c[index].quantity--;
                });
              });
              const increment = $event(function* () {
                const index = yield* i;
                setCart(c => {
                  c[index].quantity++;
                });
              });
              return function* () {
                return (
                  <div class="cart-row">
                    <span class="cart-name">{yield* item.name}</span>
                    <span class="qty">
                      <button
                        disabled={(yield* inFlight) || (yield* item.quantity) <= 1}
                        onClick={decrement}
                      >
                        −
                      </button>
                      {yield* item.quantity}
                      <button disabled={yield* inFlight} onClick={increment}>
                        +
                      </button>
                    </span>
                    <span class="cart-price">
                      ${((yield* item.price) * (yield* item.quantity)).toFixed(2)}
                    </span>
                  </div>
                );
              };
            }}
          </For>
          <div class="cart-row total">
            <span class="cart-name">Total</span>
            <span class="cart-price">${(yield* total).toFixed(2)}</span>
          </div>
        </div>

        <div class="checkout-controls">
          <label class="decline-toggle">
            <input type="checkbox" checked={yield* declineCard} onInput={toggleDecline} />
            Simulate card decline (typed <code>CardDeclinedError</code>)
          </label>
          <Show
            when={yield* inFlight}
            fallback={
              <button class="primary" onClick={place}>
                Place order — ${(yield* total).toFixed(2)}
              </button>
            }
          >
            <button class="danger" onClick={cancel}>
              Cancel checkout
            </button>
          </Show>
        </div>

        <ol class="steps">
          <For each={STEPS}>
            {function* (step) {
              const state = $(function* () {
                const order: Phase[] = ["reserving", "charging", "finalizing"];
                const current = order.indexOf(yield* phase);
                const target = order.indexOf(yield* step.phase);
                if (current === -1) return "";
                return target < current ? "done" : target === current ? "active" : "";
              });
              return function* () {
                return (
                  <li
                    class={{
                      done: (yield* state) === "done",
                      active: (yield* state) === "active"
                    }}
                  >
                    {yield* step.label}
                  </li>
                );
              };
            }}
          </For>
        </ol>

        <Show when={yield* notice}>
          {function* (n) {
            return function* () {
              return <p class={`notice ${yield* n.kind}`}>{yield* n.text}</p>;
            };
          }}
        </Show>

        <h3>Your orders</h3>
        <Loading fallback={<p class="loading">Loading orders…</p>}>{Orders({ orders })}</Loading>
      </section>
    );
  };
});
