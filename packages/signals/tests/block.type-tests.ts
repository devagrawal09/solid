// Type-level contract of `$` blocks and their hosts (checked by `tsc`).
import {
  $,
  attempt,
  call,
  createEffect,
  createMemo,
  createSignal,
  createStore,
  errored,
  loading,
  raise,
  readStore,
  wait,
  write,
  type AsyncOp,
  type BlockAsync,
  type BlockErrors,
  type BlockFailures,
  type BlockInput,
  type BlockReads,
  type BlockTasks,
  type BlockValue,
  type BlockWrites,
  type EventBlock,
  type JsxBlock
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
  // Store types carry no metadata, so derived totals stay quiet (documented).
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
// @ts-expect-error — a plain function is not a block source (call form is compiler output)
$(() => count());
// @ts-expect-error — raise never returns: the value must come from another path
const _unreachable: never = $(function* () {
  yield* raise(new NotFound());
  return 1;
});

export {};
