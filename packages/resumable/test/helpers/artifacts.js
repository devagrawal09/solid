// Shared paths and artifact I/O for the server (node) and client (jsdom)
// projects. The server project builds and renders; the client project reads.
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const fixturesDir = path.join(packageDir, "test", "fixtures");
export const outDir = path.join(packageDir, "test", ".out");

export function fixture(...parts) {
  return path.join(fixturesDir, ...parts);
}

export async function writeArtifact(name, artifact) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, `${name}.page.json`), JSON.stringify(artifact, null, 2));
}

export async function readArtifact(name) {
  const text = await fs.readFile(path.join(outDir, `${name}.page.json`), "utf8");
  return JSON.parse(text);
}

/** Split a rendered page into markup and the inline scripts it carried. */
export function splitScripts(html) {
  const scripts = [];
  const scriptRe = /<script(?:[^>]*)>([\s\S]*?)<\/script>/g;
  const markup = html.replace(scriptRe, (_, body) => {
    scripts.push(body);
    return "";
  });
  return { markup, scripts };
}
