/**
 * @jsxImportSource @solidjs/web
 */
// Store handles end to end (optimization Track B, slice 2, stage 2). This
// module is compiled with the compiler's `storeHandles` option by
// vite.config.store-handles*.mjs:
//
// - `App`'s store has lowered path reads, so it is created as a handle
//   (`_$createStoreHandle`) and read with `_$readHandleK` — no Proxy [[Get]];
// - `<Row todo={store.todos[0]} />` hands a CHILD HANDLE to `Row`, whose
//   `todo: Borrowed<Todo>` contract the compiler verifies (every use of
//   `props.todo` is a lowered path read), so `Row` reads it with
//   `_$readBorrowed`;
// - `<For each={store.todos}>`, `snapshot(store)` and `api.store = store` are
//   escapes: each becomes `_$storeProxy(store)` — the one compatibility
//   proxy, materialized there — so `For` rows are proxies, which `Row`'s
//   borrowed reads accept as well.
//
// `AppHandwritten` renders the same markup with ordinary proxy reads (no
// lowered reads, so its store is left alone): the specs compare the two.
// The compiler lowering of this exact file is pinned by
// packages/compiler/__tests__/store-handles.test.js.
// @ts-nocheck — authored `yield*` operands are values (checked by solid-tsc).
import { $, createStore, For, snapshot, type Borrowed } from "solid-js";

export interface Todo {
  id: number;
  title: string;
  meta: { done: boolean };
}

/** Row block runs by label. */
export const rowRuns: Record<string, number> = {};

function Row(props: { todo: Borrowed<Todo>; label: string }) {
  return $(function* () {
    rowRuns[props.label] = (rowRuns[props.label] ?? 0) + 1;
    return (
      <li class={{ done: yield* props.todo.meta.done }}>
        {yield* props.todo.title}:{yield* props.label}
      </li>
    );
  });
}

function initial() {
  return {
    user: { name: "Ada" },
    todos: [
      { id: 1, title: "one", meta: { done: false } },
      { id: 2, title: "two", meta: { done: true } }
    ] as Todo[]
  };
}

export const api: { setStore?: any; store?: any; snapshot?: () => unknown } = {};

export function App(): JSX.Element {
  // A literal initializer: a call could return a function (the derived
  // form), so only literals qualify for a handle.
  const [store, setStore] = createStore({
    user: { name: "Ada" },
    todos: [
      { id: 1, title: "one", meta: { done: false } },
      { id: 2, title: "two", meta: { done: true } }
    ] as Todo[]
  });
  api.setStore = setStore;
  api.store = store;
  api.snapshot = () => snapshot(store);
  return $(function* () {
    return (
      <div>
        <h1>{yield* store.user.name}</h1>
        <ul>
          <Row todo={store.todos[0]} label="first" />
          <Row todo={store.todos[1]} label="second" />
        </ul>
        <p>{yield* store.todos.length}</p>
        <ol>
          <For each={store.todos}>{todo => <Row todo={todo} label="for" />}</For>
        </ol>
      </div>
    );
  });
}

function PlainRow(props: { todo: Todo; label: string }) {
  return (
    <li class={{ done: props.todo.meta.done }}>
      {props.todo.title}:{props.label}
    </li>
  );
}

export const handwrittenApi: { setStore?: any } = {};

export function AppHandwritten() {
  const [store, setStore] = createStore(initial());
  handwrittenApi.setStore = setStore;
  return (
    <div>
      <h1>{store.user.name}</h1>
      <ul>
        <PlainRow todo={store.todos[0]} label="first" />
        <PlainRow todo={store.todos[1]} label="second" />
      </ul>
      <p>{store.todos.length}</p>
      <ol>
        <For each={store.todos}>{todo => <PlainRow todo={todo} label="for" />}</For>
      </ol>
    </div>
  );
}
