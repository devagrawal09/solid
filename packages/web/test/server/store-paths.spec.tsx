/**
 * @jsxImportSource @solidjs/web
 *
 * Strict store paths on the server (optimization Track B, slice 2): the
 * compiler lowers `yield* store.user.name` to a handle reader
 * (`readPath2(store, "user", "name")`). Server stores are plain objects, so
 * every hop is the ordinary property access — the rendered HTML must be what
 * the handwritten spelling renders.
 */
// @ts-nocheck — authored `yield*` operands are values (checked by solid-tsc).
import { describe, expect, test } from "vitest";
import { renderToString } from "@solidjs/web";
import { $, createMemo, createStore } from "solid-js";

describe("strict store paths under SSR", () => {
  test("lowered path reads render the handwritten markup", () => {
    function Card(props: { row: { title: string } }) {
      const [store] = createStore({
        user: { name: "Ada", address: { city: "London" } },
        items: [{ name: "one" }, { name: "two" }]
      });
      const i = 1;
      const summary = createMemo(
        $(function* () {
          return `${yield* store.user.name}/${yield* store.user.address.city}/${yield* store.items[
            i
          ].name}/${yield* store.items.length}/${yield* props.row.title}`;
        })
      );
      return <p>{summary()}</p>;
    }
    const lowered = renderToString(() => <Card row={{ title: "t" }} />);
    const handwritten = renderToString(() => {
      const [store] = createStore({
        user: { name: "Ada", address: { city: "London" } },
        items: [{ name: "one" }, { name: "two" }]
      });
      const summary = createMemo(
        () =>
          `${store.user.name}/${store.user.address.city}/${store.items[1].name}/${store.items.length}/t`
      );
      return <p>{summary()}</p>;
    });
    expect(lowered).toContain("Ada/London/two/2/t");
    expect(lowered).toBe(handwritten);
  });
});
