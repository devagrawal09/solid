// The interaction script shared by the behavior tests and the differential
// parity test: it mounts an App (examples/notes's or this twin's) client-only
// in jsdom — the server components and the actions run in-process against
// that app's own in-memory note store (see vitest.config.ts) — and records
// the URL and the DOM after every step.
import { vi } from "vitest";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { query } from "@solidjs/router";

export interface Mounted {
  root: HTMLElement;
  dispose(): void;
}

export function install(path: string) {
  // The router's query cache is module-level and both apps share the router
  // module: without this, the second app would read the first one's notes.
  query.clear();
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  history.replaceState(null, "", path);
}

export function uninstall() {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
}

export function mount(App: (props: {}) => unknown): Mounted {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const dispose = render(() => App({}) as never, root);
  flush();
  return { root, dispose: () => (dispose(), root.remove()) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/** Let the in-process server components, actions and lazy chunks settle. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await tick();
    flush();
  }
}

/** Settle until `cond` holds (lazy route chunks are real dynamic imports). */
export async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return settle(4);
    await tick();
    flush();
  }
  throw new Error(`timed out waiting for ${what} (at ${location.pathname}${location.search})`);
}

export function el<T extends HTMLElement = HTMLElement>(app: Mounted, selector: string): T {
  const found = app.root.querySelector<T>(selector);
  if (!found) throw new Error(`no element matched ${selector} (at ${location.pathname})`);
  return found;
}

export async function click(app: Mounted, selector: string) {
  el(app, selector).dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
  );
  await settle();
}

export async function type(app: Mounted, selector: string, value: string) {
  const input = el<HTMLInputElement | HTMLTextAreaElement>(app, selector);
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await settle();
}

/** Submits a form the way the browser does for its submit button. */
export async function submit(app: Mounted, selector: string) {
  const button = el<HTMLButtonElement>(app, selector);
  const form = button.form!;
  form.dispatchEvent(
    new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button })
  );
  await settle(40);
}

const at = (path: string) => () => location.pathname === path;

export type Step = [name: string, run: (app: Mounted) => Promise<unknown> | unknown];

export const steps: Step[] = [
  ["mount / (shell, list, empty state)", () => settle()],
  ["open a note", app => click(app, 'a.sidebar-note-open[href="/notes/0"]')],
  ["expand the second note", app => click(app, "li:nth-child(2) .sidebar-note-toggle-expand")],
  ["collapse it", app => click(app, "li:nth-child(2) .sidebar-note-toggle-expand")],
  ["search 'thing'", app => type(app, "#sidebar-search-input", "thing")],
  ["search with no match", app => type(app, "#sidebar-search-input", "zzz")],
  ["clear the search", app => type(app, "#sidebar-search-input", "")],
  [
    "edit the note",
    async app => {
      await click(app, 'a.edit-button[href="/notes/0/edit"]');
      await until(() => !!app.root.querySelector("#note-title-input"), "the editor");
    }
  ],
  ["type a title", app => type(app, "#note-title-input", "Meeting Notes (edited)")],
  ["type a body", app => type(app, "#note-body-input", "# Heading\n\nSome *new* text.")],
  [
    "save (redirect to the note)",
    async app => {
      await submit(app, ".note-editor-done");
      await until(at("/notes/0"), "the saved note");
      await until(() => !!app.root.querySelector(".note-title"), "the note view");
    }
  ],
  [
    "new note",
    async app => {
      await click(app, 'a.edit-button[href="/new"]');
      await until(() => !!app.root.querySelector("#note-title-input"), "the editor");
    }
  ],
  ["type the new title", app => type(app, "#note-title-input", "Fresh")],
  ["type the new body", app => type(app, "#note-body-input", "A **new** note.")],
  [
    "create (redirect to it)",
    async app => {
      await submit(app, ".note-editor-done");
      await until(at("/notes/3"), "the new note");
      await until(() => !!app.root.querySelector(".note-title"), "the note view");
    }
  ],
  [
    "edit the new note",
    async app => {
      await click(app, 'a.edit-button[href="/notes/3/edit"]');
      await until(() => !!app.root.querySelector(".note-editor-delete"), "the editor");
    }
  ],
  [
    "delete it (redirect home)",
    async app => {
      await submit(app, ".note-editor-delete");
      await until(at("/"), "home");
      await until(() => !app.root.querySelector('a[href="/notes/3"]'), "the list without it");
    }
  ],
  [
    "an unknown route redirects home",
    async app => {
      history.pushState(null, "", "/nowhere");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await settle();
      await until(at("/"), "home");
    }
  ]
];

/** Clock times come from `new Date()` at seed / save time. */
export function normalize(html: string) {
  return html
    .replace(/\d{1,2}:\d{2} [AP]M/g, "#time")
    .replace(/\d{1,2} \w{3} \d{4} at/g, "#date at")
    .replace(/\d{1,2}\/\d{1,2}\/\d{2}/g, "#date");
}

export async function runScript(app: Mounted): Promise<string[]> {
  const out: string[] = [];
  for (const [, run] of steps) {
    await run(app);
    out.push(normalize(`${location.pathname}${location.search}\n${app.root.innerHTML}`));
  }
  return out;
}
