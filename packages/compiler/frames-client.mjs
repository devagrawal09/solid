// The applier for compiler-derived server components (frames).
//
// documentation/plans/ssr-hydration-redesign.md, "Compiler-derived server
// components". Loaded lazily: by an island frame's driver on the frame's
// first refetch, or by the navigation module on the first client navigation.
// The first load of a page needs only the islands loader.
//
// - `frame(el, args)`: an island frame's arguments changed — fetch the
//   region (the frame's generated server function, a declared GET read:
//   `<endpoint>/<id>?args=<JSON>`, answered with the region's HTML) and
//   morph it in place.
// - `navigate(routes, href)`: a client navigation — match the route table,
//   compute the route frame's arguments from params / location, fetch it,
//   and morph the outlet's frame (same route) or swap the outlet (another
//   route).
// - `morph(el, html)`: the keyed morph. The region's element keeps its
//   identity (attributes synced) and its content becomes the server's.
//   Islands whose (island id, key) — `data-k`: a `$key` prop or the server
//   row's item id — match an island active before the swap are activated on
//   their new anchors with that island's state (`anchor.$ss[id]()`, cells in
//   emission order); the islands entry's activator (`self.$SI.act`) loads the
//   chunk. Unkeyed islands start from the server's state. Then the landing
//   event (`solid-islands`) lets the loader and the eager activation see the
//   new anchors, as a streamed boundary does.
//
// No render props, claims, hydration or `insert`: the region is server HTML
// and every live piece in it is a compiled island.

let endpoint = "/_server";
const cache = new Map();
const LIMIT = 64;
let seq = 0;

/** Where frames are served (the server-functions endpoint). */
export function configure(options = {}) {
  if (options.endpoint) endpoint = options.endpoint.replace(/\/$/, "");
}

/** A frame request's URL: the server function's plain-HTTP address, a declared read. */
export function frameUrl(id, args) {
  const a = typeof args === "string" ? args : JSON.stringify(args);
  return endpoint + "/" + encodeURIComponent(id) + "?args=" + encodeURIComponent(a);
}

function load(u) {
  let p = cache.get(u);
  if (!p) {
    p = fetch(u, { headers: { accept: "text/html" } }).then(r => {
      if (!r.ok) throw new Error("[solid-frames] " + u + ": " + r.status);
      return r.text();
    });
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value);
    cache.set(u, p);
    p.catch(() => cache.delete(u));
  }
  return p;
}

/** Drop cached frame responses (all, or those of one frame id). */
export function invalidate(id) {
  for (const u of [...cache.keys()])
    if (id == null || u.startsWith(endpoint + "/" + encodeURIComponent(id) + "?")) cache.delete(u);
}

/** An island frame's driver: the server call's arguments changed. */
export function frame(el, args) {
  const n = (el.$fs = (el.$fs || 0) + 1);
  return load(frameUrl(el.getAttribute("data-f"), args)).then(h => {
    if (el.$fs === n && el.isConnected) morph(el, h);
  });
}

/** Anchors in a subtree (the root included). */
function anchors(root) {
  const out = root.nodeType === 1 && root.hasAttribute("data-i") ? [root] : [];
  out.push(...root.querySelectorAll("[data-i]"));
  return out;
}

/** The keyed islands' state in a subtree: `id \0 key` → cell values. */
function states(roots) {
  const s = new Map();
  for (const r of roots)
    for (const a of anchors(r)) {
      const k = a.getAttribute("data-k");
      if (k == null || !a.$ss) continue;
      for (const id in a.$ss) s.set(id + "\0" + k, a.$ss[id]());
    }
  return s;
}

/** New anchors take the state of the keyed islands they replace; then the landing event. */
function land(roots, st) {
  const act = self.$SI && self.$SI.act;
  if (act && st.size)
    for (const r of roots)
      for (const a of anchors(r)) {
        const k = a.getAttribute("data-k");
        if (k == null) continue;
        for (const id of a.getAttribute("data-i").split(" ")) {
          const v = st.get(id + "\0" + k);
          if (v) act(a, id, v);
        }
      }
  document.dispatchEvent(new Event("solid-islands"));
}

function parse(html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}

/** The keyed morph of a frame's region (see the module comment). */
export function morph(el, html) {
  const next = parse(html).firstElementChild;
  if (!next) return el;
  const st = states([el]);
  if (el.hasAttribute("data-i")) {
    // The region's element is itself an island's anchor: replaced (its
    // listeners belong to the old activation).
    el.replaceWith(next);
    land([next], st);
    return next;
  }
  for (const a of [...el.attributes]) if (!next.hasAttribute(a.name)) el.removeAttribute(a.name);
  for (const a of [...next.attributes])
    if (el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
  el.replaceChildren(...next.childNodes);
  land([el], st);
  return el;
}

// --- navigation --------------------------------------------------------------------------

/** `/stories/:id` against a pathname (`:x?` optional, `*rest` splat). */
export function match(pattern, path) {
  const a = pattern.split("/").filter(Boolean),
    b = path.split("/").filter(Boolean),
    params = {};
  for (let i = 0; i < a.length; i++) {
    const s = a[i];
    if (s[0] === "*") {
      params[s.slice(1) || "*"] = b.slice(i).join("/");
      return params;
    }
    if (s[0] === ":") {
      const opt = s.endsWith("?");
      if (b[i] === undefined) {
        if (opt) continue;
        return null;
      }
      params[s.slice(1, opt ? -1 : undefined)] = decodeURIComponent(b[i]);
      continue;
    }
    if (s !== b[i]) return null;
  }
  return a.length >= b.length ? params : null;
}

const location_ = u => ({
  pathname: u.pathname,
  search: u.search,
  hash: u.hash,
  query: Object.fromEntries(u.searchParams)
});

/** The route and frame request for a URL: `{ id, url }`, `{}` (no frame), or null (no route). */
function resolve(routes, u) {
  for (const [paths, id, args] of routes)
    for (const p of paths) {
      const params = match(p, u.pathname);
      if (params) return id ? { id, url: frameUrl(id, args({ params, location: location_(u) })) } : {};
    }
  return null;
}

/** The outlet's markers (`<!--o-->` … `<!--/o-->`). */
function outlet() {
  const w = document.createTreeWalker(document.body, 128);
  let start;
  for (let n; (n = w.nextNode()); ) {
    if (n.data === "o") start = n;
    else if (n.data === "/o" && start) return [start, n];
  }
  return [];
}

/**
 * A client navigation to `href` (the current location when null): the
 * route's frame, fetched with its arguments, lands in the outlet. A route
 * without a frame (or none at all) is a full load.
 */
export function navigate(routes, href, { push = true } = {}) {
  const u = new URL(href == null ? location.href : href, location.href);
  const r = resolve(routes, u);
  if (!r || !r.url) return void location.assign(u.href);
  const n = ++seq;
  return load(r.url).then(
    h => {
      if (n !== seq) return;
      const [start, end] = outlet();
      if (!start) return void location.assign(u.href);
      let cur = start.nextSibling;
      while (cur && cur !== end && cur.nodeType !== 1) cur = cur.nextSibling;
      if (cur && cur !== end && cur.getAttribute("data-f") === r.id) morph(cur, h);
      else {
        const old = [];
        for (let x = start.nextSibling; x !== end; x = x.nextSibling) old.push(x);
        const st = states(old.filter(x => x.nodeType === 1));
        for (const x of old) x.remove();
        const frag = parse(h),
          added = [...frag.childNodes];
        end.before(frag);
        land(added.filter(x => x.nodeType === 1), st);
      }
      if (push) {
        history.pushState(null, "", u.href);
        scrollTo(0, 0);
      }
      // The router's link state (aria-current / data-active), as at load.
      if (self.$SI && self.$SI.links) self.$SI.links();
    },
    () => location.assign(u.href)
  );
}

/** Load a route's frame ahead of a navigation (link intent). */
export function prefetch(routes, href) {
  const r = resolve(routes, new URL(href, location.href));
  if (r && r.url) load(r.url).catch(() => {});
}
