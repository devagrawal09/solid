/**
 * The compiled-only block entries the v2 client lowering targets
 * (packages/compiler/src/blocks_v2_lower.rs): `syncBlock`, `$componentCompiled`
 * (a block or an erased plain setup), `$eventCompiled` (a block or an erased
 * handler), `effectBlockCompiled`, `settledBlockCompiled`, `withReceipts` and
 * `blockCleanup`. Each program is written the way the compiler emits it and
 * compared with the same program on the uncompiled constructors.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  $cleanup,
  $component,
  $componentCompiled,
  $effect,
  $event,
  $eventCompiled,
  $memo,
  $signal,
  blockCleanup,
  blockFlags,
  BLOCK_SYNC,
  createEffect,
  createErrorBoundary,
  createMemo,
  createRenderEffect,
  createRoot,
  createSignal,
  effectBlockCompiled,
  flush,
  isBlock,
  perform,
  readPath1,
  renderBlock,
  resetErrorHalt,
  settledBlockCompiled,
  syncBlock,
  withReceipts
} from "../src/index.js";

afterEach(() => resetErrorHalt());

function mount<P>(component: (props: P) => unknown, props: P) {
  const out: unknown[] = [];
  let dispose!: () => void;
  createRoot(d => {
    dispose = d;
    const view = component(props) as any;
    createRenderEffect(
      () => renderBlock(view),
      v => void out.push(v)
    );
  });
  flush();
  return { out, dispose };
}

class Forbidden extends Error {}

describe("compiled-only entries", () => {
  it("a fully lowered component behaves as the uncompiled one", () => {
    function run(compiled: boolean) {
      const log: string[] = [];
      let click!: (e: unknown) => void;
      const Counter = compiled
        ? // What the compiler emits: an erased setup, direct creations, a
          // fused effect half, an erased event, a `syncBlock` view.
          $componentCompiled(function (props: any) {
            const [count, setCount] = createSignal(1);
            const doubled = createMemo(function () {
              return count() * 2;
            });
            createEffect(
              function () {
                return [count()];
              },
              function (v: any) {
                const c = v[0];
                log.push(`effect ${c}`);
                const cleanup0 = () => log.push(`cleanup ${c}`);
                return cleanup0;
              }
            );
            blockCleanup(() => log.push("dispose"));
            click = $eventCompiled(function () {
              setCount(count() + 1);
            });
            return syncBlock(function () {
              return `${readPath1(props, "label")}:${perform(doubled)}`;
            }, BLOCK_SYNC);
          }, 1)
        : $component(function* (props: any) {
            const [count, setCount] = yield* $signal(1);
            const doubled = yield* $memo(function* () {
              return (yield* count) * 2;
            });
            yield* $effect(function* () {
              const c = yield* count;
              log.push(`effect ${c}`);
              yield* $cleanup(() => log.push(`cleanup ${c}`));
            });
            yield* $cleanup(() => log.push("dispose"));
            click = $event(function* () {
              yield* setCount((yield* count) + 1);
            });
            return function* () {
              return `${yield* props.label}:${yield* doubled}`;
            };
          });
      const { out, dispose } = mount(Counter as any, { label: "n" });
      click(undefined);
      flush();
      click(undefined);
      flush();
      dispose();
      return { out, log };
    }
    const compiled = run(true);
    expect(compiled).toEqual(run(false));
    expect(compiled.out).toEqual(["n:2", "n:4", "n:6"]);
    expect(compiled.log).toEqual([
      "effect 1",
      "cleanup 1",
      "effect 2",
      "cleanup 2",
      "effect 3",
      "cleanup 3",
      "dispose"
    ]);
  });

  it("syncBlock is a block: host, guard and metadata as `$(fn, BLOCK_SYNC)`", () => {
    const [a] = createSignal(1);
    const block = syncBlock(function () {
      return perform(a) + 1;
    }, BLOCK_SYNC);
    expect(isBlock(block)).toBe(true);
    expect(blockFlags(block)).toBe(BLOCK_SYNC);
    const m = createMemo(block);
    expect(m()).toBe(2);
    // The guard is raised: a direct read inside is refused in dev.
    const direct = syncBlock(function () {
      return a();
    });
    expect(() => createRoot(() => createMemo(direct)())).toThrow(/DIRECT_READ_IN_BLOCK/);
    // The SYNC claim is verified in dev.
    const wrong = syncBlock(function () {
      return Promise.resolve(1);
    });
    expect(() => wrong()).toThrow(/BLOCK_SYNC_VIOLATED/);
  });

  it("$componentCompiled accepts a setup block; the view must be a block", () => {
    const [n, setN] = createSignal(1);
    const C = $componentCompiled(
      syncBlock(function () {
        const theme = "dark";
        return syncBlock(function () {
          return `${theme}:${perform(n)}`;
        });
      })
    );
    const { out } = mount(C, {});
    setN(2);
    flush();
    expect(out).toEqual(["dark:1", "dark:2"]);
    const Broken = $componentCompiled(function () {
      return "not a view";
    });
    expect(() => mount(Broken, {})).toThrow(/COMPONENT_VIEW/);
  });

  it("an erased event routes failures to the boundary above its creation owner", () => {
    let handler!: (e: unknown) => void;
    const view = createRoot(() =>
      createErrorBoundary(
        () => {
          handler = $eventCompiled(function () {
            throw new Forbidden("no");
          });
          return "content";
        },
        error => `caught:${(error() as Error).constructor.name}`
      )
    );
    expect(view()).toBe("content");
    expect(() => handler(undefined)).not.toThrow();
    flush();
    expect(view()).toBe("caught:Forbidden");
    // Without a boundary, the failure propagates as from an ordinary handler.
    const loose = createRoot(() =>
      $eventCompiled(function () {
        throw new Forbidden("loose");
      })
    );
    expect(() => loose(undefined)).toThrow(Forbidden);
  });

  it("withReceipts: the setter returns write receipts; perform reads their value", () => {
    const [get, set] = withReceipts(createSignal(1));
    const receipt = set(5);
    expect(perform(receipt as any)).toBe(5);
    flush();
    expect(get()).toBe(5);
  });

  it("effectBlockCompiled and settledBlockCompiled run prebuilt halves", () => {
    const log: string[] = [];
    const [a, setA] = createSignal(1);
    let dispose!: () => void;
    createRoot(d => {
      dispose = d;
      effectBlockCompiled(
        syncBlock(function (v: any) {
          log.push(`half ${v[0]}`);
          blockCleanup(() => log.push(`cleanup ${v[0]}`));
        }),
        function () {
          return [a()];
        }
      );
      settledBlockCompiled(
        syncBlock(function () {
          log.push("settled");
          blockCleanup(() => log.push("settled cleanup"));
        })
      );
    });
    flush();
    setA(2);
    flush();
    dispose();
    expect(log).toEqual([
      "half 1",
      "settled",
      "cleanup 1",
      "half 2",
      "settled cleanup",
      "cleanup 2"
    ]);
  });
});
