// Server half of compiler-derived server components' single flight
// (documentation/plans/ssr-hydration-redesign.md, "Compiler-derived server
// components" → Mutations).
//
// A server call from island code whose event refreshes island frames sends
// them (`x-solid-frames: [[frameId, argsJSON], …]`) with the
// server-functions' single-flight header. This hook — installed as the
// server's `collectFlightData` — renders each frame by calling its
// generated server function in process, after the mutation ran, and
// returns their HTML; the handler folds it into the response's
// `{ value, data }` envelope (JSON), so one request brings back the value
// and every refreshed frame.
//
//   import { configureServerFunctionsServer, getServerFunction } from "@solidjs/web/server-functions";
//   import { framesFlight } from "@solidjs/compiler/frames-server";
//   configureServerFunctionsServer({ provideEvent, collectFlightData: framesFlight(getServerFunction) });

/** The `collectFlightData` hook rendering the frames a call carries. */
export function framesFlight(getServerFunction, { limit = 16 } = {}) {
  return async (event, outcome) => {
    if (outcome.thrown) return undefined;
    const header = outcome.request && outcome.request.headers.get("x-solid-frames");
    if (!header) return undefined;
    let frames;
    try {
      frames = JSON.parse(header);
    } catch {
      return undefined;
    }
    if (!Array.isArray(frames)) return undefined;
    const data = {};
    for (const [id, args] of frames.slice(0, limit)) {
      if (typeof id !== "string" || typeof args !== "string") continue;
      // Only generated frames (declared-GET reads) render here — never
      // another server function the header names.
      const known = globalThis[Symbol.for("solid.frames")];
      if (!known || !known.has(id)) continue;
      let fn;
      try {
        fn = getServerFunction(id);
      } catch {
        continue;
      }
      const res = await fn(...JSON.parse(args));
      if (!(res instanceof Response) || !res.headers.has("x-content-raw")) continue;
      data[id + " " + args] = await res.text();
    }
    return data;
  };
}
