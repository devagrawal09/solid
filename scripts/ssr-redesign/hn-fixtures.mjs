// Deterministic HN API fixtures for the server-components gate
// (sc-gate.mjs): preloaded into both HN servers (`node --import
// ./hn-fixtures.mjs server.js`), it answers the two upstream APIs the apps'
// `lib/hn.ts` fetch (node-hnapi for feeds and items, firebase for users) so
// the pages are the same on every run without a network. The 1,406-comment
// story 30186326 is served by the apps themselves from their capture.
const HNAPI = "https://node-hnapi.herokuapp.com/";
const FIREBASE = "https://hacker-news.firebaseio.com/v0/";
const FEEDS = { news: 0, newest: 1, show: 2, ask: 3, jobs: 4 };
const CAPTURED = 30186326;

function story(feed, page, i) {
  const n = feed * 1000 + page * 100 + i;
  const id = feed === 0 && page === 1 && i === 0 ? CAPTURED : 40000000 + n;
  const type = feed === 4 ? "job" : feed === 3 || i % 7 === 3 ? "ask" : "link";
  const withUrl = type !== "ask";
  return {
    id,
    title: id === CAPTURED ? "Facebook loses users for the first time" : `Fixture story ${n}`,
    points: type === "job" ? null : 10 + ((n * 37) % 400),
    user: type === "job" ? null : `user${n % 11}`,
    time: 1643900000 - n * 60,
    time_ago: `${1 + (n % 23)} hours ago`,
    comments_count: type === "job" ? 0 : (n * 13) % 90,
    type,
    ...(withUrl ? { url: `https://example.com/${feed}/${n}`, domain: "example.com" } : { url: `item?id=${id}` })
  };
}

function feed(name, page) {
  const f = FEEDS[name];
  const count = f === 0 ? 30 : f === 4 ? 12 : 30;
  return Array.from({ length: count }, (_, i) => story(f, page, i));
}

function comments(id, depth, prefix) {
  if (depth > 2) return [];
  return [0, 1].map(k => ({
    id: id * 10 + k,
    level: depth,
    user: `commenter${(id + k) % 5}`,
    time: 1643900000,
    time_ago: `${k + 1} hours ago`,
    content: `<p>Fixture comment ${prefix}${k} on ${id}</p>`,
    comments: comments(id * 10 + k, depth + 1, `${prefix}${k}.`)
  }));
}

function item(id) {
  const n = id - 40000000;
  const s = story(Math.floor(n / 1000), Math.floor((n % 1000) / 100), n % 100);
  return { ...s, id, comments: comments(id, 0, "") };
}

function user(id) {
  return {
    id,
    created: 1300000000 + id.length * 86400,
    karma: 100 + id.length * 7,
    about: id.endsWith("1") ? `<p>About ${id}</p>` : undefined
  };
}

function answer(url) {
  if (url.startsWith(HNAPI)) {
    const u = new URL(url);
    const path = u.pathname.slice(1);
    if (path in FEEDS) return feed(path, Number(u.searchParams.get("page")) || 1);
    const m = /^item\/(\d+)$/.exec(path);
    if (m) return item(Number(m[1]));
  }
  if (url.startsWith(FIREBASE)) {
    const m = /^user\/(.+)\.json$/.exec(url.slice(FIREBASE.length));
    if (m) return user(decodeURIComponent(m[1]));
  }
  return undefined;
}

const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const body = answer(String(url));
  if (body !== undefined)
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  return real(input, init);
};
export { answer as fixture };
