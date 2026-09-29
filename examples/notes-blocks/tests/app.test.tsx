/**
 * @vitest-environment jsdom
 */
// The notes twin driven through jsdom (client-only: server components and
// actions in-process, see vitest.config.ts): the shell and the sidebar list,
// opening a note, the per-note expand toggle, search, the editor's live
// preview, save / create / delete through the router's actions, and the
// catch-all redirect.
import { afterEach, describe, expect, it } from "vitest";
import App from "../src/app";
import {
  click,
  install,
  mount,
  settle,
  submit,
  type,
  uninstall,
  until,
  type Mounted
} from "./script";

let app: Mounted;
afterEach(() => {
  app?.dispose();
  uninstall();
});

async function open(path: string) {
  install(path);
  app = mount(App);
  await settle();
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.root.querySelector<T>(sel);
const $$ = (sel: string) => [...app.root.querySelectorAll<HTMLElement>(sel)];
const titles = () => $$(".sidebar-note-header strong").map(s => s.textContent);

describe("notes with generator blocks", () => {
  it("renders the shell, the sidebar list and the empty state", async () => {
    await open("/");
    expect($(".sidebar-header strong")?.textContent).toBe("Solid Notes");
    expect($("a.edit-button")?.getAttribute("href")).toBe("/new");
    expect($("a.edit-button")?.className).toBe("edit-button edit-button--solid");
    expect(titles()).toEqual([
      "Meeting Notes",
      "Make a thing",
      "A note with a very long title because sometimes you need more words"
    ]);
    expect($(".note-text--empty-state")?.textContent).toContain("Click a note on the left");
    // The excerpt is server markup inside the (collapsed) client slot.
    expect($(".sidebar-note-excerpt")?.textContent).toBe(
      "This is an example note. It contains **Markdown**!"
    );
    expect(($(".sidebar-note-excerpt")!.parentElement as HTMLElement).style.display).toBe("none");
  });

  it("opens a note: server-rendered markdown, Edit link, active sidebar entry", async () => {
    await open("/");
    await click(app, 'a.sidebar-note-open[href="/notes/0"]');
    expect(location.pathname).toBe("/notes/0");
    expect($(".note-title")?.textContent).toBe("Meeting Notes");
    expect($(".text-with-markdown")?.innerHTML).toContain("<strong>Markdown</strong>");
    expect($(".note-menu a.edit-button")?.getAttribute("href")).toBe("/notes/0/edit");
    expect($(".note-menu a.edit-button")?.className).toBe("edit-button edit-button--outline");
    const [active, other] = $$("a.sidebar-note-open");
    expect(active.style.backgroundColor).toBe("var(--tertiary-blue)");
    expect(other.style.backgroundColor).toBe("");
  });

  it("expands and collapses a sidebar entry", async () => {
    await open("/");
    const item = () => $$(".sidebar-note-list-item")[1];
    await click(app, "li:nth-child(2) .sidebar-note-toggle-expand");
    expect(item().className).toBe("sidebar-note-list-item note-expanded");
    expect(item().querySelector("img")?.getAttribute("alt")).toBe("Expand");
    expect((item().lastElementChild as HTMLElement).style.display).toBe("block");
    await click(app, "li:nth-child(2) .sidebar-note-toggle-expand");
    expect(item().className).toBe("sidebar-note-list-item ");
    expect(item().querySelector("img")?.getAttribute("alt")).toBe("Collapse");
  });

  it("searches through the ?searchText param", async () => {
    await open("/notes/0");
    await type(app, "#sidebar-search-input", "thing");
    expect(location.search).toBe("?searchText=thing");
    expect(titles()).toEqual(["Make a thing"]);
    // The server bakes the filter into the note-open links.
    expect($("a.sidebar-note-open")?.getAttribute("href")).toBe("/notes/1?searchText=thing");
    await type(app, "#sidebar-search-input", "zzz");
    expect($(".notes-empty")?.textContent).toBe(`Couldn't find any notes titled "zzz".`);
    await type(app, "#sidebar-search-input", "");
    expect(titles()).toHaveLength(3);
  });

  it("restores the search box from a deep link", async () => {
    await open("/?searchText=long");
    expect($<HTMLInputElement>("#sidebar-search-input")?.value).toBe("long");
    expect(titles()).toEqual([
      "A note with a very long title because sometimes you need more words"
    ]);
  });

  it("edits a note with a live preview and saves it", async () => {
    await open("/notes/0");
    await click(app, 'a.edit-button[href="/notes/0/edit"]');
    await until(() => !!$("#note-title-input"), "the editor");
    // Seeded from the slot args.
    expect($<HTMLInputElement>("#note-title-input")?.value).toBe("Meeting Notes");
    expect($<HTMLTextAreaElement>("#note-body-input")?.value).toBe(
      "This is an example note. It contains **Markdown**!"
    );
    expect($(".note-editor-delete")).not.toBeNull();
    await type(app, "#note-title-input", "Renamed");
    expect($(".note-editor-preview .note-title")?.textContent).toBe("Renamed");
    await type(app, "#note-body-input", "*live*");
    expect($(".note-editor-preview .text-with-markdown")?.innerHTML.trim()).toBe(
      "<p><em>live</em></p>"
    );
    await submit(app, ".note-editor-done");
    await until(() => location.pathname === "/notes/0" && !!$(".note-title"), "the note");
    expect($(".note .note-title")?.textContent).toBe("Renamed");
    expect(titles()[0]).toBe("Renamed");
  });

  it("creates a note and deletes it", async () => {
    await open("/");
    await click(app, 'a.edit-button[href="/new"]');
    await until(() => !!$("#note-title-input"), "the editor");
    expect($<HTMLInputElement>("#note-title-input")?.value).toBe("");
    expect($(".note-editor-delete")).toBeNull();
    await type(app, "#note-title-input", "Fresh");
    await type(app, "#note-body-input", "A **new** note.");
    await submit(app, ".note-editor-done");
    await until(() => location.pathname.startsWith("/notes/") && !!$(".note-title"), "the note");
    const id = location.pathname.split("/")[2];
    expect($(".note .note-title")?.textContent).toBe("Fresh");
    expect(titles()).toContain("Fresh");
    await click(app, `a.edit-button[href="/notes/${id}/edit"]`);
    await until(() => !!$(".note-editor-delete"), "the editor");
    await submit(app, ".note-editor-delete");
    await until(() => location.pathname === "/" && !titles().includes("Fresh"), "home");
    expect($(".note-text--empty-state")).not.toBeNull();
  });

  it("redirects an unknown route home", async () => {
    await open("/nowhere");
    await until(() => location.pathname === "/", "home");
    expect($(".note-text--empty-state")).not.toBeNull();
  });
});
