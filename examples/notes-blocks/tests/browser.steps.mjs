// Browser script for scripts/example-blocks/browser.mjs: both production
// servers (`node server.js` over `vite build` output), each with its own
// in-memory note store. Every route is loaded by SSR (document request) and
// reached by client navigation. Save / create / delete are covered by the
// jsdom suites only: in the production server the single-flight response
// of every mutation carries a rejected flight entry (`!{"message":"Internal
// Server Error"}`) and both apps show "Uncaught Client Exception" (see the
// README).
export const mode = "server";
export const root = "body";
// Clock times come from `new Date()` at seed / save time.
export const normalize = html =>
  html
    .replace(/\d{1,2}:\d{2} [AP]M/g, "#time")
    .replace(/\d{1,2} \w{3} \d{4} at/g, "#date at")
    .replace(/\d{1,2}\/\d{1,2}\/\d{2}/g, "#date");

const settle = page => page.waitForTimeout(250);
const idle = async page => {
  await page.waitForLoadState("networkidle");
  await settle(page);
};
const go = path => async (page, { base }) => {
  await page.goto(base + path);
  await idle(page);
};
const click = selector => async page => {
  await page.click(selector);
  await idle(page);
};
const fill = (selector, text) => async page => {
  await page.fill(selector, text);
  await idle(page);
};

export const steps = [
  ["SSR /", go("/")],
  ["open a note (client nav)", click('a.sidebar-note-open[href="/notes/0"]')],
  [
    "expand the second note",
    async page => {
      // The toggle is only visible while its entry is hovered (app.css).
      await page.hover(".notes-list > li:nth-child(2) .sidebar-note-open");
      await click(".notes-list > li:nth-child(2) .sidebar-note-toggle-expand")(page);
    }
  ],
  ["search 'thing'", fill("#sidebar-search-input", "thing")],
  ["clear the search", fill("#sidebar-search-input", "")],
  ["edit (client nav, lazy route)", click('a.edit-button[href="/notes/0/edit"]')],
  ["type a title", fill("#note-title-input", "Meeting Notes (edited)")],
  ["type a body", fill("#note-body-input", "# Heading\n\nSome *new* text.")],
  ["SSR a note", go("/notes/1")],
  ["SSR the editor (lazy route)", go("/notes/1/edit")],
  ["SSR new", go("/new")],
  ["SSR an unknown route", go("/nowhere")],
  ["SSR a search deep link", go("/?searchText=long")]
];
