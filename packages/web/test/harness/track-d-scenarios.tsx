/**
 * @jsxImportSource @solidjs/web
 *
 * Track D hydration-parity scenarios (slice 5: server-authoritative replay
 * elimination). Spread into ./scenarios.tsx, so both harness halves compile
 * them — with `serverAuthority` on by default (see the harness vite configs;
 * `SOLID_SERVER_AUTHORITY=0` is the baseline).
 *
 * Beyond the harness invariants, test/hydration/track-d-authority.spec.tsx
 * replays the same artifacts to assert the client never re-ran the sealed
 * computes (the ./track-d-api counters) and to measure what was skipped.
 */
import { createMemo, createSignal, createStore, For, Loading, Show } from "solid-js";
import { BULK, byPrice, fetchCatalog, formatPrice } from "./track-d-api.js";
import type { Scenario } from "./scenarios.jsx";

// ---------------------------------------------------------------------------
// A1 (positive). Fetch → sort → format → title, all `ssrSource: "server"`
// with nothing on the client able to invalidate them: every memo is sealed.
// The rendered branch (<Show>) and list (<For>) read only sealed values; each
// row keeps an independently live descendant (a button writing a client
// signal), and the cart line is live client state.
let addToCart!: () => void;
function Catalog() {
  const products = createMemo(() => fetchCatalog("tools"), { ssrSource: "server" });
  const sorted = createMemo(() => [...products()].sort(byPrice), { ssrSource: "server" });
  const rows = createMemo(
    () => sorted().map(p => ({ id: p.id, name: p.name, price: formatPrice(p.price) })),
    { ssrSource: "server" }
  );
  const title = createMemo(() => "Catalog (" + rows().length + ")", { ssrSource: "server" });
  const [cart, setCart] = createSignal(0);
  addToCart = () => setCart(c => c + 1);
  return (
    <section>
      <h2>{title()}</h2>
      <Show when={rows().length > 0} fallback={<p>empty</p>}>
        <ul>
          <For each={rows()}>
            {row => (
              <li>
                {row.name} {row.price}
                <button onClick={() => setCart(c => c + row.id)}>add</button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p>cart: {cart()}</p>
    </section>
  );
}
function AuthorityCatalog() {
  return (
    <Loading fallback={<p>loading</p>}>
      <Catalog />
    </Loading>
  );
}

// A1b. The same shape over a 200-row catalog — the measurement workload.
let addToBulkCart!: () => void;
function BulkCatalog() {
  const products = createMemo(() => fetchCatalog("bulk"), { ssrSource: "server" });
  const sorted = createMemo(() => [...products()].sort(byPrice), { ssrSource: "server" });
  const rows = createMemo(
    () => sorted().map(p => ({ id: p.id, name: p.name, price: formatPrice(p.price) })),
    { ssrSource: "server" }
  );
  const title = createMemo(() => "Catalog (" + rows().length + ")", { ssrSource: "server" });
  const [cart, setCart] = createSignal(0);
  addToBulkCart = () => setCart(c => c + 1);
  return (
    <section>
      <h2>{title()}</h2>
      <Show when={rows().length > 0} fallback={<p>empty</p>}>
        <ul>
          <For each={rows()}>
            {row => (
              <li>
                {row.name} {row.price}
                <button onClick={() => setCart(c => c + row.id)}>add</button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p>cart: {cart()}</p>
    </section>
  );
}
function AuthorityBulk() {
  return (
    <Loading fallback={<p>loading</p>}>
      <BulkCatalog />
    </Loading>
  );
}
const bulkText = (cart: number) =>
  "Catalog (" +
  BULK.length +
  ")" +
  [...BULK]
    .sort((a, b) => a.price - b.price)
    .map(p => "bulk:" + p.name + " $" + (p.price / 100).toFixed(2) + "add")
    .join("") +
  "cart: " +
  cart;

// ---------------------------------------------------------------------------
// A2 (negative, runtime). `ssrSource: "server"` but the input's setter
// escapes into an update handle: NOT sealed. The memo keeps the ordinary
// hydration path and must still update after hydration.
let nextPage!: () => void;
function AuthorityRejectedLive() {
  const [page, setPage] = createSignal(1);
  nextPage = () => setPage(p => p + 1);
  const label = createMemo(() => "page " + page(), { ssrSource: "server" });
  return (
    <div>
      <span>{label()}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A3 (positive, synchronous). A frozen store (no setter) sorted and
// formatted by sealed memos outside any boundary: the server serializes the
// synchronous values; the client adopts them for a text hole AND an
// attribute binding.
const LIMIT = 3;
function byValue(a: { v: number }, b: { v: number }) {
  return a.v - b.v;
}
function AuthoritySync() {
  const [items] = createStore({
    list: [
      { n: "a", v: 3 },
      { n: "b", v: 1 },
      { n: "c", v: 2 },
      { n: "d", v: 9 }
    ]
  });
  const top = createMemo(() => [...items.list].sort(byValue).slice(0, LIMIT), {
    ssrSource: "server"
  });
  const summary = createMemo(
    () =>
      top()
        .map(i => i.n + "=" + i.v)
        .join(","),
    {
      ssrSource: "server"
    }
  );
  return <p title={summary()}>{summary()}</p>;
}

export const trackDScenarios: Scenario[] = [
  {
    name: "authority-catalog",
    App: AuthorityCatalog,
    async: true,
    expectedText:
      "Catalog (4)tools:tape $3.99addtools:hammer $12.50addtools:saw $25.99addtools:drill $89.00addcart: 0",
    update: () => addToCart(),
    expectedTextAfterUpdate:
      "Catalog (4)tools:tape $3.99addtools:hammer $12.50addtools:saw $25.99addtools:drill $89.00addcart: 1",
    stableSelector: "section, h2, ul, li, button"
  },
  {
    name: "authority-bulk",
    App: AuthorityBulk,
    async: true,
    expectedText: bulkText(0),
    update: () => addToBulkCart(),
    expectedTextAfterUpdate: bulkText(1),
    stableSelector: "section, h2, ul, li, button"
  },
  {
    name: "authority-rejected-live",
    App: AuthorityRejectedLive,
    expectedText: "page 1",
    update: () => nextPage(),
    expectedTextAfterUpdate: "page 2",
    stableSelector: "div, span"
  },
  {
    name: "authority-sync",
    App: AuthoritySync,
    expectedText: "b=1,c=2,a=3",
    stableSelector: "p"
  }
];
