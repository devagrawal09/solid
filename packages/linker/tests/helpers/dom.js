// Run a built fixture app in jsdom: fresh window per run, globals installed
// for the duration, the entry chunk imported as ESM.
import { JSDOM } from "jsdom";
import { pathToFileURL } from "node:url";

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "Text",
  "Comment",
  "DocumentFragment",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "InputEvent",
  "SubmitEvent",
  "FocusEvent",
  "CustomEvent",
  "MutationObserver",
  "getComputedStyle"
];

export async function withDom(run) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "http://localhost/",
    pretendToBeVisual: true
  });
  const saved = {};
  for (const name of GLOBALS) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === "window" ? dom.window : dom.window[name]
    });
  }
  try {
    return await run(dom.window);
  } finally {
    for (const name of GLOBALS) {
      if (saved[name]) Object.defineProperty(globalThis, name, saved[name]);
      else delete globalThis[name];
    }
    dom.window.close();
  }
}

export async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 20));
}

export async function importEntry(file) {
  // No cache-busting query: chunks import the entry by its plain URL, and
  // a second URL would evaluate a second copy of it.
  return import(pathToFileURL(file).href);
}

export const coldStats = () => globalThis[Symbol.for("solid.cold.stats")];
