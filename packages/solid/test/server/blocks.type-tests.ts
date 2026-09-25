// Type-level contract of block-derived stores on the server entry (checked
// by `tsc -p tsconfig.test.json`): the SSR wrappers expose the same
// overloads as the client, so a block projection keeps its metadata there too.
import {
  $,
  createOptimisticStore,
  createProjection,
  createStore,
  readStore,
  wait,
  write,
  type BlockAsync,
  type BlockErrors,
  type BlockStore,
  type BlockValue,
  type Refreshable,
  type Store,
  type StoreSetter
} from "../../src/server/index.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

class HttpError extends Error {
  readonly kind = "http";
}
declare function fetchLabel(id: number): Promise<string>;
interface Summary {
  total: number;
  label: string;
}
declare const summaryId: { (): number; [Symbol.iterator](): Generator<any, number, any> };
declare const [source]: [Store<{ id: number }>, StoreSetter<{ id: number }>];

const summarize = $(function* (draft: Summary) {
  const id = yield* readStore(source, s => s.id);
  draft.total = id;
  draft.label = yield* wait(fetchLabel(id), HttpError);
});
const shaped = $(function* () {
  return { total: yield* readStore(source, s => s.id), label: "n" } as Summary;
});

const summary = createProjection(summarize, {}, { ssrSource: "server" });
const shapedSummary = createProjection(shaped, { total: 0 });
const [derivedSummary, setDerivedSummary] = createStore(summarize, {});
const [optimisticSummary, setOptimisticSummary] = createOptimisticStore(summarize, {});
type _blockStores = [
  Expect<Equal<typeof summary, BlockStore<typeof summarize, Summary>>>,
  Expect<Equal<typeof shapedSummary, BlockStore<typeof shaped, Summary>>>,
  Expect<Equal<typeof derivedSummary, BlockStore<typeof summarize, Summary>>>,
  Expect<Equal<typeof setDerivedSummary, StoreSetter<Summary>>>,
  Expect<Equal<typeof optimisticSummary, BlockStore<typeof summarize, Summary>>>,
  Expect<Equal<typeof setOptimisticSummary, StoreSetter<Summary>>>
];

const readsSummary = $(function* () {
  return `${yield* readStore(summary, s => s.label)}/${yield* readStore(shapedSummary, s => s.total)}`;
});
const readsShaped = $(function* () {
  return yield* readStore(shapedSummary, s => s.total);
});
type _reads = [
  Expect<Equal<BlockValue<typeof readsSummary>, string>>,
  Expect<Equal<BlockAsync<typeof readsSummary>, true>>,
  Expect<Equal<BlockErrors<typeof readsSummary>, HttpError>>,
  Expect<Equal<BlockAsync<typeof readsShaped>, false>>,
  Expect<Equal<BlockErrors<typeof readsShaped>, never>>
];

const writingDerive = $(function* (draft: Summary) {
  yield* write(setDerivedSummary, s => {
    s.total = 1;
  });
  draft.total = 1;
});
// @ts-expect-error — a projection admits no Writes
createProjection(writingDerive, {});
// @ts-expect-error — nor a derived store
createStore(writingDerive, {});
// @ts-expect-error — nor a derived optimistic store
createOptimisticStore(writingDerive, {});

// The plain forms are unchanged (including the client/seedLoadingValue pairing).
const plainProjection = createProjection((draft: Summary) => {
  draft.total = 1;
}, {});
const clientSeeded = createProjection<Summary>(
  async () => ({ total: 1, label: "" }),
  {},
  {
    ssrSource: "client",
    seedLoadingValue: true
  }
);
const [plainDerived] = createStore(async () => ({ total: 1, label: "" }), {} as Partial<Summary>);
const [plainStore, setPlainStore] = createStore({ total: 0 });
type _plainForms = [
  Expect<Equal<typeof plainProjection, Refreshable<Store<Summary>>>>,
  Expect<Equal<typeof clientSeeded, Refreshable<Store<Summary>>>>,
  Expect<Equal<typeof plainDerived, Refreshable<Store<Summary>>>>,
  Expect<Equal<typeof plainStore, { total: number }>>,
  Expect<Equal<typeof setPlainStore, StoreSetter<{ total: number }>>>
];

void summaryId;
export {};
