// Action path: a cancellable checkout saga — examples/effect's checkout,
// written with generator blocks v2.
//
// `placeOrder` stays an `effectAction` saga: its generator yields Effect
// programs to the integration's driver (a Solid `action`), which is a
// different dialect from a block — `yield*` there means "run this Effect as a
// transaction step", and failures are thrown back into it at the `yield*`.
//
// The optimistic state has no block constructor (`$store` / `$signal` are the
// plain forms), so `orders` (`createOptimisticStore`) and `phase`
// (`createOptimistic`) are created with the plain primitives in the setup.
import {
  $component,
  $event,
  $memo,
  $signal,
  $store,
  createOptimistic,
  createOptimisticStore,
  For,
  Loading,
  readStore,
  refresh,
  Show,
  type TypedProps
} from "solid-js";
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

const ORDER: Phase[] = ["reserving", "charging", "finalizing"];

/**
 * One cart row. The original writes it inline in `<For each={cart}>{(item, i)
 * => …}</For>`, with handlers `() => setCart(c => { c[i()].quantity-- })`; a
 * render callback cannot hold `$event`s or `yield*`, so the row is a
 * component (a render-callback block would keep it inline). The index is
 * passed as `i()`: `For`'s index accessor is typed `Accessor<number>`, not a
 * `SourceAccessor`, so it cannot be forwarded as a prop read.
 */
const CartRow = $component(function* (
  props: TypedProps<{
    item: CartItem;
    index: number;
    inFlight: boolean;
    change: (index: number, delta: number) => void;
  }>
) {
  const dec = $event(function* () {
    const change = yield* props.change;
    change(yield* props.index, -1);
  });
  const inc = $event(function* () {
    const change = yield* props.change;
    change(yield* props.index, 1);
  });
  return function* () {
    return (
      <div class="cart-row">
        <span class="cart-name">{yield* props.item.name}</span>
        <span class="qty">
          <button
            disabled={(yield* props.inFlight) || (yield* props.item.quantity) <= 1}
            onClick={dec}
          >
            −
          </button>
          {yield* props.item.quantity}
          <button disabled={yield* props.inFlight} onClick={inc}>
            +
          </button>
        </span>
        <span class="cart-price">
          ${((yield* props.item.price) * (yield* props.item.quantity)).toFixed(2)}
        </span>
      </div>
    );
  };
});

/** One saga step: the original's `stepState(step.phase)` in a render callback. */
const StepItem = $component(function* (
  props: TypedProps<{ step: { phase: Phase; label: string }; current: number }>
) {
  const state = yield* $memo(function* () {
    const current = yield* props.current;
    if (current === -1) return "";
    const target = ORDER.indexOf(yield* props.step.phase);
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
        {yield* props.step.label}
      </li>
    );
  };
});

export const Checkout = $component(function* () {
  const [cart, setCart] = yield* $store<CartItem[]>(INITIAL_CART.map(i => ({ ...i })));
  const [orders] = createOptimisticStore<Order[]>(async () => fetchOrders(), []);

  // Transition-scoped: writes inside the action revert automatically when it
  // settles — success, failure, or cancellation.
  const [phase, setPhase] = createOptimistic<Phase>("idle");
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
      refresh(orders);
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

  const inFlight = yield* $memo(function* () {
    return (yield* phase) !== "idle";
  });
  const current = yield* $memo(function* () {
    return ORDER.indexOf(yield* phase);
  });

  const change = (index: number, delta: number) => {
    setCart(c => {
      c[index].quantity += delta;
    });
  };
  const toggleDecline = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    yield* setDeclineCard(e.currentTarget.checked);
  });
  const place = $event(function* () {
    const items = yield* readStore(cart, c => c.map(item => ({ ...item })));
    const decline = yield* declineCard;
    // Fire and forget, as the original: the saga reports through `notice`.
    placeOrder(items, decline).catch(() => {});
  });
  const cancel = $event(function* () {
    placeOrder.interrupt();
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
          <For each={yield* readStore(cart, c => c)}>
            {(item, i) => <CartRow item={item} index={i()} inFlight={inFlight} change={change} />}
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
          <For each={STEPS}>{step => <StepItem step={step} current={current} />}</For>
        </ol>

        <Show when={yield* notice}>{n => <p class={`notice ${n().kind}`}>{n().text}</p>}</Show>

        <h3>Your orders</h3>
        <Loading fallback={<p class="loading">Loading orders…</p>}>
          <Show
            when={(yield* readStore(orders, o => o.length)) > 0}
            fallback={<p class="empty">No orders yet.</p>}
          >
            <ul class="orders">
              <For each={yield* readStore(orders, o => o)}>
                {order => (
                  <li>
                    <span class="pkg-name">{order.id}</span>
                    <span class="pkg-desc">
                      {order.items.length} line{order.items.length === 1 ? "" : "s"} · placed{" "}
                      {order.placedAt}
                    </span>
                    <span class="cart-price">${order.total.toFixed(2)}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Loading>
      </section>
    );
  };
});
