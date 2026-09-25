// Type-level contract of `$` blocks and their hosts (checked by `tsc`).
import {
  $,
  attempt,
  call,
  createEffect,
  createMemo,
  createOptimisticStore,
  createProjection,
  createSignal,
  createStore,
  errored,
  loading,
  perform,
  raise,
  readPath,
  readPath1,
  readPath2,
  readPath3,
  readPath4,
  readPathN,
  readHandle2 as readHandleAt2,
  readHandleChild,
  createStoreHandle,
  storeProxy,
  type Borrowed,
  type StoreHandle,
  readProp,
  readStore,
  wait,
  write,
  type AsyncOp,
  type BlockAsync,
  type BlockErrors,
  type BlockFailures,
  type BlockInput,
  type BlockReads,
  type BlockStore,
  type BlockTasks,
  type BlockValue,
  type BlockWrites,
  type EventBlock,
  type JsxBlock,
  type PathResult,
  type PathValue,
  type PropRead,
  type Refreshable,
  type Store,
  type SourceAccessor,
  type StoreRead,
  type StoreSetter,
  type StrictCallback
} from "../src/index.js";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Distinct members: empty subclasses of Error are structurally identical,
// and `Exclude` (like all of TypeScript) is structural.
class NotFound extends Error {
  readonly kind = "not-found";
}
class Forbidden extends Error {
  readonly kind = "forbidden";
}
class HttpError extends Error {
  readonly kind = "http";
}
declare function fetchUser(id: number): Promise<{ name: string }>;
declare const view: { tag: "p"; text: string };

const [count, setCount] = createSignal(1);
const [label] = createSignal("x");

// --- Reads only ---------------------------------------------------------------
const reads = $(function* () {
  return (yield* count) + (yield* label).length;
});
type _reads = [
  Expect<Equal<BlockValue<typeof reads>, number>>,
  Expect<Equal<BlockReads<typeof reads>, typeof count | typeof label>>,
  Expect<Equal<BlockTasks<typeof reads>, never>>,
  Expect<Equal<BlockFailures<typeof reads>, never>>,
  Expect<Equal<BlockWrites<typeof reads>, never>>,
  Expect<Equal<BlockAsync<typeof reads>, false>>,
  Expect<Equal<BlockErrors<typeof reads>, never>>,
  Expect<Equal<ReturnType<typeof reads>, number>>
];

// --- readStore: selector result inferred, store root recorded as a Read ------------
const [store, setStore] = createStore({
  user: { name: "Ada" },
  items: [{ id: 1, name: "one" }],
  index: 0
});
const fromStore = $(function* () {
  const name = yield* readStore(store, s => s.user.name);
  const names = yield* readStore(store, s => s.items.map(item => item.name));
  const item = yield* readStore(store, s => s.items[s.index]);
  return { name, names, item };
});
type _fromStore = [
  Expect<
    Equal<
      BlockValue<typeof fromStore>,
      { name: string; names: string[]; item: { id: number; name: string } }
    >
  >,
  // The root (`Store<T>` is `T`), not the path: no path typing is attempted.
  Expect<Equal<BlockReads<typeof fromStore>, typeof store>>,
  Expect<Equal<BlockTasks<typeof fromStore>, never>>,
  Expect<Equal<BlockFailures<typeof fromStore>, never>>,
  Expect<Equal<BlockWrites<typeof fromStore>, never>>,
  // A plain store carries no metadata, so derived totals stay quiet
  // (documented); block-derived stores do — see "Block-derived stores".
  Expect<Equal<BlockAsync<typeof fromStore>, false>>,
  Expect<Equal<BlockErrors<typeof fromStore>, never>>
];
// A selector is typed against the store's state.
$(function* () {
  // @ts-expect-error — no such property
  return yield* readStore(store, s => s.missing);
});
// Store writes go through `write(setStore, updater)`: an event-only category.
const storeWriter = $(function* (event: MouseEvent) {
  const count = yield* readStore(store, s => s.items.length);
  yield* write(setStore, s => {
    s.items.push({ id: count + event.detail, name: "new" });
  });
});
type _storeWriter = [
  Expect<Equal<BlockWrites<typeof storeWriter>, typeof setStore>>,
  Expect<Equal<BlockReads<typeof storeWriter>, typeof store>>
];
const _storeWriterEvent: EventBlock<MouseEvent> = storeWriter;
// @ts-expect-error — a reactive host admits no Writes
createMemo(storeWriter);
// @ts-expect-error — nor does a JSX host
const _storeWriterJsx: JsxBlock<void> = storeWriter;
// @ts-expect-error — the updater is typed against the store's state
write(setStore, s => (s.nope = 1));

// --- Block-derived stores: createProjection / createStore / createOptimisticStore -----
interface Summary {
  total: number;
  label: string;
}
// Mutation form: the draft is the block's input; the shape comes from it.
const summarize = $(function* (draft: Summary) {
  draft.total = yield* count;
  draft.label = yield* label;
});
const summary = createProjection(summarize, {});
// Return form, parameterless: the shape comes from the value; the seed is a
// Partial of it.
const shaped = $(function* () {
  return { total: yield* count, label: "n" } as Summary;
});
const shapedSummary = createProjection(shaped, { total: 0 });
// Waiting and failing inside the derive.
const remote = $(function* (draft: Summary) {
  const user = yield* wait(fetchUser(yield* count), HttpError);
  draft.label = user.name;
});
const remoteSummary = createProjection(remote, { total: 0, label: "" });
const [derivedSummary, setDerivedSummary] = createStore(remote, {});
const [optimisticSummary, setOptimisticSummary] = createOptimisticStore(remote, {});
type _blockStores = [
  Expect<Equal<typeof summary, BlockStore<typeof summarize, Summary>>>,
  Expect<Equal<typeof shapedSummary, BlockStore<typeof shaped, Summary>>>,
  Expect<Equal<typeof remoteSummary, BlockStore<typeof remote, Summary>>>,
  Expect<Equal<typeof derivedSummary, BlockStore<typeof remote, Summary>>>,
  Expect<Equal<typeof setDerivedSummary, StoreSetter<Summary>>>,
  Expect<Equal<typeof optimisticSummary, BlockStore<typeof remote, Summary>>>,
  Expect<Equal<typeof setOptimisticSummary, StoreSetter<Summary>>>,
  // The store is still the plain state: properties read as usual.
  Expect<Equal<(typeof summary)["total"], number>>
];
setDerivedSummary(s => {
  s.total = 1;
});
// @ts-expect-error — the setter is typed against the shape
setDerivedSummary(s => (s.nope = 1));
// @ts-expect-error — the seed must be a Partial of the block's shape
createProjection(summarize, { total: "1" });
const wrongShape = $(function* (draft: Summary) {
  return { nope: yield* count };
});
// @ts-expect-error — the value must be void or the shape
createProjection(wrongShape, {});
// Reading a block-derived store: the selector result is inferred, the store
// root is the Read, and the projection's async status and errors are
// inherited exactly as through `createMemo(block)`.
const readsProjection = $(function* () {
  const total = yield* readStore(summary, s => s.total);
  const name = yield* readStore(remoteSummary, s => s.label);
  return `${name}:${total}`;
});
type _readsProjection = [
  Expect<Equal<BlockValue<typeof readsProjection>, string>>,
  Expect<Equal<BlockReads<typeof readsProjection>, typeof summary | typeof remoteSummary>>,
  Expect<Equal<BlockTasks<typeof readsProjection>, never>>,
  Expect<Equal<BlockFailures<typeof readsProjection>, never>>,
  Expect<Equal<BlockAsync<typeof readsProjection>, true>>,
  Expect<Equal<BlockErrors<typeof readsProjection>, HttpError>>
];
const readsSync = $(function* () {
  return yield* readStore(summary, s => s.label);
});
type _readsSync = [
  Expect<Equal<BlockAsync<typeof readsSync>, false>>,
  Expect<Equal<BlockErrors<typeof readsSync>, never>>
];
// Two hops: a derived store reading the async projection colors its readers.
const [relabeled] = createStore(
  $(function* (draft: { text: string }) {
    draft.text = (yield* readStore(remoteSummary, s => s.label)).toUpperCase();
  }),
  { text: "" }
);
const twoHops = $(function* () {
  return yield* readStore(relabeled, s => s.text);
});
type _twoHops = [
  Expect<Equal<BlockAsync<typeof twoHops>, true>>,
  Expect<Equal<BlockErrors<typeof twoHops>, HttpError>>
];
// Store hosts are reactive hosts: a block that writes is refused by all three.
const writingDerive = $(function* (draft: Summary) {
  yield* write(setCount, 1);
  draft.total = 1;
});
// @ts-expect-error — a projection admits no Writes
createProjection(writingDerive, {});
// @ts-expect-error — nor a derived store
createStore(writingDerive, {});
// @ts-expect-error — nor a derived optimistic store
createOptimisticStore(writingDerive, {});
// Explicit type arguments select the function form: a block is still callable.
const explicit = createProjection<Summary>(summarize, {});
type _explicit = [Expect<Equal<typeof explicit, Refreshable<Store<Summary>>>>];
// The ordinary-function and plain-value forms are unchanged.
const plainProjection = createProjection((draft: Summary) => {
  draft.total = 1;
}, {});
const inferredFromSeed = createProjection(
  draft => {
    draft.total = 1;
  },
  { total: 0 }
);
const [plainDerived] = createStore(async () => ({ total: 1, label: "" }), {} as Partial<Summary>);
const [plainStore, setPlainStore] = createStore({ total: 0 });
type _plainForms = [
  Expect<Equal<typeof plainProjection, Refreshable<Store<Summary>>>>,
  Expect<Equal<typeof inferredFromSeed, Refreshable<Store<{ total: number }>>>>,
  Expect<Equal<typeof plainDerived, Refreshable<Store<Summary>>>>,
  Expect<Equal<typeof plainStore, { total: number }>>,
  Expect<Equal<typeof setPlainStore, StoreSetter<{ total: number }>>>
];

// --- Direct property syntax (projected form) ------------------------------------
// `yield* store.user.name` is what authors write; `solid-tsc` projects it to
// the `readPath` / `readProp` op below before checking, so these assertions
// are the types the authored spelling receives.
type _pathValue = [
  Expect<Equal<PathValue<typeof store, readonly ["user", "name"]>, string>>,
  Expect<Equal<PathValue<typeof store, readonly ["items", 0, "name"]>, string>>,
  Expect<Equal<PathValue<typeof store, readonly ["items", number]>, { id: number; name: string }>>,
  Expect<Equal<PathValue<typeof store, readonly ["items", "length"]>, number>>,
  Expect<Equal<PathValue<typeof store, readonly ["nope"]>, unknown>>
];
declare const idx: number;
const paths = $(function* () {
  const name = yield* readPath(store, ["user", "name"]);
  const item = yield* readPath(store, ["items", idx]);
  const count = yield* readPath(store, ["items", "length"]);
  return { name, item, count };
});
type _paths = [
  Expect<
    Equal<
      BlockValue<typeof paths>,
      { name: string; item: { id: number; name: string }; count: number }
    >
  >,
  Expect<
    Equal<
      BlockReads<typeof paths>,
      | StoreRead<typeof store, readonly ["user", "name"]>
      | StoreRead<typeof store, readonly ["items", number]>
      | StoreRead<typeof store, readonly ["items", "length"]>
    >
  >,
  Expect<Equal<BlockTasks<typeof paths>, never>>,
  Expect<Equal<BlockAsync<typeof paths>, false>>,
  Expect<Equal<Admits<typeof paths>, true>>
];
// The lowered readers (what the compiler emits for the spelling above) carry
// the same selected-value types as the projected op: `readPathK` for K keys,
// `readPathN` beyond. They return the value directly (no op, no `perform`).
type _handleReaders = [
  Expect<Equal<ReturnType<typeof readHandle1>, { name: string }>>,
  Expect<Equal<ReturnType<typeof readHandle2>, string>>,
  Expect<Equal<ReturnType<typeof readHandle3>, string>>,
  Expect<Equal<ReturnType<typeof readHandleIndex>, { id: number; name: string }>>,
  Expect<Equal<ReturnType<typeof readHandleLength>, number>>,
  Expect<Equal<ReturnType<typeof readHandle4>, string>>,
  Expect<Equal<ReturnType<typeof readHandleN>, string>>
];
const readHandle1 = () => readPath1(store, "user");
const readHandle2 = () => readPath2(store, "user", "name");
const readHandle3 = () => readPath3(store, "items", 0, "name");
const readHandleIndex = () => readPath2(store, "items", idx);
const readHandleLength = () => readPath2(store, "items", "length");
declare const deepStore: { a: { b: { c: { d: { e: string } } } } };
const readHandle4 = () => readPath4(deepStore.a, "b", "c", "d", "e");
const readHandleN = () => readPathN(deepStore, ["a", "b", "c", "d", "e"]);
// A readable found at the path is read through, as `yield*` does.
declare const withAccessor: { filter: () => "all" | "done" };
type _handleReadThrough = Expect<
  Equal<ReturnType<typeof readHandleThrough>, ReturnType<typeof withAccessor.filter>>
>;
const [filterAccessor] = createSignal<"all" | "done">("all");
const holder = { filter: filterAccessor };
const readHandleThrough = () => readPath1(holder, "filter");
// Stage 2 handles: typed like the store they stand for.
const [handleStore] = createStoreHandle({
  user: { name: "Ada" },
  rows: [{ title: "a", meta: { done: false } }]
});
const handleRow = readHandleChild(handleStore, ["rows", 0]);
const handleName = () => readHandleAt2(handleStore, "user", "name");
const handleDone = () => readHandleAt2(handleRow, "meta", "done");
const handleProxy = () => storeProxy(handleStore).user;
type _handles = [
  Expect<Equal<ReturnType<typeof handleName>, string>>,
  Expect<Equal<ReturnType<typeof handleDone>, boolean>>,
  Expect<Equal<typeof handleRow, StoreHandle<{ title: string; meta: { done: boolean } }>>>,
  Expect<Equal<ReturnType<typeof handleProxy>, { name: string }>>
];
// @ts-expect-error — a handle is opaque: not the store's value
handleStore.user;
// `Borrowed<T>` is `T`: callers pass stores (or plain values) as usual.
declare function BorrowingRow(props: { todo: Borrowed<{ title: string }> }): unknown;
BorrowingRow({ todo: { title: "x" } });
declare const props: { count: number; user: { name: string } };
const propPaths = $(function* () {
  return `${yield* readProp(props, ["count"])}:${yield* readProp(props, ["user", "name"])}`;
});
type _propPaths = [
  Expect<Equal<BlockValue<typeof propPaths>, string>>,
  Expect<
    Equal<
      BlockReads<typeof propPaths>,
      PropRead<typeof props, readonly ["count"]> | PropRead<typeof props, readonly ["user", "name"]>
    >
  >
];
// A path whose value is itself readable (an accessor, a block) reads
// through it — `yield* props.filter` is the signal's value — and inherits
// its coloring (`writableUser` is a colored signal: async, HttpError).
declare const readableProps: {
  filter: typeof count;
  block: typeof paths;
  colored: typeof writableUser;
  fn: () => string;
};
const through = $(function* () {
  const f = yield* readProp(readableProps, ["filter"]);
  const b = yield* readProp(readableProps, ["block"]);
  const fn = yield* readProp(readableProps, ["fn"]);
  return { f, b, fn };
});
type _through = [
  Expect<Equal<PathResult<typeof readableProps, readonly ["filter"]>, number>>,
  Expect<
    Equal<
      BlockValue<typeof through>,
      {
        f: number;
        b: { name: string; item: { id: number; name: string }; count: number };
        fn: () => string;
      }
    >
  >,
  Expect<Equal<BlockAsync<typeof through>, false>>
];
const throughColored = $(function* () {
  return yield* readProp(readableProps, ["colored"]);
});
type _throughColored = [
  Expect<Equal<BlockAsync<typeof throughColored>, true>>,
  Expect<Equal<BlockErrors<typeof throughColored>, HttpError>>
];
// A wrong path selects `unknown`, so it cannot pretend to be the value.
// @ts-expect-error — `unknown` is not a string
const _wrong: string = perform(readPath(store, ["user", "nope"]));

// --- Failures: raise / attempt --------------------------------------------------
const fallible = $(function* () {
  const c = yield* count;
  if (c > 1) yield* raise(new NotFound());
  if (c < 0) yield* raise(new Forbidden());
  const text = yield* label;
  const parsed = yield* attempt(() => JSON.parse(text) as { a: number }, SyntaxError);
  return { tag: "p", text: `${parsed.a}` } as typeof view;
});
type _fallible = [
  Expect<Equal<BlockFailures<typeof fallible>, NotFound | Forbidden | SyntaxError>>,
  Expect<Equal<BlockTasks<typeof fallible>, never>>,
  Expect<Equal<BlockAsync<typeof fallible>, false>>,
  Expect<Equal<BlockValue<typeof fallible>, typeof view>>
];
// An undeclared attempt / wait is honest about what it knows: `unknown`.
const undeclared = $(function* () {
  return yield* attempt(() => JSON.parse("{}"));
});
type _undeclared = [Expect<Equal<BlockFailures<typeof undeclared>, unknown>>];

// --- Tasks: wait ------------------------------------------------------------------
const profile = $(function* () {
  const id = yield* count;
  const user = yield* wait(fetchUser(id), HttpError);
  return { tag: "p", text: user.name } as typeof view;
});
type _profile = [
  Expect<Equal<BlockTasks<typeof profile>, AsyncOp<{ name: string }, HttpError>>>,
  Expect<Equal<BlockFailures<typeof profile>, HttpError>>,
  Expect<Equal<BlockAsync<typeof profile>, true>>,
  Expect<Equal<BlockErrors<typeof profile>, HttpError>>,
  Expect<Equal<ReturnType<typeof profile>, Promise<typeof view>>>
];

// A path through a block-derived (colored) store colors the reader.
const coloredStore = createStore(profile, { tag: "p", text: "" } as typeof view);
const coloredPath = $(function* () {
  return yield* readPath(coloredStore[0], ["text"]);
});
type _coloredPath = [
  Expect<Equal<BlockValue<typeof coloredPath>, string>>,
  Expect<Equal<BlockAsync<typeof coloredPath>, true>>,
  Expect<Equal<BlockErrors<typeof coloredPath>, HttpError>>
];

// --- Writes -------------------------------------------------------------------------
const writer = $(function* (event: MouseEvent) {
  const c = yield* count;
  yield* write(setCount, c + event.detail);
  return c;
});
type _writer = [
  Expect<Equal<BlockWrites<typeof writer>, typeof setCount>>,
  Expect<Equal<BlockInput<typeof writer>, MouseEvent>>,
  Expect<Equal<BlockTasks<typeof writer>, never>>
];

// --- Transitive metadata through a memo made from a block: Reads only, yet
// --- pending / error-typed through the source ------------------------------------
const user = createMemo(profile);
const greeting = $(function* () {
  return { tag: "p", text: `Hi ${(yield* user).text}` } as typeof view;
});
type _greeting = [
  Expect<Equal<BlockTasks<typeof greeting>, never>>,
  Expect<Equal<BlockFailures<typeof greeting>, never>>,
  Expect<Equal<BlockAsync<typeof greeting>, true>>,
  Expect<Equal<BlockErrors<typeof greeting>, HttpError>>
];

// A writable memo made with createSignal retains the block metadata too.
const [writableUser, setWritableUser] = createSignal(profile);
setWritableUser(view);
const writableGreeting = $(function* () {
  return { tag: "p", text: `Hi ${(yield* writableUser).text}` } as typeof view;
});
type _writableGreeting = [
  Expect<Equal<ReturnType<typeof writableUser>, typeof view>>,
  Expect<Equal<BlockTasks<typeof writableGreeting>, never>>,
  Expect<Equal<BlockFailures<typeof writableGreeting>, never>>,
  Expect<Equal<BlockAsync<typeof writableGreeting>, true>>,
  Expect<Equal<BlockErrors<typeof writableGreeting>, HttpError>>
];

// --- Delegation accumulates the callee's categories ----------------------------------
const composed = $(function* (event: MouseEvent) {
  const page = yield* fallible;
  const name = yield* profile;
  const c = yield* call(writer, event);
  return [page, name, c] as const;
});
type _composed = [
  Expect<Equal<BlockAsync<typeof composed>, true>>,
  Expect<Equal<BlockWrites<typeof composed>, typeof setCount>>
];
// Deps and errors through delegation are asserted by mutual assignment: the
// unions are built from deferred conditional types, which identity checks
// (`Equal`, or `extends` inside a conditional) treat as distinct from their
// resolution even though they resolve on use.
declare const composedReads: BlockReads<typeof composed>;
declare const expectedComposedReads: typeof count | typeof label;
const _composedReadsA: typeof count | typeof label = composedReads;
const _composedReadsB: BlockReads<typeof composed> = expectedComposedReads;
declare const composedErrors: BlockErrors<typeof composed>;
declare const expectedComposedErrors: NotFound | Forbidden | SyntaxError | HttpError;
const _composedErrorsA: NotFound | Forbidden | SyntaxError | HttpError = composedErrors;
const _composedErrorsB: BlockErrors<typeof composed> = expectedComposedErrors;

// --- Reactive host: reads, tasks, failures admitted; writes refused ----------------------
createMemo(reads);
createMemo(fallible);
createMemo(profile);
createMemo(greeting);
createEffect(profile, () => {});
createSignal(fallible);
// @ts-expect-error — a reactive host admits no Writes
createMemo(writer);
// @ts-expect-error — the compute phase of an effect is a reactive host too
createEffect(writer, () => {});
// @ts-expect-error — nor a writable memo
createSignal(writer);
// @ts-expect-error — delegation carried the write in
createMemo(composed);

// --- JSX host: direct effects must be reads only --------------------------------------------
type Admits<B> = B extends JsxBlock<any> ? true : false;
type _jsx = [
  Expect<Equal<Admits<typeof reads>, true>>,
  Expect<Equal<Admits<typeof fromStore>, true>>,
  // Pending / error-typed through its Reads is fine:
  Expect<Equal<Admits<typeof greeting>, true>>,
  Expect<Equal<Admits<typeof profile>, false>>,
  Expect<Equal<Admits<typeof fallible>, false>>,
  Expect<Equal<Admits<typeof undeclared>, false>>,
  Expect<Equal<Admits<typeof writer>, false>>,
  Expect<Equal<Admits<typeof composed>, false>>
];
const _jsxOk: JsxBlock<typeof view> = greeting;
// @ts-expect-error — a task inside a JSX block
const _jsxTask: JsxBlock<typeof view> = profile;
// @ts-expect-error — an explicit failure inside a JSX block
const _jsxFailure: JsxBlock<typeof view> = fallible;
// @ts-expect-error — a write inside a JSX block
const _jsxWrite: JsxBlock<number> = writer;

// --- Event host: everything, with the event as input ---------------------------------------
const _eventOk: EventBlock<MouseEvent> = writer;
const _eventComposed: EventBlock<MouseEvent> = composed;
const _eventReadsOnly: EventBlock<MouseEvent> = reads; // input unknown: accepts any event
// @ts-expect-error — the block expects a MouseEvent, not a KeyboardEvent
const _eventWrongInput: EventBlock<KeyboardEvent> = writer;
// An ordinary handler is still an ordinary handler: no block typing is claimed.
const plainHandler = (e: MouseEvent) => setCount(e.detail);
type _plain = [Expect<Equal<BlockWrites<typeof plainHandler>, never>>];
// Calling it from a block is an untyped step: `attempt` records `unknown`.
const wrapsLegacy = $(function* (event: MouseEvent) {
  yield* attempt(() => plainHandler(event));
});
type _wrapsLegacy = [
  Expect<Equal<BlockFailures<typeof wrapsLegacy>, unknown>>,
  Expect<Equal<BlockWrites<typeof wrapsLegacy>, never>>
];

// --- Boundaries: loading removes async, errored subtracts ------------------------------------
const loaded = loading(profile, () => ({ tag: "p", text: "loading" }) as typeof view);
type _loaded = [
  Expect<Equal<BlockAsync<typeof loaded>, false>>,
  Expect<Equal<BlockErrors<typeof loaded>, HttpError>>,
  Expect<Equal<BlockValue<typeof loaded>, typeof view>>,
  Expect<Equal<Admits<typeof loaded>, true>>
];
const handled = errored(fallible, [NotFound], () => ({ tag: "p", text: "missing" }) as typeof view);
type _handled = [
  Expect<Equal<BlockErrors<typeof handled>, Forbidden | SyntaxError>>,
  Expect<Equal<BlockAsync<typeof handled>, false>>,
  Expect<Equal<Admits<typeof handled>, true>>
];
const settledView = errored(handled, [Forbidden, SyntaxError], error => {
  const _narrowed: Forbidden | SyntaxError = error;
  return { tag: "p", text: "denied" } as typeof view;
});
type _settled = [Expect<Equal<BlockErrors<typeof settledView>, never>>];
const stillAsync = errored(profile, [HttpError], () => view);
type _stillAsync = [
  Expect<Equal<BlockAsync<typeof stillAsync>, true>>,
  Expect<Equal<BlockErrors<typeof stillAsync>, never>>
];
// @ts-expect-error — boundaries are reactive hosts: no Writes
loading(writer, () => 0);

// --- Forbidden spellings ----------------------------------------------------------------------
// @ts-expect-error — a bare yield of a signal is not an operation
$(function* () {
  yield count;
  return 1;
});
// @ts-expect-error — plain values cannot be yielded
$(function* () {
  yield 42;
  return 1;
});
// @ts-expect-error — async generators (await) are not blocks
$(async function* () {
  return 1;
});
// A plain callback is the strict compilation marker: a branded callback the
// host receives unchanged once the compiler erases the marker. The brand
// records the request only; the graph is the compiler's summary.
const strictMemo = createMemo($(() => count() * 2));
const strictAsync = createMemo($(async () => count()));
const strictEvent = $((event: MouseEvent) => event.button);
type _strict = [
  Expect<Equal<typeof strictMemo, SourceAccessor<number>>>,
  Expect<Equal<typeof strictAsync, SourceAccessor<number>>>,
  Expect<Equal<typeof strictEvent, StrictCallback<MouseEvent, number>>>
];
createEffect(
  $(() => count()),
  value => {
    const _n: number = value;
  }
);
// A strict callback is not a block: it carries no effect metadata.
type _notABlock = Expect<Equal<BlockReads<typeof strictEvent>, never>>;
// @ts-expect-error — raise never returns: the value must come from another path
const _unreachable: never = $(function* () {
  yield* raise(new NotFound());
  return 1;
});

export {};
