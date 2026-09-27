/**
 * @jsxImportSource @solidjs/web
 */
// Generator blocks v2 on the server: a `$component` renders its setup and
// view, and an async block memo streams through a Loading boundary.
import { describe, expect, test } from "vitest";
import {
  $component,
  $memo,
  $signal,
  attempt,
  createContext,
  Loading,
  type TypedProps
} from "solid-js";
import { renderToStream, renderToString } from "@solidjs/web";

const text = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, "");

function collect(code: () => any): Promise<string> {
  return new Promise(resolve => {
    const chunks: string[] = [];
    renderToStream(code).pipe({
      write: (c: string) => void chunks.push(c),
      end: () => resolve(chunks.join(""))
    });
  });
}

describe("$component on the server", () => {
  test("renders setup state and props", () => {
    const Counter = $component(function* (props: TypedProps<{ label: string }>) {
      const [count] = yield* $signal(3);
      return function* () {
        const label = yield* props.label;
        const n = yield* count;
        return (
          <p>
            {label}:{n}
          </p>
        );
      };
    });
    expect(text(renderToString(() => <Counter label="n" />))).toBe("n:3");
  });

  test("reads a context in setup (`yield* Ctx`)", () => {
    const Theme = createContext("light");
    const Label = $component(function* () {
      const theme = yield* Theme;
      return function* () {
        return <p>{theme}</p>;
      };
    });
    expect(
      text(
        renderToString(() => (
          <Theme value="dark">
            <Label />
          </Theme>
        ))
      )
    ).toBe("dark");
    expect(text(renderToString(() => <Label />))).toBe("light");
  });

  test("an async memo resolves inside Loading", async () => {
    const User = $component(function* () {
      const name = yield* $memo(function* () {
        return yield* attempt(() => Promise.resolve("Ada"));
      });
      return function* () {
        const n = yield* name;
        return <h3>{n}</h3>;
      };
    });
    const html = await collect(() =>
      Loading({
        fallback: <p>loading</p>,
        get children() {
          return User({});
        }
      })
    );
    expect(html).toContain("Ada");
  });
});
