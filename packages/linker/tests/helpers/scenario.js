// A scripted interaction run against a built fixture app in jsdom. Returns a
// transcript of observable state (DOM text, synchronous `defaultPrevented`)
// so a baseline build and an extracted build can be compared line by line.
import fs from "node:fs";
import path from "node:path";
import { coldStats, importEntry, settle, withDom } from "./dom.js";
import { tempDir } from "./fixtures.js";

export function entryFile(dir) {
  const name = fs.readdirSync(dir).find(file => /^main-.*\.js$/.test(file));
  return path.join(dir, name);
}

const ids = ["message", "words", "log", "failed", "report-out"];

export async function runScenario(buildDir, steps) {
  // A fresh copy per run: ES modules are cached by URL, and a cached entry
  // would not render into the new document.
  const dir = tempDir("run");
  fs.cpSync(buildDir, dir, { recursive: true });
  // Each bundle copy installs its own counters; clear the previous run's.
  delete globalThis[Symbol.for("solid.cold.stats")];
  return withDom(async window => {
    const doc = window.document;
    const transcript = [];
    const snapshot = label =>
      transcript.push(
        `${label} | ${ids.map(id => `${id}=${doc.getElementById(id)?.textContent ?? "-"}`).join(" ")}`
      );
    const errors = [];
    window.addEventListener("error", event => errors.push(String(event.message)));
    const onRejection = error => errors.push(String(error?.message ?? error));
    process.on("unhandledRejection", onRejection);
    try {
      await importEntry(entryFile(dir));
      await settle();
      snapshot("mounted");
      const api = {
        doc,
        window,
        type(value) {
          const input = doc.getElementById("title");
          input.value = value;
          input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        },
        submit() {
          const event = new window.Event("submit", { bubbles: true, cancelable: true });
          doc.getElementById("editor").dispatchEvent(event);
          transcript.push(`submit defaultPrevented(sync)=${event.defaultPrevented}`);
        },
        click(id, init = {}) {
          doc
            .getElementById(id)
            ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, ...init }));
        },
        snapshot,
        settle
      };
      for (const step of steps) {
        await step(api);
        await settle();
        snapshot(step.label ?? step.name ?? "step");
      }
      return { transcript, errors, stats: { ...(coldStats() ?? {}) } };
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
}

const step = (label, run) => Object.assign(run, { label });

export const fullScenario = [
  step("type", api => api.type("hello   world")),
  step("submit", api => api.submit()),
  step("clear", api => api.click("clear")),
  step("legacy", api => api.click("legacy", { button: 1 })),
  step("save", api => api.click("save", { shiftKey: true })),
  step("sensitive", api => api.click("sensitive")),
  step("escaping", api => api.click("escaping")),
  step("counted", api => api.click("counted")),
  step("outer", api => api.click("outer", { button: 2 })),
  step("report", api => api.click("report")),
  step("type again", api => api.type("again")),
  step("submit again", api => api.submit()),
  step("save again", api => api.click("save")),
  step("fail", api => api.click("fail"))
];

// The first interaction is a submit with an empty title: the cold miss must
// still prevent the default synchronously, and the typed failure must reach
// the same error boundary.
export const missScenario = [step("submit first", api => api.submit())];
