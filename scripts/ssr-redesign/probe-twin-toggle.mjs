#!/usr/bin/env node
// Reproduction for a defect observed while measuring the HackerNews twins:
// in examples/hackernews-spa's production build, under CPU throttling, the
// comment toggles sometimes never become interactive — `_$HY.done` is set,
// the server nodes are still in place, but no click ever toggles (observed
// 4 of 6 and 6 of 7 loads at 4x CPU, 0 of 6 and 1 of 7 at 1x).
//
// Build the example first (`pnpm build` in examples/hackernews-spa), then:
//   node scripts/ssr-redesign/probe-twin-toggle.mjs [hackernews-spa|hackernews] [cpu=4] [loads=6]
// Prints, per load, whether the 4th toggle responded to a click within ~10 s.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { launchChromium, ROOT } from "./lib.mjs";

const twin = process.argv[2] || "hackernews-spa";
const cpu = Number(process.argv[3] || 4);
const loads = Number(process.argv[4] || 6);
const port = 3399;
const srv = spawn(process.execPath, ["server.js"], { cwd: join(ROOT, "examples", twin), env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
process.on("exit", () => srv.kill());
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://localhost:${port}/`);
    break;
  } catch {
    await new Promise(r => setTimeout(r, 100));
  }
}
const browser = await launchChromium();
let dead = 0;
try {
  for (let n = 0; n < loads; n++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    await page.goto(`http://localhost:${port}/stories/30186326`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis._$HY?.done && document.querySelectorAll(".toggle a").length > 3, null, { timeout: 30000 });
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) {
      ok = await page.evaluate(async () => {
        const a = document.querySelectorAll(".toggle a")[3];
        const before = a.parentElement.className;
        a.click();
        await new Promise(r => setTimeout(r, 50));
        const toggled = a.parentElement.className !== before;
        if (toggled) a.click();
        return toggled;
      });
      if (!ok) await new Promise(r => setTimeout(r, 300));
    }
    if (!ok) dead++;
    console.log(`load ${n + 1}: ${ok ? "interactive" : "toggles never responded"}`);
    await context.close();
  }
} finally {
  await browser.close();
  srv.kill();
}
console.log(`${twin} at ${cpu}x CPU: ${dead}/${loads} loads with dead toggles`);
