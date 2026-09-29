/**
 * The frames client's single-flight path (frame-transport's
 * applyFlightResponse; the SINGLE_FLIGHT switch of frames/src/features.ts):
 * a mutation whose result is markup answers with a frame stream tagged
 * single-flight, carrying its own region and the `{ value, data }` envelope
 * of what it invalidated. One response: the region lands in the host's store
 * under the call's address, the invalidated data reaches the flight
 * consumer, and the caller gets the envelope's value.
 *
 * Server half from the built bundles (like the other server-function
 * specs), client half from source (the switch lives there).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  handleServerFunctionRequest,
  registerServerFunction
} from "@solidjs/web/server-functions/server";
import { frameTransformFlightResult } from "@solidjs/web/frames/server";
import { createServerComponentHandler } from "../../frames/src/frame-transport.js";
import { createFrameHost } from "../../frames/src/frame-client.js";

const RequestContext = Symbol.for("solid.RequestContext");

beforeAll(() => {
  (globalThis as any)[RequestContext] = new AsyncLocalStorage();
});

afterAll(() => {
  delete (globalThis as any)[RequestContext];
});

describe("frames client: single-flight response", () => {
  it("applies the mutation's region and hands the invalidated data to the consumer", async () => {
    registerServerFunction("sf-client-markup", async () => () => "<p>saved</p>");
    const response = await handleServerFunctionRequest(
      new Request("https://app.example/_server/data/sf-client-markup", {
        method: "POST",
        body: "[]",
        headers: {
          "Sec-Fetch-Site": "same-origin",
          "X-Server-Function-Format": "8",
          "X-Server-Function-Instance": "server-function:test",
          "X-Single-Flight": "true"
        }
      }),
      {
        collectFlightData: () => ({ "/notes": { count: 2 } }),
        transformFlightResult: frameTransformFlightResult
      }
    );
    expect(response.headers.has("X-Frame-Stream")).toBe(true);
    expect(response.headers.get("X-Single-Flight")).toBeTruthy();

    const host = createFrameHost();
    const applied: any[] = [];
    const apply = host.apply;
    host.apply = (chunk: any) => {
      applied.push(chunk);
      return apply(chunk);
    };
    let delivered: any;
    const handler = createServerComponentHandler({
      host,
      component: (id: string) => (props: any) => ({ id, props }),
      consumer: () => async (data: any) => {
        delivered = data;
      }
    });
    const result = await handler.handle(response, { id: "sf-client-markup", args: [] });
    // The region is unrooted (an empty stream id), so the caller gets the
    // envelope value; the region is applied through the host.
    expect(result).toBeUndefined();
    expect(applied.some(c => c.type === "html" || c.type === "start")).toBe(true);
    // Keyed by the single-flight request key (`X-Single-Flight: true`).
    expect(delivered).toEqual({ true: { "/notes": { count: 2 } } });
  });
});
