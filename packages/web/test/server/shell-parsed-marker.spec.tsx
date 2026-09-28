/**
 * @jsxImportSource @solidjs/web
 *
 * The shell-parsed marker: a stream whose shell still has pending fragments
 * writes a script right after the shell, so a document-root hydrate() that
 * started mid-parse (an `async` client entry) can begin once the shell is
 * parsed instead of waiting for the whole stream (DOMContentLoaded). The
 * client half is test/hydration/document-root-parse-race.spec.tsx.
 */
import { describe, expect, test } from "vitest";
import { renderToStream, Loading } from "@solidjs/web";
import { createMemo } from "solid-js";

const MARKER = `<script>typeof _$HY.sh=="function"&&_$HY.sh();_$HY.sh=1</script>`;

function collect(code: () => any, options: any = {}) {
  return new Promise<{ chunks: string[]; shellChunks: number }>(resolve => {
    const chunks: string[] = [];
    let shellChunks = -1;
    renderToStream(code, {
      ...options,
      onCompleteShell() {
        shellChunks = chunks.length;
      }
    }).pipe({
      write(chunk: string) {
        chunks.push(chunk);
      },
      end() {
        resolve({ chunks, shellChunks });
      }
    });
  });
}

describe("shell-parsed marker", () => {
  test("follows a shell that still has pending fragments, before any fragment", async () => {
    function App() {
      const data = createMemo(
        async () => new Promise<string>(r => setTimeout(() => r("late"), 20))
      );
      return (
        <main>
          <Loading fallback={<span>loading</span>}>
            <p>{data()}</p>
          </Loading>
        </main>
      );
    }
    const { chunks } = await collect(() => <App />);
    const html = chunks.join("");
    const at = html.indexOf(MARKER);
    expect(at).toBeGreaterThan(html.indexOf("loading</span>"));
    expect(at).toBeLessThan(html.search(/<template id="(?!pl-)/));
    expect(html.split(MARKER).length).toBe(2);
    expect(html).toContain("late");
  });

  test("is not written when the shell is the whole document", async () => {
    const { chunks } = await collect(() => (
      <main>
        <p>static</p>
      </main>
    ));
    expect(chunks.join("")).not.toContain("_$HY.sh");
  });

  test("is not written with noScripts", async () => {
    function App() {
      const data = createMemo(
        async () => new Promise<string>(r => setTimeout(() => r("late"), 20))
      );
      return (
        <Loading fallback={<span>loading</span>}>
          <p>{data()}</p>
        </Loading>
      );
    }
    const { chunks } = await collect(() => <App />, { noScripts: true });
    expect(chunks.join("")).not.toContain("_$HY.sh");
  });
});
