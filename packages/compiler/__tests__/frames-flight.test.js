// @vitest-environment jsdom
//
// Single flight for compiler-derived frames, end to end over real compiler
// output and the real server-functions handler: an island's event calls a
// server function (a mutation) and refreshes an island frame; the call
// carries the frame (the compiler's refresh facts), the server's
// single-flight hook (frames-server.mjs) renders it after the mutation, and
// one request brings back the value and the frame's HTML, which the applier
// morphs in place — the event's `refresh` is then a no-op.
const fs = require("fs");
const path = require("path");
const { compileIslands } = require("../index.js");
const { serverModuleClient, serverModuleRegistrations } = require("../islands-build.js");

const ROOT = path.resolve(__dirname, "..");
const SF = path.resolve(ROOT, "../web/server-functions/dist/server.js");
const T0 = path.resolve(ROOT, "../signals/dist/islands/t0.js");
const CLIENT = path.resolve(ROOT, "frames-client.mjs");
const SERVER = path.resolve(ROOT, "frames-server.mjs");
const TMP = path.join(__dirname, ".flight-tmp");
const FILE = path.join(TMP, "routes/thread.tsx");
const HN = path.join(TMP, "lib/hn.ts");

const THREAD = `
import { $component, $event, $memo, attempt, For, refresh } from "solid-js";
import { getComments, addComment } from "../lib/hn";
export const Thread = $component(function* (props) {
  const comments = yield* $memo(function* () {
    const id = yield* props.id;
    return yield* attempt(() => getComments(id));
  });
  const add = $event(function* () {
    yield* attempt(() => addComment(props.id, "second"));
    refresh(comments);
  });
  return function* () {
    return (
      <section>
        <button onClick={add}>add</button>
        <ul class="comments"><For each={yield* comments}>{c => <li>{c}</li>}</For></ul>
      </section>
    );
  };
});
`;

const write = (file, code) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, code);
  return file;
};

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("a mutation and the refresh of the frame it invalidates are one request", async () => {
  const out = compileIslands(THREAD, {
    filename: FILE,
    serverImports: [{ specifier: "../lib/hn" }],
    serverFunctionsModule: SF,
    framesModule: CLIENT
  });
  expect(out.fallback).toBe(null);
  const names = ["getComments", "addComment"];
  // --- server: the data module (registered), the compiled module, the hook --------
  write(
    HN.replace(/\.ts$/, ".server.mjs"),
    `const db = { t1: ["first"] };
export async function getComments(id) { return db[id].slice(); }
export async function addComment(id, text) { db[id].push(text); return db[id].length; }
` +
      serverModuleRegistrations(names, HN, TMP).replace(
        '"@solidjs/web/server-functions"',
        JSON.stringify(SF)
      )
  );
  const server = await import(
    write(
      path.join(TMP, "thread.server.mjs"),
      out.server
        .replace(/^import .* from "solid-js";$/m, "")
        .replace('"../lib/hn"', JSON.stringify(HN.replace(/\.ts$/, ".server.mjs")))
    )
  );
  const sf = await import(SF);
  const { framesFlight } = await import(SERVER);
  sf.configureServerFunctionsServer({
    provideEvent: (event, fn) => fn(),
    collectFlightData: framesFlight(sf.getServerFunction)
  });
  document.body.innerHTML = await server.Thread({ id: "t1" }, new Map());
  const region = document.querySelector("ul.comments");
  expect(region.getAttribute("data-f")).toMatch(/^Thread-/);
  expect(region.textContent).toBe("first");
  // --- client: the chunk, the server functions' client references ----------------
  write(
    HN.replace(/\.ts$/, ".client.mjs"),
    serverModuleClient(names, HN, TMP).replace(
      '"@solidjs/compiler/frames-client"',
      JSON.stringify(CLIENT)
    )
  );
  const chunk = await import(
    write(
      path.join(TMP, "chunk.mjs"),
      out.chunks[0].code
        .replace('"@solidjs/signals/t0"', JSON.stringify(T0))
        .replace('"../lib/hn"', JSON.stringify(HN.replace(/\.ts$/, ".client.mjs")))
    )
  );
  const requests = [];
  global.fetch = vi.fn(async (url, init = {}) => {
    requests.push([init.method || "GET", url]);
    return sf.handleServerFunctionRequest(
      new Request("http://localhost" + url, {
        ...init,
        headers: {
          ...(init.headers || {}),
          origin: "http://localhost",
          "sec-fetch-site": "same-origin"
        }
      })
    );
  });
  chunk.activate(document.querySelector("[data-i]"));
  document.querySelector("button").click();
  for (let i = 0; i < 50 && region.textContent !== "firstsecond"; i++)
    await new Promise(r => setTimeout(r, 5));
  await new Promise(r => setTimeout(r, 20));
  expect(region.textContent).toBe("firstsecond");
  // One request: the mutation, carrying the frame; no refetch after it.
  expect(requests).toEqual([["POST", expect.stringMatching(/^\/_server\/data\/addComment-/)]]);
  expect(document.querySelector("ul.comments")).toBe(region);
});
