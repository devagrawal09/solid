// Programs for the heuristic-oracle benches (heuristic-oracles.bench.ts)
// and their equivalence gate (heuristic-oracles.programs.test.ts). Each builder
// mounts one variant of a program; `sink` accumulates everything its effects
// observe, so equivalent variants leave equal sinks.
import { CONFIG_ORACLE_DETACHED, CONFIG_ORACLE_STATUSLESS } from "../src/core/constants.js";
import {
  action,
  createLoadingBoundary,
  createMemo,
  createProjection,
  createRenderEffect,
  createRoot,
  createSignal,
  createStore,
  flush,
  untrack
} from "../src/index.js";

export const N = 1000;
const same = (a: unknown, b: unknown) => a === b;
export const out = { sink: 0, runs: 0 };

export type RowsKind = "baseline" | "H1-fuse" | "H1+H8b" | "R-projection";
export function rows(kind: RowsKind) {
  const [selected, setSelected] = createSignal(-1);
  const setters: ((v: string) => void)[] = [];
  const dispose = createRoot(d => {
    let prev = -1;
    const sel =
      kind === "R-projection"
        ? createProjection<Record<number, true>>(draft => {
            const s = selected();
            if (prev !== -1) delete draft[prev];
            if (s !== -1) draft[s] = true;
            prev = s;
          }, {})
        : null;
    for (let i = 0; i < N; i++) {
      const [label, setLabel] = createSignal("row " + i);
      setters.push(setLabel);
      createRenderEffect(label, v => void (out.runs++, (out.sink += v.length)));
      if (kind === "baseline") {
        const isSel = createMemo(() => selected() === i);
        createRenderEffect(isSel, v => void (out.runs++, v && out.sink++));
      } else if (kind === "R-projection") {
        createRenderEffect(
          () => sel![i] === true,
          v => void (out.runs++, v && out.sink++)
        );
      } else {
        createRenderEffect(
          () => selected() === i,
          v => void (out.runs++, v && out.sink++),
          {
            equals: same,
            ...(kind === "H1+H8b" ? { oracle: CONFIG_ORACLE_DETACHED } : {})
          } as any
        );
      }
    }
    return d;
  });
  flush();
  let round = 0;
  return {
    dispose,
    select() {
      setSelected((++round * 7) % N);
      flush();
    },
    update10th() {
      round++;
      for (let i = 0; i < N; i += 10) setters[i]("row " + i + " #" + round);
      flush();
    }
  };
}

export function chain(fused: boolean) {
  const [src, setSrc] = createSignal(0);
  const dispose = createRoot(d => {
    for (let i = 0; i < N / 10; i++) {
      if (fused)
        createRenderEffect(
          () => ((src() + i) * 2) % 7,
          v => void (out.runs++, (out.sink += v)),
          { equals: same } as any
        );
      else {
        const a = createMemo(() => src() + i);
        const b = createMemo(() => (a() * 2) % 7);
        createRenderEffect(b, v => void (out.runs++, (out.sink += v)));
      }
    }
    return d;
  });
  flush();
  return { dispose, update: () => (setSrc(v => v + 1), flush()) };
}

export function asyncRows(kind: "baseline" | "H9-statusless" | "H9-direct") {
  const [ver, setVer] = createSignal(0);
  let resolve: (() => void) | null = null;
  const dispose = createRoot(d => {
    const data = createMemo(() => {
      const v = ver();
      return { then: (res: (x: number) => void) => void (resolve = () => res(v)) } as any;
    });
    const view = createLoadingBoundary(
      () => {
        for (let i = 0; i < N; i++) {
          if (kind === "H9-direct")
            createRenderEffect(
              () => (data() as number) + i,
              v => void (out.runs++, (out.sink += v))
            );
          else {
            const r = createMemo(
              () => (data() as number) + i,
              (kind === "H9-statusless" ? { oracle: CONFIG_ORACLE_STATUSLESS } : undefined) as any
            );
            createRenderEffect(r, v => void (out.runs++, (out.sink += v)));
          }
        }
        return "ready";
      },
      () => "loading"
    );
    createRenderEffect(view, () => {});
    return d;
  });
  const settle = () => {
    const r = resolve;
    resolve = null;
    r?.();
    flush();
  };
  flush();
  settle();
  return {
    dispose,
    refetch() {
      setVer(v => v + 1);
      flush();
      settle();
    }
  };
}

export function storeRows(kind: "store" | "S2-scalar" | "S4-static-id") {
  if (kind === "S2-scalar") {
    const setters: ((v: string) => void)[] = [];
    const dispose = createRoot(d => {
      for (let i = 0; i < N; i++) {
        const [label, setLabel] = createSignal("row " + i);
        setters.push(setLabel);
        out.sink += i; // id: static
        createRenderEffect(label, v => void (out.runs++, (out.sink += v.length)));
      }
      return d;
    });
    flush();
    let round = 0;
    return {
      dispose,
      update10th() {
        round++;
        for (let i = 0; i < N; i += 10) setters[i]("row " + i + " #" + round);
        flush();
      }
    };
  }
  const [state, setState] = createStore({
    rows: Array.from({ length: N }, (_, i) => ({ id: i, label: "row " + i }))
  });
  const dispose = createRoot(d => {
    for (let i = 0; i < N; i++) {
      const row = untrack(() => state.rows[i]);
      if (kind === "S4-static-id") out.sink += untrack(() => row.id);
      else
        createRenderEffect(
          () => row.id,
          v => void (out.sink += v)
        ); // static text: not counted as a run
      createRenderEffect(
        () => row.label,
        v => void (out.runs++, (out.sink += v.length))
      );
    }
    return d;
  });
  flush();
  let round = 0;
  return {
    dispose,
    update10th() {
      const r = ++round;
      setState(s => {
        for (let i = 0; i < N; i += 10) s.rows[i].label = "row " + i + " #" + r;
      });
      flush();
    }
  };
}

export function actions(asAction: boolean) {
  const [a, setA] = createSignal(0);
  const [b, setB] = createSignal(0);
  createRoot(() => {
    for (let i = 0; i < N / 5; i++) {
      createRenderEffect(a, v => void (out.runs++, (out.sink += v)));
      createRenderEffect(b, v => void (out.runs++, (out.sink += v)));
    }
  });
  flush();
  const act = action(function* (k: number) {
    setA(k);
    setB(k);
  });
  let k = 0;
  return asAction
    ? () => {
        act(++k);
        flush();
      }
    : () => {
        const v = ++k;
        setA(v);
        setB(v);
        flush();
      };
}
