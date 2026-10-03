// The room twin driven through jsdom over the in-process fake wire (see
// vitest.config.ts): both pages, identity and presence, posting (the
// optimistic row held for the echo), the chaos switch's reconnects, the
// undeclared summary's failure and regeneration, the nested-async card, and
// the archive's room-keyed boundary.
import { flush } from "solid-js";
import App from "../src/app";
import { advance, click, install, mount, submit, type, uninstall, type Mounted } from "./script";

let app: Mounted;
function start(path: string) {
  install(path);
  app = mount(App);
}
afterEach(() => {
  app.dispose();
  uninstall();
});

const text = (selector: string) => app.root.querySelector(selector)?.textContent ?? null;
const input = () => app.root.querySelector<HTMLInputElement>(".composer input")!;

describe("/ (the live server component)", () => {
  it("renders the panel, mints the tab's identity, joins and enables the composer", async () => {
    start("/");
    expect(text(".room")).toContain("Room, rendered on the server");
    await advance(50);
    expect(text(".room-panel h2")).toBe("#lobby");
    expect(text(".presence-row .count")).toBe("1");
    expect(app.root.querySelector(".presence-row .me")).not.toBeNull();
    expect(input().disabled).toBe(false);
    expect(input().placeholder).toBe("Message #lobby");
    expect(text(".pill")).toBe("room · connected");
  });

  it("a post reaches the transcript as the panel's markup; the draft clears", async () => {
    start("/");
    await advance(50);
    await type(app, "hi there");
    await submit(app);
    await advance(50);
    const rows = [...app.root.querySelectorAll(".room-panel .messages li")];
    expect(rows.at(-1)!.className).toBe("mine");
    expect(rows.at(-1)!.querySelector(".text")!.textContent).toBe("hi there");
    expect(input().value).toBe("");
  });

  it("the chaos switch: a reconnect is a new render, counted on the pill", async () => {
    start("/");
    await advance(50);
    const before = text(".room-panel .panel-head .muted");
    await click(app, ".chaos button");
    await advance(50);
    expect(text(".chaos .muted")).toBe(" dropped 1");
    expect(text(".pill")).toBe("room · connected (1 reconnect)");
    expect(text(".room-panel .panel-head .muted")).not.toBe(before);
  });
});

describe("/live (live data sources)", () => {
  it("presence joins once the identity exists; directory, card and archive land", async () => {
    start("/live?room=design");
    await advance(50);
    expect(text("h1")).toBe("#design");
    expect(text(".header p.muted")).toMatch(/^You are \w+-\w+, here while/);
    expect(text(".presence .count")).toBe("1");
    const entries = [...app.root.querySelectorAll(".directory li")];
    expect(entries.map(e => e.className)).toEqual(["", "current", "", ""]);
    expect(text(".side")).toContain("counting members…");
    await advance(700);
    // the directory watches every room (each entry its own connection)
    expect(entries.map(e => e.querySelector(".count-small")!.textContent)).toEqual([
      "0",
      "0",
      "0",
      "0"
    ]);
    expect([...app.root.querySelectorAll(".directory .dot-connected")]).toHaveLength(4);
    expect(text(".side")).toContain("1 member when the card was cut");
    await advance(4000);
    expect(app.root.querySelectorAll(".ticks .tick.on")).toHaveLength(8);
    expect(text(".side")).toContain("1 message ever in #design");
  });

  it("a post shows at once as pending and is held until the transcript echoes it", async () => {
    start("/live?room=design");
    await advance(50);
    await type(app, "optimistic");
    app.root
      .querySelector(".composer")!
      .dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    flush();
    const row = () => [...app.root.querySelectorAll(".transcript .messages li")].at(-1)!;
    expect(row().className).toBe("mine pending");
    expect(text(".composer .sending")).toBe("sending…");
    await advance(50);
    expect(row().className).toBe("mine");
    expect(row().querySelector(".text")!.textContent).toBe("optimistic");
    expect(app.root.querySelector(".composer .sending")).toBeNull();
  });

  it("killing the connections errors the undeclared summary; Regenerate calls again", async () => {
    start("/live?room=lobby");
    await advance(1600);
    expect(text(".side")).toContain("Finding the thread…");
    await click(app, ".chaos button");
    await advance(50);
    expect(text(".error p")).toBe("The stream died: The stream was cut off");
    // the live sources reconnected instead
    expect(text(".header .pill")).toBe("presence · connected (1 reconnect)");
    await click(app, ".error button");
    await advance(5000);
    // (the rooms are module state: earlier tests posted in #lobby)
    expect(text(".side")).toMatch(/Attempt 2: \d+ (person has|people have) posted/);
  });

  it("switching rooms keys the archive's boundary: the new room's fallback shows at once", async () => {
    start("/live?room=design");
    await advance(4100);
    expect(text(".side")).toContain("ever in #design");
    await click(app, '.directory a[href="/live?room=infra"]');
    expect(text("h1")).toBe("#infra");
    expect(text(".side")).toContain("counting the archive (4s)…");
    await advance(4100);
    expect(text(".side")).toContain("ever in #infra");
  });
});
