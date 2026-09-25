/**
 * @jsxImportSource @solidjs/web
 */
// Store handles under SSR: server stores are plain objects and handles are
// plain wrappers; the handle-compiled `App` renders the handwritten markup.
import { describe, expect, test } from "vitest";
import { renderToString } from "@solidjs/web";
import { App, AppHandwritten } from "./app.jsx";

describe("store handles, compiled for SSR", () => {
  test("renders the same HTML as the proxy spelling", () => {
    const lowered = renderToString(() => <App />);
    const handwritten = renderToString(() => <AppHandwritten />);
    // Hydration keys differ only by the extra owners the `$` blocks create,
    // and insert markers by expression shape; compare the markup without them.
    const strip = (html: string) =>
      html.replace(/ _hk=("[^"]*"|[^\s>]+)/g, "").replace(/<!--[^>]*-->/g, "");
    expect(strip(lowered)).toContain("<h1>Ada</h1>");
    expect(strip(lowered)).toContain("one:first");
    expect(strip(lowered)).toBe(strip(handwritten));
  });
});
