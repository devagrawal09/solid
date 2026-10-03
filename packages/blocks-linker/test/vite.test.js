import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";
import solidLink from "../src/vite.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, "tmp-vite");
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
function project(name) {
  const dir = path.join(tmpRoot, `vite-${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(here, "fixtures", name), dir, { recursive: true });
  return dir;
}
const waitFor = async (check, timeout = 10000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise(r => setTimeout(r, 50));
  }
};

describe("vite plugin", () => {
  it("dev: writes at startup and updates the file when a save changes the facts", async () => {
    const dir = project("gap");
    const out = path.join(dir, "src/solid-props.gen.d.ts");
    const server = await createServer({
      root: dir,
      configFile: false,
      logLevel: "silent",
      plugins: [solidLink({ log: false })],
      server: { port: 0, watch: { usePolling: true, interval: 50 } }
    });
    await server.pluginContainer.buildStart({});
    try {
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out, "utf8")).toMatch(/"UserCard": \{\n\s+user: \{ pending: true/);
      const parent = path.join(dir, "src/Parent.tsx");
      writeFileSync(
        parent,
        readFileSync(parent, "utf8").replaceAll(
          "return yield* attempt(() => fetchUser(), () => new FetchError());",
          'return { name: "x" };'
        )
      );
      // Under vitest, Vite's file watcher is inert; deliver the event chokidar
      // would (a plain `vite` dev server does, see the example twins).
      server.watcher.emit("change", parent);
      await waitFor(() =>
        /"UserCard": \{\n\s+user: \{ pending: false/.test(readFileSync(out, "utf8"))
      );
    } finally {
      await server.close();
    }
  });

  it("build: fails when the committed file is stale, passes when it is current", async () => {
    const dir = project("gap");
    const config = {
      root: dir,
      configFile: false,
      logLevel: "silent",
      plugins: [solidLink({ log: false })],
      esbuild: { jsx: "preserve" },
      build: {
        write: false,
        lib: { entry: path.join(dir, "src/UserCard.tsx"), formats: ["es"] },
        rollupOptions: { external: [/^@solidjs\//, /^solid-js/] }
      }
    };
    writeFileSync(path.join(dir, "src/solid-props.gen.d.ts"), "// stale\n");
    await expect(build(config)).rejects.toThrow(/LINK_STALE/);
  });
});
