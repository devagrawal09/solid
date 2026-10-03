// The interaction script shared by the behavior tests and the differential
// parity test: it mounts an App (examples/chat's or this twin's) client-only
// in jsdom, with the server components resolved in-process (see
// vitest.config.ts), and records the DOM after every step.
//
// Time is fake (the model's sleeps, `Date` for the stats), so both apps see
// the same generation.
import { vi } from "vitest";
import { flush } from "solid-js";
import { createComponent, render } from "@solidjs/web";
import { normalize } from "blocks-example-harness";

export const START = new Date("2026-01-01T12:00:00Z");

export interface Mounted {
  root: HTMLElement;
  dispose(): void;
}

/** The ResizeObservers the app created (the autoscroll follows the transcript). */
export const observers: { callback: () => void; observed: Element[] }[] = [];

export function install() {
  vi.useFakeTimers({ now: START });
  // jsdom has neither; the app's settled effect uses both for autoscroll.
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observed: Element[] = [];
      constructor(readonly callback: () => void) {
        observers.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      disconnect() {
        this.observed = [];
      }
    }
  );
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) }
  });
}

export function uninstall() {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
}

export function mount(App: (props: {}) => unknown): Mounted {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = render(() => createComponent(App as (props: {}) => Node, {}), root);
  flush();
  return { root, dispose: () => (dispose(), root.remove()) };
}

export async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

export async function type(app: Mounted, text: string) {
  const input = app.root.querySelector<HTMLInputElement>(".composer input")!;
  input.value = text;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await advance(0);
}

export async function send(app: Mounted) {
  app.root
    .querySelector<HTMLFormElement>(".composer")!
    .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  await advance(0);
}

export type Step = [name: string, run: (app: Mounted) => Promise<unknown> | unknown];

export const steps: Step[] = [
  ["mount (typing cursor)", () => advance(0)],
  ["welcome: thinking", () => advance(100)],
  ["welcome: first tokens", () => advance(300)],
  ["welcome: mid-stream (open code fence)", () => advance(1500)],
  ["welcome: done", () => advance(4000)],
  ["type whitespace (send stays disabled)", app => type(app, "   ")],
  ["type a prompt", app => type(app, "how do signals work?")],
  ["send", app => send(app)],
  ["reply: thinking", () => advance(500)],
  ["reply: streaming", () => advance(2000)],
  ["reply: done", () => advance(20000)],
  ["ask about server components", async app => (await type(app, "server components?"), send(app))],
  ["streaming the code block", () => advance(6000)],
  ["done", () => advance(20000)],
  [
    "copy the last code block",
    async app => {
      const buttons = app.root.querySelectorAll<HTMLButtonElement>(".copy-code");
      buttons[buttons.length - 1].click();
      await advance(0);
    }
  ],
  ["copy label resets", () => advance(1300)],
  ["empty submit is ignored", async app => (await type(app, ""), send(app))],
  ["fallback answer", async app => (await type(app, "hello"), send(app), advance(30000))]
];

export async function runScript(app: Mounted): Promise<string[]> {
  const out: string[] = [];
  for (const [, run] of steps) {
    await run(app);
    // the draft is a property, not markup: record it with the DOM
    const input = app.root.querySelector<HTMLInputElement>(".composer input");
    out.push(normalize(app.root.innerHTML) + `\n[draft: ${input?.value}]`);
  }
  return out;
}
