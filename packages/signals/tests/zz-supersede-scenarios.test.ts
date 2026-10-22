/**
 * EXPERIMENT — onCleanup at supersede vs held-until-commit.
 * Every scenario runs in both modes; facts are printed as `RESULT {json}`.
 * No `onCleanup` is ever registered after an `await`.
 */
import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  action,
  createEffect,
  createLoadingBoundary,
  createMemo,
  createOptimistic,
  createRenderEffect,
  createRoot,
  createSignal,
  flush,
  from,
  isPending,
  latest,
  onCleanup,
  resetErrorHalt
} from "../src/index.js";
import { onSupersede } from "../src/core/async.js";

const MODES = ["held", "supersede", "async-only", "after-sync", "after-sync-held"] as const;
type Mode = (typeof MODES)[number];

const out: Record<string, Record<string, unknown>> = {};
function record(name: string, mode: Mode, facts: unknown) {
  (out[name] ??= {})[mode] = facts;
}
afterAll(() => {
  const lines: string[] = [];
  for (const [name, byMode] of Object.entries(out))
    for (const [mode, facts] of Object.entries(byMode))
      lines.push(`RESULT ${name} [${mode}] ${JSON.stringify(facts)}`);
  writeFileSync(
    `${process.env.TMPDIR ?? "/tmp"}/supersede-results${process.env.ZZ_SUFFIX ?? ""}.txt`,
    lines.join("\n") + "\n"
  );
});

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) {
    await Promise.resolve();
    flush();
  }
};

function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

/** A synchronous fake clock. */
function fakeClock() {
  let now = 0;
  let timers: { id: number; at: number; every: number; fn: () => void }[] = [];
  let ids = 0;
  return {
    every(ms: number, fn: () => void) {
      const id = ++ids;
      timers.push({ id, at: now + ms, every: ms, fn });
      return () => (timers = timers.filter(t => t.id !== id));
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        now = t.at;
        t.at += t.every;
        t.fn();
      }
      now = end;
    },
    get active() {
      return timers.length;
    }
  };
}

/** A fake connection pool with readiness promises and a closed-use counter. */
function connections(log: string[]) {
  let open = 0,
    maxOpen = 0,
    usedClosed = 0;
  const ready = new Map<string, ReturnType<typeof deferred<void>>>();
  const all: Conn[] = [];
  type Conn = { id: string; closed: boolean; send(msg: string): void; close(): void };
  return {
    open(id: string): Conn {
      open++;
      maxOpen = Math.max(maxOpen, open);
      log.push(`open ${id}`);
      const c: Conn = {
        id,
        closed: false,
        send(msg) {
          if (c.closed) {
            usedClosed++;
            log.push(`USE-AFTER-CLOSE ${id}:${msg}`);
          } else log.push(`send ${id}:${msg}`);
        },
        close() {
          if (c.closed) return;
          c.closed = true;
          open--;
          log.push(`close ${id}`);
        }
      };
      ready.set(id, deferred());
      all.push(c);
      return c;
    },
    ready: (id: string) => ready.get(id)!,
    get openCount() {
      return open;
    },
    get maxOpen() {
      return maxOpen;
    },
    get usedClosed() {
      return usedClosed;
    }
  };
}

/** Exclusive lock with a FIFO queue of requests. */
function exclusiveLock(log: string[]) {
  let holder: string | null = null;
  const queue: { who: string; grant: () => void }[] = [];
  const pump = () => {
    if (holder === null && queue.length) {
      const q = queue.shift()!;
      holder = q.who;
      log.push(`grant ${q.who}`);
      q.grant();
    }
  };
  return {
    request(who: string) {
      const d = deferred();
      let released = false;
      const entry = { who, grant: () => d.resolve() };
      queue.push(entry);
      log.push(`request ${who}`);
      pump();
      return {
        granted: d.promise,
        release() {
          if (released) return;
          released = true;
          const i = queue.indexOf(entry);
          if (i >= 0) queue.splice(i, 1);
          if (holder === who) {
            holder = null;
            log.push(`release ${who}`);
            pump();
          } else log.push(`withdraw ${who}`);
        }
      };
    },
    get holder() {
      return holder;
    }
  };
}

/** Object-URL registry. */
function urlRegistry(log: string[]) {
  const live = new Set<string>();
  let n = 0;
  return {
    create(label: string) {
      const u = `blob:${label}#${++n}`;
      live.add(u);
      log.push(`create ${u}`);
      return u;
    },
    revoke(u: string) {
      live.delete(u);
      log.push(`revoke ${u}`);
    },
    isLive: (u: string) => live.has(u)
  };
}

/** Two reader shapes over an async accessor. */
type Shape = "effect" | "boundary";
function mountReaders(shape: Shape, read: () => any, seen: unknown[]) {
  if (shape === "effect") {
    createEffect(
      () => read(),
      v => {
        seen.push(v);
      }
    );
  } else {
    const view = createLoadingBoundary(
      () => {
        const pending = isPending(() => read());
        return { pending, value: latest(() => read()) };
      },
      () => "fallback"
    );
    createRenderEffect(
      () => view(),
      v => {
        seen.push(v);
      }
    );
  }
}
const label = (v: any): string =>
  v == null
    ? String(v)
    : typeof v === "string"
      ? v
      : "pending" in v
        ? `${v.pending ? "P:" : ""}${label(v.value)}`
        : (v.id ?? JSON.stringify(v));

for (const mode of MODES) {
  describe(`[${mode}]`, () => {
    beforeEach(() => {
      (globalThis as any).__SOLID_CLEANUP_AT_SUPERSEDE__ =
        mode === "supersede"
          ? true
          : mode === "async-only"
            ? "async"
            : mode === "after-sync" || mode === "after-sync-held"
              ? mode
              : false;
    });
    afterEach(() => {
      (globalThis as any).__SOLID_CLEANUP_AT_SUPERSEDE__ = false;
      resetErrorHalt();
      flush();
    });

    // ---------------------------------------------------------------- FOR
    for (const shape of ["effect", "boundary"] as Shape[])
      it(`P1 exclusive lock (${shape})`, async () => {
        const log: string[] = [];
        const lock = exclusiveLock(log);
        const [dev, setDev] = createSignal("a");
        const seen: unknown[] = [];
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const session = createMemo(async () => {
            const id = dev();
            const h = lock.request(id);
            onCleanup(() => h.release());
            await h.granted;
            return `session:${id}`;
          });
          mountReaders(shape, session, seen);
        });
        await tick();
        setDev("b");
        flush();
        await tick(20);
        const facts = {
          holder: lock.holder,
          shown: seen.map(label),
          log: [...log]
        };
        dispose();
        flush();
        record(`P1-lock-${shape}`, mode, facts);
      });

    for (const shape of ["effect", "boundary"] as Shape[])
      it(`P2 polling during pending window (${shape})`, async () => {
        const log: string[] = [];
        const clock = fakeClock();
        const [q, setQ] = createSignal("a");
        const fires: Record<string, number> = {};
        const gate = new Map<string, ReturnType<typeof deferred<void>>>();
        const seen: unknown[] = [];
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const feed = createMemo(async () => {
            const id = q();
            const stop = clock.every(100, () => {
              fires[id] = (fires[id] ?? 0) + 1;
            });
            onCleanup(stop);
            const g = deferred();
            gate.set(id, g);
            await g.promise;
            return id;
          });
          mountReaders(shape, feed, seen);
        });
        gate.get("a")!.resolve();
        await tick();
        clock.advance(300);
        const before = { ...fires };
        setQ("b");
        flush();
        await tick();
        clock.advance(1000); // pending window: b not landed
        const during = { ...fires };
        const timersDuring = clock.active;
        gate.get("b")!.resolve();
        await tick();
        clock.advance(300);
        const facts = {
          before,
          duringWindow: { a: (during.a ?? 0) - (before.a ?? 0), b: during.b ?? 0 },
          timersDuring,
          after: { ...fires },
          shown: seen.map(label)
        };
        dispose();
        flush();
        record(`P2-polling-${shape}`, mode, facts);
      });

    for (const shape of ["effect", "boundary"] as Shape[])
      it(`P3 max concurrent connections a->b->c (${shape})`, async () => {
        const log: string[] = [];
        const pool = connections(log);
        const [q, setQ] = createSignal("a");
        const seen: unknown[] = [];
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const conn = createMemo(async () => {
            const c = pool.open(q());
            onCleanup(() => c.close());
            await pool.ready(c.id).promise;
            return c.id;
          });
          mountReaders(shape, conn, seen);
        });
        pool.ready("a").resolve();
        await tick();
        setQ("b");
        flush();
        await tick();
        const afterB = pool.openCount;
        setQ("c");
        flush();
        await tick();
        const afterC = pool.openCount;
        pool.ready("c").resolve();
        await tick();
        const facts = {
          openAfterB: afterB,
          openAfterC: afterC,
          maxOpen: pool.maxOpen,
          openAtEnd: pool.openCount,
          shown: seen.map(label),
          log: [...log]
        };
        dispose();
        flush();
        record(`P3-concurrency-${shape}`, mode, facts);
      });

    it("P4 from() vs onCleanup close timing", async () => {
      const log: string[] = [];
      const [q, setQ] = createSignal("a");
      const gate = new Map<string, ReturnType<typeof deferred<void>>>();
      const seenFrom: unknown[] = [];
      const seenCleanup: unknown[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        // returned from(): the stream the value comes from
        const viaFrom = createMemo(() => {
          const id = q();
          return from<string>(next => {
            log.push(`from:open ${id}`);
            const g = deferred();
            gate.set(`from:${id}`, g);
            g.promise.then(() => next(`from:${id}`));
            return () => log.push(`from:close ${id}`);
          });
        });
        // onCleanup: same resource, async compute
        const viaCleanup = createMemo(async () => {
          const id = q();
          log.push(`oc:open ${id}`);
          onCleanup(() => log.push(`oc:close ${id}`));
          const g = deferred();
          gate.set(`oc:${id}`, g);
          await g.promise;
          return `oc:${id}`;
        });
        mountReaders("effect", viaFrom, seenFrom);
        mountReaders("effect", viaCleanup, seenCleanup);
      });
      gate.get("from:a")!.resolve();
      gate.get("oc:a")!.resolve();
      await tick();
      log.push("--- setQ(b)");
      setQ("b");
      flush();
      await tick();
      log.push("--- pending window");
      gate.get("from:b")!.resolve();
      gate.get("oc:b")!.resolve();
      await tick();
      log.push("--- landed");
      record("P4-from-vs-onCleanup", mode, {
        log: [...log],
        shownFrom: seenFrom.map(label),
        shownCleanup: seenCleanup.map(label)
      });
      dispose();
      flush();
    });

    for (const shape of ["effect", "boundary"] as Shape[])
      it(`P5 stale writes into shared state (${shape})`, async () => {
        const log: string[] = [];
        const [room, setRoom] = createSignal("a");
        const [unread, setUnread] = createSignal<string[]>([]);
        const subs = new Map<string, (m: string) => void>();
        const gate = new Map<string, ReturnType<typeof deferred<void>>>();
        const seen: unknown[] = [];
        const shownUnread: string[] = [];
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const roomData = createMemo(async () => {
            const id = room();
            subs.set(id, m => setUnread(u => [...u, `${id}:${m}`]));
            onCleanup(() => subs.delete(id));
            const g = deferred();
            gate.set(id, g);
            await g.promise;
            return id;
          });
          mountReaders(shape, roomData, seen);
          createEffect(
            () => unread().join(","),
            v => {
              shownUnread.push(`${label(seen[seen.length - 1])}|${v}`);
            }
          );
        });
        gate.get("a")!.resolve();
        await tick();
        setRoom("b");
        flush();
        await tick();
        // server pushes into room a's subscription while b is pending
        subs.get("a")?.("m1");
        flush();
        subs.get("a")?.("m2");
        flush();
        await tick();
        const duringWindow = shownUnread.slice();
        const aliveDuring = subs.has("a");
        gate.get("b")!.resolve();
        await tick();
        record(`P5-stale-writes-${shape}`, mode, {
          staleSubscriptionAliveDuringWindow: aliveDuring,
          unreadFinal: unread(),
          shownDuringWindow: duringWindow,
          shown: seen.map(label)
        });
        dispose();
        flush();
      });

    // A FOR case from OpenClaw (N2): an action pending inside the visible
    // scope; the scope's onCleanup is what retires the action.
    it("P6 retire pending action from scope cleanup (OpenClaw N2)", async () => {
      const log: string[] = [];
      const [scope, setScope] = createSignal("a");
      const [saved, setSaved] = createOptimistic("idle");
      const retire = new Map<string, () => void>();
      const seen: unknown[] = [];
      let dispose!: () => void;
      let save!: (id: string) => Promise<unknown>;
      createRoot(d => {
        dispose = d;
        save = action(function* (id: string) {
          setSaved(`saving:${id}`);
          log.push(`action start ${id}`);
          const done = deferred();
          retire.set(id, () => done.resolve());
          yield done.promise; // only resolves when retired
          log.push(`action end ${id}`);
        });
        const presentation = createMemo(async () => {
          const id = scope();
          onCleanup(() => {
            log.push(`retire ${id}`);
            retire.get(id)?.();
          });
          await Promise.resolve();
          return `scope:${id}`;
        });
        createEffect(
          () => [presentation(), saved()] as const,
          ([p, s]) => {
            seen.push(`${p}|${s}`);
          }
        );
      });
      await tick();
      save("a");
      flush();
      await tick();
      setScope("b");
      flush();
      await tick(20);
      record("P6-action-retire", mode, { log: [...log], shown: seen.slice() });
      dispose();
      flush();
    });


    // P6b: the OpenClaw N2 shape proper — the new scope READS state the
    // pending action wrote, so its pass is entangled with the action's
    // transition; the old scope's onCleanup is what retires the action.
    it("P6b retire entangled action from scope cleanup (OpenClaw N2)", async () => {
      const log: string[] = [];
      const [scope, setScope] = createSignal("a");
      const [model, setModel] = createSignal("m0");
      const retire = new Map<string, () => void>();
      const seen: unknown[] = [];
      let dispose!: () => void;
      let save!: (id: string) => Promise<unknown>;
      createRoot(d => {
        dispose = d;
        save = action(function* (id: string) {
          setModel(`m:${id}`);
          log.push(`action start ${id}`);
          const done = deferred();
          retire.set(id, () => done.resolve());
          yield done.promise;
          log.push(`action end ${id}`);
        });
        const presentation = createMemo(async () => {
          const id = scope();
          const m = model();
          onCleanup(() => {
            log.push(`retire ${id}`);
            retire.get(id)?.();
          });
          await Promise.resolve();
          return `scope:${id}/${m}`;
        });
        mountReaders("effect", presentation, seen);
      });
      await tick();
      save("a");
      flush();
      await tick();
      setScope("b");
      flush();
      await tick(30);
      record("P6b-entangled-action-retire", mode, {
        log: [...log],
        shown: seen.map(label),
        scopeNow: scope(),
        actionStillPending: !log.includes("action end a")
      });
      dispose();
      flush();
    });

    // C6: refcounted shared source; the re-run keeps the same key (only an
    // unrelated input changed). Held = acquire-before-release (reuse);
    // supersede = release-before-acquire (thrash).
    for (const sync of [false, true])
      it(`C6 refcount thrash on same-key re-run (${sync ? "sync" : "async"} memo)`, async () => {
        const log: string[] = [];
        const refs = new Map<string, number>();
        const acquire = (k: string) => {
          const n = (refs.get(k) ?? 0) + 1;
          refs.set(k, n);
          if (n === 1) log.push(`subscribe ${k}`);
          return () => {
            const m = refs.get(k)! - 1;
            refs.set(k, m);
            if (m === 0) log.push(`unsubscribe ${k}`);
          };
        };
        const [room] = createSignal("r1");
        const [filter, setFilter] = createSignal("all");
        const seen: unknown[] = [];
        const gates: ReturnType<typeof deferred<void>>[] = [];
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const view = sync
            ? createMemo(() => {
                const rel = acquire(room());
                onCleanup(rel);
                return `${room()}/${filter()}`;
              })
            : createMemo(async () => {
                const rel = acquire(room());
                onCleanup(rel);
                const f = filter();
                const g = deferred();
                gates.push(g);
                await g.promise;
                return `${room()}/${f}`;
              });
          mountReaders("effect", view, seen);
        });
        gates.forEach(g => g.resolve());
        await tick();
        setFilter("unread");
        flush();
        await tick();
        gates.forEach(g => g.resolve());
        await tick();
        record(`C6-refcount-${sync ? "sync" : "async"}`, mode, {
          log: [...log],
          shown: seen.map(label)
        });
        dispose();
        flush();
      });


    // P6c: OpenClaw's nesting — the read memo lives inside a scope memo
    // whose onCleanup retires the scope's pending action.
    for (const nested of [true, false])
      it(`P6c scope memo retires its action (${nested ? "nested read" : "sibling read"})`, async () => {
        const log: string[] = [];
        const [scope, setScope] = createSignal("a");
        const [model, setModel] = createSignal("m0");
        const retire = new Map<string, () => void>();
        const seen: unknown[] = [];
        let dispose!: () => void;
        let save!: (id: string) => Promise<unknown>;
        createRoot(d => {
          dispose = d;
          save = action(function* (id: string) {
            setModel(`m:${id}`);
            log.push(`action start ${id}`);
            const done = deferred();
            retire.set(id, () => done.resolve());
            yield done.promise;
            log.push(`action end ${id}`);
          });
          const scoped = createMemo(() => {
            const id = scope();
            onCleanup(() => {
              log.push(`retire ${id}`);
              retire.get(id)?.();
            });
            return nested
              ? createMemo(async () => {
                  const m = model();
                  await Promise.resolve();
                  return `${id}/${m}`;
                })
              : id;
          });
          const sibling = createMemo(async () => {
            const id = scoped() as string;
            const m = model();
            await Promise.resolve();
            return `${id}/${m}`;
          });
          mountReaders("effect", nested ? () => (scoped() as any)() : sibling, seen);
        });
        await tick();
        save("a");
        flush();
        await tick();
        setScope("b");
        flush();
        await tick(30);
        record(`P6c-scope-retire-${nested ? "nested" : "sibling"}`, mode, {
          log: [...log],
          shown: seen.map(label),
          actionStillPending: !log.includes("action end a")
        });
        dispose();
        flush();
      });

    it("C2c' after a rejected replacement, is the old frame ever released?", async () => {
      const log: string[] = [];
      const pool = connections(log);
      const [q, setQ] = createSignal("a");
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const conn = createMemo(async () => {
          const c = pool.open(q());
          onCleanup(() => c.close());
          await pool.ready(c.id).promise;
          return c;
        });
        createEffect(() => conn(), { effect: () => {}, error: () => {} } as any);
      });
      pool.ready("a").resolve();
      await tick();
      setQ("b");
      flush();
      await tick();
      pool.ready("b").reject(new Error("boom"));
      await tick(30);
      const afterError = [...log];
      setQ("c");
      flush();
      await tick();
      const afterRerun = [...log];
      pool.ready("c").resolve();
      await tick();
      const afterLand = [...log];
      dispose();
      flush();
      record("C2c2-rejected-then-next", mode, { afterError, afterRerun, afterLand, afterDispose: [...log] });
    });

    // -------------------------------------------------------------- AGAINST
    for (const shape of ["effect", "boundary"] as Shape[])
      it(`C1 visible handle used during pending window (${shape})`, async () => {
        const log: string[] = [];
        const pool = connections(log);
        const [q, setQ] = createSignal("a");
        const seen: unknown[] = [];
        let conn!: () => any;
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          conn = createMemo(async () => {
            const c = pool.open(q());
            onCleanup(() => c.close());
            await pool.ready(c.id).promise;
            return c;
          });
          mountReaders(shape, conn, seen);
        });
        pool.ready("a").resolve();
        await tick();
        setQ("b");
        flush();
        await tick();
        // The UI's click handler uses whatever connection is on screen.
        const visible = () => {
          const v: any = seen[seen.length - 1];
          return v && "pending" in v ? v.value : v;
        };
        const shownDuring = label(seen[seen.length - 1]);
        for (let i = 0; i < 3; i++) visible().send(`click${i}`);
        const latestVal = latest(conn);
        latestVal.send("via-latest");
        pool.ready("b").resolve();
        await tick();
        visible().send("after");
        record(`C1-visible-handle-${shape}`, mode, {
          shownDuring,
          visibleClosedDuringWindow: log.includes("close a") && shownDuring.includes("a"),
          usedClosed: pool.usedClosed,
          shown: seen.map(label),
          log: [...log]
        });
        dispose();
        flush();
      });

    for (const shape of ["effect", "boundary"] as Shape[])
      it(`C2a revert a->b->a before b lands (${shape})`, async () => {
        const log: string[] = [];
        const pool = connections(log);
        const [q, setQ] = createSignal("a");
        const seen: unknown[] = [];
        let runs = 0;
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const conn = createMemo(async () => {
            runs++;
            const id = `${q()}${runs}`;
            const c = pool.open(id);
            onCleanup(() => c.close());
            await pool.ready(id).promise;
            return c;
          });
          mountReaders(shape, conn, seen);
        });
        pool.ready("a1").resolve();
        await tick();
        setQ("b");
        flush();
        await tick();
        setQ("a");
        flush();
        await tick();
        const runsAfterRevert = runs;
        const openAfterRevert = pool.openCount;
        const shownAfterRevert = label(seen[seen.length - 1]);
        // let any reopened 'a' pass land
        for (const id of ["a3", "b2"]) {
          try {
            pool.ready(id).resolve();
          } catch {}
        }
        await tick(20);
        const v: any = seen[seen.length - 1];
        const visible = v && "pending" in v ? v.value : v;
        record(`C2a-revert-${shape}`, mode, {
          runs: runsAfterRevert,
          openAfterRevert,
          shownAfterRevert,
          shownFinal: label(v),
          visibleClosedFinal: visible?.closed,
          shown: seen.map(label),
          log: [...log]
        });
        dispose();
        flush();
      });

    it("C2b same-value write (a->a) / no-op transition", async () => {
      const log: string[] = [];
      const pool = connections(log);
      const [q, setQ] = createSignal({ id: "a" }, { equals: (x, y) => x.id === y.id });
      const seen: unknown[] = [];
      let runs = 0;
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const conn = createMemo(async () => {
          runs++;
          const id = `${q().id}${runs}`;
          const c = pool.open(id);
          onCleanup(() => c.close());
          await pool.ready(id).promise;
          return c;
        });
        mountReaders("effect", conn, seen);
      });
      pool.ready("a1").resolve();
      await tick();
      setQ({ id: "a" });
      flush();
      await tick();
      record("C2b-equal-write", mode, { runs, log: [...log], shown: seen.map(label) });
      dispose();
      flush();
    });

    it("C2c replacement rejects (error lands)", async () => {
      const log: string[] = [];
      const pool = connections(log);
      const [q, setQ] = createSignal("a");
      const seen: unknown[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const conn = createMemo(async () => {
          const c = pool.open(q());
          onCleanup(() => c.close());
          await pool.ready(c.id).promise;
          return c;
        });
        createEffect(() => conn(), {
          effect: v => {
            seen.push(v);
          },
          error: (e: any) => {
            seen.push(`ERR:${e?.message ?? e}`);
          }
        } as any);
      });
      pool.ready("a").resolve();
      await tick();
      setQ("b");
      flush();
      await tick();
      const openDuring = pool.openCount;
      pool.ready("b").reject(new Error("boom"));
      await tick();
      record("C2c-replacement-rejects", mode, {
        openDuring,
        openAfter: pool.openCount,
        shown: seen.map(label),
        log: [...log]
      });
      dispose();
      flush();
    });

    it("C2d optimistic override over a held compute, reverted", async () => {
      const log: string[] = [];
      const pool = connections(log);
      const [q, setQ] = createSignal("a");
      const seen: unknown[] = [];
      let runs = 0;
      let dispose!: () => void;
      let go!: () => Promise<unknown>;
      const finish = deferred();
      createRoot(d => {
        dispose = d;
        const [room, setRoom] = createOptimistic(() => q());
        const conn = createMemo(async () => {
          runs++;
          const id = `${room()}${runs}`;
          const c = pool.open(id);
          onCleanup(() => c.close());
          await pool.ready(id).promise;
          return c;
        });
        mountReaders("effect", conn, seen);
        go = action(function* () {
          setRoom("b"); // optimistic guess
          yield finish.promise;
          // the action never writes q: guess reverts
        });
      });
      pool.ready("a1").resolve();
      await tick();
      const p = go();
      flush();
      await tick();
      const during = { runs, open: pool.openCount, log: [...log] };
      for (const id of ["b2"]) pool.ready(id).resolve();
      await tick();
      const afterB = { runs, shown: seen.map(label) };
      finish.resolve();
      await p;
      await tick(20);
      for (const id of ["a3"])
        try {
          pool.ready(id).resolve();
        } catch {}
      await tick(20);
      const v: any = seen[seen.length - 1];
      record("C2d-optimistic-revert", mode, {
        during,
        afterB,
        runs,
        shownFinal: label(v),
        visibleClosedFinal: v?.closed,
        open: pool.openCount,
        log: [...log]
      });
      dispose();
      flush();
    });

    it("C3 sync object-URL memo in a held transition", async () => {
      const log: string[] = [];
      const reg = urlRegistry(log);
      const [sel, setSel] = createSignal(1);
      const [key, setKey] = createSignal("a");
      const gate = new Map<string, ReturnType<typeof deferred<void>>>();
      const shown: string[] = [];
      let urlRuns = 0;
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const data = createMemo(async () => {
          const k = key();
          const g = deferred();
          gate.set(k, g);
          await g.promise;
          return k;
        });
        const url = createMemo(() => {
          urlRuns++;
          const u = reg.create(`img${sel()}`);
          onCleanup(() => reg.revoke(u));
          return u;
        });
        createRenderEffect(
          () => [data(), url()] as const,
          ([dv, u]) => {
            shown.push(`${dv}|${u}|${reg.isLive(u) ? "live" : "REVOKED"}`);
          }
        );
      });
      gate.get("a")!.resolve();
      await tick();
      setSel(2);
      setKey("b");
      flush();
      await tick();
      const runsDuring = urlRuns;
      // what's on screen right now and is it live?
      const onScreen = shown[shown.length - 1];
      const onScreenUrl = onScreen.split("|")[1];
      const onScreenLive = reg.isLive(onScreenUrl);
      gate.get("b")!.resolve();
      await tick();
      record("C3-sync-url-memo", mode, {
        urlRunsBeforeCommit: runsDuring,
        onScreenDuringWindow: onScreen,
        onScreenUrlLiveDuringWindow: onScreenLive,
        shown,
        log: [...log]
      });
      dispose();
      flush();
    });

    it("C4 child computation reads parent resource after early cleanup", async () => {
      const log: string[] = [];
      const pool = connections(log);
      const [q, setQ] = createSignal("a");
      const [pulse, setPulse] = createSignal(0);
      const seen: unknown[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const conn = createMemo(async () => {
          const c = pool.open(q());
          onCleanup(() => c.close());
          // owned child: a heartbeat that uses the connection on live writes
          const hb = createMemo(() => {
            const n = pulse();
            if (n) c.send(`hb${n}`);
            return n;
          });
          // owned child effect whose own cleanup uses the parent resource
          createEffect(
            () => hb(),
            () => {}
          );
          createMemo(() => {
            onCleanup(() => c.send("unsubscribe"));
          });
          await pool.ready(c.id).promise;
          return c;
        });
        mountReaders("effect", conn, seen);
      });
      pool.ready("a").resolve();
      await tick();
      setQ("b");
      flush();
      await tick();
      setPulse(1);
      flush();
      await tick();
      setPulse(2);
      flush();
      await tick();
      pool.ready("b").resolve();
      await tick();
      record("C4-child-after-cleanup", mode, {
        usedClosed: pool.usedClosed,
        log: [...log],
        shown: seen.map(label)
      });
      dispose();
      flush();
    });


    // C7: router / <Switch> shape. The page memo is sync; the new page owns an
    // async leaf, so the swap is held. The old page's component-level
    // onCleanup (a global shortcut) is what's at stake.
    for (const shape of ["effect", "boundary"] as Shape[])
      it(`C7 page swap held by an async leaf (${shape})`, async () => {
        const log: string[] = [];
        const shortcuts = new Set<string>();
        const [route, setRoute] = createSignal("home");
        const gate = deferred();
        const seen: unknown[] = [];
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const page = createMemo(() => {
            const r = route();
            if (r === "home") {
              shortcuts.add("home:Escape");
              onCleanup(() => (shortcuts.delete("home:Escape"), log.push("home cleanup")));
              return () => "home";
            }
            const data = createMemo(async () => {
              await gate.promise;
              return "settings-data";
            });
            return () => `settings:${data()}`;
          });
          mountReaders(shape, () => page()(), seen);
        });
        await tick();
        setRoute("settings");
        flush();
        await tick();
        const shownDuring = label(seen[seen.length - 1]);
        const pressEscape = shortcuts.has("home:Escape") ? "handled" : "DEAD";
        gate.resolve();
        await tick();
        record(`C7-page-swap-${shape}`, mode, {
          shownDuring,
          escapeDuringWindow: pressEscape,
          shown: seen.map(label),
          log: [...log]
        });
        dispose();
        flush();
      });


    // C7b: the compiled/routed shape — each page owns its own render effect
    // (the leaf), so the async leaf holds the page memo's swap (l2-contract).
    it("C7b page swap, leaf render effect owned by the page", async () => {
      const log: string[] = [];
      const shortcuts = new Set<string>();
      const [route, setRoute] = createSignal("home");
      const gate = deferred();
      const dom = { text: "" };
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const page = createMemo(() => {
          const r = route();
          if (r === "home") {
            shortcuts.add("home:Escape");
            onCleanup(() => (shortcuts.delete("home:Escape"), log.push("home cleanup")));
            createRenderEffect(
              () => "home",
              v => {
                dom.text = v;
              }
            );
            return r;
          }
          const data = createMemo(async () => {
            await gate.promise;
            return "settings-data";
          });
          createRenderEffect(data, v => {
            dom.text = `settings:${v}`;
          });
          return r;
        });
        createRenderEffect(page, () => {});
      });
      await tick();
      setRoute("settings");
      flush();
      await tick();
      const shownDuring = dom.text;
      const escapeDuringWindow = shortcuts.has("home:Escape") ? "handled" : "DEAD";
      gate.resolve();
      await tick();
      record("C7b-page-swap-leaf", mode, {
        shownDuring,
        escapeDuringWindow,
        shownFinal: dom.text,
        log: [...log]
      });
      dispose();
      flush();
    });

    // C8: an action writes the branch switch and then fails. Does the visible
    // branch re-run, or stay visible with its cleanup already run?
    for (const kind of ["signal", "optimistic"] as const)
      it(`C8 action switches a branch then throws (${kind})`, async () => {
        const log: string[] = [];
        const listeners = new Set<string>();
        const [vis, setVis] =
          kind === "signal" ? createSignal(true) : createOptimistic(true);
        const fail = deferred();
        const seen: unknown[] = [];
        let runs = 0;
        let dispose!: () => void;
        createRoot(d => {
          dispose = d;
          const branch = createMemo(() => {
            runs++;
            if (!vis()) return "hidden";
            const id = `panel${runs}`;
            listeners.add(id);
            onCleanup(() => (listeners.delete(id), log.push(`cleanup ${id}`)));
            return id;
          });
          mountReaders("effect", branch, seen);
        });
        await tick();
        const p = action(function* () {
          setVis(false);
          yield fail.promise;
        })();
        flush();
        await tick();
        const during = { shown: label(seen[seen.length - 1]), listeners: [...listeners], runs };
        fail.reject(new Error("save failed"));
        await p.catch(() => {});
        await tick(20);
        const shownFinal = label(seen[seen.length - 1]);
        record(`C8-action-fails-${kind}`, mode, {
          during,
          shownFinal,
          vis: vis(),
          runs,
          listenersFinal: [...listeners],
          visibleButReleased: shownFinal.startsWith("panel") && !listeners.has(shownFinal),
          shown: seen.map(label),
          log: [...log]
        });
        dispose();
        flush();
      });

    it("C5 sync memo cleanup order vs re-run (no async at all)", () => {
      const log: string[] = [];
      const [n, setN] = createSignal(1);
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const m = createMemo(() => {
          const v = n();
          log.push(`run ${v}`);
          onCleanup(() => log.push(`cleanup ${v}`));
          return v;
        });
        createEffect(m, v => {
          log.push(`effect ${v}`);
        });
      });
      flush();
      setN(2);
      flush();
      record("C5-sync-order", mode, { log: [...log] });
      dispose();
      flush();
    });
  });
}

// ------------------------------------------------------------------ AFTER-SYNC EDGES
// Each runs in held / supersede / after-sync; after-sync also asserts.
/** Counts every cleanup run per label, to catch double or missing runs. */
function counter(log: string[]) {
  const runs = new Map<string, number>();
  return {
    reg(lbl: string) {
      onCleanup(() => {
        runs.set(lbl, (runs.get(lbl) ?? 0) + 1);
        log.push(`cleanup ${lbl}`);
      });
    },
    get counts() {
      return Object.fromEntries(runs);
    },
    doubles: () => [...runs].filter(([, n]) => n !== 1).map(([k]) => k)
  };
}
for (const mode of ["held", "supersede", "after-sync", "after-sync-held"] as const) {
  describe(`[edge ${mode}]`, () => {
    const AS = mode === "after-sync";
    beforeEach(() => {
      (globalThis as any).__SOLID_CLEANUP_AT_SUPERSEDE__ =
        mode === "supersede" ? true : mode === "held" ? false : mode;
    });
    afterEach(() => {
      (globalThis as any).__SOLID_CLEANUP_AT_SUPERSEDE__ = false;
      resetErrorHalt();
      flush();
    });

    it("E1 superseding body throws synchronously", async () => {
      const log: string[] = [];
      const c = counter(log);
      const [n, setN] = createSignal(1);
      const seen: string[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const m = createMemo(() => {
          const v = n();
          log.push(`run ${v}`);
          c.reg(`${v}`);
          if (v === 2) throw new Error(`boom${v}`);
          return v;
        });
        createEffect(m, {
          effect: (v: number) => void seen.push(`v${v}`),
          error: (e: any) => void seen.push(`ERR:${e.message}`)
        } as any);
      });
      flush();
      setN(2);
      flush();
      const afterThrow = [...log];
      setN(3);
      flush();
      const afterRecover = [...log];
      dispose();
      flush();
      const facts = { afterThrow, afterRecover, final: [...log], counts: c.counts, seen };
      record("E1-sync-throw", mode, facts);
      if (AS) {
        expect(afterThrow).toEqual(["run 1", "run 2", "cleanup 1"]);
        expect(c.doubles()).toEqual([]);
        expect(c.counts).toEqual({ 1: 1, 2: 1, 3: 1 });
      }
    });

    it("E2 superseding body throws NotReadyError on a pending source", async () => {
      const log: string[] = [];
      const c = counter(log);
      const [n, setN] = createSignal(1);
      const gates = new Map<number, ReturnType<typeof deferred<void>>>();
      const seen: string[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const src = createMemo(async () => {
          const v = n();
          const g = deferred();
          gates.set(v, g);
          await g.promise;
          return `d${v}`;
        });
        const m = createMemo(() => {
          const v = n();
          log.push(`run ${v}`);
          c.reg(`${v}#${log.length}`);
          const data = src(); // throws NotReadyError while pending
          log.push(`body-done ${v}:${data}`);
          return `${v}:${data}`;
        });
        createEffect(m, v => void seen.push(v));
      });
      gates.get(1)!.resolve();
      await tick();
      const before = [...log];
      setN(2);
      flush();
      const afterNotReady = [...log];
      await tick();
      gates.get(2)!.resolve();
      await tick();
      const afterLand = [...log];
      dispose();
      flush();
      record("E2-notready", mode, {
        before,
        afterNotReady,
        afterLand,
        final: [...log],
        counts: c.counts,
        seen
      });
      if (AS) {
        // the old frame's cleanup ran once, right after the pending body exited
        const i = afterNotReady.indexOf("run 2");
        expect(afterNotReady.slice(i, i + 2)).toEqual(["run 2", afterNotReady[i + 1]]);
        expect(afterNotReady[i + 1]).toMatch(/^cleanup 1#/);
        expect(c.doubles()).toEqual([]);
      }
    });

    it("E3 superseding body returns an iterable", async () => {
      const log: string[] = [];
      const c = counter(log);
      const [q, setQ] = createSignal("a");
      const gates = new Map<string, ReturnType<typeof deferred<void>>>();
      const seen: unknown[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const m = createMemo(() => {
          const id = q();
          log.push(`open ${id}`);
          c.reg(id);
          const g = deferred();
          gates.set(id, g);
          return (async function* () {
            log.push(`iter-start ${id}`);
            await g.promise;
            log.push(`yield ${id}`);
            yield id;
          })();
        });
        mountReaders("effect", m, seen);
      });
      gates.get("a")!.resolve();
      await tick();
      setQ("b");
      flush();
      const atSupersede = [...log];
      await tick();
      gates.get("b")!.resolve();
      await tick();
      const afterLand = [...log];
      dispose();
      flush();
      record("E3-iterable", mode, { atSupersede, afterLand, counts: c.counts, shown: seen.map(label) });
      if (AS) {
        const ia = atSupersede.indexOf("open b");
        expect(ia).toBeGreaterThan(-1);
        expect(atSupersede.indexOf("cleanup a")).toBeGreaterThan(ia);
        expect(afterLand.indexOf("yield b")).toBeGreaterThan(afterLand.indexOf("cleanup a"));
        expect(c.doubles()).toEqual([]);
      }
    });

    it("E4 owned children keep today's schedule; nested pass runs its own after-sync", async () => {
      const log: string[] = [];
      const c = counter(log);
      const [q, setQ] = createSignal("a");
      const gates = new Map<string, ReturnType<typeof deferred<void>>>();
      const seen: unknown[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const inner = createMemo(() => {
          const id = q();
          log.push(`inner run ${id}`);
          c.reg(`inner ${id}`);
          return id;
        });
        const parent = createMemo(async () => {
          const id = q();
          log.push(`parent run ${id}`);
          c.reg(`parent ${id}`);
          createMemo(() => {
            c.reg(`child ${id}`);
          });
          const i = inner();
          const g = deferred();
          gates.set(id, g);
          log.push(`parent sync-end ${id}`);
          await g.promise;
          return `${id}/${i}`;
        });
        mountReaders("effect", parent, seen);
      });
      gates.get("a")!.resolve();
      await tick();
      setQ("b");
      flush();
      const atSupersede = [...log];
      await tick();
      const window = [...log];
      gates.get("b")!.resolve();
      await tick();
      const afterLand = [...log];
      dispose();
      flush();
      record("E4-children-nested", mode, {
        atSupersede,
        window,
        afterLand,
        counts: c.counts,
        shown: seen.map(label)
      });
      if (AS) {
        // the parent's own cleanup follows its sync body; its child's waits for the commit
        expect(atSupersede.indexOf("cleanup parent a")).toBeGreaterThan(
          atSupersede.indexOf("parent sync-end b")
        );
        expect(window).not.toContain("cleanup child a");
        expect(afterLand).toContain("cleanup child a");
        expect(c.doubles()).toEqual([]);
      }
    });

    it("E5 createEffect: compute half vs effect half", async () => {
      const log: string[] = [];
      const c = counter(log);
      const [n, setN] = createSignal(1);
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        createEffect(
          () => {
            const v = n();
            log.push(`compute ${v}`);
            c.reg(`compute ${v}`);
            return v;
          },
          v => {
            log.push(`effect ${v}`);
            return () => log.push(`effect-cleanup ${v}`);
          }
        );
      });
      flush();
      setN(2);
      flush();
      const afterRerun = [...log];
      dispose();
      flush();
      record("E5-createEffect", mode, { afterRerun, final: [...log], counts: c.counts });
      if (AS) {
        expect(afterRerun).toEqual([
          "compute 1",
          "effect 1",
          "compute 2",
          "cleanup compute 1",
          "effect-cleanup 1",
          "effect 2"
        ]);
        expect(c.doubles()).toEqual([]);
      }
    });

    it("E6 sync memo inside a held transition", async () => {
      const log: string[] = [];
      const c = counter(log);
      const [sel, setSel] = createSignal(1);
      const [key, setKey] = createSignal("a");
      const gate = new Map<string, ReturnType<typeof deferred<void>>>();
      const shown: string[] = [];
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const data = createMemo(async () => {
          const k = key();
          const g = deferred();
          gate.set(k, g);
          await g.promise;
          return k;
        });
        const res = createMemo(() => {
          const s = sel();
          log.push(`acquire ${s}`);
          c.reg(`${s}`);
          return s;
        });
        createRenderEffect(
          () => [data(), res()] as const,
          ([dv, r]) => void shown.push(`${dv}|${r}`)
        );
      });
      gate.get("a")!.resolve();
      await tick();
      setSel(2);
      setKey("b");
      flush();
      await tick();
      const window = [...log];
      const onScreen = shown[shown.length - 1];
      gate.get("b")!.resolve();
      await tick();
      const afterLand = [...log];
      dispose();
      flush();
      record("E6-sync-memo-held", mode, { window, onScreen, afterLand, shown, counts: c.counts });
      if (AS) {
        expect(window).toEqual(["acquire 1", "acquire 2", "cleanup 1"]);
        expect(c.doubles()).toEqual([]);
      }
    });

    it("E7 cleanup disposes the root mid-pass (#3601 shape)", async () => {
      const log: string[] = [];
      const c = counter(log);
      const [n, setN] = createSignal(1);
      let dispose!: () => void;
      createRoot(d => {
        dispose = d;
        const m = createMemo(() => {
          const v = n();
          log.push(`run ${v}`);
          c.reg(`${v}`);
          if (v === 1) onCleanup(() => dispose());
          return v;
        });
        createEffect(m, v => void log.push(`effect ${v}`));
      });
      flush();
      setN(2);
      flush();
      dispose();
      flush();
      record("E7-dispose-in-cleanup", mode, { log: [...log], counts: c.counts });
      expect(c.doubles()).toEqual([]);
    });
  });
}

// Middle ground M1: opt-in per registration, via the existing internal
// `onSupersede` (what from() uses), paired with onCleanup as the death
// backstop. Runs in held mode only.
describe("[opt-in onSupersede, held mode]", () => {
  const both = (fn: () => void) => {
    let done = false;
    const once = () => {
      if (!done) ((done = true), fn());
    };
    onSupersede(once);
    onCleanup(once);
  };
  afterEach(() => {
    resetErrorHalt();
    flush();
  });

  it("M1 P1 lock", async () => {
    const log: string[] = [];
    const lock = exclusiveLock(log);
    const [dev, setDev] = createSignal("a");
    const seen: unknown[] = [];
    let dispose!: () => void;
    createRoot(d => {
      dispose = d;
      const session = createMemo(async () => {
        const id = dev();
        const h = lock.request(id);
        both(() => h.release());
        await h.granted;
        return `session:${id}`;
      });
      mountReaders("boundary", session, seen);
    });
    await tick();
    setDev("b");
    flush();
    await tick(20);
    record("M1-P1-lock", "held", { holder: lock.holder, shown: seen.map(label), log: [...log] });
    dispose();
    flush();
  });

  it("M1 P6c scope retire (nested)", async () => {
    const log: string[] = [];
    const [scope, setScope] = createSignal("a");
    const [model, setModel] = createSignal("m0");
    const retire = new Map<string, () => void>();
    const seen: unknown[] = [];
    let dispose!: () => void;
    let save!: (id: string) => Promise<unknown>;
    createRoot(d => {
      dispose = d;
      save = action(function* (id: string) {
        setModel(`m:${id}`);
        const done = deferred();
        retire.set(id, () => done.resolve());
        yield done.promise;
        log.push(`action end ${id}`);
      });
      const scoped = createMemo(() => {
        const id = scope();
        both(() => {
          log.push(`retire ${id}`);
          retire.get(id)?.();
        });
        return createMemo(async () => {
          const m = model();
          await Promise.resolve();
          return `${id}/${m}`;
        });
      });
      mountReaders("effect", () => (scoped() as any)(), seen);
    });
    await tick();
    save("a");
    flush();
    await tick();
    setScope("b");
    flush();
    await tick(30);
    record("M1-P6c-scope-retire", "held", { log: [...log], shown: seen.map(label) });
    dispose();
    flush();
  });
});

it("placeholder", () => expect(true).toBe(true));
