// The blocks type linker's per-module summary: analysis only, versioned JSON.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeBlocks, transform } = require("../index.js");

const source = `
import { $component, $memo, $signal, attempt, raise, type TypedProps } from "@solidjs/blocks";
import { NotFound } from "./errors";
const TITLE = "t";
export class Oops extends Error {}
export const Card = $component(function* (props: TypedProps<{ user: User; title: string }, "Card">) {
  return function* () { return <p>{(yield* props.user).name}</p>; };
});
export const Page = $component(function* (props: TypedProps<{ id: string }, "Page">) {
  const [open] = yield* $signal(false);
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    const u = yield* attempt(() => load(id), NotFound);
    if (!u) yield* raise(new Oops());
    return u;
  });
  return function* () {
    return <section>{yield* Card({ user, title: TITLE })}<Card user={user} title={yield* open ? "a" : "b"} /></section>;
  };
});
export { Card as Default };
export { Other } from "./other";
`;

describe("summarizeBlocks", () => {
  const summary = summarizeBlocks(source, { filename: "page.tsx" });

  it("is versioned", () => {
    expect(summary.schema).toBe("solid-blocks-summary");
    expect(summary.version).toBe(1);
  });

  it("reports edges, statics, classes and components with keys", () => {
    expect(summary.imports).toContainEqual({
      local: "NotFound",
      source: "./errors",
      imported: "NotFound"
    });
    expect(summary.exports).toContainEqual({ exported: "Default", local: "Card" });
    expect(summary.reexports).toContainEqual({
      exported: "Other",
      source: "./other",
      imported: "Other"
    });
    expect(summary.statics).toEqual(["TITLE"]);
    expect(summary.classes).toEqual(["Oops"]);
    expect(summary.components.map(c => [c.local, c.key, c.propsParam])).toEqual([
      ["Card", "Card", "props"],
      ["Page", "Page", "props"]
    ]);
  });

  it("gives each render site's props a value fact", () => {
    const user = summary.components[1].bindings.user;
    expect(user).toEqual({
      k: "memo",
      pending: true,
      fails: ["NotFound", "Oops"],
      reads: [{ k: "prop", name: "id" }]
    });
    const [call, tag] = summary.renders;
    expect(call).toMatchObject({ component: "Card", form: "call", owner: "Page" });
    expect(call.props).toEqual({ user, title: { k: "static" } });
    expect(tag).toMatchObject({ component: "Card", form: "tag", owner: "Page" });
    expect(tag.props.title).toEqual({ k: "value" });
  });

  it("never rewrites: the transform of the same source is unaffected", () => {
    expect(() => transform(source, { filename: "page.tsx" })).not.toThrow();
  });
});
