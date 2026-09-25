/**
 * @jsxImportSource @solidjs/web
 *
 * Hydration-parity scenarios for `$` typed blocks rendered as JSX (the
 * strict-mode shape: a component returns `$(function* () { return <…/> })`).
 *
 * Consumed through test/harness/scenarios.tsx by both harness halves, so each
 * scenario is compiled once with the ssr generate and once with the dom
 * generate; the generator pass lowers the `yield*` reads ahead of JSX
 * lowering on both sides. The invariants asserted are the harness's usual
 * ones (no hydration warnings, no client-created nodes, node identity across
 * the post-hydration update) — for blocks the question they answer is whether
 * the block's content consumed the same hydration-id slots on the server as
 * on the client.
 *
 * Coverage: block-returned JSX at the root and inside element holes with
 * id-allocating siblings, branches inside blocks, nested block components,
 * lists of block rows, blocks under `<Show>`, `<Loading>` and `<Errored>`,
 * and store path / structural reads.
 *
 * The direct store-path spelling (`yield* store.user.name`) is typed only by
 * the projected checker (`solid-tsc`, packages/typecheck); stock `tsc` cannot
 * type it, so this file skips the package `tsc` run like test/paths.spec.tsx.
 */
// @ts-nocheck
import {
  $,
  createMemo,
  createSignal,
  createStore,
  Errored,
  For,
  Loading,
  readStore,
  Show,
  type SourceAccessor
} from "solid-js";
import type { Scenario } from "./scenarios.jsx";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// B1. A component returning a block at the hydration root: text read beside
// a static sibling.
let setBlockRootCount!: (v: number) => void;
function BlockRootText() {
  const [count, set] = createSignal(1);
  setBlockRootCount = set;
  return $(function* () {
    return (
      <div>
        <p>Count: {yield* count}</p>
        <span>tail</span>
      </div>
    );
  });
}

// ---------------------------------------------------------------------------
// B2. Block-returned JSX as a component child of an element, with
// id-allocating siblings AFTER it (a condition memo, a text hole, a second
// block component). The server resolves the block while evaluating the
// template's holes; the client renders it from an insert effect — the two
// must still spend the same slots.
function BlockLeaf(props: { label: string }) {
  const [n] = createSignal(1);
  return $(function* () {
    return (
      <b>
        {props.label}
        {yield* n}
      </b>
    );
  });
}
let setBlockHoleTail!: (v: string) => void;
function BlockInElementHole() {
  const [tail, set] = createSignal("t1");
  setBlockHoleTail = set;
  const [flag] = createSignal(true);
  return (
    <div>
      <BlockLeaf label="a" />
      {flag() && <h4>head</h4>}
      <span>{tail()}</span>
      <BlockLeaf label="b" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// B3. A branch inside a block (condition memo) before a static sibling, with
// a post-hydration flip.
let setBlockBranch!: (v: boolean) => void;
function BlockBranch() {
  const [on, set] = createSignal(true);
  setBlockBranch = set;
  return $(function* () {
    return (
      <div>
        {(yield* on) ? <b>yes</b> : <i>no</i>}
        <span>sib</span>
      </div>
    );
  });
}

// ---------------------------------------------------------------------------
// B4. Nested block components three deep, with a <Show> and a plain sibling
// at the middle level and the same leaf rendered twice from different depths.
let setNestedLabel!: (v: string) => void;
function NestedInner(props: { label: SourceAccessor<string> }) {
  return $(function* () {
    return <i>{yield* props.label}</i>;
  });
}
function NestedMiddle(props: { label: SourceAccessor<string>; show: SourceAccessor<boolean> }) {
  return $(function* () {
    return (
      <section>
        <Show when={yield* props.show}>
          <u>mid</u>
        </Show>
        <NestedInner label={props.label} />
        <span>end</span>
      </section>
    );
  });
}
function BlockNestedComponents() {
  const [label, set] = createSignal("L1");
  setNestedLabel = set;
  const [show] = createSignal(true);
  return $(function* () {
    return (
      <div>
        <NestedMiddle label={label} show={show} />
        <NestedInner label={label} />
      </div>
    );
  });
}

// ---------------------------------------------------------------------------
// B5. A list whose rows are block components, followed by a sibling, with a
// post-hydration append.
let setBlockRows!: (v: string[]) => void;
function BlockRow(props: { item: string }) {
  const [hits] = createSignal(0);
  return $(function* () {
    return (
      <li>
        {props.item}:{yield* hits}
      </li>
    );
  });
}
function BlockList() {
  const [items, set] = createSignal(["a", "b"]);
  setBlockRows = set;
  return $(function* () {
    return (
      <>
        <ul>
          <For each={yield* items}>{item => <BlockRow item={item} />}</For>
        </ul>
        <button id="after-list">after</button>
      </>
    );
  });
}

// ---------------------------------------------------------------------------
// B6. A block component as the children of <Show>, with a fallback and a
// static sibling; the update swaps to the fallback.
let setBlockShow!: (v: boolean) => void;
function BlockShowChild() {
  const [visible, set] = createSignal(true);
  setBlockShow = set;
  return (
    <div>
      <Show when={visible()} fallback={<p>hidden</p>}>
        <BlockLeaf label="s" />
      </Show>
      <span>tail</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B7. A block reading an async memo under <Loading> (streamed), beside a
// static sibling inside the boundary.
let refreshBlockAsync!: () => void;
function BlockAsyncContent() {
  const [version, setVersion] = createSignal(0);
  refreshBlockAsync = () => setVersion(v => v + 1);
  const data = createMemo(async () => {
    const v = version();
    await sleep(5);
    return 42 + v;
  });
  return $(function* () {
    return <div>Value: {yield* data}</div>;
  });
}
function BlockLoading() {
  return (
    <Loading fallback={<p>loading</p>}>
      <BlockAsyncContent />
      <span>tail</span>
    </Loading>
  );
}

// ---------------------------------------------------------------------------
// B8. A block reading a memo that throws, under <Errored>: the server renders
// the fallback and serializes the error; the client adopts the fallback.
function BlockThrows() {
  const boom = createMemo((): string => {
    throw new Error("boom");
  });
  return $(function* () {
    return <p>{yield* boom}</p>;
  });
}
// Control: the same shape with a plain component (no block).
function PlainThrows() {
  const boom = createMemo((): string => {
    throw new Error("boom");
  });
  return <p>{boom()}</p>;
}
function PlainErroredControl() {
  return (
    <div>
      <Errored fallback={<p>caught</p>}>
        <PlainThrows />
      </Errored>
      <span>tail</span>
    </div>
  );
}
function BlockErrored() {
  return (
    <div>
      <Errored fallback={<p>caught</p>}>
        <BlockThrows />
      </Errored>
      <span>tail</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B9. Store reads inside a block: a direct path read (`yield* store.user.name`,
// lowered to a tracked path read), a structural `readStore` selector feeding a
// <For>, and a structural length read after it.
let updateBlockStore!: () => void;
function BlockStore() {
  const [store, setStore] = createStore({
    user: { name: "Ada" },
    items: [{ id: 1 }, { id: 2 }]
  });
  updateBlockStore = () =>
    setStore(s => {
      s.user.name = "Bob";
      s.items.push({ id: 3 });
    });
  return $(function* () {
    return (
      <div>
        <b>{yield* store.user.name}</b>
        <For each={yield* readStore(store, s => s.items)}>{item => <i>{item.id}</i>}</For>
        <span>{yield* readStore(store, s => s.items.length)}</span>
      </div>
    );
  });
}

// ---------------------------------------------------------------------------
// B10. A block whose element hole holds a block component chosen by a branch,
// nested one more level (block → branch → block), before a text hole.
let setBlockPick!: (v: boolean) => void;
function BlockPickBranch() {
  const [pick, set] = createSignal(true);
  setBlockPick = set;
  const [suffix] = createSignal("!");
  return $(function* () {
    return (
      <div>
        {(yield* pick) ? <BlockLeaf label="x" /> : <BlockLeaf label="y" />}
        <span>{yield* suffix}</span>
      </div>
    );
  });
}

// ---------------------------------------------------------------------------
// B11. A block that reads an async memo in its BODY (not inside a JSX hole):
// the server's first evaluation throws NotReady and the boundary retries the
// block after the promise settles, while the hydrating client reads the
// serialized value and renders once. The block's id scope makes the retry
// allocate exactly what the single client run allocates.
let refreshBlockDirect!: () => void;
function BlockDirectAsync() {
  const [version, setVersion] = createSignal(0);
  refreshBlockDirect = () => setVersion(v => v + 1);
  const user = createMemo(async () => {
    const v = version();
    await sleep(5);
    return { name: "ada" + v, tags: ["a", "b"] };
  });
  return $(function* () {
    const u = yield* user;
    return (
      <div>
        <b>{u.name}</b>
        <For each={u.tags}>{tag => <i>{tag}</i>}</For>
      </div>
    );
  });
}
function BlockDirectAsyncLoading() {
  const [flag] = createSignal(true);
  return (
    <Loading fallback={<p>loading</p>}>
      <BlockDirectAsync />
      {flag() && <h4>after</h4>}
      <span>tail</span>
    </Loading>
  );
}

// ---------------------------------------------------------------------------
// B12. List rows that are block components reading store paths
// (`yield* row.label`, lowered to a tracked path read) with a structural
// store write after hydration.
let renameBlockRow!: () => void;
function StoreRowBlock(props: { row: { label: string; done: boolean } }) {
  const row = props.row;
  return $(function* () {
    return <li class={{ done: yield* row.done }}>{yield* row.label}</li>;
  });
}
function BlockStoreRows() {
  const [store, setStore] = createStore({
    rows: [
      { label: "one", done: false },
      { label: "two", done: true }
    ]
  });
  renameBlockRow = () =>
    setStore(s => {
      s.rows[0].label = "uno";
    });
  return (
    <ul>
      <For each={store.rows}>{row => <StoreRowBlock row={row} />}</For>
    </ul>
  );
}

// ---------------------------------------------------------------------------
// B13. A block under <Show> followed by id-allocating siblings (a condition
// memo and another block component): the block's content is rendered from
// Show's value by the sink, after the siblings registered on both sides.
let setShowThenSiblings!: (v: boolean) => void;
function BlockShowThenSiblings() {
  const [visible, set] = createSignal(true);
  setShowThenSiblings = set;
  const [flag] = createSignal(true);
  return (
    <div>
      <Show when={visible()} fallback={<p>hidden</p>}>
        <BlockLeaf label="s" />
      </Show>
      {flag() && <h4>head</h4>}
      <BlockLeaf label="t" />
    </div>
  );
}

export const blockScenarios: Scenario[] = [
  {
    name: "block-root-text",
    App: BlockRootText,
    expectedText: "Count: 1tail",
    update: () => setBlockRootCount(2),
    expectedTextAfterUpdate: "Count: 2tail",
    stableSelector: "div, p, span"
  },
  {
    name: "block-in-element-hole",
    App: BlockInElementHole,
    expectedText: "a1headt1b1",
    update: () => setBlockHoleTail("t2"),
    expectedTextAfterUpdate: "a1headt2b1",
    stableSelector: "div, b, h4, span"
  },
  {
    name: "block-branch",
    App: BlockBranch,
    expectedText: "yessib",
    update: () => setBlockBranch(false),
    expectedTextAfterUpdate: "nosib",
    stableSelector: "div, span"
  },
  {
    name: "block-nested-components",
    App: BlockNestedComponents,
    expectedText: "midL1endL1",
    update: () => setNestedLabel("L2"),
    expectedTextAfterUpdate: "midL2endL2",
    stableSelector: "div, section, u, i, span"
  },
  {
    name: "block-list",
    App: BlockList,
    expectedText: "a:0b:0after",
    update: () => setBlockRows(["a", "b", "c"]),
    expectedTextAfterUpdate: "a:0b:0c:0after",
    stableSelector: "ul, button"
  },
  {
    name: "block-show-child",
    App: BlockShowChild,
    expectedText: "s1tail",
    update: () => setBlockShow(false),
    expectedTextAfterUpdate: "hiddentail",
    stableSelector: "div, span"
  },
  {
    name: "block-loading",
    App: BlockLoading,
    async: true,
    expectedText: "Value: 42tail",
    update: () => refreshBlockAsync(),
    expectedTextAfterUpdate: "Value: 43tail",
    stableSelector: "div, span"
  },
  {
    name: "block-errored",
    App: BlockErrored,
    expectedText: "caughttail",
    stableSelector: "div, p, span"
  },
  {
    name: "block-errored-plain-control",
    App: PlainErroredControl,
    expectedText: "caughttail",
    stableSelector: "div, p, span"
  },
  {
    name: "block-store",
    App: BlockStore,
    expectedText: "Ada122",
    update: () => updateBlockStore(),
    expectedTextAfterUpdate: "Bob1233",
    stableSelector: "div, b, span"
  },
  {
    name: "block-direct-async",
    App: BlockDirectAsyncLoading,
    async: true,
    expectedText: "ada0abaftertail",
    update: () => refreshBlockDirect(),
    expectedTextAfterUpdate: "ada1abaftertail",
    stableSelector: "h4, span"
  },
  {
    name: "block-store-rows",
    App: BlockStoreRows,
    expectedText: "onetwo",
    update: () => renameBlockRow(),
    expectedTextAfterUpdate: "unotwo",
    stableSelector: "ul, li"
  },
  {
    name: "block-show-then-siblings",
    App: BlockShowThenSiblings,
    expectedText: "s1headt1",
    update: () => setShowThenSiblings(false),
    expectedTextAfterUpdate: "hiddenheadt1",
    stableSelector: "div, h4"
  },
  {
    name: "block-pick-branch",
    App: BlockPickBranch,
    expectedText: "x1!",
    update: () => setBlockPick(false),
    expectedTextAfterUpdate: "y1!",
    stableSelector: "div, span"
  }
];
