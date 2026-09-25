/**
 * @jsxImportSource @solidjs/web
 *
 * Track D slice 6 (inert-region hydration elimination) parity scenarios.
 * Spread into ./scenarios.tsx, so both harness halves compile them with
 * `inertRegions` when `SOLID_INERT_REGIONS=1` (see the harness vite configs
 * and the `test:track-d` script); without it they are the baseline. The inert components below must
 * stay static: their bodies may not call anything (that would, correctly,
 * make them non-inert). test/hydration/track-d-inert.spec.tsx replays the
 * same artifacts to count keys, owners and DOM identity.
 */
import { createMemo, createSignal, For, Loading } from "solid-js";
import type { Scenario } from "./scenarios.jsx";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- inert components (static markup only) --------------------------------
function Icon() {
  return (
    <svg viewBox="0 0 8 8" class="icon">
      <path d="M0 0L8 8" />
    </svg>
  );
}
function Legal() {
  return (
    <footer class="legal">
      <Icon />
      <p>(c) 2026 {"ACME"} — all rights reserved</p>
      <a href="/terms">terms</a>
    </footer>
  );
}
const Banner = () => (
  <div class="banner">
    <h3>Welcome</h3>
    <p>Static marketing copy.</p>
  </div>
);
function Card() {
  return (
    <article class="card">
      <Icon />
      <h4>Feature</h4>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
      <ul>
        <li>one</li>
        <li>two</li>
        <li>three</li>
      </ul>
    </article>
  );
}

// A component that LOOKS static but handles an event: not inert (refusal).
let refusedClicks = 0;
function ClickableBadge() {
  return <b onClick={() => refusedClicks++}>badge</b>;
}

// ---------------------------------------------------------------------------
// I1. An inert footer and banner beside live state.
let bumpInertCount!: () => void;
function InertFooter() {
  const [count, setCount] = createSignal(0);
  bumpInertCount = () => setCount(c => c + 1);
  return (
    <main>
      <section>
        <Banner />
      </section>
      <p class="count">count: {count()}</p>
      <div>
        <Legal />
      </div>
    </main>
  );
}

// I2. Inert regions nested inside a LIVE component, between live descendants.
let toggleNested!: () => void;
function LivePanel() {
  const [open, setOpen] = createSignal(true);
  toggleNested = () => setOpen(o => !o);
  return (
    <div class="panel">
      <button onClick={() => setOpen(o => !o)}>{open() ? "close" : "open"}</button>
      <div class="static">
        <Icon />
        <Banner />
      </div>
      <span>{open() ? "opened" : "closed"}</span>
    </div>
  );
}
function InertNestedLive() {
  return (
    <section>
      <LivePanel />
    </section>
  );
}

// I3. Inert icons inside list rows that stay live.
let addInertRow!: () => void;
function InertInFor() {
  const [rows, setRows] = createSignal(["a", "b"]);
  addInertRow = () => setRows(r => [...r, "c"]);
  return (
    <ul>
      <For each={rows()}>
        {row => (
          <li>
            <span class="i">
              <Icon />
            </span>
            {row}
          </li>
        )}
      </For>
    </ul>
  );
}

// I4. An inert region inside a streamed Loading boundary.
let refreshInertAsync!: () => void;
function AsyncWithInert() {
  const [v, setV] = createSignal(0);
  refreshInertAsync = () => setV(x => x + 1);
  const data = createMemo(async () => {
    const x = v();
    await sleep(5);
    return "data-" + x;
  });
  return (
    <div>
      <div class="static">
        <Banner />
      </div>
      <p>{data()}</p>
    </div>
  );
}
function InertInLoading() {
  return (
    <Loading fallback={<p>loading</p>}>
      <AsyncWithInert />
    </Loading>
  );
}

// I5. Refusal: an event-handling component in the same position hydrates.
function InertRefused() {
  return (
    <div>
      <span>
        <ClickableBadge />
      </span>
      <Legal />
    </div>
  );
}

// I6. Measurement workload: 60 inert cards around one live counter.
let bumpCards!: () => void;
function InertBulk() {
  const [count, setCount] = createSignal(0);
  bumpCards = () => setCount(c => c + 1);
  return (
    <main>
      <p class="count">count: {count()}</p>
      <div class="grid">
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
        <Card />
      </div>
      <Legal />
    </main>
  );
}

const legalText = "(c) 2026 ACME — all rights reservedterms";
const bannerText = "WelcomeStatic marketing copy.";
const cardText = "FeatureLorem ipsum dolor sit amet, consectetur adipiscing elit.onetwothree";

export const trackDInertScenarios: Scenario[] = [
  {
    name: "inert-footer",
    App: InertFooter,
    expectedText: bannerText + "count: 0" + legalText,
    update: () => bumpInertCount(),
    expectedTextAfterUpdate: bannerText + "count: 1" + legalText,
    stableSelector: "main, section, footer, svg, p, a, div"
  },
  {
    name: "inert-nested-live",
    App: InertNestedLive,
    expectedText: "close" + bannerText + "opened",
    update: () => toggleNested(),
    expectedTextAfterUpdate: "open" + bannerText + "closed",
    stableSelector: "section, button, svg, h3, span"
  },
  {
    name: "inert-in-for",
    App: InertInFor,
    expectedText: "ab",
    update: () => addInertRow(),
    expectedTextAfterUpdate: "abc",
    stableSelector: "ul"
  },
  {
    name: "inert-in-loading",
    App: InertInLoading,
    async: true,
    expectedText: bannerText + "data-0",
    update: () => refreshInertAsync(),
    expectedTextAfterUpdate: bannerText + "data-1",
    stableSelector: "h3"
  },
  {
    name: "inert-refused",
    App: InertRefused,
    expectedText: "badge" + legalText,
    update: () => (document.querySelector("b") as HTMLElement).click(),
    expectedTextAfterUpdate: "badge" + legalText,
    stableSelector: "div, span, b, footer"
  },
  {
    name: "inert-bulk",
    App: InertBulk,
    expectedText: "count: 0" + cardText.repeat(60) + legalText,
    update: () => bumpCards(),
    expectedTextAfterUpdate: "count: 1" + cardText.repeat(60) + legalText,
    stableSelector: "main, article, footer"
  }
];

/** For the inert spec: the refusal's handler must fire after hydration. */
export const inertRefusedClicks = () => refusedClicks;
