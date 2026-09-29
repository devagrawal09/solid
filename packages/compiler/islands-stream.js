"use strict";
// Streaming for compiled islands (documentation/plans/ssr-hydration-redesign.md
// §3.5, "Compiler emission" → Streaming).
//
// The islands server module renders a `<Loading>` over server data through
// `_$ld($c, content, fallback)` and an `<Errored>` around such boundaries
// through `_$errS($c, content, fallback)`. Without a stream in the render
// context both await in place (the whole page, as `renderToString`). With
// one (`renderIslandsStream`):
//
// - the shell carries each pending boundary's fallback between
//   `<!--lN-->` … `<!--/lN-->`, and each `<Errored>` that contains one between
//   `<!--eN-->` … `<!--/eN-->`;
// - each boundary's content renders concurrently and is written, when it
//   settles, as an out-of-order chunk: `<template id="slN">…</template>` and
//   a `$sl("lN")` call that swaps it in (after its enclosing boundary's own
//   chunk, when nested);
// - a failure inside a streamed boundary renders the nearest enclosing
//   `<Errored>`'s fallback on the server and swaps it over that region (the
//   boundary's other pending chunks are dropped); with no `<Errored>` the
//   failure goes to `onError` and the fallback stays;
// - inert content streams as HTML only (no serialized data, no client
//   boundary object). Islands inside a chunk carry their anchors and `data-s`
//   values with it; the swap dispatches `solid-islands` on `document`, and the
//   islands entry activates what landed (and islands flagged `waits`, whose
//   static paths cross a boundary, once no boundary inside their anchor's
//   parent is pending).
//
// The swap is `swap()` below, stringified into the page once, before the
// first chunk; the conformance harness calls it directly.

const STREAM = Symbol.for("solid.islands.stream");
const FRAME = Symbol.for("solid.islands.boundary");
const ERRORED = Symbol.for("solid.islands.errored");

function deferred() {
  let resolve;
  const promise = new Promise(r => (resolve = r));
  return { promise, resolve };
}

class IslandsStream {
  constructor({ onChunk, onError } = {}) {
    this.n = 0;
    this.onChunk = onChunk || (() => {});
    this.onError = onError || (e => console.error(e));
    this.pending = new Set();
  }
  track(p) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }
  /** Every chunk written (including those registered while others rendered). */
  async done() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  emit(id, html) {
    this.onChunk({ id, html });
  }
  /**
   * `<Loading>`: the fallback now, the content as a chunk when it settles.
   * `content` and `fallback` return markup (template strings).
   */
  boundary($c, content, fallback, e) {
    const id = "l" + this.n++;
    const parent = $c.get(FRAME);
    const errored = $c.get(ERRORED);
    const rec = { id, emitted: deferred() };
    if (errored) errored.used = true;
    const inner = new Map($c).set(FRAME, rec);
    const task = (async () => {
      let html,
        error,
        failed = false;
      try {
        html = await content(inner);
      } catch (err) {
        failed = true;
        error = err;
      }
      if (parent) await parent.emitted.promise;
      if (failed) {
        if (errored) await this.fail(errored, error, e);
        else this.onError(error);
      } else if (!(errored && errored.failed) && !(parent && parent.dropped)) {
        this.emit(id, html);
      } else rec.dropped = true;
      rec.emitted.resolve();
    })();
    this.track(task);
    return `<!--${id}-->${fallback()}<!--/${id}-->`;
  }
  /** `<Errored>` whose content may stream: its region is marked when it does. */
  async errored($c, content, fallback, e) {
    const id = "e" + this.n++;
    const frame = { id, used: false, failed: false, parent: $c.get(FRAME), fallback };
    const inner = new Map($c).set(ERRORED, frame);
    let t;
    try {
      t = e(await content(inner));
    } catch (err) {
      frame.failed = true;
      return e(
        typeof fallback === "function"
          ? fallback(
              () => err,
              () => {}
            )
          : fallback
      );
    }
    return frame.used ? `<!--${id}-->${t}<!--/${id}-->` : t;
  }
  async fail(frame, error, e) {
    if (frame.failed) return;
    frame.failed = true;
    if (frame.parent) await frame.parent.emitted.promise;
    let html;
    try {
      const fb = frame.fallback;
      html = e(
        await (typeof fb === "function"
          ? fb(
              () => error,
              () => {}
            )
          : fb)
      );
    } catch (err) {
      this.onError(err);
      return;
    }
    this.emit(frame.id, html);
  }
}

/**
 * Swap chunk `id` (`lN` / `eN`) into `doc`: the nodes between `<!--id-->`
 * and `<!--/id-->` are replaced by the chunk's content (a `<template
 * id="s{id}">` in the page, or `html`), the markers removed, and
 * `solid-islands` dispatched with the region's parent element. Islands
 * activated in the replaced content (a fallback's) are disposed first: each
 * anchor's root disposers (`$d`, kept by the islands entry).
 */
function swap(id, html, doc) {
  doc = doc || document;
  var t = html == null && doc.getElementById("s" + id),
    root = doc.body || doc,
    w = (doc.ownerDocument || doc).createTreeWalker(root, 128),
    s,
    n,
    d,
    f,
    z = function (x) {
      if (x.$d) {
        var q = x.$d,
          k;
        x.$d = null;
        for (k in q) q[k]();
      }
      for (x = x.firstChild; x; x = x.nextSibling) z(x);
    };
  while ((n = w.nextNode()))
    if (n.data === id) {
      s = n;
      break;
    }
  if (s) {
    var p = s.parentNode;
    for (n = s.nextSibling; n && !(n.nodeType === 8 && n.data === "/" + id); n = d) {
      d = n.nextSibling;
      z(n);
      n.remove();
    }
    if (t) f = t.content;
    else {
      var x = (doc.ownerDocument || doc).createElement("template");
      x.innerHTML = html;
      f = x.content;
    }
    p.insertBefore(f, s);
    s.remove();
    n && n.remove();
    (doc.ownerDocument || doc).dispatchEvent(new CustomEvent("solid-islands", { detail: p }));
  }
  t && t.remove();
}

const SWAP_SCRIPT = `<script>${swap.toString().replace(/^function swap/, "function $sl")}</script>`;

/** A chunk as HTML: the content in a template, then its swap. */
function chunkHtml({ id, html }) {
  return `<template id="s${id}">${html}</template><script>$sl(${JSON.stringify(id)})</script>`;
}

/**
 * Render a page through the islands server modules with streaming.
 * `render($c)` renders the page component (`App({}, $c)`). Returns the shell
 * (a promise), the chunks as HTML through `onChunk`, and `done()`; or iterate
 * the result (`for await (const html of stream)`) for the shell and then
 * every chunk (the swap script precedes the first).
 */
function renderIslandsStream(render, { onChunk, onError } = {}) {
  const queue = [];
  let wake = null;
  const s = new IslandsStream({
    onChunk: c => {
      onChunk && onChunk(c);
      queue.push(c);
      wake && wake();
    },
    onError
  });
  const $c = new Map([[STREAM, s]]);
  const shell = Promise.resolve().then(() => render($c));
  const done = () => shell.then(() => s.done());
  return {
    shell,
    done,
    context: $c,
    async *[Symbol.asyncIterator]() {
      yield await shell;
      let first = true;
      let finished = false;
      done().then(() => {
        finished = true;
        wake && wake();
      });
      for (;;) {
        while (queue.length) {
          const c = queue.shift();
          yield (first ? SWAP_SCRIPT : "") + chunkHtml(c);
          first = false;
        }
        if (finished) return;
        await new Promise(r => (wake = r));
        wake = null;
      }
    }
  };
}

/** Render to one string: the shell with every chunk appended (in order). */
async function renderIslandsToString(render, options) {
  let out = "";
  for await (const html of renderIslandsStream(render, options)) out += html;
  return out;
}

module.exports = {
  IslandsStream,
  renderIslandsStream,
  renderIslandsToString,
  swap,
  chunkHtml,
  SWAP_SCRIPT,
  STREAM
};
