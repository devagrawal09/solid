// Streaming for compiled islands (islands-stream.js): the shell carries each
// pending boundary's fallback between markers, chunks follow out of order
// (nested ones after their parent), failures render the nearest `Errored`
// fallback over its region, and the swap replaces a region in place.
const { compileIslands } = require("../index.js");
const { renderIslandsStream, renderIslandsToString, swap } = require("../islands-stream.js");

const SRC = `
import { $component, $memo, attempt, Loading, Errored } from "solid-js";
const Slow = $component(function* (props) {
  const v = yield* $memo(function* () {
    const k = yield* props.k;
    return yield* attempt(() => globalThis.__load(k));
  });
  return function* () { return <b class={yield* props.k}>{yield* v}</b>; };
});
export const App = $component(function* () {
  return function* () {
    return (
      <main>
        <Errored fallback={e => <p class="err">{String(e())}</p>}>
          <Loading fallback={<i>a…</i>}>
            <Slow k="a" />
            <Loading fallback={<i>b…</i>}><Slow k="b" /></Loading>
          </Loading>
        </Errored>
        <Loading fallback={<i>c…</i>}><Slow k="c" /></Loading>
      </main>
    );
  };
});
`;

function load(src) {
  const out = compileIslands(src, { filename: "app.jsx" });
  expect(out.fallback).toBe(null);
  const code = out.server.replace(/^import .*$/gm, "").replace(/export const /g, "const ");
  return new Function(`${code}\nreturn { App };`)();
}

function deferreds() {
  const d = {};
  globalThis.__load = k =>
    new Promise((resolve, reject) => {
      d[k] = { resolve, reject };
    });
  return d;
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe("renderIslandsStream", () => {
  test("without a stream, boundaries are awaited in place", async () => {
    const d = deferreds();
    const { App } = load(SRC);
    const p = App({});
    // In place: each boundary renders after the markup before it.
    await tick();
    d.a.resolve("A");
    await tick();
    d.b.resolve("B");
    await tick();
    d.c.resolve("C");
    expect(await p).toBe('<main><b class="a">A</b><b class="b">B</b><b class="c">C</b></main>');
  });

  test("the shell carries fallbacks; chunks follow as they settle, nested after their parent", async () => {
    const d = deferreds();
    const { App } = load(SRC);
    const chunks = [];
    const s = renderIslandsStream($c => App({}, $c), { onChunk: c => chunks.push(c) });
    expect(await s.shell).toBe(
      "<main><!--e0--><!--l1--><i>a…</i><!--/l1--><!--/e0--><!--l2--><i>c…</i><!--/l2--></main>"
    );
    d.c.resolve("C");
    await tick();
    expect(chunks).toEqual([{ id: "l2", html: '<b class="c">C</b>' }]);
    d.a.resolve("A");
    await tick();
    // l1 renders its nested boundary's fallback and registers it.
    expect(chunks[1]).toEqual({
      id: "l1",
      html: '<b class="a">A</b><!--l3--><i>b…</i><!--/l3-->'
    });
    d.b.resolve("B");
    await s.done();
    expect(chunks[2]).toEqual({ id: "l3", html: '<b class="b">B</b>' });
  });

  test("a failure renders the nearest Errored fallback over its region", async () => {
    const d = deferreds();
    const { App } = load(SRC);
    const chunks = [];
    const s = renderIslandsStream($c => App({}, $c), { onChunk: c => chunks.push(c) });
    await s.shell;
    d.a.reject(new Error("nope"));
    d.c.resolve("C");
    await s.done();
    expect(chunks).toContainEqual({ id: "e0", html: '<p class="err">Error: nope</p>' });
    expect(chunks.find(c => c.id === "l1")).toBeUndefined();
  });

  test("as HTML: the shell, the swap script once, then template + swap per chunk", async () => {
    const d = deferreds();
    const { App } = load(SRC);
    const p = renderIslandsToString($c => App({}, $c));
    await tick();
    d.c.resolve("C");
    d.a.resolve("A");
    await tick();
    d.b.resolve("B");
    const html = await p;
    expect(html.match(/function \$sl/g)).toHaveLength(1);
    expect(html).toContain(
      '<template id="sl2"><b class="c">C</b></template><script>$sl("l2")</script>'
    );
    expect(html.indexOf('id="sl1"')).toBeLessThan(html.indexOf('id="sl3"'));
  });
});

describe("swap", () => {
  test("replaces the region between the markers, removes them, and notifies the entry", () => {
    let JSDOM;
    try {
      ({ JSDOM } = require("jsdom"));
    } catch {
      return; // jsdom is exercised by the web package's conformance islands mode
    }
    const dom = new JSDOM("<main><!--l0--><i>…</i><!--/l0--><b>x</b></main>");
    globalThis.CustomEvent = dom.window.CustomEvent;
    let landed = null;
    dom.window.document.addEventListener("solid-islands", e => (landed = e.detail));
    swap("l0", '<p data-i="i0">ok</p>', dom.window.document);
    expect(dom.window.document.body.innerHTML).toBe('<main><p data-i="i0">ok</p><b>x</b></main>');
    expect(landed.tagName).toBe("MAIN");
  });
});
