/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 *
 * A document-root hydrate() that starts while the shell is still being
 * parsed. The generated client entry loads as an `async` module, which runs
 * as soon as it arrives: on a large page (hackernews-spa's 1.4 MB story
 * page) under CPU throttling that is mid-parse, when elements whose opening
 * tag is parsed still lack their children. The walk then read `firstChild`
 * of null partway through, hydration threw, and every toggle after the
 * failure point stayed dead (6 of 7 loads at 4x CPU). hydrate() now waits
 * for the parser: DOMContentLoaded, or the shell-parsed marker a stream
 * writes after its shell while fragments are pending.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { hydrate } from "@solidjs/web";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Written by renderToStream after a shell with pending fragments (server.ts);
// pinned there by test/server/shell-parsed-marker.spec.tsx.
const SHELL_PARSED_SCRIPT = `typeof _$HY.sh=="function"&&_$HY.sh();_$HY.sh=1`;

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <main>
      <p>
        <button onClick={() => setCount(c => c + 1)}>{count()}</button>
      </p>
    </main>
  );
}
const PARSED = `<main _hk=0><p><button>0</button></p></main>`;

function setReadyState(state: DocumentReadyState | undefined) {
  if (state) Object.defineProperty(document, "readyState", { value: state, configurable: true });
  else delete (document as any).readyState;
}

describe("hydrate(document) started before the shell is parsed", () => {
  afterEach(() => {
    setReadyState(undefined);
    vi.restoreAllMocks();
  });

  test("waits for DOMContentLoaded instead of walking a half-parsed shell", async () => {
    (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
    setReadyState("loading");
    // The parser has seen <main>'s opening tag, not its children.
    document.documentElement.innerHTML = `<head></head><body><main _hk=0></main></body>`;

    let dispose!: () => void;
    expect(() => (dispose = hydrate(() => <Counter />, document))).not.toThrow();
    flush();

    // The parser catches up, then finishes.
    document.querySelector("main")!.innerHTML = `<p><button>0</button></p>`;
    const button = document.querySelector("button")!;
    setReadyState("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    flush();
    await sleep(10);
    flush();

    // Claimed (not recreated), and live.
    expect(document.querySelector("button")).toBe(button);
    button.click();
    flush();
    expect(button.textContent).toBe("1");
    dispose();
  });

  test("a stream's shell-parsed marker starts it without waiting for the stream to end", async () => {
    (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
    setReadyState("loading");
    document.documentElement.innerHTML = `<head></head><body><main _hk=0></main></body>`;

    const dispose = hydrate(() => <Counter />, document);
    flush();
    expect((globalThis as any)._$HY.done).toBeFalsy();

    // The shell finishes parsing and the marker behind it runs; the document
    // stays "loading" (fragments still streaming).
    document.querySelector("main")!.innerHTML = `<p><button>0</button></p>`;
    (0, eval)(SHELL_PARSED_SCRIPT);
    flush();
    await sleep(10);
    flush();

    const button = document.querySelector("button")!;
    button.click();
    flush();
    expect(button.textContent).toBe("1");

    // A late DOMContentLoaded does not start a second pass.
    document.dispatchEvent(new Event("DOMContentLoaded"));
    flush();
    expect(document.querySelectorAll("button").length).toBe(1);
    button.click();
    flush();
    expect(button.textContent).toBe("2");
    dispose();
  });

  test("starts immediately once the marker has already run", async () => {
    (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {}, sh: 1 };
    setReadyState("loading");
    document.documentElement.innerHTML = `<head></head><body>${PARSED}</body>`;
    const button = document.querySelector("button")!;

    const dispose = hydrate(() => <Counter />, document);
    flush();
    await sleep(10);
    flush();
    button.click();
    flush();
    expect(button.textContent).toBe("1");
    dispose();
  });

  test("disposing before the shell is parsed cancels the pending hydration", async () => {
    (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
    setReadyState("loading");
    document.documentElement.innerHTML = `<head></head><body><main _hk=0></main></body>`;
    let rendered = 0;
    const dispose = hydrate(() => {
      rendered++;
      return <Counter />;
    }, document);
    dispose();
    document.querySelector("main")!.innerHTML = `<p><button>0</button></p>`;
    setReadyState("interactive");
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await sleep(10);
    flush();
    expect(rendered).toBe(0);
  });
});
