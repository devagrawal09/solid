// Store handles (`storeHandles`, optimization Track B, slice 2, stage 2):
// the compiler holds a module-local store as a proxy-free handle when its
// uses are lowered path reads, wraps every other use in `_$storeProxy(s)`,
// verifies `Borrowed<T>` prop contracts, and emits the module's store
// summary for a linker. These tests pin positive lowering, every refusal,
// escape wrapping, contract verification and violations, linker facts, and
// the summary contract.

const fs = require("fs");
const path = require("path");
const { transform } = require("..");

const compile = (code, extra = {}) =>
  transform(code, { filename: "src/app.tsx", generate: "dom", storeHandles: true, ...extra });

/** The rewritten module still parses (TypeScript + JSX-free output). */
function parses(code) {
  const esbuild = require("esbuild");
  expect(() => esbuild.transformSync(code, { loader: "tsx" })).not.toThrow();
}

const header = `import { $, createStore, readStore, For, type Borrowed } from "solid-js";\n`;

describe("storeHandles: positive lowering", () => {
  it("creates a handle, reads through handle readers, and wraps every other use", () => {
    const { code, storeSummary } = compile(
      header +
        `export function App() {
  const [store, setStore] = createStore({ user: { name: "Ada" }, rows: [{ title: "a" }] });
  const name = $(function* () { return yield* store.user.name; });
  const deep = $(function* () { return yield* store.rows[0].title; });
  log(store);
  const { user } = store;
  const copy = { ...store };
  const obj = { store };
  for (const k in store) k;
  const picked = $(function* () { return yield* readStore(store, s => s.rows.map(r => r.title)); });
  return [name, deep, setStore, user, copy, obj, picked, <div {...store} />];
}
`
    );
    parses(code);
    expect(code).toContain("const [store, setStore] = _$createStoreHandle({");
    expect(code).toContain('_$readHandle2(store, "user", "name")');
    expect(code).toContain('_$readHandle3(store, "rows", 0, "title")');
    expect(code).toContain("log(_$storeProxy(store))");
    expect(code).toContain("const { user } = _$storeProxy(store)");
    expect(code).toContain("..._$storeProxy(store)");
    // A shorthand property is expanded so the value can be wrapped.
    expect(code).toContain("store: _$storeProxy(store)");
    expect(code).toContain("for (const k in _$storeProxy(store))");
    // Structural selectors keep proxy semantics.
    expect(code).toContain("readStore(_$storeProxy(store), (s) =>");
    expect(code).not.toMatch(/[^$]createStore\(/);
    expect(code).not.toMatch(/_\$readPath\d\(/);
    const [store] = storeSummary.stores;
    expect(store).toMatchObject({
      binding: "store",
      handle: true,
      refused: null,
      reads: 2,
      setter: true,
      proxyFree: false
    });
    expect(store.escapes.map(e => e.kind)).toEqual([
      "call-arg",
      "alias",
      "spread",
      "object-value",
      "for-in",
      "call-arg",
      "jsx-spread"
    ]);
    expect(store.escapes[0]).toMatchObject({ detail: "log" });
  });

  it("a store with only path reads and no setter is proxy-free", () => {
    const { code, storeSummary } = compile(
      header +
        `const [config] = createStore({ theme: { mode: "dark" } });
export const mode = $(function* () { return yield* config.theme.mode; });
`
    );
    expect(code).toContain("_$createStoreHandle(");
    expect(code).not.toContain("_$storeProxy");
    expect(storeSummary.stores[0]).toMatchObject({ handle: true, proxyFree: true, escapes: [] });
  });

  it("imports only the helpers it uses, into the runtime import", () => {
    const { code } = compile(
      header +
        `const [s] = createStore({ a: { b: 1 } });
export const b = $(function* () { return yield* s.a.b; });
`
    );
    expect(code).toMatch(
      /import \{ \$, createStore, readStore, For, type Borrowed, perform as _\$perform, readPath2 as _\$readPath2, createStoreHandle as _\$createStoreHandle, readHandle2 as _\$readHandle2 \} from "solid-js";/
    );
  });

  it("lowers the same way for SSR", () => {
    const { code } = compile(
      header +
        `export function App() {
  const [store] = createStore({ user: { name: "Ada" } });
  return $(function* () { return <p>{yield* store.user.name}</p>; });
}
`,
      { generate: "ssr", hydratable: true }
    );
    expect(code).toContain("_$createStoreHandle(");
    expect(code).toContain('_$readHandle2(store, "user", "name")');
  });
});

describe("storeHandles: refusals keep createStore and the stage-1 readers", () => {
  const cases = {
    exported: `export const [s] = createStore({ a: 1 });
export const r = $(function* () { return yield* s.a; });`,
    "export-specifier": `const [s] = createStore({ a: 1 });
export const r = $(function* () { return yield* s.a; });
export { s };`,
    "derived-form": `const [s] = createStore(() => ({ a: 1 }), {});
export const r = $(function* () { return yield* s.a; });`,
    "non-literal-initial": `const init = { a: 1 };
const [s] = createStore(init);
export const r = $(function* () { return yield* s.a; });`,
    "not-const": `let [s] = createStore({ a: 1 });
export const r = $(function* () { return yield* s.a; });`,
    pattern: `const [s, set, extra] = createStore({ a: 1 });
export const r = $(function* () { return yield* s.a; });`,
    "no-lowered-reads": `const [s] = createStore({ a: 1 });
export const r = () => s.a;`,
    "jsx-member-name": `const [s] = createStore({ C: () => null, a: 1 });
export const r = $(function* () { return yield* s.a; });
export const el = <s.C />;`
  };
  for (const [name, source] of Object.entries(cases)) {
    it(name, () => {
      const { code, storeSummary } = compile(header + source + "\n");
      expect(code).not.toContain("_$createStoreHandle");
      expect(code).not.toContain("_$readHandle");
      expect(code).not.toContain("_$storeProxy");
      const [store] = storeSummary.stores;
      expect(store.handle).toBe(false);
      const expected = {
        "export-specifier": /^unsupported-reference:ExportSpecifier@/,
        "jsx-member-name": /^unsupported-reference:/
      }[name];
      if (expected) expect(store.refused).toMatch(expected);
      else expect(store.refused).toBe(name);
    });
  }

  it("is off by default: no summary, stage-1 output", () => {
    const source =
      header +
      `const [s] = createStore({ a: 1 });\nexport const r = $(function* () { return yield* s.a; });\n`;
    const off = transform(source, { filename: "src/app.tsx", generate: "dom" });
    expect(off.storeSummary).toBeUndefined();
    expect(off.code).toContain('_$readPath1(s, "a")');
    expect(off.code).not.toContain("_$createStoreHandle");
  });
});

describe("storeHandles: Borrowed contracts", () => {
  const row = `interface Todo { title: string; meta: { done: boolean } }
function Row(props: { todo: Borrowed<Todo>; label: string }) {
  return $(function* () { return <li>{yield* props.todo.title}{yield* props.todo.meta.done}{yield* props.label}</li>; });
}
`;
  it("a verified prop reads with readBorrowed; a local caller hands it a child handle", () => {
    const { code, storeSummary } = compile(
      header +
        row +
        `export function App() {
  const [store] = createStore({ rows: [{ title: "a", meta: { done: false } }] });
  const i = 0;
  return $(function* () {
    return <ul><Row todo={store.rows[i]} label="x" /><Row todo={store.rows[0]} label="y" /><p>{yield* store.rows.length}</p></ul>;
  });
}
`
    );
    expect(code).toMatch(/const _\$keys1 = \["todo", "title"\];/);
    expect(code).toContain("_$readBorrowed(props, _$keys1)");
    // Non-borrowed props keep the ordinary reader.
    expect(code).toContain('_$readPath1(props, "label")');
    expect(code).toContain('_$readHandleChild(store, ["rows", i])');
    expect(code).toMatch(/_\$readHandleChild\(store, _\$keys\d\)/);
    expect(storeSummary.components).toEqual([
      {
        name: "Row",
        exported: false,
        borrowed: [{ prop: "todo", verified: true, reads: 2, violations: [] }]
      }
    ]);
    expect(storeSummary.stores[0].handoffs).toEqual([
      { component: "Row", prop: "todo", via: "local" },
      { component: "Row", prop: "todo", via: "local" }
    ]);
  });

  it("interface and type-alias contracts are recognized", () => {
    for (const decl of [
      `interface RowProps { todo: Borrowed<{ title: string }> }`,
      `type RowProps = { todo: Borrowed<{ title: string }> } & { other?: number }`
    ]) {
      const { storeSummary } = compile(
        header +
          `${decl}
export function Row(props: RowProps) { return $(function* () { return <b>{yield* props.todo.title}</b>; }); }
`
      );
      expect(storeSummary.components[0]).toMatchObject({
        name: "Row",
        exported: true,
        borrowed: [{ prop: "todo", verified: true }]
      });
    }
  });

  const violations = {
    "prop-escape": `console.log(props.todo);`,
    "props-escape": `const all = { ...props };`,
    "dynamic-prop-read": null
  };
  for (const [kind, statement] of Object.entries(violations)) {
    if (!statement) continue;
    it(`a violation deoptimizes: ${kind}`, () => {
      const { code, storeSummary } = compile(
        header +
          `function Row(props: { todo: Borrowed<{ title: string }> }) {
  ${statement}
  return $(function* () { return <b>{yield* props.todo.title}</b>; });
}
export function App() {
  const [store] = createStore({ rows: [{ title: "a" }] });
  return $(function* () { return <div><Row todo={store.rows[0]} /><p>{yield* store.rows.length}</p></div>; });
}
`
      );
      expect(code).not.toContain("_$readBorrowed");
      expect(code).toContain('_$readPath2(props, "todo", "title")');
      // The caller passes the proxy, not a handle.
      expect(code).toContain("_$storeProxy(store).rows[0]");
      const prop = storeSummary.components[0].borrowed[0];
      expect(prop.verified).toBe(false);
      expect(prop.violations[0].kind).toBe(kind);
      expect(storeSummary.stores[0].handoffs).toEqual([]);
    });
  }

  it("forwarding to a verified borrower keeps the contract (fixed point)", () => {
    const { code, storeSummary } = compile(
      header +
        `function Inner(props: { todo: Borrowed<{ title: string }> }) {
  return $(function* () { return <b>{yield* props.todo.title}</b>; });
}
function Outer(props: { todo: Borrowed<{ title: string }> }) {
  return <Inner todo={props.todo} />;
}
function Leaky(props: { todo: Borrowed<{ title: string }> }) {
  return <Unknown todo={props.todo} />;
}
`
    );
    const byName = Object.fromEntries(
      storeSummary.components.map(c => [c.name, c.borrowed[0].verified])
    );
    expect(byName).toEqual({ Inner: true, Outer: true, Leaky: false });
    expect(code).toContain("_$readBorrowed(props,");
  });

  it("a caller passes a proxy to an unverified or undeclared prop", () => {
    const { code } = compile(
      header +
        `function Plain(props: { todo: { title: string } }) {
  return $(function* () { return <b>{yield* props.todo.title}</b>; });
}
export function App() {
  const [store] = createStore({ rows: [{ title: "a" }] });
  return $(function* () { return <div><Plain todo={store.rows[0]} /><p>{yield* store.rows.length}</p></div>; });
}
`
    );
    expect(code).toContain("_$storeProxy(store).rows[0]");
    expect(code).not.toContain("_$readHandleChild");
  });
});

describe("storeHandles: cross-module contract (linker facts)", () => {
  const source =
    header +
    `import { Row } from "./row";
export function App() {
  const [store] = createStore({ rows: [{ title: "a" }] });
  return $(function* () { return <div><Row todo={store.rows[0]} /><p>{yield* store.rows.length}</p></div>; });
}
`;
  it("without facts, an imported component gets the proxy and the summary asks the linker", () => {
    const { code, storeSummary } = compile(source);
    expect(code).toContain("_$storeProxy(store).rows[0]");
    expect(storeSummary.requires).toEqual([
      { source: "./row", export: "Row", prop: "todo", status: "unknown" }
    ]);
  });
  it("with the linker's fact, the imported component gets a handle", () => {
    const { code, storeSummary } = compile(source, {
      storeLinkFacts: { borrowed: { "./row": { Row: ["todo"] } } }
    });
    expect(code).toMatch(/_\$readHandleChild\(store, _\$keys\d\)/);
    expect(storeSummary.requires[0].status).toBe("linked");
    expect(storeSummary.stores[0].handoffs).toEqual([
      { component: "Row", prop: "todo", via: "import:./row" }
    ]);
  });
  it("rejects malformed facts", () => {
    expect(() =>
      compile(source, { storeLinkFacts: { borrowed: { "./row": { Row: "todo" } } } })
    ).toThrow(/storeLinkFacts/);
  });
});

describe("storeHandles: the web end-to-end module", () => {
  it("lowers packages/web/test/store-handles/app.tsx as its specs assume", () => {
    const file = path.resolve(__dirname, "../../web/test/store-handles/app.tsx");
    const { code, storeSummary } = transform(fs.readFileSync(file, "utf8"), {
      filename: "app.tsx",
      generate: "dom",
      storeHandles: true
    });
    parses(code);
    expect(code).toContain("] = _$createStoreHandle({");
    const app = storeSummary.stores.find(s => s.binding === "store" && s.handle);
    expect(app).toBeDefined();
    expect(app.handoffs.length).toBe(2);
    expect(app.escapes.map(e => e.kind)).toEqual(["assignment", "call-arg", "member"]);
    const handwritten = storeSummary.stores.find(s => s.binding === "store" && !s.handle);
    expect(handwritten.refused).toBe("non-literal-initial");
    expect(storeSummary.components.find(c => c.name === "Row").borrowed[0].verified).toBe(true);
  });
});
