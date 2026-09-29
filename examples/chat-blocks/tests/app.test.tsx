// The chat twin driven through jsdom, client-only (server components
// resolved in-process, see vitest.config.ts): the welcome reply streaming
// through its states, the composer (draft, disabled send, submit, reset),
// replies per message with their status ticker and final stats, the usage
// meter, code blocks with copy buttons, and the fallback answer.
import App from "../src/app";
import { advance, install, mount, observers, send, type, uninstall, type Mounted } from "./script";

let app: Mounted;
let warn: { mock: { calls: unknown[][] } };
beforeEach(() => {
  install();
  warn = vi.spyOn(console, "warn");
  app = mount(App);
});
afterEach(() => {
  // no view in the app re-renders as a whole
  expect(warn.mock.calls.some(c => String(c[0]).includes("VIEW_READS_OUTSIDE_JSX"))).toBe(false);
  app.dispose();
  uninstall();
});

const $ = <T extends Element = HTMLElement>(sel: string) => app.root.querySelector<T>(sel);
const $$ = (sel: string) => [...app.root.querySelectorAll<HTMLElement>(sel)];
const input = () => $<HTMLInputElement>(".composer input")!;
const sendButton = () => $<HTMLButtonElement>(".composer button")!;
const exchanges = () => $$(".transcript > li.exchange");

describe("chat with @solidjs/blocks", () => {
  it("streams the welcome reply: cursor, ticker, text, then stats", async () => {
    expect($("h1")!.textContent).toBe("Solid Chat");
    expect($(".bubble.assistant .typing")!.textContent).toBe("▍");
    await advance(100);
    expect($(".status .ticker")!.textContent).toBe("thinking…");
    await advance(300);
    expect($(".md")!.textContent).toContain("Welcome to Solid Chat");
    expect($(".status .ticker")!.textContent).toMatch(/^\d+ tokens…$/);
    expect($(".status .meter")!.textContent).toBe("¶ 1");
    await advance(6000);
    expect($(".status .ticker")).toBeNull();
    expect($(".status .done")!.textContent).toMatch(/^\d+ tokens · \d+ tok\/s · [\d.]+s$/);
    expect($(".status .meter")!.textContent).toBe("¶ 3");
    // The code block rendered as highlighted HTML with its copy button.
    expect($(".code-block .hljs .hljs-comment")).not.toBeNull();
    expect($(".copy-code")!.textContent).toBe("Copy");
  });

  it("keeps Send disabled for an empty draft and ignores an empty submit", async () => {
    expect(sendButton().disabled).toBe(true);
    await type(app, "   ");
    expect(sendButton().disabled).toBe(true);
    await send(app);
    expect(exchanges()).toHaveLength(1);
    await type(app, "hi");
    expect(sendButton().disabled).toBe(false);
  });

  it("sends a prompt: the user bubble, a streaming reply, then stats", async () => {
    await advance(7000);
    await type(app, "  how do signals work?  ");
    await send(app);
    expect(input().value).toBe("");
    expect(sendButton().disabled).toBe(true);
    expect(exchanges()).toHaveLength(2);
    const reply = exchanges()[1];
    expect(reply.querySelector(".bubble.user")!.textContent).toBe("how do signals work?");
    expect(reply.querySelector(".typing")).not.toBeNull();
    await advance(1500);
    expect(reply.querySelector(".md")!.textContent!.length).toBeGreaterThan(0);
    expect(reply.querySelector(".status .ticker")!.textContent).toMatch(/tokens…$/);
    await advance(30000);
    expect(reply.querySelector(".md")!.textContent).toContain("signal");
    expect(reply.querySelector(".status .done")).not.toBeNull();
  });

  it("answers each message independently, and falls back for unknown prompts", async () => {
    await type(app, "tell me about markdown");
    await send(app);
    await type(app, "hello");
    await send(app);
    expect(exchanges().map(e => e.querySelector(".bubble.user")?.textContent ?? null)).toEqual([
      null,
      "tell me about markdown",
      "hello"
    ]);
    await advance(60000);
    expect($$(".status .done")).toHaveLength(3);
    const [, markdown, fallback] = exchanges();
    expect(markdown.querySelector(".md")!.innerHTML).not.toBe(
      fallback.querySelector(".md")!.innerHTML
    );
  });

  it("copies a code block and resets the label", async () => {
    await advance(7000);
    const button = $<HTMLButtonElement>(".copy-code")!;
    button.click();
    await advance(0);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining("even this code block streamed in")
    );
    expect(button.textContent).toBe("Copied!");
    await advance(1300);
    expect(button.textContent).toBe("Copy");
  });
});

describe("autoscroll", () => {
  it("follows the transcript while pinned, and stops once the reader scrolls up", async () => {
    await advance(0);
    const follow = observers.find(o => o.observed.some(el => el.matches("ol.transcript")))!;
    expect(follow).toBeDefined();
    const scrollTo = vi.mocked(window.scrollTo);
    follow.callback();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // scrolled up: far from the bottom
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 5000
    });
    window.dispatchEvent(new Event("scroll"));
    follow.callback();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // sending re-pins
    await type(app, "hello");
    await send(app);
    follow.callback();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    Reflect.deleteProperty(document.documentElement, "scrollHeight");
  });

  it("disconnects when the app is disposed", async () => {
    await advance(0);
    const follow = observers.find(o => o.observed.length > 0)!;
    app.dispose();
    expect(follow.observed).toHaveLength(0);
    app = mount(App);
  });
});
