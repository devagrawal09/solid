/**
 * `syncAction(fn)` — the compiled form of `action(function* …)` for a body
 * with no `yield` (packages/compiler/src/sync_actions.rs). Every test runs one
 * program with the transactional `action` and with `syncAction` and asserts
 * identical observable traces.
 */
import { describe, expect, it, vi } from "vitest";
import {
  action,
  createOptimistic,
  createOptimisticStore,
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  syncAction
} from "../src/index.js";

type Form = "action" | "sync";
const wrap = <A extends any[], R>(form: Form, body: (...a: A) => R) =>
  form === "action"
    ? action(function* (...a: A) {
        return body(...a);
      })
    : syncAction(body);

async function both(run: (form: Form) => Promise<unknown[]>) {
  const reference = await run("action");
  expect(await run("sync")).toEqual(reference);
  return reference;
}

describe("syncAction ≡ action for yield-free bodies", () => {
  it("plain writes: one batch, same frames, same resolved value", async () => {
    const trace = await both(async form => {
      const log: unknown[] = [];
      const [a, setA] = createSignal(0);
      const [b, setB] = createSignal(0);
      createRoot(() =>
        createRenderEffect(
          () => [a(), b()],
          v => void log.push(JSON.stringify(v))
        )
      );
      flush();
      const p = wrap(form, (k: number) => {
        setA(k);
        setB(k * 2);
        log.push(`inside a=${a()} b=${b()}`);
        return k + 1;
      })(5);
      log.push(`after call a=${a()}`);
      flush();
      log.push(`resolved ${await p}`);
      return log;
    });
    expect(trace).toEqual(["[0,0]", "inside a=0 b=0", "after call a=0", "[5,10]", "resolved 6"]);
  });

  it("a throw rejects the promise and keeps the writes before it", async () => {
    await both(async form => {
      const log: unknown[] = [];
      const [a, setA] = createSignal(0);
      createRoot(() => createRenderEffect(a, v => void log.push(v)));
      flush();
      const p = wrap(form, () => {
        setA(1);
        throw new Error("boom");
      })();
      flush();
      await p.then(
        () => log.push("resolved"),
        e => log.push(`rejected ${e.message}`)
      );
      flush();
      log.push(`a=${a()}`);
      return log;
    });
  });

  it("optimistic signal and store writes", async () => {
    await both(async form => {
      const log: unknown[] = [];
      const [o, setO] = createOptimistic(0);
      const [s, setS] = createOptimisticStore({ n: 0 });
      createRoot(() =>
        createRenderEffect(
          () => [o(), s.n],
          v => void log.push(JSON.stringify(v))
        )
      );
      flush();
      const p = wrap(form, () => {
        setO(5);
        setS(d => {
          d.n = 7;
        });
      })();
      log.push(`after call o=${o()} n=${s.n}`);
      flush();
      await p;
      flush();
      log.push(`settled o=${o()} n=${s.n}`);
      return log;
    });
  });

  it("writes to a node an in-flight action holds entangle the same way", async () => {
    await both(async form => {
      const log: unknown[] = [];
      const [x, setX] = createSignal(0);
      const [y, setY] = createSignal(0);
      createRoot(() =>
        createRenderEffect(
          () => [x(), y()],
          v => void log.push(JSON.stringify(v))
        )
      );
      flush();
      let release!: () => void;
      const slow = action(function* () {
        setX(1);
        yield new Promise<void>(r => (release = r));
        setX(2);
      });
      const p1 = slow();
      await Promise.resolve();
      flush();
      const p2 = wrap(form, () => {
        setX(10);
        setY(10);
      })();
      flush();
      await Promise.resolve();
      flush();
      log.push(`held x=${x()} y=${y()}`);
      release();
      await p1;
      await p2;
      await Promise.resolve();
      flush();
      log.push(`settled x=${x()} y=${y()}`);
      return log;
    });
  });

  it("a body that starts another (async) action", async () => {
    await both(async form => {
      const log: unknown[] = [];
      const [x, setX] = createSignal(0);
      const [y, setY] = createSignal(0);
      createRoot(() =>
        createRenderEffect(
          () => [x(), y()],
          v => void log.push(JSON.stringify(v))
        )
      );
      flush();
      let release!: () => void;
      const inner = action(function* () {
        setY(1);
        yield new Promise<void>(r => (release = r));
        setY(2);
      });
      const p = wrap(form, () => {
        setX(1);
        inner();
        setX(2);
      })();
      flush();
      await Promise.resolve();
      flush();
      log.push(`mid x=${x()} y=${y()}`);
      release();
      await p;
      await new Promise(r => setTimeout(r, 0));
      flush();
      log.push(`end x=${x()} y=${y()}`);
      return log;
    });
  });

  it("keeps the owned-scope guard", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = (form: Form) => {
      const act = wrap(form, () => 1);
      let error: string | undefined;
      createRoot(() => {
        try {
          act();
        } catch (e: any) {
          error = e.message.slice(0, 32);
        }
      });
      return error;
    };
    expect(run("sync")).toBe(run("action"));
    expect(run("sync")).toContain("ACTION_CALLED_IN_OWNED_SCOPE");
  });
});
