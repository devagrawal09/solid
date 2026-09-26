// Equivalence gate for heuristic-oracles.bench.ts: every variant of a
// program must observe the same values (sink) after mount and after each op.
import { describe, expect, it } from "vitest";
import { actions, asyncRows, chain, out, rows, storeRows } from "./heuristic-oracles.programs.js";

// Values AND effect-phase run counts: a fused effect without its memo's
// equality cut-off observes the same values but runs more often.
function trace(mount: () => any, op?: (app: any) => void): string[] {
  out.sink = 0;
  out.runs = 0;
  const app = mount();
  const t = [`${out.sink}/${out.runs}`];
  for (let i = 0; i < 5; i++) {
    op?.(app);
    t.push(`${out.sink}/${out.runs}`);
  }
  app?.dispose?.();
  return t;
}

describe("heuristic-oracle bench programs are equivalent", () => {
  it("rows: mount, select, update10th", () => {
    for (const op of ["select", "update10th"] as const) {
      const ref = trace(
        () => rows("baseline"),
        a => a[op]()
      );
      for (const k of ["H1-fuse", "H1+H8b", "R-projection"] as const)
        expect({
          k,
          op,
          t: trace(
            () => rows(k),
            a => a[op]()
          )
        }).toEqual({ k, op, t: ref });
    }
  });
  it("chain: update", () => {
    expect(
      trace(
        () => chain(true),
        a => a.update()
      )
    ).toEqual(
      trace(
        () => chain(false),
        a => a.update()
      )
    );
  });
  it("async rows: refetch", () => {
    const ref = trace(
      () => asyncRows("baseline"),
      a => a.refetch()
    );
    expect(
      trace(
        () => asyncRows("H9-statusless"),
        a => a.refetch()
      )
    ).toEqual(ref);
    expect(
      trace(
        () => asyncRows("H9-direct"),
        a => a.refetch()
      )
    ).toEqual(ref);
  });
  it("store rows: mount, update10th", () => {
    const ref = trace(
      () => storeRows("store"),
      a => a.update10th()
    );
    expect(
      trace(
        () => storeRows("S4-static-id"),
        a => a.update10th()
      )
    ).toEqual(ref);
    expect(
      trace(
        () => storeRows("S2-scalar"),
        a => a.update10th()
      )
    ).toEqual(ref);
  });
  it("action vs batch", async () => {
    const run = async (asAction: boolean) => {
      out.sink = 0;
      out.runs = 0;
      const op = actions(asAction);
      const t: string[] = [];
      for (let i = 0; i < 5; i++) {
        op();
        await Promise.resolve();
        t.push(`${out.sink}/${out.runs}`);
      }
      return t;
    };
    expect(await run(false)).toEqual(await run(true));
  });
});
