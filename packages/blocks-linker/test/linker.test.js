import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createLinker } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, ".tmp");

/** Copy a fixture into a fresh directory inside the package (so @solidjs/blocks resolves). */
function project(name) {
  const dir = path.join(tmpRoot, `${name}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(here, "fixtures", name), dir, { recursive: true });
  return dir;
}

/** Type-check a project with stock TypeScript; returns "file:line: message" strings. */
function typecheck(dir) {
  const configPath = path.join(dir, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program).map(d => {
    const file = d.file ? path.relative(dir, d.file.fileName) : "?";
    const line = d.file ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    return `${file}:${line}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
}

function lineOf(file, needle) {
  const lines = readFileSync(file, "utf8").split("\n");
  return lines.findIndex(l => l.includes(needle)) + 1;
}

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("the measured gap becomes a type error", () => {
  it("before linking: stock tsc reports nothing; after: errors at the tag outside Loading and on the parent of the call form", () => {
    const dir = project("gap");
    expect(typecheck(dir)).toEqual([]);

    const linker = createLinker({ root: dir }).scan();
    const { changed, text } = linker.write();
    expect(changed).toBe(true);
    expect(text).toContain('"UserCard": {');
    expect(text).toMatch(/user: \{ pending: true; fails: never; live: true; static: false \}/);

    const errors = typecheck(dir);
    const parent = path.join(dir, "src/Parent.tsx");
    const tagLine = lineOf(parent, "<UserCard user={user} />");
    const appLine = lineOf(parent, "<CallForm />");
    expect(errors.some(e => e.startsWith(`src/Parent.tsx:${tagLine}:`))).toBe(true);
    expect(errors.some(e => e.startsWith(`src/Parent.tsx:${appLine}:`))).toBe(true);
    // Loading handles it; the declared value type stays the contract
    const handledLine = lineOf(parent, "UserCard({ user })}</Loading>");
    expect(errors.some(e => e.startsWith(`src/Parent.tsx:${handledLine}:`))).toBe(false);
    expect(errors.every(e => e.startsWith("src/Parent.tsx") || e.startsWith("src/chain.tsx"))).toBe(
      true
    );
  });
});

describe("the graph", () => {
  it("pass-through chains, failures, static / live facts, unknown callers", () => {
    const dir = project("gap");
    const { text } = createLinker({ root: dir }).scan().generate();
    // Card receives Middle's props.user, which Grand fills with a memo that attempts and raises Missing
    expect(text).toMatch(
      /"Card": \{\n\s+user: \{ pending: true; fails: import\("\.\/chain"\)\.Missing; live: true; static: false \};/
    );
    expect(text).toMatch(
      /"Middle": \{\n\s+user: \{ pending: true; fails: import\("\.\/chain"\)\.Missing;/
    );
    expect(text).toMatch(/count: \{ pending: false; fails: never; live: false; static: true \}/);
    expect(text).toMatch(/label: \{ pending: false; fails: never; live: true; static: false \}/);
    // Hidden is used as a value (Dynamic): open, declared type kept
    expect(text).not.toContain('"Hidden": {');
    expect(text).toContain("//   Hidden (used as a value in src/chain.tsx)");
  });

  it("the Card error lands at its tag inside Middle", () => {
    const dir = project("gap");
    createLinker({ root: dir }).scan().write();
    const errors = typecheck(dir);
    const chain = path.join(dir, "src/chain.tsx");
    expect(
      errors.some(e =>
        e.startsWith(`src/chain.tsx:${lineOf(chain, "<Card user={props.user} />")}:`)
      )
    ).toBe(true);
  });
});

describe("module aliases", () => {
  it("a render site importing through a tsconfig `paths` alias reaches its component", () => {
    const dir = project("gap");
    // Parent imports UserCard through `~/…` instead of a relative path
    const parent = path.join(dir, "src/Parent.tsx");
    const code = readFileSync(parent, "utf8");
    expect(code).toContain('from "./UserCard"');
    writeFileSync(parent, code.replace('from "./UserCard"', 'from "~/UserCard"'));
    const tsconfig = path.join(dir, "tsconfig.json");
    // a tsconfig with comments and a trailing comma, as editors write them
    writeFileSync(
      tsconfig,
      readFileSync(tsconfig, "utf8").replace(
        '"types": []',
        '"types": [],\n    // the app\'s alias\n    "paths": { "~/*": ["./src/*"], },'
      )
    );
    const { text } = createLinker({ root: dir }).scan().generate();
    expect(text).toMatch(/"UserCard": \{\n\s+user: \{ pending: true;/);
    // an explicit alias option replaces the tsconfig's
    const { text: none } = createLinker({ root: dir, alias: {} }).scan().generate();
    expect(none).not.toContain('"UserCard": {');
    // and the CLI reads the tsconfig too
    const cli = spawnSync(process.execPath, [path.join(here, "../bin/solid-link.js")], {
      cwd: dir
    });
    expect(cli.status).toBe(0);
    expect(readFileSync(path.join(dir, "src/solid-props.gen.d.ts"), "utf8")).toContain(
      '"UserCard": {'
    );
  });
});

describe("staleness and incremental updates", () => {
  it("check() and `solid-link --check` fail when the committed file is stale", () => {
    const dir = project("gap");
    const linker = createLinker({ root: dir }).scan();
    linker.write();
    expect(linker.check().stale).toBe(false);
    const cli = path.join(here, "../bin/solid-link.js");
    expect(spawnSync(process.execPath, [cli, "--check", "--root", dir]).status).toBe(0);
    // a caller stops passing a pending value
    const parent = path.join(dir, "src/Parent.tsx");
    writeFileSync(
      parent,
      readFileSync(parent, "utf8").replaceAll(
        "return yield* attempt(() => fetchUser());",
        'return { name: "x" };'
      )
    );
    const fresh = createLinker({ root: dir }).scan();
    expect(fresh.check().stale).toBe(true);
    const result = spawnSync(process.execPath, [cli, "--check", "--root", dir], {
      encoding: "utf8"
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINK_STALE");
    expect(spawnSync(process.execPath, [cli, "--root", dir]).status).toBe(0);
    expect(fresh.check().stale).toBe(false);
  });

  it("updates incrementally on save (only the saved module is re-analyzed)", () => {
    const dir = project("gap");
    // grow the project: 60 more modules, each rendering Plain
    for (let i = 0; i < 60; i++)
      writeFileSync(
        path.join(dir, `src/extra${i}.tsx`),
        `import { $component, $signal } from "@solidjs/blocks";\nimport { Plain } from "./chain";\nexport const Extra${i} = $component(function* () {\n  const [t] = yield* $signal("${i}");\n  return function* () {\n    return <Plain title="a" count={${i}} label={t} />;\n  };\n});\n`
      );
    let summarized = 0;
    const { summarizeBlocks } = require("@solidjs/compiler");
    const linker = createLinker({
      root: dir,
      summarize: (code, file) => {
        summarized++;
        return summarizeBlocks(code, { filename: file });
      }
    });
    let t = performance.now();
    linker.scan().write();
    const full = performance.now() - t;
    expect(summarized).toBe(63);
    const parent = path.join(dir, "src/Parent.tsx");
    const original = readFileSync(parent, "utf8");
    const times = [];
    for (let i = 0; i < 20; i++) {
      writeFileSync(parent, original + `\n// save ${i}\n`);
      t = performance.now();
      linker.update(parent);
      linker.write();
      times.push(performance.now() - t);
    }
    expect(summarized).toBe(63 + 20);
    // an unchanged file is not re-analyzed
    linker.update(parent);
    expect(summarized).toBe(63 + 20);
    // a save that changes the facts rewrites the file
    writeFileSync(
      parent,
      original.replaceAll("return yield* attempt(() => fetchUser());", 'return { name: "x" };')
    );
    linker.update(parent);
    expect(linker.write().changed).toBe(true);
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(
      `[linker perf] full scan ${full.toFixed(1)} ms (63 modules); incremental update median ${median.toFixed(2)} ms`
    );
    writeFileSync(path.join(here, ".perf.json"), JSON.stringify({ full, median, times }));
    expect(median).toBeLessThan(full);
  });
});

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
