/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 *
 * Lazy / progressive islands: a second island hydrated AFTER the first
 * island's hydration completed (`_$HY.done`) must claim its server markup,
 * not fall back to a client render that re-creates it. The islands share
 * module state; the hydrate-before-write rule holds (no write happens before
 * the late island hydrates), so the late island's first render equals the
 * server's. documentation/plans/resumability.md, "Runtime finding".
 *
 * Server markup captured from renderToString of the identical components
 * (ssr generate, hydratable), one render per island:
 *   renderId "a": <p _hk=a0 class="count">count: <!--$-->0<!--/--></p>
 *   renderId "b": <span _hk=b0 class="label">off</span>
 */
import { afterEach, describe, expect, test } from "vitest";
import { createSignal, flush } from "solid-js";
import { hydrate } from "@solidjs/web";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const A = '<p _hk=a0 class="count">count: <!--$-->0<!--/--></p>';
const B = '<span _hk=b0 class="label">off</span>';

describe("late island hydration after _$HY.done", () => {
  const disposers: (() => void)[] = [];
  afterEach(async () => {
    for (const d of disposers.splice(0)) d();
    document.body.innerHTML = "";
    await sleep(0);
  });

  function setup() {
    (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
    const a = document.createElement("div");
    const b = document.createElement("div");
    a.innerHTML = A;
    b.innerHTML = B;
    document.body.append(a, b);
    const [count, setCount] = createSignal(0);
    const Counter = () => <p class="count">count: {count()}</p>;
    const Label = () => <span class="label">{count() > 0 ? "on" : "off"}</span>;
    return { a, b, setCount, Counter, Label };
  }

  test("the late island claims its server nodes and stays live", async () => {
    const { a, b, setCount, Counter, Label } = setup();
    disposers.push(hydrate(() => <Counter />, a, { renderId: "a" }));
    flush();
    await sleep(10);
    expect((globalThis as any)._$HY.done).toBe(true);

    const serverSpan = b.firstChild;
    disposers.push(hydrate(() => <Label />, b, { renderId: "b" }));
    flush();
    expect(b.firstChild).toBe(serverSpan);

    setCount(1);
    flush();
    expect(a.textContent).toBe("count: 1");
    expect(b.firstChild).toBe(serverSpan);
    expect(b.textContent).toBe("on");
    await sleep(10);
    expect((globalThis as any)._$HY.done).toBe(true);
  });

  test("a root hydrated before still falls back to a client render", async () => {
    const { a, Counter } = setup();
    const dispose = hydrate(() => <Counter />, a, { renderId: "a" });
    flush();
    await sleep(10);
    const claimed = a.firstChild;
    dispose();
    a.innerHTML = A;
    const markup = a.firstChild;
    disposers.push(hydrate(() => <Counter />, a, { renderId: "a" }));
    flush();
    expect(a.firstChild).not.toBe(claimed);
    expect(a.firstChild).not.toBe(markup);
    expect(a.textContent).toBe("count: 0");
  });

  test("a root without server markup for its renderId client-renders", async () => {
    const { a, b, Counter, Label } = setup();
    disposers.push(hydrate(() => <Counter />, a, { renderId: "a" }));
    flush();
    await sleep(10);
    b.innerHTML = "";
    disposers.push(hydrate(() => <Label />, b, { renderId: "b" }));
    flush();
    expect(b.innerHTML).toBe('<span class="label">off</span>');
  });
});
