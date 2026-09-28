// Prerender: run the SSR build's string-template render and write the page
// into the client build's index.html.
import { readFileSync, writeFileSync } from "node:fs";

const template = readFileSync("dist/index.html", "utf8");
const { render } = await import("./dist-server/entry-server.js");
const html = await render();
writeFileSync("dist/index.html", template.replace("<!--app-->", html));
console.log(`prerendered dist/index.html (${Buffer.byteLength(html)} B of app markup)`);
